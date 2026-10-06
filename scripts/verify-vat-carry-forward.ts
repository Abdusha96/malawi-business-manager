/**
 * Module 47: standalone checks for VAT Carry-Forward Credit Netting. No
 * database, no framework:
 *   npx tsx scripts/verify-vat-carry-forward.ts   (npm run verify:vat-carry-forward)
 * Exits non-zero if any check fails.
 *
 * Covers the pure calendar-key arithmetic and summation in
 * src/lib/vat-carry-forward.ts – the orchestration in
 * src/lib/tax-payments.ts::getVatCarryForward pulls in Prisma at module
 * scope and can't be exercised here, the same reason
 * scripts/verify-vat-refunds.ts only tests resolveVatDirection directly.
 */
import { nextMonthKey, enumerateMonthKeysBetween, sumCarryForward, MAX_CARRY_FORWARD_MONTHS } from "../src/lib/vat-carry-forward";

let failed = 0,
  total = 0;
function check(name: string, actual: unknown, expected: unknown) {
  total++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}

// ---- nextMonthKey ----
check("ordinary month roll", nextMonthKey("2026-03"), "2026-04");
check("year rollover, December -> January", nextMonthKey("2026-12"), "2027-01");
check("January -> February (no rollover)", nextMonthKey("2026-01"), "2026-02");

// ---- enumerateMonthKeysBetween ----
check("empty range (from === to)", enumerateMonthKeysBetween("2026-05", "2026-05"), []);
check("empty range (from > to)", enumerateMonthKeysBetween("2026-06", "2026-05"), []);
check("single month", enumerateMonthKeysBetween("2026-05", "2026-06"), ["2026-05"]);
check("several months, same year", enumerateMonthKeysBetween("2026-01", "2026-04"), ["2026-01", "2026-02", "2026-03"]);
check("spans a year boundary", enumerateMonthKeysBetween("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01"]);
check("exclusive of the `to` key itself", enumerateMonthKeysBetween("2026-01", "2026-03").includes("2026-03"), false);
check("inclusive of the `from` key itself", enumerateMonthKeysBetween("2026-01", "2026-03").includes("2026-01"), true);
{
  // A gap longer than MAX_CARRY_FORWARD_MONTHS should still enumerate every month in full –
  // truncation is the CALLER's job (src/lib/tax-payments.ts slices the result), not this
  // pure function's. 50 months, well past the 36-month cap.
  const keys = enumerateMonthKeysBetween("2020-01", "2024-03");
  check("long gap enumerates every month (caller truncates, not this function)", keys.length, 50);
  check("long gap starts at the from key", keys[0], "2020-01");
  check("long gap ends just before the to key", keys[keys.length - 1], "2024-02");
}

// ---- sumCarryForward ----
check("sum of nothing is zero", sumCarryForward([]), 0);
check("sum of one payable period", sumCarryForward([1200]), 1200);
check("sum of one refundable period", sumCarryForward([-450]), -450);
check("mixed periods net correctly", sumCarryForward([1000, -400, 250]), 850);
check("mixed periods can net to a credit overall", sumCarryForward([100, -900]), -800);
check("rounds to 2dp against float drift", sumCarryForward([0.1, 0.2]), 0.3);
check("exact zero when perfectly offsetting", sumCarryForward([500, -500]), 0);

// ---- sanity on the exported cap itself ----
check("MAX_CARRY_FORWARD_MONTHS is a sane positive bound", MAX_CARRY_FORWARD_MONTHS > 0 && MAX_CARRY_FORWARD_MONTHS <= 120, true);

console.log(`${total - failed}/${total} checks passed`);
if (failed > 0) process.exit(1);
