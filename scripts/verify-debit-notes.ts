/**
 * Module 44: standalone checks for Supplier Debit Notes. No database, no framework:
 *   npx tsx scripts/verify-debit-notes.ts   (npm run verify:debit-notes)
 * Exits non-zero if any check fails.
 *
 * Covers the pure math in src/lib/debit-note-calc.ts: pool draw-down across repeated debits, the
 * exact-remainder rule on the last unit, price adjustments, balance-first application, settlement
 * planning, and the VAT roll-up. Mirrors scripts/verify-credit-notes.ts, minus the discount-share
 * checks (Purchase has no discount field – see debit-note-calc.ts's doc comment). Does NOT exercise
 * Postgres: the purchase-row lock that serialises a debit note against another debit note, a payment
 * or a void is described in the README, with a manual two-request test (same pattern Module 42 used).
 */
import {
  computeDebitNote, computePools, planSettlement, statusAfterBalance, rollUpForVat,
  round2, DebitNoteCalcError, PurchaseItemForDebit, PriorDebitLine,
} from "../src/lib/debit-note-calc";

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
    if (!(e instanceof DebitNoteCalcError)) {
      failed++;
      console.error(`FAIL ${name}: threw ${(e as Error).name}, not DebitNoteCalcError`);
    } else if (messageIncludes && !e.message.includes(messageIncludes)) {
      failed++;
      console.error(`FAIL ${name}: message "${e.message}" did not include "${messageIncludes}"`);
    }
  }
}

// ---- Fixture: a purchase of 4 units at 1,000 net each (VAT 16.5% = 165/unit), no discount (Purchase
// has none), subtotal 4,000, total = 4000 + 660 = 4660.
const items: PurchaseItemForDebit[] = [
  { id: "item1", productName: "Bag of Cement", quantity: 4, total: 4000, vatAmount: 660, vatCategory: "STANDARD", unitCost: 1000, isStocked: true },
];
const purchase = { total: 4660, balance: 4660 };

// ---- 1. Pools with no prior debits equal the purchase's own items
check("pool with no priors", computePools(items, []), [
  { purchaseItemId: "item1", productName: "Bag of Cement", quantity: 4, net: 4000, vatAmount: 660 },
]);

// ---- 2. Proportional return: 1 of 4 units takes a quarter of the pool
{
  const calc = computeDebitNote({
    purchase, items, priors: [], priorTotal: 0,
    lines: [{ purchaseItemId: "item1", quantity: 1, stockOut: true }],
  });
  check("1 of 4 units: net", calc.netAmount, 1000);
  check("1 of 4 units: vat", calc.vatAmount, 165);
  check("1 of 4 units: total", calc.total, round2(1000 + 165));
  check("1 of 4 units: stockOut carried through", calc.lines[0].stockOut, true);
}

// ---- 3. Repeated debits draw the pool down; the LAST unit takes exactly what is left, no rounding drift
{
  const priors: PriorDebitLine[] = [];
  let runningTotal = 0;
  for (let i = 0; i < 4; i++) {
    const remainingQty = 4 - i;
    const calc = computeDebitNote({
      purchase, items, priors, priorTotal: runningTotal,
      lines: [{ purchaseItemId: "item1", quantity: 1, stockOut: false }],
    });
    priors.push({ purchaseItemId: "item1", quantity: 1, net: calc.lines[0].net, vatAmount: calc.lines[0].vatAmount });
    runningTotal = round2(runningTotal + calc.total);
    if (remainingQty === 1) {
      check("last unit exhausts the pool exactly: running total = purchase total", runningTotal, purchase.total);
    }
  }
  check("four 1-unit debits sum to purchase total with no drift", runningTotal, purchase.total);
}

// ---- 4. Debiting the WHOLE purchase in one note returns exactly purchase.total
{
  const calc = computeDebitNote({
    purchase, items, priors: [], priorTotal: 0,
    lines: [{ purchaseItemId: "item1", quantity: 4, stockOut: true }],
  });
  check("whole purchase: total equals purchase.total", calc.total, purchase.total);
  check("whole purchase: net equals item total (no discount to share)", calc.netAmount, 4000);
}

// ---- 5. Price adjustment: a named net amount, VAT follows proportionally, no stock moves
{
  const calc = computeDebitNote({
    purchase, items, priors: [], priorTotal: 0,
    lines: [{ purchaseItemId: "item1", quantity: 0, netAmount: 500, stockOut: false }],
  });
  check("price adjustment: net", calc.netAmount, 500);
  check("price adjustment: vat = 660 * 500/4000", calc.vatAmount, round2((660 * 500) / 4000));
  check("price adjustment: quantity is 0 (nothing physically returned)", calc.lines[0].quantity, 0);
}

