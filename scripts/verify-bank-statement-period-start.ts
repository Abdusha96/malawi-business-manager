/**
 * Module 69: standalone checks for the recorded statement start date – the pure
 * additions in src/lib/bank-statement-csv.ts (classifyLineDate/flagOutOfPeriod with
 * a periodStart, nextDayYmd, validatePeriodStart, suggestPeriodStart).
 *   npx tsx scripts/verify-bank-statement-period-start.ts   (npm run verify:bank-statement-period-start)
 * No database; exits non-zero on any failure.
 */
import {
  classifyLineDate,
  flagOutOfPeriod,
  nextDayYmd,
  validatePeriodStart,
  suggestPeriodStart,
  OUT_OF_PERIOD_LOOKBACK_DAYS,
} from "../src/lib/bank-statement-csv";

export {};

let failed = 0,
  total = 0;
function check(name: string, actual: unknown, expected: unknown) {
  total++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}
const L = OUT_OF_PERIOD_LOOKBACK_DAYS;
const END = "2026-09-30";
const START = "2026-09-01";

// --- classifyLineDate with a start date (exact) ---
check("start: first day is inside", classifyLineDate("2026-09-01", END, L, START), null);
check("start: last day is inside", classifyLineDate("2026-09-30", END, L, START), null);
check("start: mid-period inside", classifyLineDate("2026-09-15", END, L, START), null);
check("start: one day before start flagged", classifyLineDate("2026-08-31", END, L, START), "BEFORE_START");
check("start: far before start flagged BEFORE_START, not LONG_BEFORE", classifyLineDate("2025-01-01", END, L, START), "BEFORE_START");
check("start: one day after end still AFTER_STATEMENT", classifyLineDate("2026-10-01", END, L, START), "AFTER_STATEMENT");
check("start: line on a one-day statement", classifyLineDate("2026-09-30", END, L, "2026-09-30"), null);
check("start: day before a one-day statement", classifyLineDate("2026-09-29", END, L, "2026-09-30"), "BEFORE_START");

// A quarterly statement with a known start must NOT be flagged by the 92-day guess.
check("quarter: 120 days before end but after start is fine", classifyLineDate("2026-06-02", END, L, "2026-06-01"), null);
check("quarter: same line, no start -> Module 64 guess", classifyLineDate("2026-06-02", END, L, null), "LONG_BEFORE");

// --- fallbacks: no / bad start behaves exactly like Module 64 ---
check("no start: omitted param", classifyLineDate("2026-08-31", END), null);
check("no start: null param", classifyLineDate("2026-08-31", END, L, null), null);
check("no start: long before heuristic", classifyLineDate("2026-05-01", END, L, null), "LONG_BEFORE");
check("no start: after statement", classifyLineDate("2026-10-01", END, L, null), "AFTER_STATEMENT");
check("bad start string ignored", classifyLineDate("2026-05-01", END, L, "not-a-date"), "LONG_BEFORE");
check("bad start never flags every row", classifyLineDate("2026-09-15", END, L, "garbage"), null);
check("unparseable line date -> null", classifyLineDate("nope", END, L, START), null);
check("unparseable statement date -> null", classifyLineDate("2026-09-15", "nope", L, START), null);

// --- flagOutOfPeriod ---
const rows = [{ lineDate: "2026-08-31" }, { lineDate: "2026-09-01" }, { lineDate: "2026-09-30" }, { lineDate: "2026-10-01" }];
check("flagOutOfPeriod with start", flagOutOfPeriod(rows, END, L, START).map((r) => r.periodFlag), ["BEFORE_START", null, null, "AFTER_STATEMENT"]);
check("flagOutOfPeriod without start", flagOutOfPeriod(rows, END).map((r) => r.periodFlag), [null, null, null, "AFTER_STATEMENT"]);
check("flagOutOfPeriod keeps row fields", flagOutOfPeriod([{ lineDate: "2026-09-10", x: 7 }], END, L, START)[0].x, 7);
check("flagOutOfPeriod empty", flagOutOfPeriod([], END, L, START), []);

