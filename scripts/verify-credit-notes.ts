/**
 * Module 43: standalone checks for Credit Notes. No database, no framework:
 *   npx tsx scripts/verify-credit-notes.ts   (npm run verify:credit-notes)
 * Exits non-zero if any check fails.
 *
 * Covers the pure math in src/lib/credit-note-calc.ts: pool draw-down across repeated credits, the
 * exact-remainder rule on the last unit, price adjustments, the sale-level discount coming back in
 * proportion, balance-first application, settlement planning, and the VAT roll-up. Does NOT exercise
 * Postgres: the sale-row lock that serialises a credit note against another credit note, a payment or
 * a void is described in the README, with a manual two-request test (the same pattern Module 42 used).
 */
import {
  computeCreditNote, computePools, planSettlement, statusAfterBalance, rollUpForVat,
  round2, CreditNoteCalcError, SaleItemForCredit, PriorCreditLine,
} from "../src/lib/credit-note-calc";

let failed = 0, total = 0;
function check(name: string, actual: unknown, expected: unknown) {
  total++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}
function throws(name: string, fn: () => unknown, messageIncludes?: string) {
  total++;
  try {
    fn();
    failed++;
    console.error(`FAIL ${name}: did not throw`);
  } catch (e) {
    if (!(e instanceof CreditNoteCalcError)) {
      failed++;
      console.error(`FAIL ${name}: threw ${(e as Error).name}, not CreditNoteCalcError`);
    } else if (messageIncludes && !e.message.includes(messageIncludes)) {
      failed++;
      console.error(`FAIL ${name}: message "${e.message}" did not include "${messageIncludes}"`);
    }
  }
}

// ---- Fixture: a sale of 4 units at 1,000 net each (VAT 16.5% = 165/unit), a 400 sale-level discount,
// subtotal 4,000, total after discount+VAT = (4000-400) + (3600*0.165) = 3600 + 594 = 4194.
const items: SaleItemForCredit[] = [
  { id: "item1", productName: "Bag of Cement", quantity: 4, total: 4000, vatAmount: 660, vatCategory: "STANDARD", unitCost: 600, isStocked: true },
];
// total = subtotal - discount + vat = 4000 - 400 + 660 = 4260 (VAT isn't reduced by the flat discount,
// same as vat.ts's own sale-level VAT rule).
const sale = { subtotal: 4000, discount: 400, total: 4260, balance: 4260 };

// ---- 1. Pools with no prior credits equal the sale's own items
check("pool with no priors", computePools(items, []), [
  { saleItemId: "item1", productName: "Bag of Cement", quantity: 4, net: 4000, vatAmount: 660 },
]);

// ---- 2. Proportional return: 1 of 4 units takes a quarter of the pool
{
  const calc = computeCreditNote({
    sale, items, priors: [], priorDiscountShare: 0, priorTotal: 0,
    lines: [{ saleItemId: "item1", quantity: 1, restock: true }],
  });
  check("1 of 4 units: net", calc.netBeforeDiscount, 1000);
  check("1 of 4 units: vat", calc.vatAmount, 165);
  check("1 of 4 units: discount share = 400 * 1000/4000", calc.discountShare, 100);
  check("1 of 4 units: net after discount", calc.netAmount, 900);
  check("1 of 4 units: total", calc.total, round2(900 + 165));
  check("1 of 4 units: cost restored (restock)", calc.costRestored, 600);
}

// ---- 3. Repeated credits draw the pool down; the LAST unit takes exactly what is left, no rounding drift
{
  const priors: PriorCreditLine[] = [];
  let runningTotal = 0;
  let runningDiscountShare = 0;
  for (let i = 0; i < 4; i++) {
    const remainingQty = 4 - i;
    const calc = computeCreditNote({
      sale, items, priors, priorDiscountShare: runningDiscountShare, priorTotal: runningTotal,
      lines: [{ saleItemId: "item1", quantity: 1, restock: false }],
    });
    priors.push({ saleItemId: "item1", quantity: 1, net: calc.lines[0].net, vatAmount: calc.lines[0].vatAmount });
    runningTotal = round2(runningTotal + calc.total);
    runningDiscountShare = round2(runningDiscountShare + calc.discountShare);
    if (remainingQty === 1) {
      check("last unit exhausts the pool exactly: running total = sale total", runningTotal, sale.total);
      check("last unit exhausts discount exactly", runningDiscountShare, sale.discount);
    }
  }
  check("four 1-unit credits sum to sale total with no drift", runningTotal, sale.total);
}

// ---- 4. Crediting the WHOLE sale in one note returns exactly sale.total
{
  const calc = computeCreditNote({
    sale, items, priors: [], priorDiscountShare: 0, priorTotal: 0,
    lines: [{ saleItemId: "item1", quantity: 4, restock: true }],
  });
  check("whole sale: total equals sale.total", calc.total, sale.total);
  check("whole sale: discount share equals sale.discount", calc.discountShare, sale.discount);
}

// ---- 5. Price adjustment: a named net amount, VAT follows proportionally
{
  const calc = computeCreditNote({
    sale, items, priors: [], priorDiscountShare: 0, priorTotal: 0,
    lines: [{ saleItemId: "item1", quantity: 0, netAmount: 500, restock: false }],
  });
  check("price adjustment: net before discount", calc.netBeforeDiscount, 500);
  check("price adjustment: vat = 660 * 500/4000", calc.vatAmount, round2((660 * 500) / 4000));
  check("price adjustment: no cost restored (restock false)", calc.costRestored, 0);
}

