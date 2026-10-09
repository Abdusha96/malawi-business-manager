import { Prisma, InventoryMovementType } from "@prisma/client";
import { prisma } from "./prisma";
import { logAudit } from "./audit";
import { decideNonStockedMovement, nonStockedRefusalMessage } from "./product-kind";

/**
 * STOCK MUTATION RULE – read this before touching Product.quantity anywhere.
 *
 * Never run `prisma.product.update({ data: { quantity: ... } })` directly
 * from a route handler. Always go through `recordInventoryMovement()`, which
 * updates the quantity AND appends the audit row in the same transaction.
 * The Sales and Purchases modules (next) will call this instead of touching
 * Product.quantity themselves – that's what keeps "why is stock at 12"
 * always answerable from InventoryMovement.
 *
 * `delta` is signed: positive increases stock (purchase, opening stock,
 * sales return), negative decreases it (sale, damage, purchase return).
 *
 * Module 28: `branchId` is optional and additive. Product.quantity (the
 * business-wide total, checked below) is updated exactly as before
 * regardless of whether a branch is given – that check alone is what kept
 * every pre-Module-28 caller correct, and still does. When a branchId IS
 * given, this ALSO upserts that branch's own StockLevel row and enforces a
 * second, narrower check: that specific branch can't go negative either,
 * even if the business total has plenty (stock sitting at a different
 * branch doesn't help a sale actually happening at this one). Callers that
 * never pass branchId (adjustments, unattributed sales/purchases, and every
 * call site that existed before this module) see no behavior change –
 * StockLevel simply never gets a row for that movement.
 */
export async function recordInventoryMovement(params: {
  tx?: Prisma.TransactionClient;
  businessId: string;
  productId: string;
  type: InventoryMovementType;
  delta: number;
  branchId?: string | null;
  reason?: string;
  referenceType?: string;
  referenceId?: string;
  // Optional effective timestamp for historical opening-stock migrations.
  // Existing callers keep their current behavior and signatures.
  occurredAt?: Date;
  createdById: string;
}) {
  const db = params.tx ?? prisma;

  const run = async (client: Prisma.TransactionClient) => {
    const product = await client.product.findUniqueOrThrow({
      where: { id: params.productId },
    });

    if (product.businessId !== params.businessId) {
      // Defense in depth: even if a caller somehow passed a productId from
      // another business, this stops the write cold.
      throw new Error("Product does not belong to the specified business.");
    }

    // Module 77: a non-stocked product (a service) has no quantity to move. A sale or a return of one is
    // ignored so selling, voiding and crediting a service all work; anything else is refused. No
    // InventoryMovement row is written, so the stock ledger only ever describes real stock.
    if (!product.isStocked) {
      if (decideNonStockedMovement(params.type) === "REFUSE") {
        throw new StockError(nonStockedRefusalMessage(product.name));
      }
      return Number(product.quantity);
    }

    const newQuantity = Number(product.quantity) + params.delta;

    if (newQuantity < 0) {
      throw new StockError(
        `Insufficient stock for ${product.name}: has ${product.quantity}, tried to remove ${Math.abs(
          params.delta
        )}.`
      );
    }

    if (params.branchId) {
      const existingLevel = await client.stockLevel.findUnique({
        where: { productId_branchId: { productId: params.productId, branchId: params.branchId } },
      });
      const currentBranchQuantity = existingLevel ? Number(existingLevel.quantity) : 0;
      const newBranchQuantity = currentBranchQuantity + params.delta;

      if (newBranchQuantity < 0) {
        throw new StockError(
          `Insufficient stock for ${product.name} at this branch: has ${currentBranchQuantity}, tried to remove ${Math.abs(
            params.delta
          )} (business-wide total is ${product.quantity} – stock may need transferring in from another branch first).`
        );
      }

      await client.stockLevel.upsert({
        where: { productId_branchId: { productId: params.productId, branchId: params.branchId } },
        create: {
          businessId: params.businessId,
          productId: params.productId,
          branchId: params.branchId,
          quantity: newBranchQuantity,
        },
        update: { quantity: newBranchQuantity },
      });
    }

    await client.product.update({
      where: { id: params.productId },
      data: { quantity: newQuantity },
    });

    await client.inventoryMovement.create({
      data: {
        businessId: params.businessId,
        productId: params.productId,
        type: params.type,
        quantity: params.delta,
        quantityAfter: newQuantity,
        branchId: params.branchId ?? undefined,
        reason: params.reason,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
        createdById: params.createdById,
        ...(params.occurredAt ? { createdAt: params.occurredAt } : {}),
      },
    });

    return newQuantity;
  };

  // If the caller already has an open transaction (e.g. Sales module
  // creating a sale + decrementing stock atomically), reuse it instead of
  // nesting transactions.
  if (params.tx) return run(params.tx);
  return prisma.$transaction(run);
}

