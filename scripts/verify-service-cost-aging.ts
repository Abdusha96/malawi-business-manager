/**
 * Module 80 - standalone checks for Service Cost Clearing ageing and bulk settlement (the Module 80 additions to
 * src/lib/service-cost-clearing.ts and src/lib/service-cost-clearing-run.ts). No database:
 *   npx tsx scripts/verify-service-cost-aging.ts   (npm run verify:service-cost-aging)
 * Exits non-zero if any check fails.
 *
 * Part 1 checks the PURE additions. Part 2 runs the real getServiceCostClearing(), getAgedServiceCostSummary(),
 * settleServiceCost() (with expectedBalance) and settleManyServiceCosts() against an in-memory fake. The fake
 * cannot prove Postgres behaviour (the row lock), only the logic around it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
// Makes this file a module so its top-level names do not collide with the other standalone scripts.
export {};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require("module");

let failed = 0, total = 0;
function check(name: string, actual: unknown, expected: unknown) {
  total++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}
async function rejects(name: string, fn: () => Promise<unknown>, contains: string) {
  total++;
  try {
    await fn();
    failed++;
    console.error(`FAIL ${name}\n  expected a refusal containing "${contains}", but it succeeded`);
  } catch (err: any) {
    if (!String(err?.message ?? err).includes(contains)) {
      failed++;
      console.error(`FAIL ${name}\n  expected a refusal containing "${contains}"\n  actual   "${err?.message ?? err}"`);
    }
  }
}

// ------------------------------------------------------------------ fake DB
const db: any = {
  products: [],
  saleItems: [],
  purchaseItems: [],
  debitLines: [],
  settlements: [],
  journal: [],
  accounts: [{ id: "SERVICE_COST_CLEARING", businessId: "b1", systemKey: "SERVICE_COST_CLEARING" }],
  audit: [],
  seq: 0,
};
let reverseMode = "normal" as "normal" | "none";

const productApi = {
  async findMany({ where }: any) {
    return db.products
      .filter((p: any) => p.businessId === where.businessId && (where.id ? p.id === where.id : true) && (where.isStocked === undefined || p.isStocked === where.isStocked))
      .sort((a: any, b: any) => a.name.localeCompare(b.name))
      .map((p: any) => ({ id: p.id, name: p.name, sku: p.sku ?? null }));
  },
  async findFirst({ where }: any) {
    const p = db.products.find((x: any) => x.id === where.id && x.businessId === where.businessId);
    return p ? { id: p.id, name: p.name, isStocked: p.isStocked } : null;
  },
  async updateMany({ where }: any) {
    return { count: db.products.filter((p: any) => p.id === where.id && p.businessId === where.businessId).length };
  },
  async count({ where }: any) {
    return db.products.filter((p: any) => p.businessId === where.businessId && (where.isStocked === undefined || p.isStocked === where.isStocked)).length;
  },
};
const businessApi = {
  async findUniqueOrThrow({ where }: any) {
    return { serviceCostAlertDays: db.alertDays ?? 30, id: where.id };
  },
};
const saleItemApi = {
  async findMany({ where }: any) {
    return db.saleItems
      .filter((i: any) => where.productId.in.includes(i.productId) && i.sale.businessId === where.sale.businessId && i.sale.status !== "VOIDED")
      .map((i: any) => ({ productId: i.productId, quantity: i.quantity, unitCost: i.unitCost, sale: { saleDate: new Date(i.sale.saleDate ?? Date.now()) } }));
  },
};
const purchaseItemApi = {
  async findMany({ where }: any) {
    return db.purchaseItems
      .filter((i: any) => where.productId.in.includes(i.productId) && i.purchase.businessId === where.purchase.businessId && i.purchase.status !== "VOIDED")
      .map((i: any) => ({ productId: i.productId, total: i.total, purchase: { purchaseDate: new Date(i.purchase.purchaseDate ?? Date.now()) } }));
  },
};
const debitLineApi = {
  async findMany({ where }: any) {
    return db.debitLines
      .filter((l: any) => where.purchaseItem.productId.in.includes(l.productId) && l.businessId === where.debitNote.businessId)
      .map((l: any) => ({ net: l.net, purchaseItem: { productId: l.productId }, debitNote: { issuedAt: new Date(l.issuedAt ?? Date.now()) } }));
  },
};
const settlementApi = {
  async findMany({ where, take, include }: any) {
    let rows = db.settlements.filter((s: any) => s.businessId === where.businessId);
    if (where.productId) rows = rows.filter((s: any) => where.productId.in.includes(s.productId));
    if (where.status) rows = rows.filter((s: any) => s.status === where.status);
    rows = [...rows].reverse();
    if (take) rows = rows.slice(0, take);
    return rows.map((s: any) => (include ? { ...s, createdAt: new Date(s.createdAt), voidedAt: s.voidedAt ? new Date(s.voidedAt) : null, product: { name: db.products.find((p: any) => p.id === s.productId).name } } : { ...s, createdAt: new Date(s.createdAt) }));
  },
  async findFirst({ where }: any) {
    const s = db.settlements.find((x: any) => x.id === where.id && x.businessId === where.businessId);
    return s ? { ...s } : null;
  },
  async create({ data }: any) {
    const row = { id: `set_${++db.seq}`, voidedAt: null, voidedById: null, voidReason: null, createdAt: new Date().toISOString(), ...data };
    db.settlements.push(row);
    return { ...row };
  },
  async updateMany({ where, data }: any) {
    const rows = db.settlements.filter((s: any) => s.id === where.id && s.businessId === where.businessId && s.status === where.status);
    rows.forEach((s: any) => Object.assign(s, data));
    return { count: rows.length };
  },
};
const accountApi = {
  async findFirst({ where }: any) {
    const a = db.accounts.find((x: any) => x.businessId === where.businessId && x.systemKey === where.systemKey);
    return a ? { id: a.id } : null;
  },
};
const journalLineApi = {
  async aggregate({ where }: any) {
    let debit = 0, credit = 0;
    for (const e of db.journal) {
      if (e.businessId !== where.journalEntry.businessId) continue;
      for (const l of e.lines) if (l.accountId === where.accountId) { debit += l.debit ?? 0; credit += l.credit ?? 0; }
    }
    return { _sum: { debit, credit } };
  },
};
const fakeTx: any = {
  business: businessApi,
  product: productApi,
  saleItem: saleItemApi,
  purchaseItem: purchaseItemApi,
  supplierDebitNoteLine: debitLineApi,
  serviceCostSettlement: settlementApi,
  account: accountApi,
  journalLine: journalLineApi,
};
const fakePrisma: any = {
  ...fakeTx,
  async $transaction(fn: (tx: any) => Promise<any>) {
    const snapshot = JSON.stringify(db);
    try { return await fn(fakeTx); } catch (err) { Object.assign(db, JSON.parse(snapshot)); throw err; }
  },
};
const realLoad = Module._load;
Module._load = function (request: string, parent: any, isMain: boolean) {
  if (request === "./prisma") return { prisma: fakePrisma };
  if (request === "./audit") return { logAudit: async (a: any) => { db.audit.push({ action: a.action, entityId: a.entityId, metadata: a.metadata }); } };
  if (request === "./accounting") {
    const post = async (e: any) => {
      const debit = e.lines.reduce((s: number, l: any) => s + Math.round((l.debit ?? 0) * 100), 0);
      const credit = e.lines.reduce((s: number, l: any) => s + Math.round((l.credit ?? 0) * 100), 0);
      if (debit !== credit) throw new Error("unbalanced");
      const entry = { businessId: e.businessId, entryNumber: `JE-${db.journal.length + 1}`, referenceType: e.referenceType, referenceId: e.referenceId, description: e.description, lines: e.lines };
      db.journal.push(entry);
      return entry;
    };
    return {
      AccountingError: class AccountingError extends Error {},
      postJournalEntry: post,
      getSystemAccountId: async (_tx: any, _b: string, key: string) => key,
      getOrCreateSystemAccountId: async (_tx: any, _b: string, key: string) => key,
      reverseJournalEntriesForReference: async (p: any) => {
        if (reverseMode === "none") return [];
        const found = db.journal.filter((e: any) => e.businessId === p.businessId && e.referenceType === p.referenceType && e.referenceId === p.referenceId);
        const out = [];
        for (const e of found) {
          out.push(await post({ businessId: p.businessId, description: p.reason, referenceType: `${p.referenceType}Reversal`, referenceId: p.referenceId, lines: e.lines.map((l: any) => ({ accountId: l.accountId, debit: l.credit || undefined, credit: l.debit || undefined })) }));
        }
        return out;
      },
    };
  }
  return realLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pure = require("../src/lib/service-cost-clearing");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const run = require("../src/lib/service-cost-clearing-run");

function facts(over: Partial<any> = {}) {
  return { productId: "p", name: "Svc", sku: null, billed: 0, debited: 0, recognised: 0, costUp: 0, costDown: 0, ...over };
}

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0); // fixed clock: 2 Oct 2026 12:00 UTC

async function main() {
  // ================================================================ Part 1: pure ageing
  check("age: exactly 30 days", pure.balanceAgeDays(NOW - 30 * DAY, NOW), 30);
  check("age: 29.99 days floors to 29", pure.balanceAgeDays(NOW - 30 * DAY + 1000, NOW), 29);
  check("age: same instant is 0", pure.balanceAgeDays(NOW, NOW), 0);
  check("age: future date is 0, never negative", pure.balanceAgeDays(NOW + 5 * DAY, NOW), 0);
  check("age: unknown is null (not 0)", [pure.balanceAgeDays(null, NOW), pure.balanceAgeDays(undefined, NOW), pure.balanceAgeDays(NaN, NOW), pure.balanceAgeDays(1, NaN)], [null, null, null, null]);

  check("aged: needs the days", pure.isAgedBalance(10000, 29, 30), false);
  check("aged: at the threshold counts", pure.isAgedBalance(10000, 30, 30), true);
  check("aged: credit side counts too", pure.isAgedBalance(-10000, 90, 30), true);
  check("aged: under K1.00 is dust", [pure.isAgedBalance(99, 400, 30), pure.isAgedBalance(-99, 400, 30), pure.isAgedBalance(100, 400, 30)], [false, false, true]);
  check("aged: zero balance never", pure.isAgedBalance(0, 400, 30), false);
  check("aged: unknown age never", pure.isAgedBalance(10000, null, 30), false);
  check("aged: bad threshold never", [pure.isAgedBalance(10000, 400, 0), pure.isAgedBalance(10000, 400, 1.5), pure.isAgedBalance(10000, 400, NaN)], [false, false, false]);
  check("bounds", [pure.DEFAULT_SERVICE_COST_ALERT_DAYS, pure.MIN_SERVICE_COST_ALERT_DAYS, pure.MAX_SERVICE_COST_ALERT_DAYS, pure.MIN_ALERT_BALANCE_TAMBALA], [30, 7, 365, 100]);

  const clock = { alertDays: 30, nowMs: NOW };
  const rep = pure.buildClearingReport(
    [
      facts({ productId: "old", name: "Old job", billed: 50000, lastActivityMs: NOW - 45 * DAY }),
      facts({ productId: "new", name: "New job", billed: 50000, lastActivityMs: NOW - 2 * DAY }),
      facts({ productId: "dust", name: "Dust", billed: 50, lastActivityMs: NOW - 300 * DAY }),
      facts({ productId: "unk", name: "No date", billed: 50000 }),
      facts({ productId: "done", name: "Done", billed: 5000, recognised: 5000, lastActivityMs: NOW - 300 * DAY }),
      facts({ productId: "cr", name: "Sold unbilled", recognised: 20000, lastActivityMs: NOW - 70 * DAY }),
    ],
    0,
    clock
  );
  const row = (id: string) => rep.rows.find((r: any) => r.productId === id);
  check("report: old debit leftover is aged", [row("old").ageDays, row("old").aged], [45, true]);
  check("report: recent leftover is not aged", [row("new").ageDays, row("new").aged], [2, false]);
  check("report: dust leftover is old but not aged", [row("dust").ageDays, row("dust").aged], [300, false]);
  check("report: unknown date is not aged", [row("unk").ageDays, row("unk").aged], [null, false]);
  check("report: settled service is not aged", row("done").aged, false);
  check("report: credit leftover can be aged", [row("cr").ageDays, row("cr").aged], [70, true]);
  check("report: agedCount", rep.agedCount, 2);
  const noClock = pure.buildClearingReport([facts({ billed: 50000, lastActivityMs: NOW - 400 * DAY })], 0);
  check("report without a clock (Module 79 callers): no age, nothing aged", [noClock.rows[0].ageDays, noClock.rows[0].aged, noClock.agedCount], [null, false, 0]);

  const sum = pure.summariseAgedBalances(rep.rows, 30);
  check("summary: counts, oldest, total", [sum.count, sum.oldestDays, sum.oldestName, sum.totalAbs], [2, 70, "Sold unbilled", 70000]);
  check("summary: 70 days is over 2x30, so URGENT", sum.severity, "URGENT");
  const sum2 = pure.summariseAgedBalances(rep.rows.filter((r: any) => r.productId === "old"), 30);
  check("summary: 45 days is WARNING", sum2.severity, "WARNING");
  const sum3 = pure.summariseAgedBalances(rep.rows.filter((r: any) => r.productId === "old"), 20);
  check("summary: exactly 2x threshold is URGENT (alertDays 20 -> 40, age 45)", sum3.severity, "URGENT");
  check("summary: nothing aged is null", pure.summariseAgedBalances(rep.rows.filter((r: any) => r.productId === "new"), 30), null);
  check("summary: empty is null", pure.summariseAgedBalances([], 30), null);

  // ================================================================ Part 1: bulk plan
  const cur = pure.buildClearingReport(
    [
      facts({ productId: "a", name: "Alpha", billed: 10000 }),
      facts({ productId: "b", name: "Beta", recognised: 25050 }),
      facts({ productId: "z", name: "Zero", billed: 100, recognised: 100 }),
    ],
    0
  ).rows;
  const plan = pure.planBulkSettlement([{ productId: "a", expectedBalance: 100 }, { productId: "b", expectedBalance: -250.5 }], cur, "Bills final");
  check("bulk plan: both settle", plan.ok && plan.items.map((i: any) => [i.productId, i.action, i.balance]), [["a", "SETTLE", 10000], ["b", "SETTLE", -25050]]);
  const pl2 = pure.planBulkSettlement([{ productId: "a", expectedBalance: 99 }], cur, "x");
  check("bulk plan: moved balance skipped, message shows both figures", [pl2.items[0].action, /you saw 99\.00, it is now 100\.00/.test(pl2.items[0].message)], ["SKIP", true]);
  const pl3 = pure.planBulkSettlement([{ productId: "z", expectedBalance: 0 }, { productId: "nope", expectedBalance: 5 }], cur, "x");
  check("bulk plan: zero balance and unknown service skipped", pl3.items.map((i: any) => i.action), ["SKIP", "SKIP"]);
  check("bulk plan: sign matters (saw debit, now credit)", pure.planBulkSettlement([{ productId: "b", expectedBalance: 250.5 }], cur, "x").items[0].action, "SKIP");
  check("bulk plan: float noise on a typed amount is fine (0.1+0.2)", pure.planBulkSettlement([{ productId: "a", expectedBalance: 100.0000000001 }], cur, "x").ok, true);
  check("bulk plan: no reason refused", pure.planBulkSettlement([{ productId: "a", expectedBalance: 100 }], cur, "  ").ok, false);
  check("bulk plan: reason too long refused", pure.planBulkSettlement([{ productId: "a", expectedBalance: 100 }], cur, "x".repeat(201)).ok, false);
  check("bulk plan: empty list refused", pure.planBulkSettlement([], cur, "x").ok, false);
  check("bulk plan: duplicate service refused", pure.planBulkSettlement([{ productId: "a", expectedBalance: 100 }, { productId: "a", expectedBalance: 100 }], cur, "x").ok, false);
  check("bulk plan: NaN expected refused", pure.planBulkSettlement([{ productId: "a", expectedBalance: NaN }], cur, "x").ok, false);
  check("bulk plan: three decimals refused", pure.planBulkSettlement([{ productId: "a", expectedBalance: 100.005 }], cur, "x").ok, false);
  const many = Array.from({ length: 201 }, (_, i) => ({ productId: `p${i}`, expectedBalance: 1 }));
  check("bulk plan: more than 200 refused", pure.planBulkSettlement(many, cur, "x").ok, false);
  check("bulk plan: exactly 200 allowed", pure.planBulkSettlement(many.slice(0, 200), cur, "x").ok, true);

  // ================================================================ Part 2: DB layer against the fake
  db.products.push(
    { id: "svc1", businessId: "b1", name: "Delivery", sku: "DLV", isStocked: false },
    { id: "svc2", businessId: "b1", name: "Installation", sku: null, isStocked: false },
    { id: "svc3", businessId: "b1", name: "Training", sku: null, isStocked: false },
    { id: "svc4", businessId: "b1", name: "Consulting", sku: null, isStocked: false },
    { id: "goods1", businessId: "b1", name: "Cement", sku: "CEM", isStocked: true },
    { id: "other", businessId: "b2", name: "Other business service", sku: null, isStocked: false }
  );
  const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();
  // Delivery: billed 1,000 at 60 days ago, sold 400 cost at 50 days ago, a debit note 20 days ago. Newest touch = 20 days.
  db.purchaseItems.push({ productId: "svc1", total: 1000, purchase: { businessId: "b1", status: "PAID", purchaseDate: iso(60) } });
  db.saleItems.push({ productId: "svc1", quantity: 2, unitCost: 200, sale: { businessId: "b1", status: "PAID", saleDate: iso(50) } });
  db.debitLines.push({ productId: "svc1", businessId: "b1", net: 100, issuedAt: iso(20) });
  // Installation: sold 100 cost 90 days ago, plus a VOIDED sale 1 day ago that must not reset the age.
  db.saleItems.push(
    { productId: "svc2", quantity: 1, unitCost: 100, sale: { businessId: "b1", status: "PAID", saleDate: iso(90) } },
    { productId: "svc2", quantity: 1, unitCost: 100, sale: { businessId: "b1", status: "VOIDED", saleDate: iso(1) } }
  );
  // Training: billed 500 only 3 days ago (recent).
  db.purchaseItems.push({ productId: "svc3", total: 500, purchase: { businessId: "b1", status: "PAID", purchaseDate: iso(3) } });
  // Consulting: billed 0.50 400 days ago (dust).
  db.purchaseItems.push({ productId: "svc4", total: 0.5, purchase: { businessId: "b1", status: "PAID", purchaseDate: iso(400) } });
  // other business: old and big, must never show for b1
  db.purchaseItems.push({ productId: "other", total: 9999, purchase: { businessId: "b2", status: "PAID", purchaseDate: iso(500) } });

  const t0 = Date.now();
  let got = await run.getServiceCostClearing("b1", t0);
  const g = (id: string) => got.report.rows.find((r: any) => r.productId === id);
  check("db: alertDays comes from the business (default 30)", got.alertDays, 30);
  check("db: age is days since the NEWEST touch (debit note 20d, not bill 60d)", g("svc1").ageDays, 20);
  check("db: Delivery is below threshold so not aged", g("svc1").aged, false);
  check("db: voided sale does not reset the age", g("svc2").ageDays, 90);
  check("db: Installation aged (credit leftover)", [g("svc2").aged, g("svc2").balance], [true, -10000]);
  check("db: recent bill is not aged", [g("svc3").ageDays, g("svc3").aged], [3, false]);
  check("db: dust is not aged", [g("svc4").ageDays, g("svc4").aged, g("svc4").balance], [400, false, 50]);
  check("db: other business not present", got.report.rows.some((r: any) => r.productId === "other"), false);
  check("db: agedCount", got.report.agedCount, 1);

  let aged = await run.getAgedServiceCostSummary("b1", t0);
  check("alert summary: one aged service, 90 days, WARNING (<= 2x? 90 >= 60 so URGENT)", [aged.count, aged.oldestDays, aged.oldestName, aged.severity], [1, 90, "Installation", "URGENT"]);
  db.alertDays = 60;
  aged = await run.getAgedServiceCostSummary("b1", t0);
  check("alert summary: threshold 60 -> still aged at 90 days, WARNING (90 < 120)", [aged.count, aged.severity], [1, "WARNING"]);
  db.alertDays = 120;
  check("alert summary: threshold 120 -> nothing aged -> null", await run.getAgedServiceCostSummary("b1", t0), null);
  db.alertDays = 30;
  check("alert summary: business with no service products is null without loading facts", await run.getAgedServiceCostSummary("b3", t0), null);

  // ---- expectedBalance on a single settle
  await rejects("single: stale expectedBalance refused", () => run.settleServiceCost({ businessId: "b1", userId: "u1", productId: "svc3", reason: "final", expectedBalance: 400 }), "changed since you looked");
  check("single: refusal wrote nothing", [db.settlements.length, db.journal.length], [0, 0]);
  const one = await run.settleServiceCost({ businessId: "b1", userId: "u1", productId: "svc3", reason: "final", expectedBalance: 500 });
  check("single: matching expectedBalance settles", [one.balanceAfter, db.settlements.length], [0, 1]);
  const no = await run.settleServiceCost({ businessId: "b1", userId: "u1", productId: "svc4", reason: "dust", amount: 0.5 });
  check("single: Module 79 behaviour unchanged without expectedBalance", [no.balanceAfter, db.settlements.length], [0, 2]);
  got = await run.getServiceCostClearing("b1", Date.now());
  check("db: a settlement counts as activity (age resets to 0)", [got.report.rows.find((r: any) => r.productId === "svc3").ageDays], [0]);

  // ---- bulk
  db.settlements.length = 0; db.journal.length = 0; db.audit.length = 0;
  // Put svc3 and svc4 back into leftover by voiding nothing: simply rebuild fresh purchases for two new services.
  db.products.push({ id: "svc5", businessId: "b1", name: "Alignment", sku: null, isStocked: false }, { id: "svc6", businessId: "b1", name: "Binding", sku: null, isStocked: false });
  db.purchaseItems.push(
    { productId: "svc5", total: 300, purchase: { businessId: "b1", status: "PAID", purchaseDate: iso(40) } },
    { productId: "svc6", total: 200, purchase: { businessId: "b1", status: "PAID", purchaseDate: iso(40) } }
  );
  // svc3/svc4 were settled earlier in the test via settlements that we just cleared, so their leftover is back.
  const res = await run.settleManyServiceCosts({
    businessId: "b1",
    userId: "u1",
    reason: "Bills are final",
    items: [
      { productId: "svc2", expectedBalance: -100 },
      { productId: "svc5", expectedBalance: 300 },
      { productId: "svc6", expectedBalance: 199 }, // stale: saw 199, real 200
      { productId: "goods1", expectedBalance: 1 }, // stocked product: not a service
      { productId: "ghost", expectedBalance: 1 },
    ],
  });
  check("bulk: counts", [res.settledCount, res.skippedCount, res.results.length], [2, 3, 5]);
  check("bulk: statuses in request order", res.results.map((r: any) => `${r.productId}:${r.status}`), ["svc2:SETTLED", "svc5:SETTLED", "svc6:SKIPPED", "goods1:SKIPPED", "ghost:SKIPPED"]);
  check("bulk: total settled is the sum of absolute leftovers", res.totalSettled, 400);
  check("bulk: stale one skipped with the reason", /you saw 199\.00, it is now 200\.00/.test(res.results[2].message), true);
  check("bulk: one settlement + one journal entry per settled service", [db.settlements.length, db.journal.length], [2, 2]);
  check("bulk: directions derived (credit leftover COST_DOWN, debit COST_UP)", db.settlements.map((s: any) => [s.productId, s.direction, s.amount]), [["svc2", "COST_DOWN", 100], ["svc5", "COST_UP", 300]]);
  check("bulk: every settlement keeps the shared reason", db.settlements.every((s: any) => s.reason === "Bills are final"), true);
  const bulkAudit = db.audit.filter((a: any) => a.action === "service_cost.bulk_settle");
  check("bulk: one summary audit row plus one per settlement", [bulkAudit.length, db.audit.filter((a: any) => a.action === "service_cost.settle").length], [1, 2]);
  check("bulk: summary audit metadata", [bulkAudit[0].metadata.settled, bulkAudit[0].metadata.skipped, bulkAudit[0].metadata.totalSettled, bulkAudit[0].metadata.skippedServices.length], [2, 3, 400, 3]);

  got = await run.getServiceCostClearing("b1", Date.now());
  const after = (id: string) => got.report.rows.find((r: any) => r.productId === id);
  check("bulk: settled services now at zero, the skipped one untouched", [after("svc2").balance, after("svc5").balance, after("svc6").balance], [0, 0, 20000]);

  // a settled-by-bulk service can be voided on its own
  await run.voidServiceCostSettlement({ businessId: "b1", userId: "u1", settlementId: db.settlements[1].id, reason: "wrong one" });
  got = await run.getServiceCostClearing("b1", Date.now());
  check("bulk: voiding one settlement restores only that service", [got.report.rows.find((r: any) => r.productId === "svc5").balance, got.report.rows.find((r: any) => r.productId === "svc2").balance], [30000, 0]);

  // bulk refusals at request level post nothing
  const before = [db.settlements.length, db.journal.length, db.audit.length];
  await rejects("bulk: no reason", () => run.settleManyServiceCosts({ businessId: "b1", userId: "u1", reason: "  ", items: [{ productId: "svc6", expectedBalance: 200 }] }), "reason is required");
  await rejects("bulk: empty selection", () => run.settleManyServiceCosts({ businessId: "b1", userId: "u1", reason: "x", items: [] }), "at least one");
  await rejects("bulk: duplicate", () => run.settleManyServiceCosts({ businessId: "b1", userId: "u1", reason: "x", items: [{ productId: "svc6", expectedBalance: 200 }, { productId: "svc6", expectedBalance: 200 }] }), "twice");
  check("bulk: request-level refusals write nothing (no settlement, entry or audit row)", [db.settlements.length, db.journal.length, db.audit.length], before);

  // other business cannot be settled through bulk
  const cross = await run.settleManyServiceCosts({ businessId: "b1", userId: "u1", reason: "x", items: [{ productId: "other", expectedBalance: 9999 }] });
  check("bulk: another business's service is skipped as not found", [cross.settledCount, cross.results[0].status], [0, "SKIPPED"]);

  // one failing service must not stop the rest: make the journal throw for exactly one posting
  const realPush = db.journal.push.bind(db.journal);
  let boom = true;
  db.journal.push = (...args: any[]) => { if (boom && args[0].description?.includes("Binding")) { boom = false; throw new Error("disk full"); } return realPush(...args); };
  db.purchaseItems.push({ productId: "svc1", total: 100, purchase: { businessId: "b1", status: "PAID", purchaseDate: iso(1) } });
  got = await run.getServiceCostClearing("b1", Date.now());
  const svc1Bal = got.report.rows.find((r: any) => r.productId === "svc1").balance / 100;
  const origError = console.error; console.error = () => {};
  const mixed = await run.settleManyServiceCosts({ businessId: "b1", userId: "u1", reason: "x", items: [{ productId: "svc6", expectedBalance: 200 }, { productId: "svc1", expectedBalance: svc1Bal }] });
  console.error = origError;
  check("bulk: an unexpected failure on one service is reported and the next still settles", mixed.results.map((r: any) => `${r.productId}:${r.status}`), ["svc6:SKIPPED", "svc1:SETTLED"]);
  check("bulk: unexpected failure message is generic", mixed.results[0].message, "Unexpected error; this service was not settled.");
  check("bulk: the failed service left no half-written settlement", db.settlements.filter((s: any) => s.productId === "svc6").length, 0);
  db.journal.push = realPush;

  if (failed > 0) {
    console.error(`${failed}/${total} checks FAILED`);
    process.exit(1);
  }
  console.log(`${total}/${total} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