// ---- 6. Balance-first application: partial balance means part of the debit is "already paid"
{
  const partlyPaidPurchase = { ...purchase, balance: 300 }; // we still owe 300 of the 4660
  const calc = computeDebitNote({
    purchase: partlyPaidPurchase, items, priors: [], priorTotal: 0,
    lines: [{ purchaseItemId: "item1", quantity: 4, stockOut: true }],
  });
  check("applied to balance capped at what's owed", calc.appliedToBalance, 300);
  check("settled amount is the rest", calc.settledAmount, round2(calc.total - 300));
}

// ---- 7. Nothing owed at all: the whole debit needs settling
{
  const paidPurchase = { ...purchase, balance: 0 };
  const calc = computeDebitNote({
    purchase: paidPurchase, items, priors: [], priorTotal: 0,
    lines: [{ purchaseItemId: "item1", quantity: 2, stockOut: false }],
  });
  check("nothing owed: applied to balance is 0", calc.appliedToBalance, 0);
  check("nothing owed: settled amount equals total", calc.settledAmount, calc.total);
}

// ---- 8. Errors: over-debiting a quantity, an amount, or the whole purchase
throws("over-debit quantity", () =>
  computeDebitNote({ purchase, items, priors: [], priorTotal: 0, lines: [{ purchaseItemId: "item1", quantity: 5, stockOut: false }] }),
  "left to debit"
);
throws("over-debit amount", () =>
  computeDebitNote({ purchase, items, priors: [], priorTotal: 0, lines: [{ purchaseItemId: "item1", quantity: 0, netAmount: 9000, stockOut: false }] }),
  "left to debit"
);
throws("stockOut without a quantity", () =>
  computeDebitNote({ purchase, items, priors: [], priorTotal: 0, lines: [{ purchaseItemId: "item1", quantity: 0, netAmount: 100, stockOut: true }] }),
  "sent back"
);
throws("empty lines", () =>
  computeDebitNote({ purchase, items, priors: [], priorTotal: 0, lines: [] })
);
throws("duplicate purchase item on one note", () =>
  computeDebitNote({
    purchase, items, priors: [], priorTotal: 0,
    lines: [{ purchaseItemId: "item1", quantity: 1, stockOut: false }, { purchaseItemId: "item1", quantity: 1, stockOut: false }],
  }),
  "once"
);
throws("already fully debited (priorTotal = purchase.total)", () =>
  computeDebitNote({ purchase, items, priors: [{ purchaseItemId: "item1", quantity: 4, net: 4000, vatAmount: 660 }], priorTotal: 4660, lines: [{ purchaseItemId: "item1", quantity: 1, stockOut: false }] })
);

// ---- 9. Settlement planning
check("settlement: nothing to settle needs no method", planSettlement({ settledAmount: 0 }), { settlement: "NONE", cashAccountId: null });
check(
  "settlement: cash with an account",
  planSettlement({ settledAmount: 500, method: "CASH", cashAccountId: "acct1" }),
  { settlement: "CASH", cashAccountId: "acct1" }
);
check(
  "settlement: supplier credit",
  planSettlement({ settledAmount: 500, method: "SUPPLIER_CREDIT" }),
  { settlement: "SUPPLIER_CREDIT", cashAccountId: null }
);
throws("settlement: amount to settle but no method chosen", () => planSettlement({ settledAmount: 500 }));
throws("settlement: cash chosen but no account", () => planSettlement({ settledAmount: 500, method: "CASH" }));

// ---- 10. Purchase status after balance
check("status: balance to zero becomes PAID", statusAfterBalance("PARTIAL", 0), "PAID");
check("status: balance remains, status unchanged", statusAfterBalance("CREDIT", 500), "CREDIT");
check("status: already PAID with tiny rounding residue stays PAID", statusAfterBalance("PAID", 0.005), "PAID");

// ---- 11. VAT roll-up
check(
  "rollUpForVat sums net by category, vat and total",
  rollUpForVat([
    { issuedAt: new Date(), netAmount: 900, vatAmount: 165, total: 1065, lines: [{ net: 900, vatAmount: 165, vatCategory: "STANDARD", quantity: 1, stockOut: true, unitCost: 900 }] },
    { issuedAt: new Date(), netAmount: 200, vatAmount: 0, total: 200, lines: [{ net: 200, vatAmount: 0, vatCategory: "ZERO_RATED", quantity: 2, stockOut: false, unitCost: 100 }] },
  ]),
  { count: 2, byCategory: { STANDARD: 900, ZERO_RATED: 200, EXEMPT: 0 }, vat: 165, total: round2(1065 + 200) }
);

console.log(`\n${total - failed}/${total} checks passed.`);
if (failed > 0) process.exit(1);
