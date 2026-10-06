/**
 * Module 67: standalone checks for the pure tax-installment logic. No
 * database, no framework:
 *   npx tsx scripts/verify-tax-installments.ts   (npm run verify:tax-installments)
 * Exits non-zero if any check fails.
 *
 * Covers src/lib/tax-installments.ts directly. createTaxPayment() itself pulls
 * in Prisma at module scope and can't be exercised here (same reason the
 * stock-transfer verify scripts only test the pure half).
 */
import {
  supportsInstallments,
  toTambala,
  summarizeSettlement,
  installmentKey,
  decideInstallment,
  InstallmentRow,
} from "../src/lib/tax-installments";

let failed = 0,
  total = 0;
function check(name: string, actual: unknown, expected: unknown) {
  total++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}

const row = (installmentNo: number, principalAmount: number, settlesPeriod = false): InstallmentRow => ({ installmentNo, principalAmount, settlesPeriod });

// --- supportsInstallments ---
check("PAYE supports", supportsInstallments("PAYE"), true);
check("WHT supports", supportsInstallments("WITHHOLDING_TAX"), true);
check("provisional supports", supportsInstallments("PROVISIONAL_TAX"), true);
check("annual supports", supportsInstallments("ANNUAL_INCOME_TAX"), true);
check("VAT does not", supportsInstallments("VAT"), false);
check("unknown does not", supportsInstallments("NOPE"), false);

// --- toTambala ---
check("tambala plain", toTambala(12.34), 1234);
check("tambala float noise", toTambala(0.1 + 0.2), 30);
check("tambala NaN is 0", toTambala(NaN), 0);
check("tambala Infinity is 0", toTambala(Infinity), 0);
check("tambala negative", toTambala(-1.5), -150);

// --- summarizeSettlement ---
{
  const s = summarizeSettlement(1000, []);
  check("none: count", s.count, 0);
  check("none: not settled", s.settled, false);
  check("none: not partial", s.partiallyPaid, false);
  check("none: remaining is expected", s.remaining, 1000);
  check("none: next is 1", s.nextInstallmentNo, 1);
}
{
  const s = summarizeSettlement(1000, [row(1, 400)]);
  check("part: paid", s.paid, 400);
  check("part: remaining", s.remaining, 600);
  check("part: partiallyPaid", s.partiallyPaid, true);
  check("part: not settled", s.settled, false);
  check("part: next is 2", s.nextInstallmentNo, 2);
}
{
  const s = summarizeSettlement(1000, [row(1, 400), row(2, 600)]);
  check("reached figure: settled", s.settled, true);
  check("reached figure: remaining 0", s.remaining, 0);
  check("reached figure: not partial", s.partiallyPaid, false);
  check("reached figure: next is 3", s.nextInstallmentNo, 3);
}
{
  const s = summarizeSettlement(1000, [row(1, 400), row(2, 100, true)]);
  check("closed by flag below figure: settled", s.settled, true);
  check("closed by flag: remaining still shown", s.remaining, 500);
  check("closed by flag: not partial", s.partiallyPaid, false);
}
{
  // A legacy single payment (settlesPeriod default true) for less than the live estimate.
  const s = summarizeSettlement(5000, [row(1, 1200, true)]);
  check("legacy payment below estimate stays settled", s.settled, true);
}
{
  const s = summarizeSettlement(0, [row(1, 50)]);
  check("zero expected: any payment settles", s.settled, true);
  check("zero expected: none is not settled", summarizeSettlement(0, []).settled, false);
}
{
  const s = summarizeSettlement(0.3, [row(1, 0.1), row(2, 0.2)]);
  check("0.1+0.2 reaches 0.3", s.settled, true);
  check("0.1+0.2 no phantom remainder", s.remaining, 0);
}
{
  const s = summarizeSettlement(1000, [row(1, 400), row(3, 100)]);
  check("gap in numbering: next is max+1", s.nextInstallmentNo, 4);
}
check("negative expected treated as zero", summarizeSettlement(-50, [row(1, 10)]).settled, true);

