/**
 * Module 68 - standalone checks for linking free-text quotation lines to
 * products at convert time (src/lib/quotation-line-mapping.ts and the changes
 * to convertQuotationToSale() in src/lib/quotations.ts). No database:
 *   npx tsx scripts/verify-quotation-line-mapping.ts   (npm run verify:quotation-line-mapping)
 * Exits non-zero if any check fails.
 *
 * Part 1 checks the PURE resolver directly. Part 2 runs the real
 * convertQuotationToSale() against an in-memory fake (same approach as
 * verify-quotation-conversion.ts: `$transaction` restores the snapshot when the
 * callback throws), which proves the ORCHESTRATION: the link is written inside
 * the claim's transaction, the Sale is created for the chosen product, and a
 * refusal or a stock failure leaves the line free-text again with no sale.
 * It cannot prove Postgres behaviour.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
// Makes this file a module so its top-level names (db, check, seed, ...) do not
// collide with the other standalone scripts in the same tsc program.
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
const db: { quotations: any[]; sales: any[]; products: any[] } = { quotations: [], sales: [], products: [] };
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
const quotationApi = {
  async updateMany({ where, data }: any) {
    const rows = db.quotations.filter((q) => matches(q, where));
    rows.forEach((q) => Object.assign(q, data));
    return { count: rows.length };
  },
  async findUnique({ where }: any) { const q = db.quotations.find((x) => x.id === where.id); return q ? { ...q } : null; },
  async findUniqueOrThrow({ where }: any) {
    const q = db.quotations.find((x) => x.id === where.id);
    if (!q) throw new Error("not found");
    return { ...q, items: q.items.map((i: any) => ({ ...i })) };
  },
  async update({ where, data }: any) { const q = db.quotations.find((x) => x.id === where.id)!; Object.assign(q, data); return { ...q }; },
};
const itemApi = {
  async update({ where, data }: any) {
    for (const q of db.quotations) { const it = q.items.find((x: any) => x.id === where.id); if (it) Object.assign(it, data); }
  },
};
const productApi = {
  async findMany({ where }: any) { return db.products.filter((p) => matches(p, where)).map((p) => ({ ...p })); },
};
const fakePrisma: any = {
  quotation: quotationApi,
  async $transaction(fn: (tx: any) => Promise<any>) {
    const snapshot = JSON.stringify(db);
    const tx = { quotation: quotationApi, quotationItem: itemApi, product: productApi };
    try { return await fn(tx); } catch (err) {
      const r = JSON.parse(snapshot); db.quotations = r.quotations; db.sales = r.sales; db.products = r.products;
      throw err;
    }
  },
};
class FakeSaleValidationError extends Error {}
let saleBehaviour: "ok" | "stock" = "ok";
const saleInputs: any[] = [];
async function fakeCreateSale(params: any) {
  saleInputs.push(params.input.items.map((i: any) => i.productId));
  if (saleBehaviour === "stock") throw new FakeSaleValidationError("Not enough stock for Widget.");
  const sale = { id: `sale_${db.sales.length + 1}` };
  db.sales.push(sale);
  return sale;
}
const realLoad = Module._load;
Module._load = function (request: string, parent: any, isMain: boolean) {
  if (request === "./prisma") return { prisma: fakePrisma };
  if (request === "./sales") return { createSale: fakeCreateSale, SaleValidationError: FakeSaleValidationError };
  if (request === "./vat") return { getVatConfig: async () => ({ vatRegistered: false, vatRate: 0 }), computeVatForLines: (l: any[]) => ({ vatAmounts: l.map(() => 0), vatTotal: 0 }) };
  if (request === "./validation") return {};
  if (request === "@prisma/client") return {};
  return realLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveLineMapping, freeTextLines } = require("../src/lib/quotation-line-mapping");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { convertQuotationToSale } = require("../src/lib/quotations");

const L = (id: string, description: string, productId: string | null = null) => ({ id, description, productId });

// ============================================================ Part 1 - pure
{
  const lines = [L("a", "Widget", "p1"), L("b", "Custom install"), L("c", "Delivery")];
  check("freeTextLines picks only unlinked", freeTextLines(lines).map((l: any) => l.id), ["b", "c"]);

  const ok = resolveLineMapping(lines, [{ itemId: "b", productId: "p2" }, { itemId: "c", productId: "p3" }]);
  check("both free-text lines mapped: ok", ok.ok, true);
  check("productIdByItem keeps quotation line order", ok.productIdByItem, [
    { itemId: "a", productId: "p1" }, { itemId: "b", productId: "p2" }, { itemId: "c", productId: "p3" },
  ]);
  check("newLinks holds only the newly linked lines", ok.newLinks, [{ itemId: "b", productId: "p2" }, { itemId: "c", productId: "p3" }]);

  const allLinked = resolveLineMapping([L("a", "Widget", "p1")], undefined);
  check("all lines already linked, no choices: ok, nothing to write", [allLinked.ok, allLinked.newLinks], [true, []]);
  check("null choices treated as none", resolveLineMapping([L("a", "Widget", "p1")], null).ok, true);

  const one = resolveLineMapping([L("b", "Custom install")], []);
  check("one unlinked line, no choice: refused", [one.ok, one.code], [false, "STILL_UNLINKED"]);
  check("one unlinked line message names it", one.message, `"Custom install" isn't linked to a real product - choose the product it should be sold as, or edit the quotation.`);
  check("STILL_UNLINKED reports the line ids", one.itemIds, ["b"]);

  const partial = resolveLineMapping(lines, [{ itemId: "b", productId: "p2" }]);
  check("only one of two free-text lines chosen: refused", [partial.ok, partial.code, partial.itemIds], [false, "STILL_UNLINKED", ["c"]]);

  const many = resolveLineMapping([L("1", "A"), L("2", "B"), L("3", "C"), L("4", "D"), L("5", "E")], []);
  check("more than three unlinked: first three named, rest counted", many.message,
    `"A", "B", "C" and 2 more aren't linked to real products - choose the product each should be sold as, or edit the quotation.`);
  const two = resolveLineMapping([L("1", "A"), L("2", "B")], []);
  check("two unlinked: plural wording, no 'and N more'", two.message,
    `"A", "B" aren't linked to real products - choose the product each should be sold as, or edit the quotation.`);

  const linkedTarget = resolveLineMapping(lines, [{ itemId: "a", productId: "p9" }, { itemId: "b", productId: "p2" }, { itemId: "c", productId: "p3" }]);
  check("choice for an already-linked line refused (never re-pointed)", [linkedTarget.ok, linkedTarget.code], [false, "ALREADY_LINKED"]);
  check("ALREADY_LINKED message names the line", linkedTarget.message, `"Widget" is already linked to a product - edit the quotation if it should be a different one.`);

  const unknown = resolveLineMapping(lines, [{ itemId: "zzz", productId: "p2" }]);
  check("choice for a line not on the quotation refused", [unknown.ok, unknown.code], [false, "UNKNOWN_LINE"]);

  const dup = resolveLineMapping(lines, [{ itemId: "b", productId: "p2" }, { itemId: "b", productId: "p3" }, { itemId: "c", productId: "p3" }]);
  check("same line chosen twice refused (even with the same product)", [dup.ok, dup.code], [false, "DUPLICATE_LINE"]);
  const dupSame = resolveLineMapping(lines, [{ itemId: "b", productId: "p2" }, { itemId: "b", productId: "p2" }, { itemId: "c", productId: "p3" }]);
  check("same line, same product twice still refused", dupSame.code, "DUPLICATE_LINE");

  const blank1 = resolveLineMapping(lines, [{ itemId: "b", productId: "" }, { itemId: "c", productId: "p3" }]);
  const blank2 = resolveLineMapping(lines, [{ itemId: "  ", productId: "p2" }, { itemId: "c", productId: "p3" }]);
  check("blank product refused", [blank1.ok, blank1.code], [false, "BLANK_CHOICE"]);
  check("blank line id refused", [blank2.ok, blank2.code], [false, "BLANK_CHOICE"]);

  check("no lines at all: 'no items'", resolveLineMapping([], []).message, "This quotation has no items.");
  check("blank description still gets a readable name", resolveLineMapping([L("b", "  ")], []).message.startsWith(`"(no description)"`), true);

  check("the same product may be chosen for two different lines", resolveLineMapping(lines, [{ itemId: "b", productId: "p2" }, { itemId: "c", productId: "p2" }]).ok, true);
  const inputCopy = [{ itemId: "b", productId: "p2" }, { itemId: "c", productId: "p3" }];
  const before = JSON.stringify([lines, inputCopy]);
  resolveLineMapping(lines, inputCopy);
  check("inputs are never mutated", JSON.stringify([lines, inputCopy]), before);
}

// ============================================================ Part 2 - orchestration
function seed(items: any[], over: any = {}, products?: any[]) {
  db.quotations = [{
    id: "q1", businessId: "b1", status: "ACCEPTED", convertedSaleId: null, customerId: "c1", branchId: null,
    total: 1500, discount: 0,
    items: items.map((it, i) => ({ id: `i${i}`, description: `Line ${i}`, quantity: 1, unitPrice: 500, discount: 0, ...it })),
    ...over,
  }];
  db.sales = []; saleInputs.length = 0; saleBehaviour = "ok";
  db.products = products ?? [
    { id: "p1", businessId: "b1", name: "Widget", isActive: true },
    { id: "p2", businessId: "b1", name: "Install kit", isActive: true },
    { id: "pOld", businessId: "b1", name: "Retired", isActive: false },
    { id: "pX", businessId: "other", name: "Foreign", isActive: true },
  ];
}
const CONV = (lineProducts?: any, over: any = {}) => ({ businessId: "b1", quotationId: "q1", userId: "u1", input: { paymentMethod: "CASH", amountPaid: 1500, ...(lineProducts ? { lineProducts } : {}) }, ...over });
async function outcome(p: Promise<any>): Promise<string> {
  try { await p; return "ok"; } catch (e: any) { return `${e.constructor.name}: ${e.message}`; }
}
const productIds = () => db.quotations[0].items.map((i: any) => i.productId ?? null);

(async () => {
  // A. Free-text line linked at convert time: sale made, link persisted
  seed([{ productId: "p1", description: "Widget" }, { productId: null, description: "Custom install" }]);
  check("free-text line + choice: converts", await outcome(convertQuotationToSale(CONV([{ itemId: "i1", productId: "p2" }]))), "ok");
  check("A: sale created for the linked product and the chosen one", saleInputs, [["p1", "p2"]]);
  check("A: link written back to the quotation", productIds(), ["p1", "p2"]);
  check("A: quotation CONVERTED and linked to the sale", [db.quotations[0].status, db.quotations[0].convertedSaleId], ["CONVERTED", "sale_1"]);
  check("A: quoted description left as quoted", db.quotations[0].items[1].description, "Custom install");

  // B. Nothing free-text, no choices: unchanged behaviour, no link writes
  seed([{ productId: "p1", description: "Widget" }]);
  check("all linked, no choices: converts as before", await outcome(convertQuotationToSale(CONV())), "ok");
  check("B: sale product", saleInputs, [["p1"]]);

  // C. Free-text line, no choice: refused, restored, no sale
  seed([{ productId: "p1" }, { productId: null, description: "Custom install" }]);
  check("free-text line without a choice refused",
    await outcome(convertQuotationToSale(CONV())),
    `QuotationValidationError: "Custom install" isn't linked to a real product - choose the product it should be sold as, or edit the quotation.`);
  check("C: status restored, still free-text, no sale", [db.quotations[0].status, productIds(), db.sales.length, saleInputs.length], ["ACCEPTED", ["p1", null], 0, 0]);

  // D. Refused choices leave everything exactly as it was
  const bad: [string, any, string][] = [
    ["unknown product", [{ itemId: "i1", productId: "nope" }], `QuotationValidationError: The product chosen for "Custom install" wasn't found in this business.`],
    ["other business's product", [{ itemId: "i1", productId: "pX" }], `QuotationValidationError: The product chosen for "Custom install" wasn't found in this business.`],
    ["inactive product", [{ itemId: "i1", productId: "pOld" }], `QuotationValidationError: Retired is not active and cannot be sold - choose a different product for "Custom install".`],
    ["already-linked line", [{ itemId: "i0", productId: "p2" }, { itemId: "i1", productId: "p2" }], `QuotationValidationError: "Widget" is already linked to a product - edit the quotation if it should be a different one.`],
    ["line not on this quotation", [{ itemId: "ghost", productId: "p2" }], `QuotationValidationError: One of the chosen lines isn't on this quotation - reload the page and try again.`],
    ["line chosen twice", [{ itemId: "i1", productId: "p2" }, { itemId: "i1", productId: "p1" }], `QuotationValidationError: "Custom install" was given more than one product - choose one.`],
  ];
  for (const [label, choices, expected] of bad) {
    seed([{ productId: "p1", description: "Widget" }, { productId: null, description: "Custom install" }]);
    check(`D ${label}: refused`, await outcome(convertQuotationToSale(CONV(choices))), expected);
    check(`D ${label}: nothing changed`, [db.quotations[0].status, productIds(), db.sales.length, saleInputs.length], ["ACCEPTED", ["p1", null], 0, 0]);
  }

  // E. A stock failure AFTER the link was written rolls the link back too
  seed([{ productId: null, description: "Custom install" }], { total: 500 });
  saleBehaviour = "stock";
  check("E: stock failure mapped", await outcome(convertQuotationToSale(CONV([{ itemId: "i0", productId: "p2" }], { input: { paymentMethod: "CASH", amountPaid: 500, lineProducts: [{ itemId: "i0", productId: "p2" }] } }))), "QuotationValidationError: Not enough stock for Widget.");
  check("E: link rolled back to free-text, status restored, no sale", [productIds(), db.quotations[0].status, db.sales.length], [[null], "ACCEPTED", 0]);
  saleBehaviour = "ok";
  check("E: retry after fixing stock converts", await outcome(convertQuotationToSale({ businessId: "b1", quotationId: "q1", userId: "u1", input: { paymentMethod: "CASH", amountPaid: 500, lineProducts: [{ itemId: "i0", productId: "p2" }] } })), "ok");
  check("E: retry linked and converted", [productIds(), db.quotations[0].status], [["p2"], "CONVERTED"]);

  // F. A credit-sale customer check still runs after linking, and also rolls back
  seed([{ productId: null, description: "Custom install" }], { customerId: null, total: 500 });
  const noCust = await outcome(convertQuotationToSale({ businessId: "b1", quotationId: "q1", userId: "u1", input: { paymentMethod: "CASH", amountPaid: 100, lineProducts: [{ itemId: "i0", productId: "p2" }] } }));
  check("F: partial payment without a customer refused", noCust.startsWith("QuotationValidationError: A customer must be attached"), true);
  check("F: link rolled back", [productIds(), db.quotations[0].status], [[null], "ACCEPTED"]);

  // G. Two free-text lines, one product for both; a repeated conversion adds no sale
  seed([{ productId: null, description: "Service A" }, { productId: null, description: "Service B" }], { total: 1000 });
  const both = { businessId: "b1", quotationId: "q1", userId: "u1", input: { paymentMethod: "CASH", amountPaid: 1000, lineProducts: [{ itemId: "i0", productId: "p2" }, { itemId: "i1", productId: "p2" }] } };
  check("G: same product for two lines converts", await outcome(convertQuotationToSale(both)), "ok");
  check("G: sale lines", saleInputs, [["p2", "p2"]]);
  check("G: second conversion refused, still one sale", [await outcome(convertQuotationToSale(both)), db.sales.length], ["QuotationValidationError: This quotation has already been converted to a sale.", 1]);

  // H. Wrong tenant: nothing linked
  seed([{ productId: null, description: "Custom install" }]);
  check("H: other business's quotation not found", await outcome(convertQuotationToSale(CONV([{ itemId: "i0", productId: "p2" }], { businessId: "other" }))), "QuotationValidationError: Quotation not found in this business.");
  check("H: untouched", [productIds(), db.quotations[0].status], [[null], "ACCEPTED"]);

  console.log(`${total - failed}/${total} checks passed`);
  process.exit(failed ? 1 : 0);
})();
