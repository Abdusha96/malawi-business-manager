import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import {
  AccountingError,
  getOrCreateSystemAccountId,
  getSystemAccountId,
  postJournalEntry,
  reverseJournalEntriesForReference,
} from "./accounting";
import { logAudit } from "./audit";
import {
  buildClearingReport,
  clearingBalance,
  describeSettlement,
  formatTambala,
  planBulkSettlement,
  planSettlement,
  settlementJournalLines,
  summariseAgedBalances,
  toTambala,
  type AgedBalanceSummary,
  type BulkSettlementRequestItem,
  type ClearingReport,
  type ServiceClearingFacts,
  type SettlementDirection,
} from "./service-cost-clearing";

/**
 * Module 79 - Service Cost Clearing: reading the per-service balance and settling it.
 *
 * DESIGN CHOICES, stated plainly:
 *
 * 1. THE BALANCE IS COMPUTED, NEVER STORED. Every figure comes from rows that already exist (sale lines, purchase
 *    lines, debit-note lines, recorded settlements), the same principle as customer/supplier balances and
 *    accumulated depreciation. A voided sale or purchase simply drops out, so nothing here can go stale.
 *
 * 2. THE LEDGER IS THE AUTHORITY, THE PER-SERVICE FIGURES EXPLAIN IT. The report also reads what account 1210
 *    really holds and shows the difference as "unattributed" (see buildClearingReport) instead of hiding it.
 *
 * 3. SETTLING IS A DELIBERATE ACT, NEVER AUTOMATIC. A debit balance can be a service bought for work not yet
 *    sold, a credit balance a job done but not yet billed. Only a person knows the difference is final.
 *
 * 4. ONE POSTING PATH. The entry goes through postJournalEntry() tagged referenceType "ServiceCostSettlement",
 *    referenceId = the settlement row. A void reverses it with reverseJournalEntriesForReference(); nothing is
 *    deleted and a settlement can't be edited (void and settle again), the same rule as manual journals.
 *
 * 5. DATED NOW. Like credit notes and stock write-offs the entry is never back-dated, so it can never land in a
 *    closed period (Module 42 reasoning).
 *
 * 6. CONCURRENCY. The balance is re-read INSIDE the transaction after taking a row lock on the product (a
 *    no-op UPDATE). Two people settling the same service at once therefore run one after the other, and the
 *    second sees the first's settlement and is refused (or settles only what is left). Void takes the same lock.
 *    This relies on Postgres READ COMMITTED (Prisma's default): statements after the lock see committed rows.
 *
 * Module 80 adds:
 *
 * 7. AGE IS COMPUTED, NEVER STORED. A service's age is "days since the latest event that touched its balance":
 *    the newest non-voided sale date, supplier bill date, debit-note date or recorded settlement. Nothing new is
 *    written to the service, so nothing can go stale. A voided settlement does NOT reset the age (it is not read).
 *
 * 8. BULK SETTLE IS N INDEPENDENT SETTLEMENTS, NOT ONE BIG TRANSACTION. Each service runs the exact Module 79
 *    path (its own row lock, its own journal entry, its own audit row) so a bulk settlement can be voided one
 *    service at a time. One service failing must not stop the rest, so the result lists every service as settled
 *    or skipped with the reason. The person's `expectedBalance` per service is checked INSIDE each locked
 *    transaction: a sale that landed after the page loaded makes that one service refuse, never settle silently
 *    at a figure nobody looked at.
 */

export class ServiceCostClearingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceCostClearingError";
  }
}

type Db = Prisma.TransactionClient;

