import { prisma } from "./prisma";
import { recordInventoryMovement, StockError } from "./inventory";
import { postJournalEntryForStockTakeAdjustment } from "./accounting-integrations";
import { reverseJournalEntriesForReference } from "./accounting";
import { logAudit } from "./audit";
import { countReopens, getReopenHistory, reopenCapMessage } from "./reopen-audit";
import { OpenStockTakeInput } from "./validation";

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export class StockTakeError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "StockTakeError";
    this.status = status;
  }
}

/**
 * Opens a new stock take and immediately generates one PENDING line per
 * active product in scope (the whole catalog, or just one category –
 * see StockTake.categoryId), snapshotting each line's current quantity
 * and cost. Only one IN_PROGRESS stock take per scope at a time – the
 * same "no overlapping views of the same unresolved state" rule Module
 * 22 enforces per CashAccount, here enforced per (category, branch)
 * scope (whole catalog at a given branch, or business-wide, each counts
 * as its own scope) so two teams can genuinely count two different
 * categories – or the same category at two different branches – on the
 * same day without colliding.
 *
 * Module 31: when `branchId` is given, each line's systemQuantityAtCount
 * is snapshotted from that branch's own StockLevel.quantity (0 if the
 * branch has no row yet for a product) instead of the business-wide
 * Product.quantity – the per-branch counterpart to the whole-catalog
 * count, same relationship Module 30's Inventory Report has to the
 * business-wide one. Every active product in scope still gets a line
 * even with no StockLevel row, since physically counting a branch is
 * exactly how stock that was never explicitly attributed there gets
 * attributed for the first time.
 */
export async function openStockTake(params: {
  businessId: string;
  createdById: string;
  branchId?: string | null;
  data: OpenStockTakeInput;
}) {
  const { businessId, createdById, branchId, data } = params;
  const categoryId = data.categoryId ?? null;

  if (categoryId) {
    const category = await prisma.category.findFirst({ where: { id: categoryId, businessId } });
    if (!category) throw new StockTakeError("Category not found.");
  }

  if (branchId) {
    const branch = await prisma.branch.findFirst({ where: { id: branchId, businessId } });
    if (!branch) throw new StockTakeError("Branch not found.");
  }

  const existing = await prisma.stockTake.findFirst({
    where: { businessId, categoryId, branchId: branchId ?? null, status: "IN_PROGRESS" },
  });
  if (existing) {
    const scopeLabel = categoryId ? "This category" : "The whole catalog";
    throw new StockTakeError(
      `${scopeLabel}${branchId ? " at this branch" : ""} already has a stock take in progress. Finish or delete it before starting another.`
    );
  }

  const products = await prisma.product.findMany({
    where: { businessId, isActive: true, isStocked: true, ...(categoryId ? { categoryId } : {}) }, // Module 77: a service can't be counted
    select: { id: true, quantity: true, purchasePrice: true },
  });
  if (products.length === 0) {
    throw new StockTakeError("No active stocked products found in this scope to count.");
  }

  let branchQuantities: Map<string, number> | null = null;
  if (branchId) {
    const levels = await prisma.stockLevel.findMany({
      where: { businessId, branchId, productId: { in: products.map((p) => p.id) } },
      select: { productId: true, quantity: true },
    });
    branchQuantities = new Map(levels.map((l) => [l.productId, Number(l.quantity)]));
  }

  const stockTake = await prisma.stockTake.create({
    data: {
      businessId,
      categoryId,
      branchId: branchId ?? null,
      note: data.note,
      createdById,
      lines: {
        create: products.map((p) => ({
          businessId,
          productId: p.id,
          systemQuantityAtCount: branchQuantities ? branchQuantities.get(p.id) ?? 0 : p.quantity,
          unitCost: p.purchasePrice,
        })),
      },
    },
  });

  await logAudit({
    businessId,
    userId: createdById,
    action: "stocktake.open",
    entityType: "StockTake",
    entityId: stockTake.id,
    metadata: { categoryId, branchId: branchId ?? undefined, productCount: products.length },
  });

  return stockTake;
}

async function getOpenStockTakeOrThrow(businessId: string, stockTakeId: string) {
  const stockTake = await prisma.stockTake.findFirst({ where: { id: stockTakeId, businessId } });
  if (!stockTake) throw new StockTakeError("Stock take not found.");
  if (stockTake.status !== "IN_PROGRESS") {
    throw new StockTakeError("This stock take is already completed and can no longer be changed.");
  }
  return stockTake;
}

