import { prisma } from "./prisma";
import { recordInventoryMovement, StockError } from "./inventory";
import { logAudit } from "./audit";
import {
  postJournalEntryForTransferShortfall,
  postJournalEntryForTransferRecovery,
} from "./accounting-integrations";
import { resolveReceipt, ReceiptLineInput } from "./stock-transfer-receipt";
import { resolveRecovery, validateRecoveryNote, RecoveryLineInput } from "./stock-transfer-recovery";
import { StockTransferInput } from "./validation";

export class StockTransferValidationError extends Error {}

/**
 * Moves stock from one branch to another.
 *
 * MODULE 55 – IN-TRANSIT / RECEIVING WORKFLOW. Until this module, a
 * transfer was always immediate and fully applied in one step (the same
 * simplicity choice Module 9's transferBetweenAccounts() made for cash) –
 * closes the KNOWN LIMITATION this comment used to document: real stock
 * physically spends time on a truck between branches, and nothing modeled
 * that gap or let the destination branch confirm what actually turned up.
 *
 * createStockTransfer() now only posts the TRANSFER_OUT leg (stock has
 * genuinely left fromBranch) and leaves the transfer IN_TRANSIT. Nothing
 * arrives at toBranch – and toBranch's StockLevel doesn't move – until a
 * destination-branch member calls receiveStockTransfer(), which posts the
 * TRANSFER_IN leg. If the goods never arrive (wrong order, truck turned
 * back, damaged in transit and being handled as a separate claim),
 * cancelStockTransfer() reverses the TRANSFER_OUT instead, restoring
 * fromBranch's stock – via a TRANSFER_IN movement at fromBranch, reusing
 * the existing type since it IS stock arriving back at a branch, just not
 * the one it was headed to (referenceType "StockTransferCancel" keeps it
 * distinguishable from an ordinary receipt in the movement history).
 *
 * Each line becomes a recordInventoryMovement() call, which is what
 * actually enforces that the source branch has enough of its OWN recorded
 * stock (not just enough business-wide) – see that function's Module 28
 * comment.
 *
 * KNOWN LIMITATION: a product with no StockLevel row yet at the source
 * branch (never explicitly attributed there via a branch-tagged purchase,
 * opening stock, or an earlier transfer) can't be transferred out of it,
 * even if the business-wide total has plenty sitting unattributed – this
 * is intentional (see StockLevel's schema comment), not a bug to route
 * around by defaulting to Head Office or any other branch.
 *
 * KNOWN LIMITATION: dispatch is still all-or-nothing – there's no
 * partial-dispatch/backorder handling (a transfer can't be sent in two
 * instalments against one transfer number).
 *
 * MODULE 65: RECEIPT is no longer all-or-nothing. receiveStockTransfer()
 * takes the quantity that actually arrived per line; anything short is
 * written off at dispatch-time cost (see its comment) instead of being
 * received in full and corrected afterwards. Closes the "no damaged/short-
 * received path" limitation this header used to describe.
 *
 * MODULE 59: each line also snapshots the product's purchasePrice at the
 * moment of dispatch into `unitCostAtDispatch` – closes the KNOWN LIMITATION
 * Module 56 documented on getInTransitSummary() (its value estimate used
 * whatever the product's cost happens to be RIGHT NOW, which drifts once a
 * later purchase changes purchasePrice while the transfer is still sitting
 * in transit). Read-only visibility only, same as Module 56 – this still
 * never touches the GL.
 */