/** Loads the five inputs of the balance for the given services (or every service of the business). */
export async function loadClearingFacts(db: Db, businessId: string, onlyProductId?: string): Promise<ServiceClearingFacts[]> {
  const products = await db.product.findMany({
    where: onlyProductId ? { id: onlyProductId, businessId } : { businessId, isStocked: false },
    select: { id: true, name: true, sku: true },
    orderBy: { name: "asc" },
  });
  if (products.length === 0) return [];
  const ids = products.map((p) => p.id);

  const [saleItems, purchaseItems, debitLines, settlements] = await Promise.all([
    db.saleItem.findMany({
      where: { productId: { in: ids }, sale: { businessId, status: { not: "VOIDED" } } },
      select: { productId: true, quantity: true, unitCost: true, sale: { select: { saleDate: true } } },
    }),
    db.purchaseItem.findMany({
      where: { productId: { in: ids }, purchase: { businessId, status: { not: "VOIDED" } } },
      select: { productId: true, total: true, purchase: { select: { purchaseDate: true } } },
    }),
    db.supplierDebitNoteLine.findMany({
      where: { purchaseItem: { productId: { in: ids } }, debitNote: { businessId } },
      select: { net: true, purchaseItem: { select: { productId: true } }, debitNote: { select: { issuedAt: true } } },
    }),
    db.serviceCostSettlement.findMany({
      where: { businessId, productId: { in: ids }, status: "RECORDED" },
      select: { productId: true, direction: true, amount: true, createdAt: true },
    }),
  ]);

  const facts = new Map<string, ServiceClearingFacts>();
  const recognisedRaw = new Map<string, number>();
  for (const p of products) {
    facts.set(p.id, { productId: p.id, name: p.name, sku: p.sku, billed: 0, debited: 0, recognised: 0, costUp: 0, costDown: 0 });
    recognisedRaw.set(p.id, 0);
  }
  // Cost on sales is quantity x unit cost, summed per service and rounded to a tambala ONCE.
  // Module 80: newest event per service, epoch ms. Only the four sources the balance itself reads.
  const lastActivity = new Map<string, number>();
  const touch = (productId: string, when: Date) => {
    const ms = when.getTime();
    if (Number.isFinite(ms) && ms > (lastActivity.get(productId) ?? -Infinity)) lastActivity.set(productId, ms);
  };
  for (const i of saleItems) {
    recognisedRaw.set(i.productId, (recognisedRaw.get(i.productId) ?? 0) + Number(i.quantity) * Number(i.unitCost));
    touch(i.productId, i.sale.saleDate);
  }
  for (const [id, raw] of Array.from(recognisedRaw.entries())) facts.get(id)!.recognised = toTambala(raw);
  for (const i of purchaseItems) {
    facts.get(i.productId)!.billed += toTambala(Number(i.total));
    touch(i.productId, i.purchase.purchaseDate);
  }
  for (const l of debitLines) {
    const f = facts.get(l.purchaseItem.productId);
    if (f) {
      f.debited += toTambala(Number(l.net));
      touch(l.purchaseItem.productId, l.debitNote.issuedAt);
    }
  }
  for (const s of settlements) {
    const f = facts.get(s.productId)!;
    if (s.direction === "COST_UP") f.costUp += toTambala(Number(s.amount));
    else f.costDown += toTambala(Number(s.amount));
    touch(s.productId, s.createdAt);
  }
  for (const [id, ms] of Array.from(lastActivity.entries())) facts.get(id)!.lastActivityMs = ms;
  return products.map((p) => facts.get(p.id)!);
}

/** What the ledger holds in account 1210, debit positive, whole tambala. 0 when the account was never needed. */
export async function getLedgerClearingBalance(db: Db, businessId: string): Promise<number> {
  const account = await db.account.findFirst({ where: { businessId, systemKey: "SERVICE_COST_CLEARING" }, select: { id: true } });
  if (!account) return 0;
  const agg = await db.journalLine.aggregate({
    where: { accountId: account.id, journalEntry: { businessId } },
    _sum: { debit: true, credit: true },
  });
  return toTambala(Number(agg._sum.debit ?? 0)) - toTambala(Number(agg._sum.credit ?? 0));
}

export interface SettlementListItem {
  id: string;
  productId: string;
  productName: string;
  direction: SettlementDirection;
  amount: number;
  reason: string;
  status: "RECORDED" | "VOIDED";
  createdAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
  summary: string;
}

export async function listRecentSettlements(db: Db, businessId: string, limit = 30): Promise<SettlementListItem[]> {
  const rows = await db.serviceCostSettlement.findMany({
    where: { businessId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { product: { select: { name: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    productName: r.product.name,
    direction: r.direction as SettlementDirection,
    amount: Number(r.amount),
    reason: r.reason,
    status: r.status as "RECORDED" | "VOIDED",
    createdAt: r.createdAt,
    voidedAt: r.voidedAt,
    voidReason: r.voidReason,
    summary: describeSettlement(r.direction as SettlementDirection, toTambala(Number(r.amount))),
  }));
}

export async function getServiceCostClearing(
  businessId: string,
  nowMs: number = Date.now()
): Promise<{ report: ClearingReport; settlements: SettlementListItem[]; alertDays: number }> {
  const [facts, ledger, settlements, business] = await Promise.all([
    loadClearingFacts(prisma, businessId),
    getLedgerClearingBalance(prisma, businessId),
    listRecentSettlements(prisma, businessId),
    prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { serviceCostAlertDays: true } }),
  ]);
  const alertDays = business.serviceCostAlertDays;
  return { report: buildClearingReport(facts, ledger, { alertDays, nowMs }), settlements, alertDays };
}

/**
 * Module 80: what the bell alert needs, nothing more. Returns null when no service has an aged leftover.
 * Runs on every bell sync, so a business with no service products costs one small count query.
 */
export async function getAgedServiceCostSummary(businessId: string, nowMs: number = Date.now()): Promise<AgedBalanceSummary | null> {
  const serviceCount = await prisma.product.count({ where: { businessId, isStocked: false } });
  if (serviceCount === 0) return null;
  const [facts, business] = await Promise.all([
    loadClearingFacts(prisma, businessId),
    prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { serviceCostAlertDays: true } }),
  ]);
  const alertDays = business.serviceCostAlertDays;
  // The ledger figure is not needed for ageing, so pass 0; only the rows are read.
  const report = buildClearingReport(facts, 0, { alertDays, nowMs });
  return summariseAgedBalances(report.rows, alertDays);
}

