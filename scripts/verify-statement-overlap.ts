/**
 * Module 70: standalone checks for the cross-statement checks in
 * src/lib/statement-overlap.ts (overlapping periods, lines repeated from another
 * statement, the query date span) plus the interaction with Module 62's own
 * within-statement duplicate flag.
 *   npx tsx scripts/verify-statement-overlap.ts   (npm run verify:statement-overlap)
 * No database; exits non-zero on any failure.
 */
import {
  findOverlappingStatements,
  describeOverlap,
  flagRepeatsOfOtherStatements,
  repeatKey,
  lineDateSpan,
} from "../src/lib/statement-overlap";
import { statementLineKey, flagDuplicates } from "../src/lib/bank-statement-csv";

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

const P = (id: string, periodStart: string | null, statementDate: string) => ({ id, periodStart, statementDate });
const CUR = { periodStart: "2026-09-01", statementDate: "2026-09-30" };

// --- overlap: no overlap ---
check("adjacent months do not overlap", findOverlappingStatements(CUR, [P("a", "2026-08-01", "2026-08-31")]).overlaps, []);
check("adjacent: nothing not-comparable", findOverlappingStatements(CUR, [P("a", "2026-08-01", "2026-08-31")]).notComparable, 0);
check("later month does not overlap", findOverlappingStatements(CUR, [P("a", "2026-10-01", "2026-10-31")]).overlaps, []);
check("no other statements", findOverlappingStatements(CUR, []), { overlaps: [], notComparable: 0 });

// --- overlap: real overlaps ---
const one = findOverlappingStatements(CUR, [P("a", "2026-08-15", "2026-09-05")]).overlaps;
check("partial overlap found", one.length, 1);
check("partial overlap start/end", [one[0].overlapStart, one[0].overlapEnd], ["2026-09-01", "2026-09-05"]);
check("partial overlap days inclusive", one[0].overlapDays, 5);
check("shared single boundary day counts as 1", findOverlappingStatements(CUR, [P("a", "2026-08-01", "2026-09-01")]).overlaps[0].overlapDays, 1);
check("shared last day counts as 1", findOverlappingStatements(CUR, [P("a", "2026-09-30", "2026-10-31")]).overlaps[0].overlapDays, 1);
check("identical period = whole overlap", findOverlappingStatements(CUR, [P("a", "2026-09-01", "2026-09-30")]).overlaps[0].overlapDays, 30);
check("other contains current", findOverlappingStatements(CUR, [P("a", "2026-01-01", "2026-12-31")]).overlaps[0].overlapDays, 30);
check("current contains other", findOverlappingStatements(CUR, [P("a", "2026-09-10", "2026-09-12")]).overlaps[0].overlapDays, 3);
check("one-day statements on the same day", findOverlappingStatements({ periodStart: "2026-09-30", statementDate: "2026-09-30" }, [P("a", "2026-09-30", "2026-09-30")]).overlaps[0].overlapDays, 1);
check("one-day statements on different days", findOverlappingStatements({ periodStart: "2026-09-30", statementDate: "2026-09-30" }, [P("a", "2026-09-29", "2026-09-29")]).overlaps, []);
check("overlap across a leap-day boundary", findOverlappingStatements({ periodStart: "2028-02-28", statementDate: "2028-03-02" }, [P("a", "2028-02-01", "2028-02-29")]).overlaps[0].overlapDays, 2);
check("overlap across a year boundary", findOverlappingStatements({ periodStart: "2026-12-25", statementDate: "2027-01-10" }, [P("a", "2026-12-01", "2026-12-31")]).overlaps[0].overlapDays, 7);

// --- overlap: sorting and multiple ---
const many = findOverlappingStatements(CUR, [P("z", "2026-09-20", "2026-10-10"), P("m", "2026-08-20", "2026-09-02"), P("q", "2026-07-01", "2026-07-31")]);
check("several overlaps sorted oldest first", many.overlaps.map((o) => o.id), ["m", "z"]);
check("non-overlapping ignored among several", many.notComparable, 0);
check("same statement date ties broken by id", findOverlappingStatements(CUR, [P("b", "2026-09-05", "2026-09-30"), P("a", "2026-09-06", "2026-09-30")]).overlaps.map((o) => o.id), ["a", "b"]);