/**
 * Module 53: the one place that decides which reorder threshold actually
 * applies at a branch – a branch-specific override if one has been set
 * (including an explicit 0, which means "don't track this branch"), else
 * the business-wide Product.reorderLevel. Pure, so it's trivial to reason
 * about at every call site below rather than re-deriving the fallback
 * logic in three different places.
 */
export function resolveEffectiveReorderLevel(
  productReorderLevel: number,
  branchOverride: number | null
): number {
  return branchOverride !== null ? branchOverride : productReorderLevel;
}

/**
 * MODULE 56 – IN-TRANSIT STOCK VISIBILITY.
 *
 * Closes the KNOWN LIMITATION Module 55's own header documented the moment
 * the in-transit workflow shipped: stock dispatched but not yet received
 * already leaves fromBranch's StockLevel (createStockTransfer() posts
 * TRANSFER_OUT immediately) but doesn't arrive at toBranch's until
 * receiveStockTransfer() runs – so for the whole window in between, that
 * quantity is real, exists, and is owed to a specific branch, but wasn't
 * counted or shown anywhere. This doesn't add a bucket to StockLevel or the
 * GL (Module 55 deliberately kept in-transit stock out of both – see its
 * header) – it's read-only visibility, computed live off StockTransfer the
 * same "computed, never stored" way every other derived balance in this app
 * works (accumulated depreciation, customer/supplier debt).
 *
 * Deliberately queried directly against StockTransferLine here rather than
 * imported from stock-transfers.ts – that file already imports from THIS
 * one (recordInventoryMovement, StockError), so importing back would create
 * a circular dependency. The query itself is a handful of lines; not worth
 * restructuring either file's import graph to share it.
 */
async function getInTransitLinesForProduct(businessId: string, productId: string) {
  return prisma.stockTransferLine.findMany({
    where: { productId, transfer: { businessId, status: "IN_TRANSIT" } },
    select: { quantity: true, transfer: { select: { fromBranchId: true, toBranchId: true } } },
  });
}

/**
 * Per-branch breakdown for one product – every branch the business has,
 * with 0 for any branch that has no StockLevel row yet (never had stock
 * attributed to it), so the UI can show a complete table rather than just
 * the branches that happen to have a row. Module 53: also resolves each
 * branch's effective reorder level (override, or the business-wide
 * fallback) so a product-detail page can show and edit it per branch.
 * Module 56: each row also carries `inTransitIn` (dispatched toward this
 * branch, not yet confirmed) and `inTransitOut` (dispatched from this
 * branch, not yet confirmed at the other end) – both 0 for the common case
 * of no open transfers.
 */
export async function getBranchStockForProduct(businessId: string, productId: string) {
  const [branches, product, levels, inTransitLines] = await Promise.all([
    prisma.branch.findMany({
      where: { businessId },
      orderBy: [{ isHeadOffice: "desc" }, { name: "asc" }],
    }),
    prisma.product.findUniqueOrThrow({ where: { id: productId } }),
    prisma.stockLevel.findMany({ where: { businessId, productId } }),
    getInTransitLinesForProduct(businessId, productId),
  ]);

  const productReorderLevel = Number(product.reorderLevel);

  return branches.map((branch) => {
    const level = levels.find((l) => l.branchId === branch.id);
    const override = level?.reorderLevel != null ? Number(level.reorderLevel) : null;
    const inTransitIn = inTransitLines
      .filter((l) => l.transfer.toBranchId === branch.id)
      .reduce((sum, l) => sum + Number(l.quantity), 0);
    const inTransitOut = inTransitLines
      .filter((l) => l.transfer.fromBranchId === branch.id)
      .reduce((sum, l) => sum + Number(l.quantity), 0);
    return {
      branch,
      quantity: level ? Number(level.quantity) : 0,
      reorderLevelOverride: override,
      effectiveReorderLevel: resolveEffectiveReorderLevel(productReorderLevel, override),
      inTransitIn,
      inTransitOut,
    };
  });
}

/**
 * Every product's stock at one branch – the per-branch counterpart to the
 * business-wide /inventory list. Only returns products that have a
 * StockLevel row at this branch (i.e. have actually had stock attributed
 * to it); a product never sold/purchased/transferred at this branch simply
 * doesn't appear, rather than showing a misleading 0 for every product in
 * the whole catalog. Module 53: each row also carries its effective
 * reorder level (branch override if set, else the business-wide one) so
 * this list – and the Inventory Report's per-branch view, which reuses it
 * – can flag low stock against the threshold that actually applies here.
 *
 * Module 56: also merges in `inTransitIn`/`inTransitOut` per product. A
 * product with stock ARRIVING here but no StockLevel row yet (never
 * before attributed to this branch – see StockLevel's own schema comment)
 * gets a synthetic row with quantity 0 rather than being invisible until
 * receiveStockTransfer() runs; a product only DEPARTING (already has a
 * StockLevel row here, since the OUT leg already decremented it) picks up
 * inTransitOut on its existing row instead.
 */