// --- installmentKey ---
check("key 1 keeps legacy format", installmentKey("b1", "PAYE", "2026-01", 1), "b1|PAYE|2026-01");
check("key 2 appends", installmentKey("b1", "PAYE", "2026-01", 2), "b1|PAYE|2026-01|2");
check("key 7 appends", installmentKey("b1", "WITHHOLDING_TAX", "2026-03", 7), "b1|WITHHOLDING_TAX|2026-03|7");
check("key 0 is treated as 1", installmentKey("b1", "PAYE", "2026-01", 0), "b1|PAYE|2026-01");

// --- decideInstallment: first payment ---
{
  const d = decideInstallment({ taxType: "PAYE", expected: 1000, rows: [], principal: 1000, partial: false });
  check("full first payment ok", d.ok, true);
  if (d.ok) {
    check("full first: settles", d.settlesPeriod, true);
    check("full first: number 1", d.installmentNo, 1);
    check("full first: remainingAfter 0", d.remainingAfter, 0);
  }
}
{
  const d = decideInstallment({ taxType: "PAYE", expected: 1000, rows: [], principal: 1500, partial: false });
  check("first payment above estimate keeps historic freedom", d.ok, true);
  if (d.ok) check("above estimate settles", d.settlesPeriod, true);
}
{
  const d = decideInstallment({ taxType: "PAYE", expected: 1000, rows: [], principal: 400, partial: true });
  check("part-payment ok", d.ok, true);
  if (d.ok) {
    check("part-payment does not settle", d.settlesPeriod, false);
    check("part-payment remainingAfter", d.remainingAfter, 600);
    check("part-payment number 1", d.installmentNo, 1);
  }
}
{
  const d = decideInstallment({ taxType: "PAYE", expected: 1000, rows: [], principal: 1200, partial: true });
  check("part-payment over the figure refused", d.ok, false);
  if (!d.ok) check("over-figure message names the amount owed", d.message.includes("1,000"), true);
}
{
  const d = decideInstallment({ taxType: "PAYE", expected: 1000, rows: [], principal: 1000, partial: true });
  check("part-payment of everything is really final", d.ok && d.settlesPeriod, true);
}
{
  const d = decideInstallment({ taxType: "PAYE", expected: 0, rows: [], principal: 300, partial: true });
  check("part-payment against zero estimate is allowed", d.ok, true);
  if (d.ok) check("zero estimate part-payment not flagged final", d.settlesPeriod, false);
}

// --- decideInstallment: later payments ---
{
  const rows = [row(1, 400)];
  const d = decideInstallment({ taxType: "PAYE", expected: 1000, rows, principal: 300, partial: true });
  check("second part-payment ok", d.ok, true);
  if (d.ok) {
    check("second: number 2", d.installmentNo, 2);
    check("second: remainingAfter", d.remainingAfter, 300);
    check("second: still open", d.settlesPeriod, false);
  }
}
{
  const d = decideInstallment({ taxType: "PAYE", expected: 1000, rows: [row(1, 400)], principal: 600, partial: false });
  check("final payment ok", d.ok, true);
  if (d.ok) {
    check("final: settles", d.settlesPeriod, true);
    check("final: number 2", d.installmentNo, 2);
  }
}
{
  const d = decideInstallment({ taxType: "PAYE", expected: 1000, rows: [row(1, 400)], principal: 700, partial: false });
  check("non-partial second payment must fit too", d.ok, false);
  if (!d.ok) check("names what is left", d.message.includes("600"), true);
}
{
  const d = decideInstallment({ taxType: "PAYE", expected: 1000, rows: [row(1, 400)], principal: 600, partial: true });
  check("part-payment that exactly clears the rest is final", d.ok && d.settlesPeriod, true);
}
{
  const d = decideInstallment({ taxType: "PAYE", expected: 1000, rows: [row(1, 400), row(2, 600)], principal: 1, partial: true });
  check("settled period refuses more (by figure)", d.ok, false);
}
{
  const d = decideInstallment({ taxType: "PAYE", expected: 1000, rows: [row(1, 200, true)], principal: 50, partial: false });
  check("settled period refuses more (by flag)", d.ok, false);
  if (!d.ok) check("settled message points at penalty/void", d.message.includes("penalty"), true);
}
{
  const d = decideInstallment({ taxType: "PAYE", expected: 0.3, rows: [row(1, 0.1)], principal: 0.2, partial: true });
  check("0.1 then 0.2 against 0.3 is final, no float residue", d.ok && d.settlesPeriod, true);
}
{
  const d = decideInstallment({ taxType: "PAYE", expected: 1000, rows: [row(1, 400), row(3, 100)], principal: 100, partial: true });
  check("numbering continues past a gap", d.ok && d.installmentNo, 4);
}