export async function createStockTransfer(params: {
  businessId: string;
  userId: string;
  input: StockTransferInput;
}) {
  const { businessId, userId, input } = params;

  if (input.fromBranchId === input.toBranchId) {
    throw new StockTransferValidationError("Source and destination branch must be different.");
  }

  return prisma.$transaction(async (tx) => {
    const [fromBranch, toBranch] = await Promise.all([
      tx.branch.findUnique({ where: { id: input.fromBranchId } }),
      tx.branch.findUnique({ where: { id: input.toBranchId } }),
    ]);
    if (!fromBranch || fromBranch.businessId !== businessId) {
      throw new StockTransferValidationError("Source branch not found in this business.");
    }
    if (!toBranch || toBranch.businessId !== businessId) {
      throw new StockTransferValidationError("Destination branch not found in this business.");
    }

    const productIds = input.items.map((i) => i.productId);
    const products = await tx.product.findMany({ where: { id: { in: productIds } } });
    for (const item of input.items) {
      const product = products.find((p) => p.id === item.productId);
      if (!product || product.businessId !== businessId) {
        throw new StockTransferValidationError(`Product ${item.productId} not found in this business.`);
      }
      if (!product.isActive) {
        throw new StockTransferValidationError(`${product.name} is not active and cannot be transferred.`);
      }
    }

    // Atomically claim the next transfer number – same increment-and-read
    // pattern createSale()/createPurchase() use for their own numbering.
    const business = await tx.business.update({
      where: { id: businessId },
      data: { nextStockTransferNumber: { increment: 1 } },
    });
    const transferNumber = `${business.stockTransferPrefix}-${String(
      business.nextStockTransferNumber - 1
    ).padStart(6, "0")}`;

    const transfer = await tx.stockTransfer.create({
      data: {
        businessId,
        fromBranchId: input.fromBranchId,
        toBranchId: input.toBranchId,
        transferNumber,
        notes: input.notes ?? undefined,
        createdById: userId,
        status: "IN_TRANSIT", // explicit – overrides the schema's backfill-only RECEIVED default
        lines: {
          create: input.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            // Module 59: snapshot cost now – products.find() is the same
            // array this function already loaded above for validation.
            unitCostAtDispatch: products.find((p) => p.id === item.productId)!.purchasePrice,
          })),
        },
      },
      include: { lines: true },
    });

    // Module 55: only the OUT leg posts here – the goods have genuinely
    // left fromBranch, so its StockLevel must reflect that immediately.
    // The IN leg at toBranch waits for receiveStockTransfer().
    for (const item of input.items) {
      const product = products.find((p) => p.id === item.productId)!;

      try {
        await recordInventoryMovement({
          tx,
          businessId,
          productId: item.productId,
          type: "TRANSFER_OUT",
          delta: -item.quantity,
          branchId: input.fromBranchId,
          referenceType: "StockTransfer",
          referenceId: transfer.id,
          reason: `Transfer ${transferNumber} to ${toBranch.name}`,
          createdById: userId,
        });
      } catch (err) {
        if (err instanceof StockError) {
          throw new StockTransferValidationError(
            `Cannot transfer ${item.quantity} ${product.unit} of ${product.name} out of ${fromBranch.name}: ${err.message}`
          );
        }
        throw err;
      }
    }

    await logAudit({
      tx,
      businessId,
      userId,
      action: "stocktransfer.create",
      entityType: "StockTransfer",
      entityId: transfer.id,
      metadata: { transferNumber, fromBranch: fromBranch.name, toBranch: toBranch.name },
    });

    return tx.stockTransfer.findUniqueOrThrow({
      where: { id: transfer.id },
      include: { fromBranch: true, toBranch: true, lines: { include: { product: true } } },
    });
  });
}

/**
 * Confirms a transfer's goods arrived at toBranch – posts the TRANSFER_IN leg
 * createStockTransfer() deferred, and moves the transfer to RECEIVED.
 * Refuses anything not currently IN_TRANSIT (already received, already
 * cancelled) so this can never double-post the IN leg.
 *
 * MODULE 65 – SHORT / DAMAGED RECEIPT. `lines` is optional: omitted (or empty)
 * means everything arrived in full, exactly the Module 55 behaviour. Naming a
 * line with a smaller quantityReceived records what really turned up:
 *
 *   - TRANSFER_IN posts for the RECEIVED quantity only (skipped at zero).
 *   - The shortfall needs no inventory movement: TRANSFER_OUT already took it
 *     off both fromBranch's StockLevel and the business-wide Product.quantity
 *     at dispatch. What still carries it is the GL Inventory account, so each
 *     short line is written off at its dispatch-time cost (Dr Inventory
 *     Shrinkage & Adjustment / Cr Inventory) – see
 *     postJournalEntryForTransferShortfall(). The movement history stays
 *     truthful without it: TRANSFER_OUT -10 then TRANSFER_IN +8 already shows
 *     8 arrived, and the line row records the other 2 and why.
 *   - Every line gets its quantityReceived written (full lines included), so
 *     NULL afterwards only ever means "received before Module 65".
 *
 * Validation (0 <= received <= dispatched, reason required when short) is the
 * pure resolveReceipt(), run BEFORE any write so a bad body leaves nothing
 * half-applied.
 */
