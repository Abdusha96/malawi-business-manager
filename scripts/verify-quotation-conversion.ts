/**
 * Module 38 – standalone checks for the atomic quotation conversion in
 * src/lib/quotations.ts. No database, no framework:
 *   npx tsx scripts/verify-quotation-conversion.ts   (npm run verify:quotations)
 * Exits non-zero if any check fails.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. It swaps `./prisma`, `./sales`, `./vat`
 * and `@prisma/client` for an in-memory fake whose `$transaction` snapshots the
 * state and RESTORES it if the callback throws (real rollback semantics), and
 * whose `updateMany` honours the `where` filter the way Postgres does. That
 * checks the ORCHESTRATION the module is about: the claim happens first, the
 * sale is created with the caller's `tx`, every failure after the claim leaves
 * the quotation exactly as it was, and a second conversion is refused without a
 * second sale. It cannot prove Postgres row-lock behaviour under real
 * concurrency (a fake can't) – that rests on the documented semantics of a
 * conditional UPDATE under READ COMMITTED, and on the manual test in the README.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require("module");

let failed = 0, total = 0;
function check(name: string, actual: unknown, expected: unknown) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed++; console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`); }
}

// ---------------------------------------------------------------- fake DB
type Q = { id: string; businessId: string; status: string; convertedSaleId: string | null; customerId: string | null; branchId: string | null; total: number; discount: number; updatedAt: number; items: any[] };
const db: { quotations: Q[]; sales: any[] } = { quotations: [], sales: [] };

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
  async findUnique({ where, include }: any) {
    const q = db.quotations.find((x) => x.id === where.id);
    return q ? (include?.items ? { ...q } : { ...q, items: undefined }) : null;
  },
  async findUniqueOrThrow(args: any) {
    const q = await quotationApi.findUnique(args);
    if (!q) throw new Error("not found");
    return q;
  },
  async update({ where, data }: any) {
    const q = db.quotations.find((x) => x.id === where.id)!;
    const { items, ...rest } = data;
    Object.assign(q, rest);
    if (items?.create) q.items = items.create.map((i: any) => ({ ...i }));
    return { ...q };
  },
};

let txCounter = 0;
const fakePrisma: any = {
  quotation: quotationApi,
  async $transaction(fn: (tx: any) => Promise<any>) {
    const snapshot = JSON.stringify(db);
    const tx = { __tx: ++txCounter, quotation: quotationApi, quotationItem: { async deleteMany({ where }: any) { const q = db.quotations.find((x) => x.id === where.quotationId)!; q.items = []; }, async update({ where, data }: any) { for (const q of db.quotations) { const it = q.items.find((x: any) => x.id === where.id); if (it) Object.assign(it, data); } } }, product: { async findMany() { return []; } } };
    try {
      return await fn(tx);
    } catch (err) {
      const restored = JSON.parse(snapshot);
      db.quotations = restored.quotations; db.sales = restored.sales;
      throw err;
    }
  },
};

// ---------------------------------------------------------------- fake createSale
class FakeSaleValidationError extends Error {}
const saleCalls: { txPassed: boolean; statusSeenInsideSale: string | undefined }[] = [];
let saleBehaviour: "ok" | "stock" | "plan" = "ok";
class FakePlanError extends Error { status = 403; }
async function fakeCreateSale(params: any) {
  const q = db.quotations.find((x) => x.id === params.quotationIdForTest) ?? db.quotations[0];
  saleCalls.push({ txPassed: !!params.tx, statusSeenInsideSale: q?.status });
  if (saleBehaviour === "stock") throw new FakeSaleValidationError("Not enough stock for Widget.");
  if (saleBehaviour === "plan") throw new FakePlanError("Monthly sales cap reached.");
  const sale = { id: `sale_${db.sales.length + 1}` };
  db.sales.push(sale); // rolled back with everything else if the transaction later fails
  return sale;
}

// ---------------------------------------------------------------- module interception
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
const quotations = require("../src/lib/quotations");
const { convertQuotationToSale, setQuotationStatus, updateQuotation, QuotationValidationError } = quotations;

function seed(over: Partial<Q> = {}, items?: any[]): Q {
  const q: Q = {
    id: "q1", businessId: "b1", status: "ACCEPTED", convertedSaleId: null, customerId: "c1", branchId: null,
    total: 1000, discount: 0, updatedAt: 0,
    // Module 68: lines need ids now (the convert step names lines by id).
    items: (items ?? [{ productId: "p1", description: "Widget", quantity: 2, unitPrice: 500, discount: 0 }]).map((it: any, i: number) => ({ id: `i${i}`, ...it })),
    ...over,
  };
  db.quotations = [q]; db.sales = []; saleCalls.length = 0; saleBehaviour = "ok";
  return q;
}
const pay = { paymentMethod: "CASH", amountPaid: 1000 };
async function outcome(p: Promise<any>): Promise<string> {
  try { await p; return "ok"; } catch (e: any) { return `${e.constructor.name}: ${e.message}`; }
}
const CONV = (over: any = {}) => ({ businessId: "b1", quotationId: "q1", userId: "u1", input: pay, ...over });

(async () => {
  // 1. Happy path: one sale, created with the caller's tx, quotation CONVERTED and linked
  seed();
  const sale = await convertQuotationToSale(CONV());
  check("happy: returns sale", sale.id, "sale_1");
  check("happy: exactly one sale", db.sales.length, 1);
  check("happy: createSale got the shared tx", saleCalls.map((c) => c.txPassed), [true]);
  check("happy: claim happened BEFORE createSale", saleCalls[0].statusSeenInsideSale, "CONVERTED");
  check("happy: status", db.quotations[0].status, "CONVERTED");
  check("happy: linked", db.quotations[0].convertedSaleId, "sale_1");

  // 2. Second conversion: refused, NO second sale (the pre-Module-38 double-sale bug)
  const again = await outcome(convertQuotationToSale(CONV()));
  check("double convert refused", again, "QuotationValidationError: This quotation has already been converted to a sale.");
  check("double convert: still one sale", db.sales.length, 1);
  check("double convert: createSale not called again", saleCalls.length, 1);

  // 3. Each failure after the claim rolls the claim back (and any sale) – status restored
  for (const from of ["DRAFT", "SENT", "ACCEPTED"]) {
    seed({ status: from });
    saleBehaviour = "stock";
    const r = await outcome(convertQuotationToSale(CONV()));
    check(`stock failure from ${from}: mapped to QuotationValidationError`, r, "QuotationValidationError: Not enough stock for Widget.");
    check(`stock failure from ${from}: status restored`, db.quotations[0].status, from);
    check(`stock failure from ${from}: no link, no sale`, [db.quotations[0].convertedSaleId, db.sales.length], [null, 0]);
  }

  seed(); saleBehaviour = "plan";
  const planR = await outcome(convertQuotationToSale(CONV()));
  check("plan restriction passes through unmapped", planR, "FakePlanError: Monthly sales cap reached.");
  check("plan restriction: status restored", db.quotations[0].status, "ACCEPTED");

  seed({}, [{ productId: "p1", description: "Widget", quantity: 1, unitPrice: 500, discount: 0 }, { productId: null, description: "Custom install", quantity: 1, unitPrice: 500, discount: 0 }]);
  const free = await outcome(convertQuotationToSale(CONV()));
  check("free-text line refused with the line named", free, `QuotationValidationError: "Custom install" isn't linked to a real product - choose the product it should be sold as, or edit the quotation.`);
  check("free-text line: status restored, createSale never called", [db.quotations[0].status, saleCalls.length], ["ACCEPTED", 0]);

  seed({}, []);
  check("no items refused + restored", [await outcome(convertQuotationToSale(CONV())), db.quotations[0].status], ["QuotationValidationError: This quotation has no items.", "ACCEPTED"]);

  seed({ customerId: null });
  const noCust = await outcome(convertQuotationToSale(CONV({ input: { paymentMethod: "CASH", amountPaid: 100 } })));
  check("credit sale without customer refused", noCust.startsWith("QuotationValidationError: A customer must be attached"), true);
  check("credit sale without customer: status restored", db.quotations[0].status, "ACCEPTED");
  seed({ customerId: null });
  check("fully paid walk-in sale still converts", await outcome(convertQuotationToSale(CONV())), "ok");

  // 4. Not-convertible states and wrong tenant
  for (const st of ["DECLINED", "EXPIRED"]) {
    seed({ status: st });
    check(`${st} refused`, await outcome(convertQuotationToSale(CONV())), `QuotationValidationError: A ${st.toLowerCase()} quotation can't be converted – change its status first if this was a mistake.`);
    check(`${st} untouched`, [db.quotations[0].status, saleCalls.length], [st, 0]);
  }
  seed();
  check("other business → not found", await outcome(convertQuotationToSale(CONV({ businessId: "other" }))), "QuotationValidationError: Quotation not found in this business.");
  check("other business: untouched", db.quotations[0].status, "ACCEPTED");
  check("unknown id → not found", await outcome(convertQuotationToSale(CONV({ quotationId: "nope" }))), "QuotationValidationError: Quotation not found in this business.");

  // 5. setQuotationStatus can never overwrite CONVERTED (read-then-write race)
  seed({ status: "CONVERTED", convertedSaleId: "sale_9" });
  check("CONVERTED status can't be changed", await outcome(setQuotationStatus({ businessId: "b1", quotationId: "q1", status: "DECLINED" })), "QuotationValidationError: A converted quotation's status can't be changed – see the sale it created instead.");
  check("CONVERTED stays CONVERTED", [db.quotations[0].status, db.quotations[0].convertedSaleId], ["CONVERTED", "sale_9"]);
  seed({ status: "DRAFT" });
  check("DRAFT → SENT allowed", await outcome(setQuotationStatus({ businessId: "b1", quotationId: "q1", status: "SENT" })), "ok");
  check("DRAFT → SENT applied", db.quotations[0].status, "SENT");
  check("status change on other business → not found", await outcome(setQuotationStatus({ businessId: "other", quotationId: "q1", status: "SENT" })), "QuotationValidationError: Quotation not found in this business.");

  // 6. updateQuotation: only a DRAFT is editable, checked atomically; items untouched when refused
  const editInput = { customerId: "c1", branchId: null, customerName: null, expiryDate: null, discount: 0, notes: null, terms: null, items: [{ productId: null, description: "New", quantity: 1, unitPrice: 10, discount: 0 }] };
  seed({ status: "CONVERTED", convertedSaleId: "sale_9" });
  const before = JSON.stringify(db.quotations[0].items);
  check("edit of CONVERTED refused", await outcome(updateQuotation({ businessId: "b1", quotationId: "q1", input: editInput })), "QuotationValidationError: Only a DRAFT quotation can be edited – change its status back to DRAFT first, or create a new one.");
  check("edit of CONVERTED leaves items alone", JSON.stringify(db.quotations[0].items), before);
  seed({ status: "DRAFT" });
  check("edit of DRAFT allowed", await outcome(updateQuotation({ businessId: "b1", quotationId: "q1", input: editInput })), "ok");
  check("edit of DRAFT replaced items", db.quotations[0].items.map((i: any) => i.description), ["New"]);
  seed({ status: "DRAFT" });
  check("edit in other business → not found", await outcome(updateQuotation({ businessId: "other", quotationId: "q1", input: editInput })), "QuotationValidationError: Quotation not found in this business.");

  console.log(`${total - failed}/${total} checks passed`);
  process.exit(failed ? 1 : 0);
})();