export async function getBranchStockList(businessId: string, branchId: string) {
  const [levels, inTransitLines] = await Promise.all([
    prisma.stockLevel.findMany({
      where: { businessId, branchId },
      include: { product: { include: { category: true } } },
      orderBy: { product: { name: "asc" } },
    }),
    prisma.stockTransferLine.findMany({
      where: {
        transfer: { businessId, status: "IN_TRANSIT", OR: [{ toBranchId: branchId }, { fromBranchId: branchId }] },
      },
      select: {
        quantity: true,
        productId: true,
        product: { include: { category: true } },
        transfer: { select: { fromBranchId: true, toBranchId: true } },
      },
    }),
  ]);

  const inTransitInByProduct = new Map<string, number>();
  const inTransitOutByProduct = new Map<string, number>();
  for (const line of inTransitLines) {
    const qty = Number(line.quantity);
    if (line.transfer.toBranchId === branchId) {
      inTransitInByProduct.set(line.productId, (inTransitInByProduct.get(line.productId) ?? 0) + qty);
    }
    if (line.transfer.fromBranchId === branchId) {
      inTransitOutByProduct.set(line.productId, (inTransitOutByProduct.get(line.productId) ?? 0) + qty);
    }
  }

  const rows = levels.map((l) => {
    const override = l.reorderLevel != null ? Number(l.reorderLevel) : null;
    return {
      product: l.product,
      quantity: Number(l.quantity),
      reorderLevelOverride: override,
      effectiveReorderLevel: resolveEffectiveReorderLevel(Number(l.product.reorderLevel), override),
      inTransitIn: inTransitInByProduct.get(l.productId) ?? 0,
      inTransitOut: inTransitOutByProduct.get(l.productId) ?? 0,
    };
  });

  // Add synthetic rows for products with something arriving here that have
  // no StockLevel row at this branch at all yet – otherwise "arriving" stock
  // would be silently invisible until it's actually received.
  const seenProductIds = new Set(levels.map((l) => l.productId));
  for (const line of inTransitLines) {
    if (line.transfer.toBranchId !== branchId || seenProductIds.has(line.productId)) continue;
    seenProductIds.add(line.productId);
    rows.push({
      product: line.product,
      quantity: 0,
      reorderLevelOverride: null,
      effectiveReorderLevel: Number(line.product.reorderLevel),
      inTransitIn: inTransitInByProduct.get(line.productId) ?? 0,
      inTransitOut: inTransitOutByProduct.get(line.productId) ?? 0,
    });
  }

  return rows.sort((a, b) => a.product.name.localeCompare(b.product.name));
}

/**
 * Module 56: business-wide "what's currently on a truck" figure – the
 * dashboard/inventory-summary counterpart to getBranchStockList()'s
 * per-branch detail.
 *
 * Module 59: value now uses each line's OWN `unitCostAtDispatch` snapshot
 * (what the product actually cost at the moment it was dispatched) instead
 * of the product's current purchasePrice – closes the KNOWN LIMITATION this
 * comment used to document, that the estimate drifted if a later purchase
 * changed the cost while the transfer was still in transit. Falls back to
 * current purchasePrice only for lines created before Module 59 shipped
 * (unitCostAtDispatch is null on those – nothing to snapshot retroactively,
 * same backfill gap every nullable-added-later column carries).
 */
export async function getInTransitSummary(businessId: string) {
  const [transferCount, lines] = await Promise.all([
    prisma.stockTransfer.count({ where: { businessId, status: "IN_TRANSIT" } }),
    prisma.stockTransferLine.findMany({
      where: { transfer: { businessId, status: "IN_TRANSIT" } },
      select: { quantity: true, unitCostAtDispatch: true, product: { select: { purchasePrice: true } } },
    }),
  ]);

  const totalQuantity = lines.reduce((sum, l) => sum + Number(l.quantity), 0);
  const totalValue = lines.reduce((sum, l) => {
    const unitCost = l.unitCostAtDispatch != null ? Number(l.unitCostAtDispatch) : Number(l.product.purchasePrice);
    return sum + Number(l.quantity) * unitCost;
  }, 0);

  return { transferCount, totalQuantity, totalValue };
}