export async function receiveStockTransfer(params: {
  businessId: string;
  userId: string;
  transferId: string;
  lines?: ReceiptLineInput[];
}) {
  const { businessId, userId, transferId } = params;

  return prisma.$transaction(async (tx) => {
    const transfer = await tx.stockTransfer.findUnique({
      where: { id: transferId },
      include: { fromBranch: true, toBranch: true, lines: { include: { product: true } } },
    });
    if (!transfer || transfer.businessId !== businessId) {
      throw new StockTransferValidationError("Transfer not found in this business.");
    }
    if (transfer.status !== "IN_TRANSIT") {
      throw new StockTransferValidationError(
        transfer.status === "RECEIVED"
          ? "This transfer has already been received."
          : "This transfer was cancelled and can no longer be received."
      );
    }

    // Module 65: decide what each line received BEFORE claiming or writing
    // anything, so an invalid quantity/reason is a clean refusal.
    const receipt = resolveReceipt(
      transfer.lines.map((line) => ({
        id: line.id,
        productName: line.product.name,
        quantity: Number(line.quantity),
        // Same snapshot-or-current-cost rule Module 59 uses for the in-transit value.
        unitCost: Number(line.unitCostAtDispatch ?? line.product.purchasePrice),
      })),
      params.lines
    );
    if (!receipt.ok) {
      throw new StockTransferValidationError(receipt.error);
    }

    // Atomic claim: transition out of IN_TRANSIT before applying stock
    // movements. The state change is in this transaction, so any later
    // failure rolls it back. A concurrent receive/cancel waits for this
    // update and then sees a state other than IN_TRANSIT, so it cannot apply
    // the same transfer twice. Writing IN_TRANSIT to itself would not claim
    // the row: the waiting request would still match after the first commit.
    const receivedAt = new Date();
    const claimed = await tx.stockTransfer.updateMany({
      where: { id: transferId, businessId, status: "IN_TRANSIT" },
      data: { status: "RECEIVED", receivedAt, receivedById: userId },
    });
    if (claimed.count === 0) {
      throw new StockTransferValidationError("This transfer is no longer in transit.");
    }

    for (const resolved of receipt.lines) {
      const line = transfer.lines.find((l) => l.id === resolved.lineId)!;

      if (resolved.quantityReceived > 0) {
        await recordInventoryMovement({
          tx,
          businessId,
          productId: line.productId,
          type: "TRANSFER_IN",
          delta: resolved.quantityReceived,
          branchId: transfer.toBranchId,
          referenceType: "StockTransfer",
          referenceId: transfer.id,
          reason: resolved.isShort
            ? `Transfer ${transfer.transferNumber} from ${transfer.fromBranch.name} (received ${resolved.quantityReceived} of ${resolved.quantityDispatched})`
            : `Transfer ${transfer.transferNumber} from ${transfer.fromBranch.name}`,
          createdById: userId,
        });
      }

      // Guarded like the stock-take posting: a shortfall worth less than a
      // tambala (or a zero-cost product) has nothing to write off.
      if (resolved.isShort && resolved.shortfallValue > 0) {
        await postJournalEntryForTransferShortfall({
          tx,
          businessId,
          lineId: line.id,
          transferNumber: transfer.transferNumber,
          productName: resolved.productName,
          shortfall: resolved.shortfall,
          unitCost: resolved.unitCost,
          createdById: userId,
        });
      }

      await tx.stockTransferLine.update({
        where: { id: line.id },
        data: {
          quantityReceived: resolved.quantityReceived,
          shortfallReason: resolved.shortfallReason,
        },
      });
    }

    const updated = await tx.stockTransfer.findUniqueOrThrow({
      where: { id: transferId },
      include: { fromBranch: true, toBranch: true, lines: { include: { product: true } } },
    });

    await logAudit({
      tx,
      businessId,
      userId,
      action: "stocktransfer.receive",
      entityType: "StockTransfer",
      entityId: transfer.id,
      metadata: {
        transferNumber: transfer.transferNumber,
        shortLineCount: receipt.shortLineCount,
        totalShortfallValue: receipt.totalShortfallValue,
        receivedNothing: receipt.receivedNothing,
        ...(receipt.shortLineCount > 0
          ? {
              shortLines: receipt.lines
                .filter((l) => l.isShort)
                .map((l) => ({
                  lineId: l.lineId,
                  product: l.productName,
                  dispatched: l.quantityDispatched,
                  received: l.quantityReceived,
                  reason: l.shortfallReason,
                })),
            }
          : {}),
      },
    });

    return updated;
  });
}

