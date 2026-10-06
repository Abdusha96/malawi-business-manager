/**
 * Module 70 – cross-statement checks for bank reconciliations.
 *
 * Closes two limitations Module 69 (carried from 62) documented:
 *   1. "Overlaps between consecutive statements are not detected."
 *   2. "Lines are de-duplicated only within one reconciliation."
 *
 * Why it matters: a line already settled in an earlier statement (its book
 * transaction is matched there, and one book transaction can settle only one
 * statement line) can never match again. Importing it a second time into a later
 * reconciliation leaves an UNMATCHED line that blocks completion forever.
 *
 * Pure and import-free on purpose (same split as bank-statement-csv.ts): the
 * server and the "use client" workspace run the same functions, so the tags on
 * screen and the counts from the API always agree. Calendar days only, as
 * "YYYY-MM-DD" strings – zone-proof.
 */

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isYmd(s: string | null | undefined): s is string {
  if (!s || !YMD_RE.test(s)) return false;
  const m = YMD_RE.exec(s)!;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(t)) return false;
  const d = new Date(t);
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

function dayNumber(ymd: string): number {
  const m = YMD_RE.exec(ymd)!;
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

// ---------------------------------------------------------------------------
// 1. Overlapping statement periods
// ---------------------------------------------------------------------------

export interface StatementPeriod {
  id: string;
  statementDate: string; // last day covered, "YYYY-MM-DD"
  periodStart: string | null; // first day covered, or null when not recorded (Module 69)
}

export interface StatementOverlap {
  id: string;
  statementDate: string;
  periodStart: string; // always known for an overlap – an unknown start can't be compared
  overlapStart: string; // first shared day
  overlapEnd: string; // last shared day
  overlapDays: number; // inclusive: sharing exactly one day = 1
}

export interface OverlapResult {
  overlaps: StatementOverlap[];
  /** Other statements that could not be compared (no recorded start, or this one has none / a bad range). */
  notComparable: number;
}

/**
 * Which OTHER statements of the same account cover any of the same days as
 * `current`. Both ranges must be known to compare: a statement with no recorded
 * start is counted in `notComparable`, never guessed at (the same "store the
 * fact, keep the heuristic only where the fact is missing" rule as Module 69 –
 * and here there is no sensible heuristic, so the answer is "can't tell").
 * A range where start is after end is treated as unusable.
 * Sharing a single boundary day counts as an overlap of 1 day (some banks repeat
 * the closing day as the next statement's opening day); the caller only warns.
 * Sorted oldest first.
 */
export function findOverlappingStatements(current: { periodStart: string | null; statementDate: string }, others: StatementPeriod[]): OverlapResult {
  const overlaps: StatementOverlap[] = [];
  let notComparable = 0;

  const currentUsable = isYmd(current.statementDate) && isYmd(current.periodStart) && dayNumber(current.periodStart) <= dayNumber(current.statementDate);
  if (!currentUsable) {
    return { overlaps, notComparable: others.length };
  }
  const cs = current.periodStart as string;
  const ce = current.statementDate;

  for (const o of others) {
    if (!isYmd(o.statementDate) || !isYmd(o.periodStart) || dayNumber(o.periodStart) > dayNumber(o.statementDate)) {
      notComparable += 1;
      continue;
    }
    const start = dayNumber(cs) > dayNumber(o.periodStart) ? cs : o.periodStart;
    const end = dayNumber(ce) < dayNumber(o.statementDate) ? ce : o.statementDate;
    const days = dayNumber(end) - dayNumber(start) + 1;
    if (days >= 1) {
      overlaps.push({
        id: o.id,
        statementDate: o.statementDate,
        periodStart: o.periodStart,
        overlapStart: start,
        overlapEnd: end,
        overlapDays: days,
      });
    }
  }
  overlaps.sort((a, b) => (a.statementDate < b.statementDate ? -1 : a.statementDate > b.statementDate ? 1 : a.id < b.id ? -1 : 1));
  return { overlaps, notComparable };
}

/** One human sentence for an overlap, shared by the banner and the tests. */
export function describeOverlap(o: StatementOverlap): string {
  const days = o.overlapDays === 1 ? "1 day" : `${o.overlapDays} days`;
  return `${o.periodStart} to ${o.statementDate} (${days} shared)`;
}

// ---------------------------------------------------------------------------
// 2. Lines that repeat another statement's lines
// ---------------------------------------------------------------------------

export interface LineLike {
  lineDate: string; // "YYYY-MM-DD"
  description: string;
  amount: number;
}

/** Same key as bank-statement-csv.ts::statementLineKey (kept here so this file stays import-free). */
export function repeatKey(line: LineLike): string {
  const desc = line.description.replace(/\s+/g, " ").trim().toLowerCase();
  return `${line.lineDate}|${desc}|${line.amount.toFixed(2)}`;
}

export type WithRepeat<T> = T & { repeatsOtherStatement: boolean };

/**
 * Flags rows whose date + description + amount already exist on ANOTHER
 * statement of the same account. COUNT-AWARE like Module 62's within-statement
 * check: if another statement holds a key N times, only the first N matching rows
 * are flagged, so a genuinely new identical line still gets through.
 *
 * Rows for which `skip(row)` is true are passed over WITHOUT using up a count –
 * the caller passes "already a duplicate inside this reconciliation" here so one
 * row is never counted twice and the skip counts never overlap.
 */
export function flagRepeatsOfOtherStatements<T extends LineLike>(
  rows: T[],
  otherStatementLines: LineLike[],
  skip: (row: T) => boolean = () => false
): WithRepeat<T>[] {
  const remaining = new Map<string, number>();
  for (const l of otherStatementLines) {
    const k = repeatKey(l);
    remaining.set(k, (remaining.get(k) ?? 0) + 1);
  }
  return rows.map((r) => {
    if (skip(r)) return { ...r, repeatsOtherStatement: false };
    const k = repeatKey(r);
    const left = remaining.get(k) ?? 0;
    if (left > 0) {
      remaining.set(k, left - 1);
      return { ...r, repeatsOtherStatement: true };
    }
    return { ...r, repeatsOtherStatement: false };
  });
}

/** The smallest and largest line date among the rows ("YYYY-MM-DD"), or null when there are none / none are valid. Used to bound the database query. */
export function lineDateSpan(rows: { lineDate: string }[]): { min: string; max: string } | null {
  let min: string | null = null;
  let max: string | null = null;
  for (const r of rows) {
    if (!isYmd(r.lineDate)) continue;
    if (min === null || r.lineDate < min) min = r.lineDate;
    if (max === null || r.lineDate > max) max = r.lineDate;
  }
  return min !== null && max !== null ? { min, max } : null;
}