async function getLineOrThrow(businessId: string, lineId: string) {
  const line = await prisma.stockTakeLine.findFirst({ where: { id: lineId, businessId }, include: { product: true } });
  if (!line) throw new StockTakeError("Stock take line not found.");
  return line;
}

/**
 * Records (or re-records, before posting) the physical count for one
 * product. Variance is never stored – it's always countedQuantity minus
 * the snapshotted systemQuantityAtCount, computed on read (see
 * getStockTake). A zero-variance line needs no further action: it's
 * already COUNTED and that's a complete, correct state on its own.
 */
export async function recordStockCount(params: {
  businessId: string;
  stockTakeId: string;
  lineId: string;
  countedQuantity: number;
  countedById: string;
}) {
  const { businessId, stockTakeId, lineId, countedQuantity, countedById } = params;
  await getOpenStockTakeOrThrow(businessId, stockTakeId);
  const line = await getLineOrThrow(businessId, lineId);
  if (line.stockTakeId !== stockTakeId) throw new StockTakeError("This line doesn't belong to that stock take.");
  if (line.status === "POSTED") {
    throw new StockTakeError("This line's adjustment has already been posted – unpost it first to re-count.");
  }

  await logAudit({
    businessId,
    userId: countedById,
    action: "stocktake.count",
    entityType: "StockTakeLine",
    entityId: lineId,
    metadata: { countedQuantity, systemQuantityAtCount: Number(line.systemQuantityAtCount) },
  });

  return prisma.stockTakeLine.update({
    where: { id: lineId },
    data: {
      countedQuantity: round3(countedQuantity),
      status: "COUNTED",
      countedById,
      countedAt: new Date(),
    },
  });
}

/** Puts a COUNTED (not yet POSTED/IGNORED) line back to PENDING, in case the count was mis-typed. */
export async function uncountStockTakeLine(params: { businessId: string; lineId: string; unsetById: string }) {
  const { businessId, lineId, unsetById } = params;
  const line = await getLineOrThrow(businessId, lineId);
  await getOpenStockTakeOrThrow(businessId, line.stockTakeId);
  if (line.status !== "COUNTED") throw new StockTakeError("Only a counted line can be reset – unpost or un-ignore it first.");

  await logAudit({ businessId, userId: unsetById, action: "stocktake.uncount", entityType: "StockTakeLine", entityId: lineId });

  return prisma.stockTakeLine.update({
    where: { id: lineId },
    data: { countedQuantity: null, status: "PENDING", countedById: null, countedAt: null },
  });
}

/**
 * The reason this module exists: a counted line whose physical quantity
 * genuinely differs from the books gets corrected for real – an
 * InventoryMovement (so Product.quantity and the stock ledger reflect
 * reality) and a JournalEntry (so the balance sheet does too), in one
 * transaction. If the line's unitCost is zero (a free/promotional
 * product), only the quantity is corrected – a zero-value journal entry
 * isn't a real entry, so none is posted, and that's stated here rather
 * than silently skipped.
 */
export async function postStockTakeLineAdjustment(params: { businessId: string; lineId: string; postedById: string }) {
  const { businessId, lineId, postedById } = params;
  const line = await getLineOrThrow(businessId, lineId);
  const stockTake = await getOpenStockTakeOrThrow(businessId, line.stockTakeId);
  if (line.status !== "COUNTED") throw new StockTakeError("This line hasn't been counted yet.");
  if (line.countedQuantity === null) throw new StockTakeError("This line hasn't been counted yet.");

  const variance = round3(Number(line.countedQuantity) - Number(line.systemQuantityAtCount));
  if (variance === 0) {
    throw new StockTakeError("This line has no variance – there's nothing to post.");
  }

  try {
    await prisma.$transaction(async (tx) => {
      await recordInventoryMovement({
        tx,
        businessId,
        productId: line.productId,
        type: "ADJUSTMENT",
        delta: variance,
        // Module 31: a branch-scoped stock take's adjustment moves that
        // branch's own StockLevel (and, via recordInventoryMovement's
        // existing dual-check, the business-wide Product.quantity along
        // with it) – a business-wide stock take (branchId null) behaves
        // exactly as before.
        branchId: stockTake.branchId,
        reason: "Stock take adjustment",
        referenceType: "StockTake",
        referenceId: line.id,
        createdById: postedById,
      });

      const unitCost = Number(line.unitCost);
      if (round2(Math.abs(variance) * unitCost) > 0) {
        await postJournalEntryForStockTakeAdjustment({
          tx,
          businessId,
          lineId: line.id,
          productName: line.product.name,
          variance,
          unitCost,
          createdById: postedById,
        });
      }

      await tx.stockTakeLine.update({ where: { id: lineId }, data: { status: "POSTED" } });
    });
  } catch (err) {
    if (err instanceof StockError) throw new StockTakeError(err.message);
    throw err;
  }

  await logAudit({
    businessId,
    userId: postedById,
    action: "stocktake.post_adjustment",
    entityType: "StockTakeLine",
    entityId: lineId,
    metadata: { variance },
  });

  return prisma.stockTakeLine.findUniqueOrThrow({ where: { id: lineId } });
}