/**
 * Module 53: set (a number) or clear (null) a branch's reorder-level
 * override for one product. Clearing when no StockLevel row exists is a
 * no-op – there was never an override to clear. Setting one when no row
 * exists yet creates it with quantity 0, the same "watch this branch
 * before stock has physically moved there" case the StockLevel model
 * comment now documents.
 */
export async function setBranchReorderLevel(
  businessId: string,
  productId: string,
  branchId: string,
  reorderLevel: number | null
): Promise<void> {
  const [product, branch] = await Promise.all([
    prisma.product.findUnique({ where: { id: productId } }),
    prisma.branch.findUnique({ where: { id: branchId } }),
  ]);
  if (!product || product.businessId !== businessId) throw new StockError("Product not found.");
  if (!branch || branch.businessId !== businessId) throw new StockError("Branch not found.");
  if (!product.isStocked) throw new StockError(nonStockedRefusalMessage(product.name)); // Module 77

  await prisma.$transaction((tx) => applyReorderLevelToBranchIds(tx, businessId, productId, [branchId], reorderLevel));
}

/**
 * MODULE 60 – closes the KNOWN LIMITATION Module 53 documented from the
 * start: setting an override was strictly one branch at a time, so a
 * business standardizing a new threshold across every branch (or clearing
 * every override back to the business-wide default) had to repeat the same
 * save N times. Reuses the exact same upsert/clear logic
 * setBranchReorderLevel() already used for a single branch – factored out
 * into applyReorderLevelToBranchIds() below so there's exactly one place
 * that knows how to set-or-clear an override, whether for one branch or
 * every branch. Audited (unlike the single-branch PUT, which never was) –
 * a one-click change touching every branch at once is exactly the kind of
 * "could be disputed later" action audit.ts's own header calls for.
 *
 * Returns the number of branches affected, for the UI's confirmation
 * message.
 */
export async function applyReorderLevelToAllBranches(params: {
  businessId: string;
  userId: string;
  productId: string;
  reorderLevel: number | null;
}): Promise<number> {
  const { businessId, userId, productId, reorderLevel } = params;
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || product.businessId !== businessId) throw new StockError("Product not found.");
  if (!product.isStocked) throw new StockError(nonStockedRefusalMessage(product.name)); // Module 77

  const branches = await prisma.branch.findMany({ where: { businessId }, select: { id: true } });
  const branchIds = branches.map((b) => b.id);

  await prisma.$transaction(async (tx) => {
    await applyReorderLevelToBranchIds(tx, businessId, productId, branchIds, reorderLevel);
    await logAudit({
      tx,
      businessId,
      userId,
      action: "product.bulk_reorder_level_applied",
      entityType: "Product",
      entityId: productId,
      metadata: { reorderLevel, branchCount: branchIds.length },
    });
  });

  return branchIds.length;
}

/**
 * Shared set-or-clear, run for every branchId given – a single-item array
 * for setBranchReorderLevel(), every branch in the business for
 * applyReorderLevelToAllBranches(). Always run inside the caller's
 * transaction so a bulk apply is all-or-nothing rather than leaving some
 * branches updated and others not if one write fails partway through.
 */
async function applyReorderLevelToBranchIds(
  tx: Prisma.TransactionClient,
  businessId: string,
  productId: string,
  branchIds: string[],
  reorderLevel: number | null
): Promise<void> {
  for (const branchId of branchIds) {
    if (reorderLevel === null) {
      await tx.stockLevel.updateMany({
        where: { businessId, productId, branchId },
        data: { reorderLevel: null },
      });
    } else {
      await tx.stockLevel.upsert({
        where: { productId_branchId: { productId, branchId } },
        create: { businessId, productId, branchId, quantity: 0, reorderLevel },
        update: { reorderLevel },
      });
    }
  }
}

export class StockError extends Error {}

export async function getLowStockProducts(businessId: string) {
  // Prisma can't compare two columns of the same row in a `where` filter
  // portably across DBs, so we filter in application code. Fine at SME
  // scale (hundreds to low thousands of products); revisit with a raw query
  // if a business's catalog ever gets large enough for this to matter.
  const products = await prisma.product.findMany({
    where: { businessId, isActive: true, isStocked: true }, // Module 77: a service is never "low on stock"
  });

  return products.filter((p) => Number(p.quantity) <= Number(p.reorderLevel));
}

export async function getOutOfStockProducts(businessId: string) {
  return prisma.product.findMany({
    where: { businessId, isActive: true, isStocked: true, quantity: { lte: 0 } },
  });
}

export async function getInventoryValue(businessId: string): Promise<number> {
  const products = await prisma.product.findMany({
    where: { businessId, isActive: true, isStocked: true },
    select: { quantity: true, purchasePrice: true },
  });

  return products.reduce((sum, p) => sum + Number(p.quantity) * Number(p.purchasePrice), 0);
}