/**
 * Cancels a transfer that never arrived – reverses the TRANSFER_OUT leg
 * (fromBranch gets its stock back) and moves the transfer to CANCELLED.
 * Only possible while IN_TRANSIT: a RECEIVED transfer is done (send a new
 * transfer the other way to correct it, the same principle Module 9 and
 * this file's own header apply); an already-CANCELLED one can't be
 * cancelled twice.
 */
export async function cancelStockTransfer(params: {
  businessId: string;
  userId: string;
  transferId: string;
  reason: string;
}) {
  const { businessId, userId, transferId, reason } = params;

  return prisma.$transaction(async (tx) => {
    const transfer = await tx.stockTransfer.findUnique({
      where: { id: transferId },
      include: { fromBranch: true, toBranch: true, lines: { include: { product: true } } },
    });
    if (!transfer || transfer.businessId !== businessId) {
      throw new StockTransferValidationError("Transfer not found in this business.");
    }
    if (transfer.status !== "IN_TRANSIT") {
      throw new StockTransferValidationError(
        transfer.status === "RECEIVED"
          ? "This transfer has already been received and can no longer be cancelled – send a new transfer the other way to correct it."
          : "This transfer has already been cancelled."
      );
    }

    // Claim by changing state in this transaction. The change rolls back if
    // any stock movement fails, and prevents a concurrent receive/cancel
    // from passing the same IN_TRANSIT condition after waiting on this row.
    const cancelledAt = new Date();
    const claimed = await tx.stockTransfer.updateMany({
      where: { id: transferId, businessId, status: "IN_TRANSIT" },
      data: {
        status: "CANCELLED",
        cancelledAt,
        cancelledById: userId,
        cancelReason: reason,
      },
    });
    if (claimed.count === 0) {
      throw new StockTransferValidationError("This transfer is no longer in transit.");
    }

    for (const line of transfer.lines) {
      await recordInventoryMovement({
        tx,
        businessId,
        productId: line.productId,
        type: "TRANSFER_IN", // stock arriving back at fromBranch, not at its intended destination
        delta: Number(line.quantity),
        branchId: transfer.fromBranchId,
        referenceType: "StockTransferCancel",
        referenceId: transfer.id,
        reason: `Transfer ${transfer.transferNumber} to ${transfer.toBranch.name} cancelled: ${reason}`,
        createdById: userId,
      });
    }

    const updated = await tx.stockTransfer.findUniqueOrThrow({
      where: { id: transferId },
      include: { fromBranch: true, toBranch: true, lines: { include: { product: true } } },
    });

    await logAudit({
      tx,
      businessId,
      userId,
      action: "stocktransfer.cancel",
      entityType: "StockTransfer",
      entityId: transfer.id,
      metadata: { transferNumber: transfer.transferNumber, reason },
    });

    return updated;
  });
}

/**
 * MODULE 66 – recovers stock that was written off as short at receipt and has
 * since turned up (second delivery, found in the wrong bay...).
 *
 * Only a RECEIVED transfer can have a shortfall, so anything else is refused.
 * For each named line (see resolveRecovery(), which validates every quantity
 * BEFORE any write so a bad body leaves nothing half-applied):
 *
 *   - TRANSFER_IN posts for the recovered quantity at toBranch (referenceType
 *     "StockTransferRecovery" keeps it distinct from the original receipt in
 *     the movement history). This is a real stock increase – TRANSFER_OUT took
 *     the units off both the branch StockLevel and Product.quantity at
 *     dispatch, and the short receipt never put them back.
 *   - The Module 65 write-off is reversed for those units at the SAME cost it
 *     used (Dr Inventory / Cr Inventory Shrinkage), dated now so it never
 *     lands in a closed period.
 *   - StockTransferLine.quantityRecovered is advanced by the recovered amount.
 *
 * CONCURRENCY. Two people recovering the same line at once must not both get
 * credit for the same outstanding units. Each line's update is conditioned on
 * quantityRecovered still holding the value that was read (NULL included), so
 * the loser's updateMany matches nothing and the whole recovery is refused –
 * the same fail-closed claim receive/cancel use on `status`, applied to the
 * one column that changes here.
 *
 * `note` (required) records where the stock turned up; it lives in the audit
 * metadata alongside the per-line quantities rather than in another column.
 */