// --- overlap: cannot compare ---
const nc = findOverlappingStatements(CUR, [P("a", null, "2026-09-15"), P("b", "2026-09-10", "2026-09-20")]);
check("unknown-start other is counted, never guessed", nc.notComparable, 1);
check("known one still compared", nc.overlaps.map((o) => o.id), ["b"]);
check("current has no start -> nothing compared", findOverlappingStatements({ periodStart: null, statementDate: "2026-09-30" }, [P("a", "2026-09-01", "2026-09-30"), P("b", null, "2026-08-31")]), { overlaps: [], notComparable: 2 });
check("current bad start -> nothing compared", findOverlappingStatements({ periodStart: "junk", statementDate: "2026-09-30" }, [P("a", "2026-09-01", "2026-09-30")]).notComparable, 1);
check("current start after end -> unusable", findOverlappingStatements({ periodStart: "2026-10-05", statementDate: "2026-09-30" }, [P("a", "2026-09-01", "2026-09-30")]), { overlaps: [], notComparable: 1 });
check("other with start after end is not comparable", findOverlappingStatements(CUR, [P("a", "2026-09-20", "2026-09-10")]), { overlaps: [], notComparable: 1 });
check("other with impossible date is not comparable", findOverlappingStatements(CUR, [P("a", "2026-02-31", "2026-09-10")]).notComparable, 1);
check("current impossible date -> unusable", findOverlappingStatements({ periodStart: "2026-02-30", statementDate: "2026-09-30" }, [P("a", "2026-09-01", "2026-09-30")]).notComparable, 1);

// --- describeOverlap ---
check("describe plural", describeOverlap(one[0]), "2026-08-15 to 2026-09-05 (5 days shared)");
check("describe singular", describeOverlap(findOverlappingStatements(CUR, [P("a", "2026-08-01", "2026-09-01")]).overlaps[0]), "2026-08-01 to 2026-09-01 (1 day shared)");

// --- repeat key stays identical to Module 62's key ---
const samples = [
  { lineDate: "2026-09-03", description: "  Airtel  MONEY   ", amount: -500 },
  { lineDate: "2026-09-03", description: "airtel money", amount: -500.004 },
  { lineDate: "2026-09-04", description: "Salary", amount: 1234.5 },
];
for (const [i, sm] of samples.entries()) check(`repeatKey == statementLineKey #${i}`, repeatKey(sm), statementLineKey(sm));
check("key ignores case and spacing", repeatKey(samples[0]), repeatKey({ lineDate: "2026-09-03", description: "airtel money", amount: -500 }));

// --- repeats of other statements ---
const row = (n: number, d: string, desc: string, amt: number) => ({ rowNumber: n, lineDate: d, description: desc, amount: amt });
const other = [
  { lineDate: "2026-09-03", description: "Airtel Money", amount: -500 },
  { lineDate: "2026-09-04", description: "Salary", amount: 1000 },
];
const rows = [row(1, "2026-09-03", "airtel  money", -500), row(2, "2026-09-04", "Salary", 1000), row(3, "2026-09-05", "New", 10)];
const f = flagRepeatsOfOtherStatements(rows, other);
check("repeats: matching rows flagged", f.map((r) => r.repeatsOtherStatement), [true, true, false]);
check("repeats: original fields kept", f[0].rowNumber, 1);
check("repeats: input not mutated", "repeatsOtherStatement" in rows[0], false);
check("repeats: different amount not flagged", flagRepeatsOfOtherStatements([row(1, "2026-09-03", "Airtel Money", -501)], other)[0].repeatsOtherStatement, false);
check("repeats: different date not flagged", flagRepeatsOfOtherStatements([row(1, "2026-09-02", "Airtel Money", -500)], other)[0].repeatsOtherStatement, false);
check("repeats: different description not flagged", flagRepeatsOfOtherStatements([row(1, "2026-09-03", "Airtel Money 2", -500)], other)[0].repeatsOtherStatement, false);
check("repeats: none elsewhere", flagRepeatsOfOtherStatements(rows, []).map((r) => r.repeatsOtherStatement), [false, false, false]);
check("repeats: no rows", flagRepeatsOfOtherStatements([], other), []);