// ---- 6. Balance-first application: partial balance means part of the credit is "already paid"
{
  const partlyPaidSale = { ...sale, balance: 300 }; // customer still owes 300 of the 4194
  const calc = computeCreditNote({
    sale: partlyPaidSale, items, priors: [], priorDiscountShare: 0, priorTotal: 0,
    lines: [{ saleItemId: "item1", quantity: 4, restock: true }],
  });
  check("applied to balance capped at what's owed", calc.appliedToBalance, 300);
  check("settled amount is the rest", calc.settledAmount, round2(calc.total - 300));
}

// ---- 7. Nothing owed at all: the whole credit needs settling
{
  const paidSale = { ...sale, balance: 0 };
  const calc = computeCreditNote({
    sale: paidSale, items, priors: [], priorDiscountShare: 0, priorTotal: 0,
    lines: [{ saleItemId: "item1", quantity: 2, restock: false }],
  });
  check("nothing owed: applied to balance is 0", calc.appliedToBalance, 0);
  check("nothing owed: settled amount equals total", calc.settledAmount, calc.total);
}

// ---- 8. Errors: over-crediting a quantity, an amount, or the whole sale
throws("over-credit quantity", () =>
  computeCreditNote({ sale, items, priors: [], priorDiscountShare: 0, priorTotal: 0, lines: [{ saleItemId: "item1", quantity: 5, restock: false }] }),
  "left to credit"
);
throws("over-credit amount", () =>
  computeCreditNote({ sale, items, priors: [], priorDiscountShare: 0, priorTotal: 0, lines: [{ saleItemId: "item1", quantity: 0, netAmount: 9000, restock: false }] }),
  "left to credit"
);
throws("restock without a quantity", () =>
  computeCreditNote({ sale, items, priors: [], priorDiscountShare: 0, priorTotal: 0, lines: [{ saleItemId: "item1", quantity: 0, netAmount: 100, restock: true }] }),
  "restock"
);
throws("empty lines", () =>
  computeCreditNote({ sale, items, priors: [], priorDiscountShare: 0, priorTotal: 0, lines: [] })
);
throws("duplicate sale item on one note", () =>
  computeCreditNote({
    sale, items, priors: [], priorDiscountShare: 0, priorTotal: 0,
    lines: [{ saleItemId: "item1", quantity: 1, restock: false }, { saleItemId: "item1", quantity: 1, restock: false }],
  }),
  "once"
);
throws("already fully credited (priorTotal = sale.total)", () =>
  computeCreditNote({ sale, items, priors: [{ saleItemId: "item1", quantity: 4, net: 3600, vatAmount: 660 }], priorDiscountShare: 400, priorTotal: 4194, lines: [{ saleItemId: "item1", quantity: 1, restock: false }] })
);

// ---- 9. Settlement planning
check("settlement: nothing to settle needs no method", planSettlement({ settledAmount: 0, hasCustomer: true }), { settlement: "NONE", cashAccountId: null });
check(
  "settlement: cash with an account",
  planSettlement({ settledAmount: 500, method: "CASH", hasCustomer: true, cashAccountId: "acct1" }),
  { settlement: "CASH", cashAccountId: "acct1" }
);
check(
  "settlement: customer credit",
  planSettlement({ settledAmount: 500, method: "CUSTOMER_CREDIT", hasCustomer: true }),
  { settlement: "CUSTOMER_CREDIT", cashAccountId: null }
);
throws("settlement: amount to settle but no method chosen", () => planSettlement({ settledAmount: 500, hasCustomer: true }));
throws("settlement: cash chosen but no account", () => planSettlement({ settledAmount: 500, method: "CASH", hasCustomer: true }));
throws("settlement: customer credit on a walk-in sale", () => planSettlement({ settledAmount: 500, method: "CUSTOMER_CREDIT", hasCustomer: false }), "walk-in");

// ---- 10. Sale status after balance
check("status: balance to zero becomes PAID", statusAfterBalance("PARTIAL", 0), "PAID");
check("status: balance remains, status unchanged", statusAfterBalance("CREDIT", 500), "CREDIT");
check("status: already PAID with tiny rounding residue stays PAID", statusAfterBalance("PAID", 0.005), "PAID");

// ---- 11. VAT roll-up
check(
  "rollUpForVat sums net by category, vat and total",
  rollUpForVat([
    { issuedAt: new Date(), netAmount: 900, vatAmount: 165, total: 1065, costRestored: 600, lines: [{ net: 900, vatAmount: 165, vatCategory: "STANDARD", quantity: 1, restock: true, unitCost: 600 }] },
    { issuedAt: new Date(), netAmount: 200, vatAmount: 0, total: 200, costRestored: 0, lines: [{ net: 200, vatAmount: 0, vatCategory: "ZERO_RATED", quantity: 2, restock: false, unitCost: 50 }] },
  ]),
  { count: 2, byCategory: { STANDARD: 900, ZERO_RATED: 200, EXEMPT: 0 }, vat: 165, total: round2(1065 + 200) }
);

console.log(`\n${total - failed}/${total} checks passed.`);
if (failed > 0) process.exit(1);