// --- decideInstallment: input rules ---
check("zero principal refused", decideInstallment({ taxType: "PAYE", expected: 100, rows: [], principal: 0, partial: false }).ok, false);
check("negative principal refused", decideInstallment({ taxType: "PAYE", expected: 100, rows: [], principal: -5, partial: false }).ok, false);
check("NaN principal refused", decideInstallment({ taxType: "PAYE", expected: 100, rows: [], principal: NaN, partial: false }).ok, false);
check("sub-tambala principal refused", decideInstallment({ taxType: "PAYE", expected: 100, rows: [], principal: 0.004, partial: false }).ok, false);

// --- decideInstallment: VAT and the other types ---
{
  const d = decideInstallment({ taxType: "VAT", expected: 500, rows: [], principal: 500, partial: false });
  check("VAT single payment ok", d.ok, true);
  if (d.ok) check("VAT is instalment 1 and final", [d.installmentNo, d.settlesPeriod], [1, true]);
}
check("VAT part-payment refused", decideInstallment({ taxType: "VAT", expected: 500, rows: [], principal: 100, partial: true }).ok, false);
check("VAT second payment refused", decideInstallment({ taxType: "VAT", expected: 500, rows: [row(1, 500, true)], principal: 10, partial: false }).ok, false);
for (const t of ["WITHHOLDING_TAX", "PROVISIONAL_TAX", "ANNUAL_INCOME_TAX"]) {
  const d = decideInstallment({ taxType: t, expected: 800, rows: [row(1, 300)], principal: 500, partial: false });
  check(`${t} completes after a part-payment`, d.ok && d.settlesPeriod && d.installmentNo === 2, true);
}

// --- a realistic sequence end to end ---
{
  const rows: InstallmentRow[] = [];
  let expected = 12_500.5;
  const steps: [number, boolean][] = [[5000, true], [4000.25, true], [3500.25, false]];
  const outcomes: unknown[] = [];
  for (const [amount, partial] of steps) {
    const d = decideInstallment({ taxType: "PAYE", expected, rows, principal: amount, partial });
    outcomes.push(d.ok);
    if (d.ok) rows.push({ installmentNo: d.installmentNo, principalAmount: d.principal, settlesPeriod: d.settlesPeriod });
  }
  check("three-step sequence all accepted", outcomes, [true, true, true]);
  const s = summarizeSettlement(expected, rows);
  check("sequence: settled", s.settled, true);
  check("sequence: paid the whole figure", s.paid, 12_500.5);
  check("sequence: 3 payments", s.count, 3);
  // Voiding installment 2 re-opens the period, because settlement is computed live from the rows left.
  const afterVoid = summarizeSettlement(expected, rows.filter((r) => r.installmentNo !== 2));
  check("voiding a middle installment leaves the final flag settling it", afterVoid.settled, true);
  const partOnly = rows.map((r) => ({ ...r, settlesPeriod: false })).filter((r) => r.installmentNo !== 2);
  const reopened = summarizeSettlement(expected, partOnly);
  check("voiding a middle part-payment re-opens the period", reopened.partiallyPaid, true);
  check("re-opened remaining", reopened.remaining, 4000.25);
  check("re-opened next number", reopened.nextInstallmentNo, 4);
}

console.log(`${total - failed}/${total} checks passed`);
if (failed > 0) process.exit(1);