// count-aware
const twoOther = [other[0], other[0]];
const threeRows = [row(1, "2026-09-03", "Airtel Money", -500), row(2, "2026-09-03", "Airtel Money", -500), row(3, "2026-09-03", "Airtel Money", -500)];
check("count-aware: two elsewhere flags first two of three", flagRepeatsOfOtherStatements(threeRows, twoOther).map((r) => r.repeatsOtherStatement), [true, true, false]);
check("count-aware: one elsewhere flags only the first", flagRepeatsOfOtherStatements(threeRows, [other[0]]).map((r) => r.repeatsOtherStatement), [true, false, false]);

// skip callback does not consume a count
const skipFirst = flagRepeatsOfOtherStatements(threeRows, [other[0]], (r) => r.rowNumber === 1);
check("skip: skipped row never flagged", skipFirst[0].repeatsOtherStatement, false);
check("skip: skipped row does not use up the count", skipFirst.map((r) => r.repeatsOtherStatement), [false, true, false]);

// interaction with Module 62's within-statement duplicates: one row is never both
const inHere = [{ lineDate: "2026-09-03", description: "Airtel Money", amount: -500 }];
const dup = flagDuplicates(threeRows, inHere);
check("62: first of three is a within-statement duplicate", dup.map((r) => r.possibleDuplicate), [true, false, false]);
const both = flagRepeatsOfOtherStatements(dup, [other[0]], (r) => r.possibleDuplicate);
check("70: duplicate row is passed over, the next identical row takes the elsewhere count", both.map((r) => [r.possibleDuplicate, r.repeatsOtherStatement]), [
  [true, false],
  [false, true],
  [false, false],
]);
check("no row is both flags", both.some((r) => r.possibleDuplicate && r.repeatsOtherStatement), false);

// existing lines checked against other statements (getBankReconciliation shape)
const hereLines = [
  { id: "l1", lineDate: "2026-09-03", description: "Airtel Money", amount: -500 },
  { id: "l2", lineDate: "2026-09-03", description: "Airtel Money", amount: -500 },
  { id: "l3", lineDate: "2026-09-09", description: "Fee", amount: -5 },
];
check("live: only as many lines as exist elsewhere", flagRepeatsOfOtherStatements(hereLines, [other[0]]).filter((r) => r.repeatsOtherStatement).map((r) => r.id), ["l1"]);
check("live: ids preserved", flagRepeatsOfOtherStatements(hereLines, twoOther).filter((r) => r.repeatsOtherStatement).map((r) => r.id), ["l1", "l2"]);

// --- date span for the query ---
check("span of several", lineDateSpan([{ lineDate: "2026-09-05" }, { lineDate: "2026-08-30" }, { lineDate: "2026-09-20" }]), { min: "2026-08-30", max: "2026-09-20" });
check("span of one", lineDateSpan([{ lineDate: "2026-09-05" }]), { min: "2026-09-05", max: "2026-09-05" });
check("span of none", lineDateSpan([]), null);
check("span ignores garbage", lineDateSpan([{ lineDate: "junk" }, { lineDate: "2026-09-05" }, { lineDate: "2026-02-31" }]), { min: "2026-09-05", max: "2026-09-05" });
check("span only garbage", lineDateSpan([{ lineDate: "junk" }]), null);
check("span across a year", lineDateSpan([{ lineDate: "2027-01-02" }, { lineDate: "2026-12-30" }]), { min: "2026-12-30", max: "2027-01-02" });

if (failed > 0) {
  console.error(`\n${failed} of ${total} checks FAILED`);
  process.exit(1);
}
console.log(`statement-overlap: ${total}/${total} checks passed`);
