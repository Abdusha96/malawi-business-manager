/**
 * Module 37 – standalone checks for src/lib/pnl-layout.ts. No database, no
 * framework:  npx tsx scripts/verify-profit-and-loss.ts   (npm run verify:pnl)
 * Exits non-zero if any check fails.
 */
import { buildProfitAndLoss, PnlAccountActivity } from "../src/lib/pnl-layout";

let failed = 0, total = 0;
function check(name: string, actual: unknown, expected: unknown) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed++; console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`); }
}

const rev = (debit: number, credit: number): PnlAccountActivity => ({ code: "4000", name: "Sales Revenue", type: "REVENUE", normalBalance: "CREDIT", systemKey: "SALES_REVENUE", debit, credit });
const cogs = (d: number, c = 0): PnlAccountActivity => ({ code: "9999", name: "COGS renamed", type: "EXPENSE", normalBalance: "DEBIT", systemKey: "COST_OF_GOODS_SOLD", debit: d, credit: c });
const exp = (code: string, key: string | null, d: number, c = 0, name = "Expense " + code): PnlAccountActivity => ({ code, name, type: "EXPENSE", normalBalance: "DEBIT", systemKey: key, debit: d, credit: c });
const disposal = (d: number, c: number) => exp("5130", "GAIN_LOSS_ON_DISPOSAL_OF_ASSETS", d, c, "Gain/Loss on Disposal of Assets");
const bank = (d: number, c: number) => exp("5140", "BANK_CHARGES_AND_INTEREST", d, c, "Bank Charges & Interest");
const shrink = (d: number, c: number) => exp("5150", "INVENTORY_SHRINKAGE_AND_ADJUSTMENT", d, c, "Inventory Shrinkage & Adjustment");

// 1. Basic layout, COGS found by systemKey even when code/name changed
let r = buildProfitAndLoss([rev(0, 10000), cogs(4000), exp("5200", null, 1500)]);
check("cogs by systemKey", r.costOfGoodsSold, 4000);
check("gross", r.grossProfit, 6000);
check("opex total", r.totalOperatingExpenses, 1500);
check("operating profit", r.operatingProfit, 4500);
check("pbt equals operating when no other items", r.profitBeforeTax, 4500);
check("no other lines", [r.otherIncome.length, r.otherExpenses.length], [0, 0]);
check("cogs not in opex", r.operatingExpenses.map((l) => l.code), ["5200"]);

// 2. Disposal gain -> Other Income, out of operating expenses
r = buildProfitAndLoss([rev(0, 10000), exp("5200", null, 1500), disposal(0, 800)]);
check("gain in other income", r.otherIncome, [{ code: "5130", name: "Gain on Disposal of Assets", type: "EXPENSE", amount: 800 }]);
check("gain not negative opex", r.operatingExpenses.map((l) => l.code), ["5200"]);
check("operating profit excludes gain", r.operatingProfit, 8500);
check("pbt includes gain", r.profitBeforeTax, 9300);

// 3. Disposal loss -> Other Expenses
r = buildProfitAndLoss([rev(0, 10000), disposal(300, 0)]);
check("loss label", r.otherExpenses.map((l) => [l.name, l.amount]), [["Loss on Disposal of Assets", 300]]);
check("loss pbt", r.profitBeforeTax, 9700);

// 4. Net per account: gain 200 and loss 50 in the same period -> one net gain of 150
r = buildProfitAndLoss([disposal(50, 200)]);
check("net gain", r.otherIncome.map((l) => l.amount), [150]);
check("no expense side", r.otherExpenses.length, 0);

// 5. A voided charge (debit 500 then reversing credit 500) nets to nothing on BOTH sides
r = buildProfitAndLoss([bank(500, 500)]);
check("reversal shows nothing", [r.otherIncome.length, r.otherExpenses.length, r.profitBeforeTax], [0, 0, 0]);

// 6. Bank: interest earned vs charges
check("interest label", buildProfitAndLoss([bank(15, 40)]).otherIncome.map((l) => [l.name, l.amount]), [["Bank Interest Earned", 25]]);
check("charges label", buildProfitAndLoss([bank(60, 10)]).otherExpenses.map((l) => [l.name, l.amount]), [["Bank Charges & Interest", 50]]);

// 7. Shrinkage stays operating, including a net-found (negative) period
r = buildProfitAndLoss([rev(0, 1000), shrink(0, 120)]);
check("found stock stays in opex", r.operatingExpenses.map((l) => [l.code, l.amount]), [["5150", -120]]);
check("found stock raises operating profit", r.operatingProfit, 1120);
check("no other lines for shrinkage", [r.otherIncome.length, r.otherExpenses.length], [0, 0]);

// 8. THE invariant: profitBeforeTax == sum of every account's (credit - debit), which is
//    what the Balance Sheet's retained earnings must equal for the sheet to balance.
const mixed: PnlAccountActivity[] = [
  rev(20, 12345.67), cogs(5000.5), exp("5100", "SALARY_EXPENSE", 2000), exp("5200", null, 333.33),
  shrink(10, 70), disposal(0, 1200), bank(45.5, 12.25), exp("5160", "TAX_PENALTIES_AND_INTEREST", 90),
];
r = buildProfitAndLoss(mixed);
const raw = Math.round(mixed.reduce((s, a) => s + (a.credit - a.debit), 0) * 100) / 100;
check("pbt equals raw net of all accounts", r.profitBeforeTax, raw);

// 9. Old behaviour preserved: old operatingProfit (all EXPENSE accounts in opex) == new pbt
const oldOperating = Math.round((mixed.filter((a) => a.type === "REVENUE").reduce((s, a) => s + a.credit - a.debit, 0)
  - mixed.filter((a) => a.type === "EXPENSE").reduce((s, a) => s + a.debit - a.credit, 0)) * 100) / 100;
check("new pbt equals old operating profit", r.profitBeforeTax, oldOperating);

// 10. Non-operating key on a non-EXPENSE row is not reclassified; zero-amount rows dropped
r = buildProfitAndLoss([exp("5200", null, 0), disposal(0, 0)]);
check("zero rows dropped", [r.operatingExpenses.length, r.otherIncome.length, r.otherExpenses.length], [0, 0, 0]);

console.log(`${total - failed}/${total} checks passed`);
if (failed) process.exit(1);