/**
 * Reverses a posted adjustment – an equal-and-opposite InventoryMovement
 * and JournalEntry, both keyed off referenceType "StockTake"/
 * "StockTakeAdjustment" + referenceId = lineId, mirroring Bank
 * Reconciliation's unpost exactly. Only while the stock take is still
 * IN_PROGRESS. Can fail if a later movement makes the reversal impossible
 * – e.g. found stock this line added has since been sold – in which case
 * the underlying StockError surfaces as a normal StockTakeError rather
 * than being silently swallowed.
 */
export async function unpostStockTakeLineAdjustment(params: { businessId: string; lineId: string; unpostedById: string }) {
  const { businessId, lineId, unpostedById } = params;
  const line = await getLineOrThrow(businessId, lineId);
  const stockTake = await getOpenStockTakeOrThrow(businessId, line.stockTakeId);
  if (line.status !== "POSTED") throw new StockTakeError("This line hasn't been posted.");
  if (line.countedQuantity === null) throw new StockTakeError("This line has no recorded count to reverse to.");

  const variance = round3(Number(line.countedQuantity) - Number(line.systemQuantityAtCount));

  try {
    await prisma.$transaction(async (tx) => {
      await recordInventoryMovement({
        tx,
        businessId,
        productId: line.productId,
        type: "ADJUSTMENT",
        delta: -variance,
        branchId: stockTake.branchId,
        reason: "Reversing stock take adjustment",
        referenceType: "StockTakeReversal",
        referenceId: line.id,
        createdById: unpostedById,
      });
      await reverseJournalEntriesForReference({
        tx,
        businessId,
        referenceType: "StockTakeAdjustment",
        referenceId: lineId,
        createdById: unpostedById,
        reason: `Reversing stock take adjustment: ${line.product.name}`,
      });
      await tx.stockTakeLine.update({ where: { id: lineId }, data: { status: "COUNTED" } });
    });
  } catch (err) {
    if (err instanceof StockError) throw new StockTakeError(err.message);
    throw err;
  }

  await logAudit({
    businessId,
    userId: unpostedById,
    action: "stocktake.unpost_adjustment",
    entityType: "StockTakeLine",
    entityId: lineId,
  });

  return prisma.stockTakeLine.findUniqueOrThrow({ where: { id: lineId } });
}

/**
 * Marks a counted, variant line as deliberately left unadjusted – e.g. a
 * recount is scheduled, or the variance is judged too small to bother
 * correcting the books for. Same "void, don't silently drop" philosophy
 * as Bank Reconciliation's ignore: the line stays visible with its status
 * and reason, not hidden.
 */
export async function ignoreStockTakeLine(params: { businessId: string; lineId: string; reason?: string | null; ignoredById: string }) {
  const { businessId, lineId, reason, ignoredById } = params;
  const line = await getLineOrThrow(businessId, lineId);
  await getOpenStockTakeOrThrow(businessId, line.stockTakeId);
  if (line.status !== "COUNTED") throw new StockTakeError("Only a counted line can be ignored.");

  await logAudit({
    businessId,
    userId: ignoredById,
    action: "stocktake.ignore",
    entityType: "StockTakeLine",
    entityId: lineId,
    metadata: { reason: reason ?? undefined },
  });

  return prisma.stockTakeLine.update({ where: { id: lineId }, data: { status: "IGNORED" } });
}