// --- nextDayYmd ---
check("next: ordinary", nextDayYmd("2026-09-30"), "2026-10-01");
check("next: month end 31", nextDayYmd("2026-01-31"), "2026-02-01");
check("next: year end", nextDayYmd("2026-12-31"), "2027-01-01");
check("next: feb 28 non-leap", nextDayYmd("2026-02-28"), "2026-03-01");
check("next: feb 28 leap", nextDayYmd("2028-02-28"), "2028-02-29");
check("next: feb 29 leap", nextDayYmd("2028-02-29"), "2028-03-01");
check("next: impossible day rejected", nextDayYmd("2026-02-31"), null);
check("next: feb 29 non-leap rejected", nextDayYmd("2026-02-29"), null);
check("next: month 13 rejected", nextDayYmd("2026-13-01"), null);
check("next: wrong shape rejected", nextDayYmd("30/09/2026"), null);
check("next: empty rejected", nextDayYmd(""), null);

// --- validatePeriodStart ---
check("valid: start before end", validatePeriodStart("2026-09-01", END), null);
check("valid: start equals end (one-day statement)", validatePeriodStart("2026-09-30", END), null);
check("invalid: start after end", validatePeriodStart("2026-10-01", END), "The statement start date can't be after the statement date.");
check("invalid: start one day after end", validatePeriodStart("2026-10-01", "2026-09-30")?.includes("after"), true);
check("invalid: impossible start", validatePeriodStart("2026-02-30", END), "The statement start date isn't a valid date.");
check("invalid: garbage start", validatePeriodStart("x", END), "The statement start date isn't a valid date.");
check("invalid: garbage end", validatePeriodStart("2026-09-01", "x"), "The statement date isn't a valid date.");
check("valid: year-spanning", validatePeriodStart("2025-12-01", "2026-02-28"), null);

// --- suggestPeriodStart ---
check("suggest: day after the previous statement", suggestPeriodStart(["2026-08-31"], END), "2026-09-01");
check("suggest: picks the latest earlier one", suggestPeriodStart(["2026-06-30", "2026-08-31", "2026-07-31"], END), "2026-09-01");
check("suggest: order of input irrelevant", suggestPeriodStart(["2026-08-31", "2026-06-30"], END), "2026-09-01");
check("suggest: none -> null", suggestPeriodStart([], END), null);
check("suggest: same-day statement is not 'previous'", suggestPeriodStart(["2026-09-30"], END), null);
check("suggest: later statement ignored", suggestPeriodStart(["2026-10-31"], END), null);
check("suggest: later ignored, earlier used", suggestPeriodStart(["2026-10-31", "2026-08-31"], END), "2026-09-01");
check("suggest: month-end rollover", suggestPeriodStart(["2026-01-31"], "2026-02-28"), "2026-02-01");
check("suggest: year rollover", suggestPeriodStart(["2025-12-31"], "2026-01-31"), "2026-01-01");
check("suggest: previous is the day before end -> one-day statement", suggestPeriodStart(["2026-09-29"], END), "2026-09-30");
check("suggest: garbage dates skipped", suggestPeriodStart(["junk", "2026-08-31"], END), "2026-09-01");
check("suggest: only garbage -> null", suggestPeriodStart(["junk"], END), null);
check("suggest: garbage statement date -> null", suggestPeriodStart(["2026-08-31"], "junk"), null);
check("suggest result always validates", validatePeriodStart(suggestPeriodStart(["2026-08-31"], END)!, END), null);

// --- end-to-end shape: suggested start makes the previous statement's last day BEFORE_START ---
const s = suggestPeriodStart(["2026-08-31"], END);
check("suggested start excludes previous statement's last day", classifyLineDate("2026-08-31", END, L, s), "BEFORE_START");
check("suggested start includes its own first day", classifyLineDate("2026-09-01", END, L, s), null);

if (failed > 0) {
  console.error(`\n${failed} of ${total} checks FAILED`);
  process.exit(1);
}
console.log(`bank-statement-period-start: ${total}/${total} checks passed`);