/**
 * Settles all or part of one service's clearing balance. Returns the settlement row and the balance left.
 * `amount` omitted = the whole balance. The direction is derived from the balance (see planSettlement).
 */
export async function settleServiceCost(params: {
  businessId: string;
  userId: string;
  productId: string;
  amount?: number | null;
  reason: string;
  /** Module 80: the leftover (kwacha, debit positive) the person saw. When given, a different current balance refuses. */
  expectedBalance?: number | null;
}) {
  const { businessId, userId, productId } = params;

  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findFirst({ where: { id: productId, businessId }, select: { id: true, name: true, isStocked: true } });
    if (!product) throw new ServiceCostClearingError("Service not found.");
    if (product.isStocked) {
      throw new ServiceCostClearingError(`${product.name} is a stocked product. Only a service has a balance in Service Cost Clearing.`);
    }

    // Row lock: concurrent settlements/voids of this service queue here, then read fresh data below.
    await tx.product.updateMany({ where: { id: productId, businessId }, data: { updatedAt: new Date() } });

    const [facts] = await loadClearingFacts(tx, businessId, productId);
    const balanceBefore = clearingBalance(facts);
    if (params.expectedBalance !== undefined && params.expectedBalance !== null) {
      const expected = toTambala(params.expectedBalance);
      if (expected !== balanceBefore) {
        throw new ServiceCostClearingError(
          `The leftover changed since you looked (you saw ${formatTambala(expected)}, it is now ${formatTambala(balanceBefore)}). Nothing was settled; reload and review it.`
        );
      }
    }
    const plan = planSettlement(balanceBefore, { amount: params.amount, reason: params.reason });
    if (!plan.ok) throw new ServiceCostClearingError(plan.message);

    const cogsAccountId = await getSystemAccountId(tx, businessId, "COST_OF_GOODS_SOLD");
    const clearingAccountId = await getOrCreateSystemAccountId(tx, businessId, "SERVICE_COST_CLEARING");

    const settlement = await tx.serviceCostSettlement.create({
      data: {
        businessId,
        productId,
        direction: plan.direction,
        amount: plan.amount / 100,
        reason: params.reason.trim(),
        status: "RECORDED",
        createdById: userId,
      },
    });

    const entry = await postJournalEntry({
      tx,
      businessId,
      description: `Service cost settled – ${product.name}`,
      lines: settlementJournalLines(plan.direction, plan.amount, { cogsAccountId, clearingAccountId }),
      referenceType: "ServiceCostSettlement",
      referenceId: settlement.id,
      createdById: userId,
    });

    await logAudit({
      tx,
      businessId,
      userId,
      action: "service_cost.settle",
      entityType: "ServiceCostSettlement",
      entityId: settlement.id,
      metadata: {
        productId,
        productName: product.name,
        direction: plan.direction,
        amount: plan.amount / 100,
        balanceBefore: balanceBefore / 100,
        balanceAfter: plan.balanceAfter / 100,
        partial: plan.balanceAfter !== 0,
        reason: params.reason.trim(),
        journalEntryNumber: entry.entryNumber,
      },
    });

    return { settlement, balanceAfter: plan.balanceAfter };
  });
}

export interface BulkSettlementResultItem {
  productId: string;
  name: string;
  status: "SETTLED" | "SKIPPED";
  /** Kwacha settled (always positive) for SETTLED. */
  amount?: number;
  settlementId?: string;
  message?: string;
}

/**
 * Module 80: settles the whole leftover of several services with one shared reason. Each service goes through
 * settleServiceCost() on its own (own lock, own entry, own audit row, own void), so one refusing never stops the
 * others. Request-level problems throw before anything is posted; the result then lists every service.
 */
