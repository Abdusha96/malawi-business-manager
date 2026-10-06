/**
 * Module 79 - standalone checks for Service Cost Clearing (src/lib/service-cost-clearing.ts and
 * src/lib/service-cost-clearing-run.ts). No database:
 *   npx tsx scripts/verify-service-cost-clearing.ts   (npm run verify:service-cost-clearing)
 * Exits non-zero if any check fails.
 *
 * Part 1 checks the PURE module directly. Part 2 runs the real getServiceCostClearing(), settleServiceCost() and
 * voidServiceCostSettlement() against an in-memory fake. The fake cannot prove Postgres behaviour (the row lock,
 * READ COMMITTED), only the logic around it.
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
let reverseMode: "normal" | "none" = "normal";

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

async function main() {
  // ================================================================ Part 1: pure
  check("toTambala 12.34", pure.toTambala(12.34), 1234);
  check("toTambala 0.1+0.2 is 30", pure.toTambala(0.1 + 0.2), 30);
  check("toTambala null/NaN is 0", [pure.toTambala(null), pure.toTambala(NaN), pure.toTambala(undefined)], [0, 0, 0]);
  check("fromTambala", pure.fromTambala(1234), 12.34);
  check("formatTambala", [pure.formatTambala(123456), pure.formatTambala(-5), pure.formatTambala(0)], ["1,234.56", "-0.05", "0.00"]);

  check("balance: billed only is debit", pure.clearingBalance(facts({ billed: 50000 })), 50000);
  check("balance: sold only is credit", pure.clearingBalance(facts({ recognised: 30000 })), -30000);
  check("balance: bill less debit note less sold", pure.clearingBalance(facts({ billed: 100000, debited: 10000, recognised: 80000 })), 10000);
  check("balance: costUp lowers a debit balance", pure.clearingBalance(facts({ billed: 100000, recognised: 80000, costUp: 20000 })), 0);
  check("balance: costDown raises a credit balance", pure.clearingBalance(facts({ recognised: 80000, billed: 70000, costDown: 10000 })), 0);

  check("state zero", pure.classifyClearingBalance(0), "SETTLED");
  check("state debit", pure.classifyClearingBalance(1), "BILLED_NOT_SOLD");
  check("state credit", pure.classifyClearingBalance(-1), "SOLD_NOT_BILLED");
  check("state labels distinct", new Set(["SETTLED", "BILLED_NOT_SOLD", "SOLD_NOT_BILLED"].map((s) => pure.describeClearingState(s))).size, 3);

  // planSettlement
  const ok = (p: any) => (p.ok ? { d: p.direction, a: p.amount, after: p.balanceAfter } : p.message);
  check("plan: debit balance settles COST_UP in full", ok(pure.planSettlement(10000, { reason: "final" })), { d: "COST_UP", a: 10000, after: 0 });
  check("plan: credit balance settles COST_DOWN in full", ok(pure.planSettlement(-7550, { reason: "final" })), { d: "COST_DOWN", a: 7550, after: 0 });
  check("plan: part of a debit balance", ok(pure.planSettlement(10000, { amount: 25.5, reason: "x" })), { d: "COST_UP", a: 2550, after: 7450 });
  check("plan: part of a credit balance", ok(pure.planSettlement(-10000, { amount: 40, reason: "x" })), { d: "COST_DOWN", a: 4000, after: -6000 });
  check("plan: exactly the balance as a typed amount", ok(pure.planSettlement(10000, { amount: 100, reason: "x" })), { d: "COST_UP", a: 10000, after: 0 });
  check("plan: float-noise amount is accepted (0.1+0.2)", ok(pure.planSettlement(10000, { amount: 0.1 + 0.2, reason: "x" })), { d: "COST_UP", a: 30, after: 9970 });
  check("plan: reason trimmed-empty refused", pure.planSettlement(10000, { reason: "   " }).ok, false);
  check("plan: missing reason refused", pure.planSettlement(10000, {}).ok, false);
  check("plan: reason over 200 refused", pure.planSettlement(10000, { reason: "x".repeat(201) }).ok, false);
  check("plan: reason of 200 is fine", pure.planSettlement(10000, { reason: "x".repeat(200) }).ok, true);
  check("plan: zero balance has nothing to settle", ok(pure.planSettlement(0, { reason: "x" })), "This service has nothing left over to settle.");
  check("plan: zero amount refused", pure.planSettlement(10000, { amount: 0, reason: "x" }).ok, false);
  check("plan: negative amount refused", pure.planSettlement(10000, { amount: -5, reason: "x" }).ok, false);
  check("plan: three decimals refused", pure.planSettlement(10000, { amount: 1.005, reason: "x" }).ok, false);
  check("plan: NaN refused", pure.planSettlement(10000, { amount: NaN, reason: "x" }).ok, false);
  check("plan: more than the balance refused", pure.planSettlement(10000, { amount: 100.01, reason: "x" }).ok, false);
  check("plan: more than a credit balance refused (never flips sign)", pure.planSettlement(-10000, { amount: 150, reason: "x" }).ok, false);
  check("plan: fractional tambala balance refused", pure.planSettlement(10000.5, { reason: "x" }).ok, false);
  check("plan: null amount means all", ok(pure.planSettlement(500, { amount: null, reason: "x" })), { d: "COST_UP", a: 500, after: 0 });

  // journal lines
  const up = pure.settlementJournalLines("COST_UP", 2550, { cogsAccountId: "COGS", clearingAccountId: "CLR" });
  check("lines COST_UP: Dr COGS / Cr clearing", up.map((l: any) => `${l.accountId}:${l.debit ? "Dr" : "Cr"}:${l.debit ?? l.credit}`), ["COGS:Dr:25.5", "CLR:Cr:25.5"]);
  const down = pure.settlementJournalLines("COST_DOWN", 2550, { cogsAccountId: "COGS", clearingAccountId: "CLR" });
  check("lines COST_DOWN: Dr clearing / Cr COGS", down.map((l: any) => `${l.accountId}:${l.debit ? "Dr" : "Cr"}:${l.debit ?? l.credit}`), ["CLR:Dr:25.5", "COGS:Cr:25.5"]);
  check("lines balance", up.reduce((s: number, l: any) => s + (l.debit ?? 0) - (l.credit ?? 0), 0), 0);
  check("describeSettlement", [pure.describeSettlement("COST_UP", 1000), pure.describeSettlement("COST_DOWN", 1000)], ["Recognised 10.00 more cost", "Recognised 10.00 less cost"]);

  // report
  const rep = pure.buildClearingReport(
    [
      facts({ productId: "a", name: "Zeta", billed: 10000 }),
      facts({ productId: "b", name: "Alpha", recognised: 30000 }),
      facts({ productId: "c", name: "Idle" }),
      facts({ productId: "d", name: "Done", billed: 5000, recognised: 5000 }),
      facts({ productId: "e", name: "Beta", billed: 10000 }),
    ],
    10000 - 30000 + 0 + 10000
  );
  check("report: idle service dropped, settled-with-history kept", rep.rows.map((r: any) => r.name), ["Alpha", "Beta", "Zeta", "Done"]);
  check("report: largest absolute first, ties by name", rep.rows.map((r: any) => r.balance), [-30000, 10000, 10000, 0]);
  check("report: open count excludes the zero one", rep.openCount, 3);
  check("report: total of services", rep.productsTotal, -10000);
  check("report: ledger equal means nothing unattributed", [rep.unattributed, rep.unattributedKind, rep.unattributedNote], [0, "NONE", null]);
  const rounding = pure.buildClearingReport([facts({ billed: 10000 })], 10007);
  check("report: a few tambala is rounding", [rounding.unattributed, rounding.unattributedKind], [7, "ROUNDING"]);
  const roundingNeg = pure.buildClearingReport([facts({ billed: 10000 })], 9990);
  check("report: negative edge of rounding", [roundingNeg.unattributed, roundingNeg.unattributedKind], [-10, "ROUNDING"]);
  const review = pure.buildClearingReport([facts({ billed: 10000 })], 10011);
  check("report: 11 tambala needs review", [review.unattributed, review.unattributedKind], [11, "REVIEW"]);
  check("report: review note names the likely causes", /journal entry/.test(review.unattributedNote) && /became a service/.test(review.unattributedNote), true);
  const empty = pure.buildClearingReport([], 0);
  check("report: no services at all", [empty.rows.length, empty.openCount, empty.unattributedKind], [0, 0, "NONE"]);
  const emptyButLedger = pure.buildClearingReport([], 5000);
  check("report: ledger with no services is flagged", emptyButLedger.unattributedKind, "REVIEW");

  // ================================================================ Part 2: DB layer against the fake
  db.products.push(
    { id: "svc1", businessId: "b1", name: "Delivery", sku: "DLV", isStocked: false },
    { id: "svc2", businessId: "b1", name: "Installation", sku: null, isStocked: false },
    { id: "svc3", businessId: "b1", name: "Training", sku: null, isStocked: false },
    { id: "goods1", businessId: "b1", name: "Cement", sku: "CEM", isStocked: true },
    { id: "other", businessId: "b2", name: "Other business service", sku: null, isStocked: false }
  );
  // Delivery: billed 1,000.00 (+ a voided 400 bill that must not count), sold 3 x 200.00 = 600.00 plus a voided sale; debit note 100.00.
  db.purchaseItems.push(
    { productId: "svc1", total: 1000, purchase: { businessId: "b1", status: "PAID" } },
    { productId: "svc1", total: 400, purchase: { businessId: "b1", status: "VOIDED" } }
  );
  db.saleItems.push(
    { productId: "svc1", quantity: 1, unitCost: 200, sale: { businessId: "b1", status: "PAID" } },
    { productId: "svc1", quantity: 2, unitCost: 200, sale: { businessId: "b1", status: "CREDIT" } },
    { productId: "svc1", quantity: 5, unitCost: 200, sale: { businessId: "b1", status: "VOIDED" } }
  );
  db.debitLines.push({ productId: "svc1", businessId: "b1", net: 100 });
  // Installation: sold before the supplier billed it: 2 x 150.50 = 301.00 recognised, nothing billed.
  db.saleItems.push({ productId: "svc2", quantity: 2, unitCost: 150.5, sale: { businessId: "b1", status: "PAID" } });
  // Matching ledger: purchase Dr 1000, debit note Cr 100, sales Cr 600 + 301. Balance = 1000 - 100 - 600 - 301 = -1.00
  db.journal.push(
    { businessId: "b1", entryNumber: "JE-X1", referenceType: "PurchaseInventory", referenceId: "p1", lines: [{ accountId: "SERVICE_COST_CLEARING", debit: 1000 }, { accountId: "AP", credit: 1000 }] },
    { businessId: "b1", entryNumber: "JE-X2", referenceType: "DebitNote", referenceId: "d1", lines: [{ accountId: "AP", debit: 100 }, { accountId: "SERVICE_COST_CLEARING", credit: 100 }] },
    { businessId: "b1", entryNumber: "JE-X3", referenceType: "SaleCOGS", referenceId: "s1", lines: [{ accountId: "COST_OF_GOODS_SOLD", debit: 600 }, { accountId: "SERVICE_COST_CLEARING", credit: 600 }] },
    { businessId: "b1", entryNumber: "JE-X4", referenceType: "SaleCOGS", referenceId: "s2", lines: [{ accountId: "COST_OF_GOODS_SOLD", debit: 301 }, { accountId: "SERVICE_COST_CLEARING", credit: 301 }] },
    // another business's entry on its own account id must not leak into b1's ledger figure
    { businessId: "b2", entryNumber: "JE-Y1", referenceType: "PurchaseInventory", referenceId: "p9", lines: [{ accountId: "SERVICE_COST_CLEARING", debit: 777 }, { accountId: "AP", credit: 777 }] }
  );

  let r = await run.getServiceCostClearing("b1");
  const byName = (name: string) => r.report.rows.find((x: any) => x.name === name);
  check("db: only services of this business, stocked product and other business left out", r.report.rows.map((x: any) => x.name).sort(), ["Delivery", "Installation"]);
  check("db: Delivery facts (voided bill and sale ignored, debit note counted)", [byName("Delivery").billed, byName("Delivery").debited, byName("Delivery").recognised, byName("Delivery").balance], [100000, 10000, 60000, 30000]);
  check("db: Delivery state", byName("Delivery").state, "BILLED_NOT_SOLD");
  check("db: Installation recognised 301.00 and credit balance", [byName("Installation").recognised, byName("Installation").balance, byName("Installation").state], [30100, -30100, "SOLD_NOT_BILLED"]);
  check("db: ledger matches services exactly (other business's entry ignored)", [r.report.ledgerBalance, r.report.unattributed, r.report.unattributedKind], [30000 - 30100, 0, "NONE"]);
  check("db: no settlements yet", r.settlements.length, 0);

  const base = { businessId: "b1", userId: "u1" };
  await rejects("settle: unknown product", () => run.settleServiceCost({ ...base, productId: "nope", reason: "x" }), "Service not found");
  await rejects("settle: another business's service", () => run.settleServiceCost({ ...base, productId: "other", reason: "x" }), "Service not found");
  await rejects("settle: a stocked product", () => run.settleServiceCost({ ...base, productId: "goods1", reason: "x" }), "stocked product");
  await rejects("settle: nothing left over (Training never used)", () => run.settleServiceCost({ ...base, productId: "svc3", reason: "x" }), "nothing left over");
  await rejects("settle: reason required", () => run.settleServiceCost({ ...base, productId: "svc1", reason: " " }), "reason is required");
  await rejects("settle: more than the balance", () => run.settleServiceCost({ ...base, productId: "svc1", amount: 300.01, reason: "x" }), "more than what is left over");
  check("db: refusals wrote nothing", [db.settlements.length, db.journal.length, db.audit.length], [0, 5, 0]);

  // partial settlement of Delivery (debit balance 300.00): recognise 100.00 more cost
  const s1 = await run.settleServiceCost({ ...base, productId: "svc1", amount: 100, reason: "Part of the bill is final" });
  check("settle partial: balance after", s1.balanceAfter, 20000);
  check("settle partial: row", [s1.settlement.direction, s1.settlement.amount, s1.settlement.status, s1.settlement.reason], ["COST_UP", 100, "RECORDED", "Part of the bill is final"]);
  const e1 = db.journal[db.journal.length - 1];
  check("settle partial: entry shape", [e1.referenceType, e1.referenceId, e1.lines.map((l: any) => `${l.accountId}:${l.debit ? "Dr" : "Cr"}:${l.debit ?? l.credit}`)], ["ServiceCostSettlement", s1.settlement.id, ["COST_OF_GOODS_SOLD:Dr:100", "SERVICE_COST_CLEARING:Cr:100"]]);
  check("settle partial: audit", [db.audit[0].action, db.audit[0].metadata.balanceBefore, db.audit[0].metadata.balanceAfter, db.audit[0].metadata.partial], ["service_cost.settle", 300, 200, true]);

  r = await run.getServiceCostClearing("b1");
  check("db: balance after a part settlement", byNameOf(r, "Delivery").balance, 20000);
  check("db: settled column shows costUp", byNameOf(r, "Delivery").costUp, 10000);
  check("db: ledger still agrees after the settlement (Cr 100.00 more)", [r.report.ledgerBalance, r.report.unattributed], [-10100, 0]);

  // the rest
  const s2 = await run.settleServiceCost({ ...base, productId: "svc1", reason: "Supplier bill is final" });
  check("settle rest: full remaining balance", [s2.settlement.amount, s2.settlement.direction, s2.balanceAfter], [200, "COST_UP", 0]);
  await rejects("settle: nothing left after clearing", () => run.settleServiceCost({ ...base, productId: "svc1", reason: "again" }), "nothing left over");

  // credit balance -> COST_DOWN (Installation, credit 301.00)
  const s3 = await run.settleServiceCost({ ...base, productId: "svc2", reason: "Subcontractor never billed us" });
  const e3 = db.journal[db.journal.length - 1];
  check("settle credit: COST_DOWN of the full 301.00", [s3.settlement.direction, s3.settlement.amount, s3.balanceAfter], ["COST_DOWN", 301, 0]);
  check("settle credit: Dr clearing / Cr COGS", e3.lines.map((l: any) => `${l.accountId}:${l.debit ? "Dr" : "Cr"}:${l.debit ?? l.credit}`), ["SERVICE_COST_CLEARING:Dr:301", "COST_OF_GOODS_SOLD:Cr:301"]);

  r = await run.getServiceCostClearing("b1");
  check("db: everything settled, ledger back to zero and fully explained", [r.report.openCount, r.report.ledgerBalance, r.report.unattributed], [0, 0, 0]);
  check("db: settlements listed newest first", r.settlements.map((s: any) => s.productName), ["Installation", "Delivery", "Delivery"]);
  check("db: summary text", r.settlements[0].summary, "Recognised 301.00 less cost");

  // void s3: the credit balance comes back, ledger reversed
  await rejects("void: reason required", () => run.voidServiceCostSettlement({ ...base, settlementId: s3.settlement.id, reason: "x" }), "reason is required");
  await rejects("void: another business can't void it", () => run.voidServiceCostSettlement({ businessId: "b2", userId: "u9", settlementId: s3.settlement.id, reason: "not yours" }), "not found");
  await rejects("void: unknown id", () => run.voidServiceCostSettlement({ ...base, settlementId: "nope", reason: "no such" }), "not found");

  reverseMode = "none";
  const beforeFail = JSON.stringify([db.settlements, db.journal.length]);
  await rejects("void: ledger and record disagree -> refused", () => run.voidServiceCostSettlement({ ...base, settlementId: s3.settlement.id, reason: "ledger check" }), "Expected one posted entry");
  check("void: that refusal rolled the claim back", JSON.stringify([db.settlements, db.journal.length]), beforeFail);
  reverseMode = "normal";

  const v = await run.voidServiceCostSettlement({ ...base, settlementId: s3.settlement.id, reason: "Bill arrived after all" });
  check("void: ok", v.id, s3.settlement.id);
  const stored = db.settlements.find((s: any) => s.id === s3.settlement.id);
  check("void: row kept as history", [stored.status, stored.voidReason, stored.voidedById], ["VOIDED", "Bill arrived after all", "u1"]);
  const rev = db.journal[db.journal.length - 1];
  check("void: equal and opposite entry", [rev.referenceType, rev.lines.map((l: any) => `${l.accountId}:${l.debit ? "Dr" : "Cr"}:${l.debit ?? l.credit}`)], ["ServiceCostSettlementReversal", ["SERVICE_COST_CLEARING:Cr:301", "COST_OF_GOODS_SOLD:Dr:301"]]);
  check("void: audit row", db.audit[db.audit.length - 1].action, "service_cost.void_settlement");
  await rejects("void: twice refused", () => run.voidServiceCostSettlement({ ...base, settlementId: s3.settlement.id, reason: "again please" }), "already been voided");

  r = await run.getServiceCostClearing("b1");
  check("void: Installation is open again with its credit balance", [byNameOf(r, "Installation").balance, byNameOf(r, "Installation").state], [-30100, "SOLD_NOT_BILLED"]);
  check("void: ledger agrees again", r.report.unattributed, 0);
  check("void: the voided row still lists, flagged", r.settlements.find((s: any) => s.id === s3.settlement.id).status, "VOIDED");

  // settle again after a void works and can't double count the voided one
  const s4 = await run.settleServiceCost({ ...base, productId: "svc2", amount: 100.5, reason: "Part settle after void" });
  check("settle after void: only recorded settlements count", [s4.settlement.direction, s4.balanceAfter], ["COST_DOWN", -20050]);

  // an entry posted straight to the account is surfaced, not hidden
  db.journal.push({ businessId: "b1", entryNumber: "JE-M1", referenceType: "ManualJournal", referenceId: "mj1", lines: [{ accountId: "SERVICE_COST_CLEARING", debit: 50 }, { accountId: "OTHER", credit: 50 }] });
  r = await run.getServiceCostClearing("b1");
  check("db: a manual posting to the account shows as unattributed REVIEW", [r.report.unattributed, r.report.unattributedKind], [5000, "REVIEW"]);

  Module._load = realLoad;
  console.log(`${total - failed}/${total} checks passed`);
  if (failed > 0) process.exit(1);
}

function byNameOf(r: any, name: string) {
  return r.report.rows.find((x: any) => x.name === name);
}

main().catch((e) => { console.error(e); process.exit(1); });
