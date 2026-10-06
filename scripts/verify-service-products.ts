/**
 * Module 77 - standalone checks for non-stocked (service) products and the converted-quotation refresh
 * (src/lib/product-kind.ts, src/lib/quotation-refresh.ts, and the changes to recordInventoryMovement() in
 * src/lib/inventory.ts and convertQuotationToSale() in src/lib/quotations.ts). No database:
 *   npx tsx scripts/verify-service-products.ts   (npm run verify:service-products)
 * Exits non-zero if any check fails.
 *
 * Parts 1 and 2 check the PURE modules directly. Part 3 runs the real recordInventoryMovement() against an
 * in-memory fake. Part 4 runs the real convertQuotationToSale() against an in-memory fake. Neither fake can
 * prove Postgres behaviour.
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

// ------------------------------------------------------------------ fake DB
const db: any = { products: [], movements: [], levels: [], quotations: [], sales: [] };
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const c = v as any;
      if ("in" in c) return c.in.includes(row[k]);
      if ("notIn" in c) return !c.notIn.includes(row[k]);
    }
    return row[k] === v;
  });
}
const productApi = {
  async findUniqueOrThrow({ where }: any) {
    const p = db.products.find((x: any) => x.id === where.id);
    if (!p) throw new Error("not found");
    return { ...p };
  },
  async findMany({ where }: any) { return db.products.filter((p: any) => matches(p, where)).map((p: any) => ({ ...p })); },
  async update({ where, data }: any) { const p = db.products.find((x: any) => x.id === where.id); Object.assign(p, data); return { ...p }; },
};
const levelApi = {
  async findUnique() { return null; },
  async upsert({ create, update }: any) { db.levels.push(create ?? update); },
};
const movementApi = { async create({ data }: any) { db.movements.push(data); } };
const quotationApi = {
  async updateMany({ where, data }: any) {
    const rows = db.quotations.filter((q: any) => matches(q, where));
    rows.forEach((q: any) => Object.assign(q, data));
    return { count: rows.length };
  },
  async findUnique({ where }: any) { const q = db.quotations.find((x: any) => x.id === where.id); return q ? { ...q } : null; },
  async findUniqueOrThrow({ where }: any) {
    const q = db.quotations.find((x: any) => x.id === where.id);
    if (!q) throw new Error("not found");
    return { ...q, items: q.items.map((i: any) => ({ ...i })) };
  },
  async update({ where, data }: any) { const q = db.quotations.find((x: any) => x.id === where.id); Object.assign(q, data); return { ...q }; },
};
const itemApi = {
  async update({ where, data }: any) {
    for (const q of db.quotations) { const it = q.items.find((x: any) => x.id === where.id); if (it) Object.assign(it, data); }
  },
};
const fakePrisma: any = {
  product: productApi,
  async $transaction(fn: (tx: any) => Promise<any>) {
    const snapshot = JSON.stringify(db);
    const tx = { product: productApi, stockLevel: levelApi, inventoryMovement: movementApi, quotation: quotationApi, quotationItem: itemApi };
    try { return await fn(tx); } catch (err) { Object.assign(db, JSON.parse(snapshot)); throw err; }
  },
};
class FakeSaleValidationError extends Error {}
async function fakeCreateSale() { const sale = { id: `sale_${db.sales.length + 1}` }; db.sales.push(sale); return sale; }
const journal: any[] = [];
let vatCfg = { vatRegistered: true, vatRate: 16.5 };
const realLoad = Module._load;
Module._load = function (request: string, parent: any, isMain: boolean) {
  if (request === "./prisma") return { prisma: fakePrisma };
  if (request === "./audit") return { logAudit: async () => undefined };
  if (request === "./sales") return { createSale: fakeCreateSale, SaleValidationError: FakeSaleValidationError };
  if (request === "./vat") {
    // Mirrors computeLineVat()/computeVatForLines() in src/lib/vat.ts (the real file pulls in the whole app).
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      getVatConfig: async () => ({ ...vatCfg }),
      computeVatForLines: (lines: any[], cfg: any) => {
        const vatAmounts = lines.map((l) => (!cfg.vatRegistered || l.category !== "STANDARD" ? 0 : r2(l.total * (cfg.vatRate / 100))));
        return { vatAmounts, vatTotal: r2(vatAmounts.reduce((a: number, b: number) => a + b, 0)) };
      },
    };
  }
  if (request === "./chart-of-accounts") {
    return { CASH_ACCOUNT_KEYS: {}, getExpenseAccountKey: () => "", accountTypeForPaymentMethod: () => null };
  }
  if (request === "./accounting") {
    return {
      postJournalEntry: async (e: any) => { journal.push(e); return e; },
      getSystemAccountId: async (_tx: any, _b: string, key: string) => key,
      getOrCreateSystemAccountId: async (_tx: any, _b: string, key: string) => key,
      reverseJournalEntriesForReference: async () => undefined,
    };
  }
  if (request === "./validation") return {};
  if (request === "@prisma/client") return {};
  return realLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const kind = require("../src/lib/product-kind");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const refresh = require("../src/lib/quotation-refresh");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { recordInventoryMovement, StockError } = require("../src/lib/inventory");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { convertQuotationToSale } = require("../src/lib/quotations");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const integrations = require("../src/lib/accounting-integrations");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const creditCalc = require("../src/lib/credit-note-calc");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const debitCalc = require("../src/lib/debit-note-calc");

// ============================================================ Part 1 - product kind
{
  check("SALE is skipped for a service", kind.decideNonStockedMovement("SALE"), "SKIP");
  check("RETURN_IN is skipped for a service", kind.decideNonStockedMovement("RETURN_IN"), "SKIP");
  for (const t of ["PURCHASE", "ADJUSTMENT", "DAMAGED", "RETURN_OUT", "OPENING_STOCK", "TRANSFER_OUT", "TRANSFER_IN"]) {
    check(`${t} is refused for a service`, kind.decideNonStockedMovement(t), "REFUSE");
  }
  check("refusal message names the product", kind.nonStockedRefusalMessage("Delivery"), "Delivery is a service with no stock, so stock can't be recorded against it.");

  // Module 78: a service has a cost of its own; sale cost splits between goods and services
  check("split: goods only", kind.splitLineCosts([{ isStocked: true, quantity: 2, unitCost: 300 }]), { goodsCost: 600, serviceCost: 0 });
  check("split: service only", kind.splitLineCosts([{ isStocked: false, quantity: 3, unitCost: 150 }]), { goodsCost: 0, serviceCost: 450 });
  check("split: mixed", kind.splitLineCosts([
    { isStocked: true, quantity: 2, unitCost: 300 }, { isStocked: false, quantity: 1, unitCost: 500 }, { isStocked: true, quantity: 1, unitCost: 99.5 },
  ]), { goodsCost: 699.5, serviceCost: 500 });
  check("split: nothing", kind.splitLineCosts([]), { goodsCost: 0, serviceCost: 0 });
  check("net split: mixed", kind.splitNetByKind([{ isStocked: true, net: 1000 }, { isStocked: false, net: 250.5 }, { isStocked: false, net: 100 }]), { goodsNet: 1000, serviceNet: 350.5 });
  check("net split: goods only", kind.splitNetByKind([{ isStocked: true, net: 80 }]), { goodsNet: 80, serviceNet: 0 });

  check("stocked product: any stock fields allowed", kind.validateProductKind({ isStocked: true, openingQuantity: 5, reorderLevel: 2, expiryDate: "2027-01-01T00:00:00.000Z" }), null);
  check("service with nothing stock-only: ok", kind.validateProductKind({ isStocked: false }), null);
  check("service with zero stock fields: ok", kind.validateProductKind({ isStocked: false, openingQuantity: 0, reorderLevel: 0, expiryDate: null }), null);
  check("service with opening quantity refused", kind.validateProductKind({ isStocked: false, openingQuantity: 3 }), "A service has no stock, so it can't have an opening quantity.");
  check("service with reorder level refused", kind.validateProductKind({ isStocked: false, reorderLevel: 1 }), "A service has no stock, so it can't have a reorder level.");
  check("service with expiry date refused", kind.validateProductKind({ isStocked: false, expiryDate: "2027-01-01T00:00:00.000Z" }), "A service has no stock, so it can't have an expiry date.");

  const clean = { quantity: 0, nonZeroBranchLevels: 0, inTransitLines: 0, openStockTakeLines: 0 };
  check("no change of kind: always fine", kind.checkKindChange(true, true, { ...clean, quantity: 40 }), null);
  check("service to stocked: always fine", kind.checkKindChange(false, true, { ...clean, quantity: 40 }), null);
  check("stocked to service at zero everywhere: fine", kind.checkKindChange(true, false, clean), null);
  check("stocked to service with stock on hand refused", kind.checkKindChange(true, false, { ...clean, quantity: 40 }),
    "This product still has 40 in stock. Adjust it to zero (sell it, write it off or transfer it out) before making it a service.");
  check("tiny float residue treated as zero", kind.checkKindChange(true, false, { ...clean, quantity: 0.0001 }), null);
  check("branch stock refused", kind.checkKindChange(true, false, { ...clean, nonZeroBranchLevels: 1 }),
    "A branch still holds stock of this product. Bring every branch to zero before making it a service.");
  check("in-transit refused", kind.checkKindChange(true, false, { ...clean, inTransitLines: 2 }),
    "This product is on a stock transfer that is still in transit. Receive or cancel the transfer first.");
  check("open stock take refused", kind.checkKindChange(true, false, { ...clean, openStockTakeLines: 1 }),
    "This product is on a stock take that is still in progress. Finish or delete the stock take first.");
  check("stock is reported before transit", kind.checkKindChange(true, false, { quantity: 5, nonZeroBranchLevels: 0, inTransitLines: 1, openStockTakeLines: 0 })?.startsWith("This product still has 5"), true);
  check("labels", [kind.describeProductKind(true), kind.describeProductKind(false)], ["Stocked", "Service"]);
}

// ============================================================ Part 2 - quotation refresh
{
  const line = (id: string, total: number, category: string, vatAmount: number, oldCategory = "STANDARD", oldVatAmount = 0) =>
    ({ id, total, category, vatAmount, oldCategory, oldVatAmount });
  const base = { subtotal: 1000, discount: 0, existingQuotedTax: null, existingQuotedTotal: null };

  const same = refresh.planQuotationRefresh({ ...base, lines: [line("a", 1000, "STANDARD", 160, "STANDARD", 160)], oldTax: 160, oldTotal: 1160 });
  check("nothing changed: not changed, nothing to write", [same.changed, same.lineUpdates, same.quotedTax, same.quotedTotal], [false, [], null, null]);

  const zero = refresh.planQuotationRefresh({ ...base, lines: [line("a", 1000, "ZERO_RATED", 0, "STANDARD", 160)], oldTax: 160, oldTotal: 1160 });
  check("linked to zero-rated product: tax and total drop", [zero.changed, zero.tax, zero.total], [true, 0, 1000]);
  check("quoted figures kept", [zero.quotedTax, zero.quotedTotal], [160, 1160]);
  check("line update carries category and VAT", zero.lineUpdates, [{ id: "a", vatCategory: "ZERO_RATED", vatAmount: 0 }]);

  const mixed = refresh.planQuotationRefresh({
    subtotal: 3000, discount: 100, existingQuotedTax: null, existingQuotedTotal: null, oldTax: 480, oldTotal: 3380,
    lines: [line("a", 1000, "STANDARD", 160, "STANDARD", 160), line("b", 1000, "EXEMPT", 0, "STANDARD", 160), line("c", 1000, "STANDARD", 160, "STANDARD", 160)],
  });
  check("only the changed line is updated", mixed.lineUpdates.map((u: any) => u.id), ["b"]);
  check("tax is the sum of the new line VAT", mixed.tax, 320);
  check("total is subtotal - discount + new tax", mixed.total, 3220);

  const rate = refresh.planQuotationRefresh({ ...base, lines: [line("a", 1000, "STANDARD", 175, "STANDARD", 160)], oldTax: 160, oldTotal: 1160 });
  check("VAT rate change alone is picked up", [rate.changed, rate.tax, rate.total, rate.lineUpdates.length], [true, 175, 1175, 1]);

  const again = refresh.planQuotationRefresh({
    ...base, lines: [line("a", 1000, "STANDARD", 175, "ZERO_RATED", 0)], oldTax: 0, oldTotal: 1000, existingQuotedTax: 160, existingQuotedTotal: 1160,
  });
  check("an earlier quoted figure is never overwritten", [again.quotedTax, again.quotedTotal], [160, 1160]);

  const catOnly = refresh.planQuotationRefresh({ ...base, lines: [line("a", 1000, "ZERO_RATED", 0, "STANDARD", 0)], oldTax: 0, oldTotal: 1000 });
  check("category change with the same figures: line updated, no quoted figures", [catOnly.changed, catOnly.lineUpdates.length, catOnly.quotedTax, catOnly.quotedTotal], [true, 1, null, null]);

  const inputs = { ...base, lines: [line("a", 1000, "ZERO_RATED", 0, "STANDARD", 160)], oldTax: 160, oldTotal: 1160 };
  const before = JSON.stringify(inputs);
  refresh.planQuotationRefresh(inputs);
  check("inputs never mutated", JSON.stringify(inputs), before);

  check("no quoted total: no sentence", refresh.describeQuotedDifference(null, 1000), null);
  check("same figures: no sentence", refresh.describeQuotedDifference(1000, 1000), null);
  check("lower charged total", refresh.describeQuotedDifference(1160, 1000),
    "Quoted at MWK 1,160.00. The sale charged MWK 1,000.00 (-MWK 160.00) because VAT was recalculated from the product sold.");
  check("higher charged total", refresh.describeQuotedDifference(1000, 1160),
    "Quoted at MWK 1,000.00. The sale charged MWK 1,160.00 (+MWK 160.00) because VAT was recalculated from the product sold.");
}

// ============================================================ Part 2b - backfill planner (Module 78)
{
  const ql = (id: string, productId: string | null, over: any = {}) =>
    ({ id, productId, quantity: 1, unitPrice: 1000, discount: 0, total: 1000, vatCategory: "STANDARD", vatAmount: 160, ...over });
  const sl = (productId: string, over: any = {}) =>
    ({ productId, quantity: 1, unitPrice: 1000, discount: 0, total: 1000, vatCategory: "STANDARD", vatAmount: 160, ...over });
  const quote = (lines: any[], over: any = {}) => ({ tax: 160, total: 1160, quotedTax: null, quotedTotal: null, lines, ...over });

  const same = refresh.planConvertedQuotationBackfill({ quotation: quote([ql("a", "p1")]), sale: { tax: 160, total: 1160, lines: [sl("p1")] } });
  check("backfill: already agrees", [same.action, same.lineUpdates.length], ["SKIP_NO_DIFFERENCE", 0]);

  const diff = refresh.planConvertedQuotationBackfill({
    quotation: quote([ql("a", "p1")]),
    sale: { tax: 0, total: 1000, lines: [sl("p1", { vatCategory: "ZERO_RATED", vatAmount: 0 })] },
  });
  check("backfill: figures taken from the sale", [diff.action, diff.tax, diff.total], ["UPDATE", 0, 1000]);
  check("backfill: quoted figures kept", [diff.quotedTax, diff.quotedTotal], [160, 1160]);
  check("backfill: matched line updated", diff.lineUpdates, [{ id: "a", vatCategory: "ZERO_RATED", vatAmount: 0 }]);

  const done = refresh.planConvertedQuotationBackfill({
    quotation: quote([ql("a", "p1")], { quotedTax: 160, quotedTotal: 1160, tax: 0, total: 1000 }),
    sale: { tax: 0, total: 1000, lines: [sl("p1", { vatCategory: "ZERO_RATED", vatAmount: 0 })] },
  });
  check("backfill: second run skips a refreshed quotation", [done.action, done.lineUpdates.length], ["SKIP_ALREADY_REFRESHED", 0]);

  // two identical quotation lines for the same product: ambiguous, so no line is updated, but the document is
  const dup = refresh.planConvertedQuotationBackfill({
    quotation: quote([ql("a", "p1"), ql("b", "p1")], { tax: 320, total: 2320 }),
    sale: { tax: 160, total: 2160, lines: [sl("p1", { vatCategory: "ZERO_RATED", vatAmount: 0 }), sl("p1")] },
  });
  check("backfill: ambiguous lines left alone", [dup.lineUpdates, dup.unmatchedLineIds], [[], ["a", "b"]]);
  check("backfill: document totals still taken from the sale", [dup.action, dup.tax, dup.total, dup.quotedTotal], ["UPDATE", 160, 2160, 2320]);

  const part = refresh.planConvertedQuotationBackfill({
    quotation: quote([ql("a", "p1"), ql("b", "p2", { unitPrice: 500, total: 500, vatAmount: 80 })], { tax: 240, total: 1740 }),
    sale: { tax: 160, total: 1660, lines: [sl("p1"), sl("p2", { unitPrice: 500, total: 500, vatCategory: "EXEMPT", vatAmount: 0 })] },
  });
  check("backfill: only the differing line is updated", part.lineUpdates, [{ id: "b", vatCategory: "EXEMPT", vatAmount: 0 }]);

  const noProduct = refresh.planConvertedQuotationBackfill({
    quotation: quote([ql("a", null)]),
    sale: { tax: 0, total: 1000, lines: [sl("p1", { vatCategory: "ZERO_RATED", vatAmount: 0 })] },
  });
  check("backfill: a line with no product is never guessed", [noProduct.lineUpdates, noProduct.unmatchedLineIds], [[], ["a"]]);
}

// ============================================================ Part 2c - note calculators (Module 78)
{
  const svc = { id: "s1", productName: "Delivery", quantity: 2, total: 400, vatAmount: 64, vatCategory: "STANDARD", unitCost: 120, isStocked: false };
  const gd = { id: "g1", productName: "Widget", quantity: 2, total: 1000, vatAmount: 160, vatCategory: "STANDARD", unitCost: 300, isStocked: true };
  const sale = { subtotal: 1400, discount: 0, total: 1624, balance: 1624 };

  const noRestock = (() => { try { creditCalc.computeCreditNote({ sale, items: [svc], priors: [], priorDiscountShare: 0, priorTotal: 0, lines: [{ saleItemId: "s1", quantity: 1, restock: true }] }); return "ok"; } catch (e: any) { return e.message; } })();
  check("credit note: restock on a service refused", noRestock, "Delivery is a service, so nothing can go back into stock. Untick restock.");
  const money = creditCalc.computeCreditNote({ sale, items: [svc, gd], priors: [], priorDiscountShare: 0, priorTotal: 0, lines: [{ saleItemId: "s1", quantity: 1, restock: false }] });
  check("credit note: a service can be credited for money, no cost reversed", [money.netAmount, money.costRestored], [200, 0]);
  const goods = creditCalc.computeCreditNote({ sale, items: [svc, gd], priors: [], priorDiscountShare: 0, priorTotal: 0, lines: [{ saleItemId: "g1", quantity: 1, restock: true }] });
  check("credit note: goods restock still reverses cost", goods.costRestored, 300);

  const pSvc = { id: "s1", productName: "Delivery", quantity: 2, total: 400, vatAmount: 64, vatCategory: "STANDARD", unitCost: 200, isStocked: false };
  const pGd = { id: "g1", productName: "Widget", quantity: 2, total: 1000, vatAmount: 160, vatCategory: "STANDARD", unitCost: 500, isStocked: true };
  const purchase = { total: 1624, balance: 1624 };
  const noSend = (() => { try { debitCalc.computeDebitNote({ purchase, items: [pSvc], priors: [], priorTotal: 0, lines: [{ purchaseItemId: "s1", quantity: 1, stockOut: true }] }); return "ok"; } catch (e: any) { return e.message; } })();
  check("debit note: sending back a service refused", noSend, 'Delivery is a service, so nothing can be sent back. Untick "sent back to supplier".');
  const adj = debitCalc.computeDebitNote({ purchase, items: [pSvc, pGd], priors: [], priorTotal: 0, lines: [{ purchaseItemId: "s1", quantity: 0, netAmount: 100, stockOut: false }, { purchaseItemId: "g1", quantity: 1, stockOut: true }] });
  check("debit note: lines carry isStocked", adj.lines.map((l: any) => l.isStocked), [false, true]);
  check("debit note: a service price adjustment and a goods return together", adj.lines.map((l: any) => l.net), [100, 500]);
}

// ============================================================ Part 2d - ledger postings (Module 78)
async function part2d() {
  const asMap = (entry: any) => entry.lines.map((l: any) => `${l.accountId}:${l.debit != null ? "Dr" : "Cr"}:${l.debit ?? l.credit}`);
  const balanced = (entry: any) => Math.abs(entry.lines.reduce((a: number, l: any) => a + (l.debit ?? 0) - (l.credit ?? 0), 0)) < 0.005;
  const tx = {};

  journal.length = 0;
  await integrations.postJournalEntryForSale({ tx, businessId: "b1", saleId: "s1", saleNumber: "S-1", total: 2000, vatAmount: 0, cost: 600, serviceCost: 300, createdById: "u1" });
  const cogs = journal.find((e) => e.referenceType === "SaleCOGS");
  check("sale: COGS debit is goods plus service cost", asMap(cogs)[0], "COST_OF_GOODS_SOLD:Dr:900");
  check("sale: goods credit Inventory, service credits Service Cost Clearing", asMap(cogs).slice(1), ["INVENTORY:Cr:600", "SERVICE_COST_CLEARING:Cr:300"]);
  check("sale: entry balances", balanced(cogs), true);

  journal.length = 0;
  await integrations.postJournalEntryForSale({ tx, businessId: "b1", saleId: "s2", saleNumber: "S-2", total: 500, cost: 0, serviceCost: 120, createdById: "u1" });
  check("sale: service-only sale never touches Inventory", asMap(journal.find((e) => e.referenceType === "SaleCOGS")), ["COST_OF_GOODS_SOLD:Dr:120", "SERVICE_COST_CLEARING:Cr:120"]);

  journal.length = 0;
  await integrations.postJournalEntryForSale({ tx, businessId: "b1", saleId: "s3", saleNumber: "S-3", total: 500, cost: 200, createdById: "u1" });
  check("sale: goods-only sale is unchanged", asMap(journal.find((e) => e.referenceType === "SaleCOGS")), ["COST_OF_GOODS_SOLD:Dr:200", "INVENTORY:Cr:200"]);

  journal.length = 0;
  await integrations.postJournalEntryForSale({ tx, businessId: "b1", saleId: "s4", saleNumber: "S-4", total: 500, cost: 0, serviceCost: 0, createdById: "u1" });
  check("sale: nothing costed posts no COGS entry", journal.some((e) => e.referenceType === "SaleCOGS"), false);

  journal.length = 0;
  await integrations.postJournalEntryForPurchase({ tx, businessId: "b1", purchaseId: "p1", purchaseNumber: "P-1", total: 1160, vatAmount: 160, serviceNet: 400, createdById: "u1" });
  const pe = journal[0];
  check("purchase: goods to Inventory, service to Service Cost Clearing", asMap(pe), ["INVENTORY:Dr:600", "SERVICE_COST_CLEARING:Dr:400", "VAT_INPUT_RECEIVABLE:Dr:160", "ACCOUNTS_PAYABLE:Cr:1160"]);
  check("purchase: entry balances", balanced(pe), true);

  journal.length = 0;
  await integrations.postJournalEntryForPurchase({ tx, businessId: "b1", purchaseId: "p2", purchaseNumber: "P-2", total: 1000, serviceNet: 1000, createdById: "u1" });
  check("purchase: service-only purchase has no Inventory line", asMap(journal[0]), ["SERVICE_COST_CLEARING:Dr:1000", "ACCOUNTS_PAYABLE:Cr:1000"]);

  journal.length = 0;
  await integrations.postJournalEntryForPurchase({ tx, businessId: "b1", purchaseId: "p3", purchaseNumber: "P-3", total: 1000, createdById: "u1" });
  check("purchase: goods-only purchase is unchanged", asMap(journal[0]), ["INVENTORY:Dr:1000", "ACCOUNTS_PAYABLE:Cr:1000"]);

  journal.length = 0;
  await integrations.postJournalEntryForDebitNote({ tx, businessId: "b1", debitNoteId: "d1", debitNoteNumber: "DN-1", purchaseNumber: "P-1", netAmount: 600, serviceNetAmount: 100, vatAmount: 96, appliedToBalance: 696, settledAmount: 0, settlement: "NONE", createdById: "u1" });
  check("debit note: goods credit Inventory, service credits Service Cost Clearing", asMap(journal[0]), ["INVENTORY:Cr:500", "SERVICE_COST_CLEARING:Cr:100", "VAT_INPUT_RECEIVABLE:Cr:96", "ACCOUNTS_PAYABLE:Dr:696"]);
  check("debit note: entry balances", balanced(journal[0]), true);

  journal.length = 0;
  await integrations.postJournalEntryForDebitNote({ tx, businessId: "b1", debitNoteId: "d2", debitNoteNumber: "DN-2", purchaseNumber: "P-1", netAmount: 500, vatAmount: 0, appliedToBalance: 500, settledAmount: 0, settlement: "NONE", createdById: "u1" });
  check("debit note: goods-only unchanged", asMap(journal[0]), ["INVENTORY:Cr:500", "ACCOUNTS_PAYABLE:Dr:500"]);
}

// ============================================================ Part 3 - movements
async function outcome(p: Promise<any>): Promise<string> {
  try { await p; return "ok"; } catch (e: any) { return `${e.constructor.name}: ${e.message}`; }
}
const MOVE = (productId: string, type: string, delta: number, branchId: string | null = null) =>
  ({ businessId: "b1", productId, type, delta, branchId, createdById: "u1" });

(async () => {
  await part2d();
  db.products = [
    { id: "g", businessId: "b1", name: "Widget", isStocked: true, quantity: 10 },
    { id: "s", businessId: "b1", name: "Delivery", isStocked: false, quantity: 0 },
  ];
  db.movements = []; db.levels = [];

  check("stocked sale still decrements", await recordInventoryMovement(MOVE("g", "SALE", -3)), 7);
  check("stocked sale wrote a movement", db.movements.length, 1);

  check("service sale returns, no failure", await outcome(recordInventoryMovement(MOVE("s", "SALE", -5))), "ok");
  check("service return is ignored too", await outcome(recordInventoryMovement(MOVE("s", "RETURN_IN", 5))), "ok");
  check("service sale with a branch leaves no stock level", [db.levels.length, db.products[1].quantity], [0, 0]);
  check("service sale wrote no movement", db.movements.length, 1);

  for (const [t, d] of [["PURCHASE", 5], ["ADJUSTMENT", 1], ["DAMAGED", -1], ["OPENING_STOCK", 4], ["TRANSFER_OUT", -1], ["TRANSFER_IN", 1], ["RETURN_OUT", -1]] as [string, number][]) {
    check(`service ${t} refused`, await outcome(recordInventoryMovement(MOVE("s", t, d))),
      "StockError: Delivery is a service with no stock, so stock can't be recorded against it.");
  }
  check("refusals wrote nothing", [db.movements.length, db.levels.length, db.products[1].quantity], [1, 0, 0]);
  check("StockError class is the one callers catch", (() => { try { throw new StockError("x"); } catch (e) { return e instanceof StockError; } })(), true);

  // ======================================================== Part 4 - conversion refresh
  const prod = (id: string, vatCategory: string) => ({ id, businessId: "b1", name: id, isActive: true, isStocked: true, vatCategory });
  function seed(items: any[], over: any = {}) {
    db.quotations = [{
      id: "q1", businessId: "b1", status: "ACCEPTED", convertedSaleId: null, customerId: "c1", branchId: null,
      subtotal: 1000, discount: 0, tax: 160, total: 1160, quotedTax: null, quotedTotal: null,
      items: items.map((it, i) => ({ id: `i${i}`, description: `Line ${i}`, quantity: 1, unitPrice: 1000, discount: 0, total: 1000, vatCategory: "STANDARD", vatAmount: 160, ...it })),
      ...over,
    }];
    db.sales = [];
    db.products = [prod("pStd", "STANDARD"), prod("pZero", "ZERO_RATED"), prod("pEx", "EXEMPT")];
  }
  const CONV = (lineProducts?: any) => ({ businessId: "b1", quotationId: "q1", userId: "u1", input: { paymentMethod: "CASH", amountPaid: 1000, ...(lineProducts ? { lineProducts } : {}) } });

  async function run(items: any[], lineProducts: any, over: any = {}) {
    seed(items, over);
    return outcome(convertQuotationToSale(CONV(lineProducts)));
  }
  const q = () => db.quotations[0];

  // A. free-text line linked to a ZERO_RATED product: VAT drops to 0, quoted figures kept
  vatCfg = { vatRegistered: true, vatRate: 16 };
  check("A: converts", await run([{ productId: null, description: "Custom install" }], [{ itemId: "i0", productId: "pZero" }]), "ok");
  check("A: tax and total refreshed", [q().tax, q().total], [0, 1000]);
  check("A: quoted figures recorded", [q().quotedTax, q().quotedTotal], [160, 1160]);
  check("A: line category and VAT refreshed", [q().items[0].vatCategory, q().items[0].vatAmount], ["ZERO_RATED", 0]);
  check("A: quoted price, description and net total untouched", [q().items[0].unitPrice, q().items[0].description, q().items[0].total, q().subtotal], [1000, "Custom install", 1000, 1000]);

  // B. linked to a STANDARD product at the same rate: nothing changes, nothing recorded
  check("B: converts", await run([{ productId: null }], [{ itemId: "i0", productId: "pStd" }]), "ok");
  check("B: figures unchanged", [q().tax, q().total, q().quotedTax, q().quotedTotal], [160, 1160, null, null]);

  // C. already-linked line, same product, same rate: untouched
  check("C: converts", await run([{ productId: "pStd" }], undefined), "ok");
  check("C: figures unchanged", [q().tax, q().total, q().quotedTax, q().quotedTotal], [160, 1160, null, null]);

  // D. VAT rate changed since quoting
  vatCfg = { vatRegistered: true, vatRate: 20 };
  check("D: converts", await run([{ productId: "pStd" }], undefined), "ok");
  check("D: refreshed at the current rate", [q().tax, q().total, q().quotedTotal], [200, 1200, 1160]);

  // E. business no longer VAT registered
  vatCfg = { vatRegistered: false, vatRate: 16 };
  check("E: converts", await run([{ productId: "pStd" }], undefined), "ok");
  check("E: VAT removed", [q().tax, q().total, q().quotedTax, q().quotedTotal], [0, 1000, 160, 1160]);

  // F. mixed lines, document discount
  vatCfg = { vatRegistered: true, vatRate: 16 };
  const items = [
    { productId: "pStd", total: 1000, vatAmount: 160 },
    { productId: null, total: 1000, vatAmount: 160 },
    { productId: null, total: 1000, vatAmount: 160 },
  ];
  check("F: converts", await run(items, [{ itemId: "i1", productId: "pEx" }, { itemId: "i2", productId: "pZero" }], { subtotal: 3000, discount: 300, tax: 480, total: 3180 }), "ok");
  check("F: VAT only on the standard line", q().items.map((i: any) => i.vatAmount), [160, 0, 0]);
  check("F: totals", [q().tax, q().total, q().quotedTax, q().quotedTotal], [160, 2860, 480, 3180]);
  check("F: subtotal and discount untouched", [q().subtotal, q().discount], [3000, 300]);

  // G. a refused conversion leaves the quotation exactly as it was
  check("G: refused when a free-text line has no product",
    (await run([{ productId: null, description: "Custom install" }], undefined)).startsWith("QuotationValidationError"), true);
  check("G: nothing refreshed, status restored", [q().tax, q().total, q().quotedTotal, q().status], [160, 1160, null, "ACCEPTED"]);
})().then(() => {
  console.log(`${total - failed}/${total} checks passed`);
  if (failed > 0) process.exit(1);
});