/** Puts an IGNORED line back to COUNTED, in case it was ignored by mistake. */
export async function unignoreStockTakeLine(params: { businessId: string; lineId: string; unignoredById: string }) {
  const { businessId, lineId, unignoredById } = params;
  const line = await getLineOrThrow(businessId, lineId);
  await getOpenStockTakeOrThrow(businessId, line.stockTakeId);
  if (line.status !== "IGNORED") throw new StockTakeError("This line isn't ignored.");

  await logAudit({ businessId, userId: unignoredById, action: "stocktake.unignore", entityType: "StockTakeLine", entityId: lineId });

  return prisma.stockTakeLine.update({ where: { id: lineId }, data: { status: "COUNTED" } });
}

/**
 * The stock take's working view: every line plus a variance computed on
 * read (countedQuantity - systemQuantityAtCount), never stored. A line is
 * "ready" once it's PENDING no longer and, if it turned out to have a
 * variance, that variance has been POSTED or IGNORED – a zero-variance
 * COUNTED line needs no further action.
 */
export async function getStockTake(businessId: string, stockTakeId: string) {
  const stockTake = await prisma.stockTake.findFirst({
    where: { id: stockTakeId, businessId },
    include: {
      category: { select: { id: true, name: true } },
      branch: { select: { id: true, name: true } },
      lines: { orderBy: { createdAt: "asc" }, include: { product: { select: { id: true, name: true, sku: true, unit: true } } } },
    },
  });
  if (!stockTake) return null;

  const lines = stockTake.lines.map((l) => {
    const systemQuantityAtCount = Number(l.systemQuantityAtCount);
    const countedQuantity = l.countedQuantity === null ? null : Number(l.countedQuantity);
    const variance = countedQuantity === null ? null : round3(countedQuantity - systemQuantityAtCount);
    const unitCost = Number(l.unitCost);
    return {
      ...l,
      systemQuantityAtCount,
      countedQuantity,
      unitCost,
      variance,
      varianceValue: variance === null ? null : round2(variance * unitCost),
    };
  });

  const counts = {
    pending: lines.filter((l) => l.status === "PENDING").length,
    counted: lines.filter((l) => l.status === "COUNTED").length,
    posted: lines.filter((l) => l.status === "POSTED").length,
    ignored: lines.filter((l) => l.status === "IGNORED").length,
  };
  const unresolvedVariances = lines.filter((l) => l.status === "COUNTED" && l.variance !== 0).length;

  // Module 50: reopen count and timeline are both read live off AuditLog –
  // see reopen-audit.ts for why this is computed rather than stored.
  // Module 51: the cap itself is now the business's own setting, not a
  // shared constant – fetched alongside so the UI never has to import it.
  // Module 52: history is now the first PAGE, not the whole thing – a
  // `historyNextCursor` tells the UI whether the reopen-history route has
  // more to fetch.
  const [reopenCount, historyPage, business] = await Promise.all([
    countReopens(businessId, "StockTake", stockTakeId),
    getReopenHistory(businessId, "StockTake", stockTakeId),
    prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { maxReopens: true } }),
  ]);

  return {
    ...stockTake,
    lines,
    counts,
    readyToComplete: counts.pending === 0 && unresolvedVariances === 0,
    reopenCount,
    maxReopens: business.maxReopens,
    reopensRemaining: Math.max(0, business.maxReopens - reopenCount),
    history: historyPage.rows,
    historyNextCursor: historyPage.nextCursor,
  };
}