export async function recoverStockTransferShortfall(params: {
  businessId: string;
  userId: string;
  transferId: string;
  lines: RecoveryLineInput[];
  note: string;
}) {
  const { businessId, userId, transferId } = params;

  const note = validateRecoveryNote(params.note);
  if (!note.ok) throw new StockTransferValidationError(note.error);

  return prisma.$transaction(async (tx) => {
    const transfer = await tx.stockTransfer.findUnique({
      where: { id: transferId },
      include: { fromBranch: true, toBranch: true, lines: { include: { product: true } } },
    });
    if (!transfer || transfer.businessId !== businessId) {
      throw new StockTransferValidationError("Transfer not found in this business.");
    }
    if (transfer.status !== "RECEIVED") {
      throw new StockTransferValidationError(
        transfer.status === "IN_TRANSIT"
          ? "This transfer hasn't been received yet, so nothing has been written off. Receive it first."
          : "This transfer was cancelled – its stock already went back to the source branch."
      );
    }

    const recovery = resolveRecovery(
      transfer.lines.map((line) => ({
        id: line.id,
        productName: line.product.name,
        quantity: Number(line.quantity),
        quantityReceived: line.quantityReceived === null ? null : Number(line.quantityReceived),
        quantityRecovered: line.quantityRecovered === null ? null : Number(line.quantityRecovered),
        // Same snapshot-or-current-cost rule the write-off used (Modules 59/65).
        unitCost: Number(line.unitCostAtDispatch ?? line.product.purchasePrice),
      })),
      params.lines
    );
    if (!recovery.ok) {
      throw new StockTransferValidationError(recovery.error);
    }

    for (const resolved of recovery.lines) {
      const line = transfer.lines.find((l) => l.id === resolved.lineId)!;

      // Optimistic claim on the running total – see the CONCURRENCY note above.
      const claimed = await tx.stockTransferLine.updateMany({
        where: { id: line.id, transferId, quantityRecovered: line.quantityRecovered },
        data: { quantityRecovered: resolved.recoveredTotal },
      });
      if (claimed.count === 0) {
        throw new StockTransferValidationError(
          `${resolved.productName} was just updated by someone else. Reload the transfer and try again.`
        );
      }

      await recordInventoryMovement({
        tx,
        businessId,
        productId: line.productId,
        type: "TRANSFER_IN",
        delta: resolved.quantity,
        branchId: transfer.toBranchId,
        referenceType: "StockTransferRecovery",
        referenceId: transfer.id,
        reason: `Transfer ${transfer.transferNumber} short-received stock recovered at ${transfer.toBranch.name}: ${note.note}`,
        createdById: userId,
      });

      // Guarded like the write-off it reverses: a recovery worth less than a
      // tambala (or a zero-cost product) has nothing to put back in the GL.
      if (resolved.value > 0) {
        await postJournalEntryForTransferRecovery({
          tx,
          businessId,
          lineId: line.id,
          transferNumber: transfer.transferNumber,
          productName: resolved.productName,
          quantity: resolved.quantity,
          unitCost: resolved.unitCost,
          createdById: userId,
        });
      }
    }

    await logAudit({
      tx,
      businessId,
      userId,
      action: "stocktransfer.recover_shortfall",
      entityType: "StockTransfer",
      entityId: transfer.id,
      metadata: {
        transferNumber: transfer.transferNumber,
        note: note.note,
        totalValue: recovery.totalValue,
        lines: recovery.lines.map((l) => ({
          lineId: l.lineId,
          product: l.productName,
          recovered: l.quantity,
          outstandingAfter: l.outstandingAfter,
          fullyRecovered: l.fullyRecovered,
        })),
      },
    });

    return tx.stockTransfer.findUniqueOrThrow({
      where: { id: transferId },
      include: { fromBranch: true, toBranch: true, lines: { include: { product: true } } },
    });
  });
}

export async function getStockTransfers(
  businessId: string,
  opts: { branchId?: string | null; limit?: number } = {}
) {
  return prisma.stockTransfer.findMany({
    where: {
      businessId,
      ...(opts.branchId
        ? { OR: [{ fromBranchId: opts.branchId }, { toBranchId: opts.branchId }] }
        : {}),
    },
    include: { fromBranch: true, toBranch: true, lines: { include: { product: true } } },
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 50,
  });
}

export async function getStockTransfer(businessId: string, transferId: string) {
  const transfer = await prisma.stockTransfer.findUnique({
    where: { id: transferId },
    include: { fromBranch: true, toBranch: true, lines: { include: { product: true } } },
  });
  if (!transfer || transfer.businessId !== businessId) return null;
  return transfer;
}