export async function settleManyServiceCosts(params: {
  businessId: string;
  userId: string;
  items: BulkSettlementRequestItem[];
  reason: string;
}): Promise<{ results: BulkSettlementResultItem[]; settledCount: number; skippedCount: number; totalSettled: number }> {
  const { businessId, userId } = params;
  const reason = params.reason.trim();

  const facts = await loadClearingFacts(prisma, businessId);
  const current = buildClearingReport(facts, 0).rows;
  const plan = planBulkSettlement(params.items, current, reason);
  if (!plan.ok) throw new ServiceCostClearingError(plan.message);

  const expectedById = new Map(params.items.map((i) => [i.productId, i.expectedBalance]));
  const results: BulkSettlementResultItem[] = [];
  for (const item of plan.items) {
    if (item.action === "SKIP") {
      results.push({ productId: item.productId, name: item.name, status: "SKIPPED", message: item.message });
      continue;
    }
    try {
      const done = await settleServiceCost({
        businessId,
        userId,
        productId: item.productId,
        amount: null,
        reason,
        expectedBalance: expectedById.get(item.productId) ?? null,
      });
      results.push({
        productId: item.productId,
        name: item.name,
        status: "SETTLED",
        amount: Number(done.settlement.amount),
        settlementId: done.settlement.id,
      });
    } catch (err) {
      if (err instanceof ServiceCostClearingError || err instanceof AccountingError) {
        results.push({ productId: item.productId, name: item.name, status: "SKIPPED", message: err.message });
      } else {
        // Unknown failure: this service is NOT settled (its own transaction rolled back), the rest carry on, and
        // the person is told. Logged so it is not lost.
        console.error("Bulk service cost settlement failed for", item.productId, err);
        results.push({ productId: item.productId, name: item.name, status: "SKIPPED", message: "Unexpected error; this service was not settled." });
      }
    }
  }

  const settled = results.filter((r) => r.status === "SETTLED");
  const totalSettled = settled.reduce((sum, r) => sum + toTambala(r.amount ?? 0), 0);
  // One summary row so the audit trail shows the bulk act as a whole. Each settlement still has its own row.
  await logAudit({
    businessId,
    userId,
    action: "service_cost.bulk_settle",
    entityType: "ServiceCostSettlement",
    entityId: settled[0]?.settlementId ?? "none",
    metadata: {
      reason,
      requested: results.length,
      settled: settled.length,
      skipped: results.length - settled.length,
      totalSettled: totalSettled / 100,
      settlementIds: settled.map((r) => r.settlementId),
      skippedServices: results.filter((r) => r.status === "SKIPPED").map((r) => ({ productId: r.productId, message: r.message })),
    },
  });

  return { results, settledCount: settled.length, skippedCount: results.length - settled.length, totalSettled: totalSettled / 100 };
}

/**
 * Voids a settlement: the entry is reversed (nothing deleted) and the row stays as history. A conditional write
 * claims the row first so two voids can't both post a reversal (the Module 38/41 rule).
 */
export async function voidServiceCostSettlement(params: { businessId: string; userId: string; settlementId: string; reason: string }) {
  const { businessId, userId, settlementId } = params;
  const reason = params.reason.trim();
  if (reason.length < 3) throw new ServiceCostClearingError("A reason is required to void a settlement.");

  const existing = await prisma.serviceCostSettlement.findFirst({ where: { id: settlementId, businessId } });
  if (!existing) throw new ServiceCostClearingError("Settlement not found.");
  if (existing.status !== "RECORDED") throw new ServiceCostClearingError("This settlement has already been voided.");

  return prisma.$transaction(async (tx) => {
    await tx.product.updateMany({ where: { id: existing.productId, businessId }, data: { updatedAt: new Date() } });

    const claimed = await tx.serviceCostSettlement.updateMany({
      where: { id: settlementId, businessId, status: "RECORDED" },
      data: { status: "VOIDED", voidedAt: new Date(), voidedById: userId, voidReason: reason },
    });
    if (claimed.count === 0) throw new ServiceCostClearingError("This settlement has already been voided.");

    const reversals = await reverseJournalEntriesForReference({
      tx,
      businessId,
      referenceType: "ServiceCostSettlement",
      referenceId: settlementId,
      createdById: userId,
      reason: `Service cost settlement voided – ${reason}`,
    });
    // A RECORDED settlement always has exactly one posted entry. Anything else means the ledger and the record
    // disagree: fail loudly and roll the claim back rather than mark it voided with nothing reversed.
    if (reversals.length !== 1) {
      throw new ServiceCostClearingError(`Expected one posted entry for this settlement but found ${reversals.length}; nothing was changed.`);
    }

    await logAudit({
      tx,
      businessId,
      userId,
      action: "service_cost.void_settlement",
      entityType: "ServiceCostSettlement",
      entityId: settlementId,
      metadata: {
        productId: existing.productId,
        direction: existing.direction,
        amount: Number(existing.amount),
        reason,
        reversalEntryNumber: reversals[0].entryNumber,
      },
    });

    return { id: settlementId };
  });
}