// Module 31: takes an optional branchId so /stock-take can be branch-locked
// the same way every other list in this app is – the API route resolves it
// via resolveBranchScope() before calling in, same pattern as /purchases.
export async function listStockTakes(businessId: string, branchId?: string | null) {
  const stockTakes = await prisma.stockTake.findMany({
    where: { businessId, ...(branchId ? { branchId } : {}) },
    include: {
      category: { select: { id: true, name: true } },
      branch: { select: { id: true, name: true } },
      _count: { select: { lines: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return stockTakes;
}

/**
 * Locks the stock take in. Requires every line to have been counted, and
 * every genuine variance to have been either posted or ignored – the
 * whole point of a physical count is that someone actually looked at
 * every product, not just the ones that seemed worth checking.
 *
 * A completed stock take CAN be reopened – see reopenStockTake below –
 * but only as a deliberate, reasoned Owner act, not by editing this
 * function's own gate.
 */
export async function completeStockTake(params: { businessId: string; stockTakeId: string; completedById: string }) {
  const { businessId, stockTakeId, completedById } = params;
  await getOpenStockTakeOrThrow(businessId, stockTakeId);

  const lines = await prisma.stockTakeLine.findMany({ where: { businessId, stockTakeId } });
  const pendingCount = lines.filter((l) => l.status === "PENDING").length;
  if (pendingCount > 0) {
    throw new StockTakeError(`${pendingCount} product${pendingCount === 1 ? "" : "s"} still need${pendingCount === 1 ? "s" : ""} to be counted before this stock take can be completed.`);
  }
  const unresolvedCount = lines.filter(
    (l) => l.status === "COUNTED" && l.countedQuantity !== null && round3(Number(l.countedQuantity) - Number(l.systemQuantityAtCount)) !== 0
  ).length;
  if (unresolvedCount > 0) {
    throw new StockTakeError(
      `${unresolvedCount} counted product${unresolvedCount === 1 ? "" : "s"} still ha${unresolvedCount === 1 ? "s" : "ve"} an unresolved variance – post or ignore each before completing.`
    );
  }

  const postedLines = lines.filter((l) => l.status === "POSTED");
  const netAdjustmentValue = round2(
    postedLines.reduce((sum, l) => {
      const variance = round3(Number(l.countedQuantity) - Number(l.systemQuantityAtCount));
      return sum + variance * Number(l.unitCost);
    }, 0)
  );

  const completed = await prisma.stockTake.update({
    where: { id: stockTakeId },
    data: { status: "COMPLETED", completedAt: new Date(), completedById },
  });

  await logAudit({
    businessId,
    userId: completedById,
    action: "stocktake.complete",
    entityType: "StockTake",
    entityId: stockTakeId,
    metadata: { postedLines: postedLines.length, netAdjustmentValue },
  });

  return { stockTake: completed, postedCount: postedLines.length, netAdjustmentValue };
}

/**
 * Module 49. Puts a COMPLETED stock take back to IN_PROGRESS so a mistake
 * found after the fact – a mistyped count, a posted adjustment that
 * shouldn't have been, a line that should have been ignored instead –
 * can actually be corrected, instead of only being fixed by a separate,
 * disconnected manual journal. Mirrors reopenBankReconciliation (Module
 * 48) exactly, field for field and check for check.
 *
 * Deliberately the SAME permission split as Bank Reconciliation's own
 * close/reopen (and Period Close before it): completing a stock take is
 * an ordinary inventory act (`stocktake.manage`, Owner + Accountant, same
 * as every other stock take action); reopening one that's already
 * completed is bigger – undoing a signed-off physical count – so it also
 * needs `business.settings.manage` (Owner only). The caller (the API
 * route) resolves that permission and passes the result in as
 * `canReopen`; this function only enforces the boolean, it doesn't know
 * how to check permissions itself.
 *
 * A reason is required – never a silent reopen – logged to AuditLog and
 * also snapshotted onto the row itself (see the schema comment on
 * `reopenedAt` for why only the most recent reopen lives there).
 *
 * Guards against the one real hazard: by the time this stock take is
 * reopened, the business may already have opened a NEWER one for the
 * same scope (category, branch) – openStockTake's own "only one
 * IN_PROGRESS per scope" rule would otherwise be silently broken.
 * Reopening an older one while a newer one on the same scope is
 * mid-flight is refused with a pointer to finish or delete that newer
 * one first.
 *
 * Once reopened, every existing per-line function (count/uncount/post/
 * unpost/ignore/unignore) works completely unchanged – they all gate on
 * status === IN_PROGRESS via getOpenStockTakeOrThrow, which this
 * function's own status update now satisfies again. That includes
 * unpostStockTakeLineAdjustment: a POSTED line's real inventory/GL
 * effect can now genuinely be undone after the fact. Nothing about the
 * lines themselves is reset – a line that was already COUNTED, POSTED,
 * or IGNORED stays exactly as it was; reopening resumes the stock take,
 * it doesn't restart it.
 *
 * No interaction with Period Close needed: stock take adjustments always
 * post dated "now", never back-dated, so they were never blocked by
 * `booksClosedThrough` and reopening doesn't need to check it either –
 * same reasoning Module 48 documented for Bank Reconciliation.
 *
 * Module 54: an optional `lineId` names which product's line the reopen is
 * actually about – mirrors reopenBankReconciliation's own `lineId` field
 * for field, closing the same KNOWN LIMITATION on this side too. Verified
 * to belong to THIS stock take before anything is written. Unlike a
 * BankStatementLine, a StockTakeLine is never individually deleted (only
 * the whole stock take can be, and only while nothing's posted), so the
 * label snapshot in AuditLog is really about a product being renamed later
 * rather than the line disappearing – but the same "capture it now" reasoning
 * applies either way.
 */
export async function reopenStockTake(params: {
  businessId: string;
  stockTakeId: string;
  reason: string;
  lineId?: string | null;
  reopenedById: string;
  canReopen: boolean;
}) {
  const { businessId, stockTakeId, reopenedById, canReopen } = params;
  const reason = params.reason.trim();

  if (!canReopen) {
    throw new StockTakeError("Only the Owner can reopen a completed stock take.", 403);
  }
  if (!reason) {
    throw new StockTakeError("A reason is required to reopen a completed stock take.");
  }

  const stockTake = await prisma.stockTake.findFirst({ where: { id: stockTakeId, businessId } });
  if (!stockTake) throw new StockTakeError("Stock take not found.");
  if (stockTake.status !== "COMPLETED") {
    throw new StockTakeError("Only a completed stock take can be reopened.");
  }

  const conflicting = await prisma.stockTake.findFirst({
    where: {
      businessId,
      categoryId: stockTake.categoryId,
      branchId: stockTake.branchId,
      status: "IN_PROGRESS",
      id: { not: stockTakeId },
    },
  });
  if (conflicting) {
    throw new StockTakeError(
      "This scope already has a different stock take in progress. Finish or delete it before reopening an earlier one."
    );
  }

  let lineLabel: string | null = null;
  const lineId = params.lineId || null;
  if (lineId) {
    const line = await prisma.stockTakeLine.findFirst({
      where: { id: lineId, businessId, stockTakeId },
      include: { product: { select: { name: true, sku: true } } },
    });
    if (!line) throw new StockTakeError("That line doesn't belong to this stock take.");
    lineLabel = line.product.sku ? `${line.product.name} (${line.product.sku})` : line.product.name;
  }

  const [priorReopens, business] = await Promise.all([
    countReopens(businessId, "StockTake", stockTakeId),
    prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { maxReopens: true } }),
  ]);
  if (priorReopens >= business.maxReopens) {
    throw new StockTakeError(reopenCapMessage("stock take", business.maxReopens));
  }

  const reopened = await prisma.stockTake.update({
    where: { id: stockTakeId },
    data: { status: "IN_PROGRESS", reopenedAt: new Date(), reopenedById, reopenReason: reason, reopenLineId: lineId },
  });

  await logAudit({
    businessId,
    userId: reopenedById,
    action: "stocktake.reopen",
    entityType: "StockTake",
    entityId: stockTakeId,
    metadata: { reason, previousCompletedAt: stockTake.completedAt, lineId, lineLabel },
  });

  return reopened;
}

/**
 * Deletes an IN_PROGRESS stock take outright – only while no line has
 * been POSTED (a posted line has real inventory/GL effect; unpost it
 * first). Same "void, don't silently delete" rule the rest of this app
 * follows once something has touched the ledger for real.
 */
export async function deleteStockTake(params: { businessId: string; stockTakeId: string; deletedById: string }) {
  const { businessId, stockTakeId, deletedById } = params;
  const stockTake = await getOpenStockTakeOrThrow(businessId, stockTakeId);

  const postedCount = await prisma.stockTakeLine.count({ where: { businessId, stockTakeId, status: "POSTED" } });
  if (postedCount > 0) {
    throw new StockTakeError("This stock take has posted adjustments – unpost them before deleting the stock take.");
  }

  await prisma.stockTake.delete({ where: { id: stockTakeId } });

  await logAudit({
    businessId,
    userId: deletedById,
    action: "stocktake.delete",
    entityType: "StockTake",
    entityId: stockTakeId,
    metadata: { categoryId: stockTake.categoryId },
  });
}
