/**
 * Period Close rules, Module 42. Pure (no Prisma, no Next, no I/O) so the server, the
 * Period Close page and scripts/verify-period-close.ts all use the same code.
 *
 * THE RULE. `Business.booksClosedThrough` is the last calendar day of the books that is
 * closed, as a bare "YYYY-MM-DD" (or null when nothing is closed). A record whose own date
 * falls on or before that day can't be created, changed or voided. The day is compared as a
 * calendar day in the business time zone (Modules 34/35), never as an instant, so the answer
 * does not depend on the server's clock or zone.
 *
 * Why a string and not a DateTime: it names a day, not a moment. A DateTime would have to
 * be "23:59:59.999 in some zone", and an Owner changing the zone would silently move the lock.
 *
 * What the lock does NOT do: it never blocks a posting dated "now". The lock can only cover
 * days before today (see planClosedThroughChange), so "now" is by definition open. Skipping
 * the check for undated postings also means a zone change can never lock the business out of
 * posting for a few hours. Voids and reversals are dated today, so they always land in the
 * open period. See the README for which records a void is still refused on.
 */

import { ymdIn } from "./timezone";
import { lastOfMonthYmd } from "./date-range";
import { getFiscalYear, getFiscalQuarters } from "./fiscal-period";

export const EARLIEST_CLOSE_DATE = "2000-01-01";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written "YYYY-MM-DD" ("2026-02-31" is not real). */
export function isRealYmd(value: unknown): value is string {
  if (typeof value !== "string" || !YMD.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** The calendar day after `ymd`, as "YYYY-MM-DD". */
export function dayAfter(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** The last calendar day of a "YYYY-MM" month, as "YYYY-MM-DD". */
export function monthEndYmd(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** True when `day` ("YYYY-MM-DD") is on or before the closed-through day. */
export function isDayClosed(closedThrough: string | null | undefined, day: string): boolean {
  if (!closedThrough) return false;
  // Zero-padded ISO dates sort the same as they read, so a string comparison is a date comparison.
  return day <= closedThrough;
}

/** True when the instant falls on a closed calendar day in `tz`. */
export function isInstantClosed(closedThrough: string | null | undefined, instant: Date, tz: string): boolean {
  if (!closedThrough) return false;
  return isDayClosed(closedThrough, ymdIn(instant, tz));
}

function sentenceStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The message for a record that sits in a closed period. `what` reads as a noun phrase
 * ("this sale", "the expense date", "a journal entry"). `mode`:
 *  - "date": the user picked the date, so tell them the first open day to use instead.
 *  - "change": the record already lives in the period, so it can't be edited or voided at all.
 *  - "post": the system picks the date (a depreciation run is dated the month end), so the
 *    user can't re-date it; the only way through is reopening the period.
 */
export function closedPeriodMessage(params: {
  what: string;
  day: string;
  closedThrough: string;
  mode: "date" | "change" | "post";
}): string {
  const { what, day, closedThrough, mode } = params;
  if (mode === "date") {
    return `${sentenceStart(what)} is dated ${day}, but the books are closed through ${closedThrough}. Use ${dayAfter(closedThrough)} or a later date, or ask the Owner to reopen the period.`;
  }
  if (mode === "post") {
    return `${sentenceStart(what)} is dated ${day}, and the books are closed through ${closedThrough}. Nothing can be posted to a closed period. Ask the Owner to reopen it first.`;
  }
  return `${sentenceStart(what)} is dated ${day}, and the books are closed through ${closedThrough}. Records in a closed period can't be changed or voided. Ask the Owner to reopen the period first.`;
}

/**
 * Returns the refusal message when `instant` is in a closed period, otherwise null.
 * `mode` is passed through to closedPeriodMessage.
 */
export function checkRecordDate(params: {
  closedThrough: string | null | undefined;
  instant: Date | null | undefined;
  tz: string;
  what: string;
  mode: "date" | "change" | "post";
}): string | null {
  const { closedThrough, instant, tz, what, mode } = params;
  if (!closedThrough || !instant) return null;
  const day = ymdIn(instant, tz);
  if (!isDayClosed(closedThrough, day)) return null;
  return closedPeriodMessage({ what, day, closedThrough, mode });
}

export type PeriodChangePlan =
  | { ok: true; action: "close" | "reopen"; from: string | null; to: string | null }
  | { ok: false; error: string };

/**
 * Decides what a request to set the closed-through day means, without touching anything.
 *  - `requested` null means "reopen everything".
 *  - A later day than the current one is a close. An earlier day (or null) is a reopen.
 *  - The new day must be a real date, no earlier than EARLIEST_CLOSE_DATE, and strictly
 *    before `today` (in the business zone). Today's books are still being written.
 *  - Asking for the day already in force is refused so a double click does nothing quietly.
 */
export function planClosedThroughChange(params: {
  current: string | null;
  requested: string | null;
  today: string;
}): PeriodChangePlan {
  const { current, requested, today } = params;

  if (requested === null) {
    if (current === null) return { ok: false, error: "The books are already open. There is nothing to reopen." };
    return { ok: true, action: "reopen", from: current, to: null };
  }

  if (!isRealYmd(requested)) return { ok: false, error: "That is not a real calendar date. Use the form 2026-03-31." };
  if (requested < EARLIEST_CLOSE_DATE) return { ok: false, error: `The date can't be before ${EARLIEST_CLOSE_DATE}.` };
  if (requested >= today) {
    return { ok: false, error: `You can only close days that have finished. The latest day you can close through is ${previousDay(today)}.` };
  }
  if (current !== null && requested === current) {
    return { ok: false, error: `The books are already closed through ${current}.` };
  }
  if (current === null || requested > current) return { ok: true, action: "close", from: current, to: requested };
  return { ok: true, action: "reopen", from: current, to: requested };
}

/** The calendar day before `ymd`, as "YYYY-MM-DD". */
export function previousDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

export interface ClosePreset {
  key: "last-month" | "last-quarter" | "last-year";
  label: string;
  date: string;
}

/**
 * One-click choices for the Period Close page: the end of last month, the end of the last
 * finished fiscal quarter, and the end of the last finished fiscal year. Each is a day that
 * has already finished, so it is always a valid thing to close through. The fiscal year and
 * quarters follow Business.financialYearStartMonth, the same helpers the Corporate Tax
 * calendar uses. Duplicates (a quarter that ends when a month does) are kept, since the
 * label tells the user what each one means.
 */
export function closePresets(params: {
  financialYearStartMonth: number;
  tz: string;
  now?: Date;
}): ClosePreset[] {
  const { financialYearStartMonth, tz } = params;
  const now = params.now ?? new Date();
  const today = ymdIn(now, tz);
  const out: ClosePreset[] = [];

  out.push({ key: "last-month", label: "End of last month", date: lastOfMonthYmd(tz, now, -1) });

  // Latest fiscal quarter that has fully finished: look at this fiscal year and the one before.
  const thisYear = getFiscalYear(financialYearStartMonth, now, tz);
  // One millisecond before this fiscal year begins is the last instant of the previous one.
  const lastYear = getFiscalYear(financialYearStartMonth, new Date(thisYear.start.getTime() - 1), tz);
  const quarterEnds = [...getFiscalQuarters(lastYear.start, tz), ...getFiscalQuarters(thisYear.start, tz)]
    .map((q) => ymdIn(q.end, tz))
    .filter((d) => d < today)
    .sort();
  if (quarterEnds.length > 0) {
    out.push({ key: "last-quarter", label: "End of last quarter", date: quarterEnds[quarterEnds.length - 1] });
  }

  const lastYearEnd = ymdIn(lastYear.end, tz);
  if (lastYearEnd < today) out.push({ key: "last-year", label: "End of last financial year", date: lastYearEnd });

  return out;
}
