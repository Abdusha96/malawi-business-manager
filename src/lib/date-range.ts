/**
 * Module 34 – one place that decides what a date-only string means.
 *
 * Pure (no Prisma, no Next, no I/O) so BOTH server routes and client
 * components can import it, the same way src/lib/tax-period.ts is shared.
 *
 * WHY THIS EXISTS. Before Module 34 every report route did its own
 * `new Date(searchParams.get("to"))`. For a date-only string such as
 * "2026-03-31", JavaScript parses that as MIDNIGHT UTC at the START of the
 * day, and every report compares `entryDate <= to` – so the chosen last
 * day's activity was silently dropped (Module 33 found and documented this
 * but did not fix it). Separately, the browser-side defaults used
 * `new Date(...).toISOString().slice(0, 10)`, which converts to UTC first:
 * in Malawi (UTC+2) local midnight on the 1st becomes 22:00 UTC on the LAST
 * DAY OF THE PREVIOUS MONTH, so every "From" picker defaulted to one day
 * early, and between 00:00 and 02:00 local "today" was yesterday.
 *
 * THE RULE (documented once, here):
 *   - A date-only string ("YYYY-MM-DD") names a whole CALENDAR DAY in the
 *     BUSINESS'S time zone (Business.timezone – Module 35; before that, the
 *     runtime's local zone). As a range's lower bound it means the start of
 *     that day; as an upper bound (or an "as of" date) it means the END of
 *     that day (23:59:59.999), so the day is included.
 *   - Anything with a time component ("2026-03-31T10:00:00Z") is an exact
 *     instant and is used as given.
 *   - "YYYY-MM-DD" strings for display/inputs are produced from calendar
 *     fields in that zone (`ymd()`), never `toISOString()`.
 *
 * Module 35: every function here that needs a calendar takes `tz` (an IANA id,
 * from `getBusinessTimeZone()` on the server or a prop on the client) – there
 * is no default, so a caller that forgets it is a compile error rather than a
 * silent return to the server's clock. See src/lib/timezone.ts.
 */

import { ymd, parseYmd, endOfDay } from "./tax-period";
import { startOfDayIn, startOfMonthIn, zonedDate } from "./timezone";

export { ymd, endOfDay };

export type DateEdge = "start" | "end";

/** Thrown for a query parameter that is present but not a valid date. Routes turn it into a 400. */
export class DateParamError extends Error {
  readonly param: string;
  constructor(param: string, message?: string) {
    super(message ?? `"${param}" must be a valid date (YYYY-MM-DD).`);
    this.name = "DateParamError";
    this.param = param;
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** True for a bare calendar date such as "2026-03-31" (no time component). */
export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value.trim());
}

/** 00:00:00.000 on the day `d` falls on in `tz`. */
export function startOfDay(d: Date, tz: string): Date {
  return startOfDayIn(d, tz);
}

/**
 * Parses one user/query-supplied date. Date-only strings resolve to the
 * start or end of that day IN `tz` per `edge`; full timestamps are used as
 * given (`edge` is ignored). Returns null for anything unparseable –
 * including calendar overflow such as "2026-02-31", which `new Date()` would
 * silently roll into March.
 */
export function parseDateInput(raw: string, edge: DateEdge, tz: string): Date | null {
  const value = raw.trim();
  if (value === "") return null;
  if (isDateOnly(value)) {
    const day = parseYmd(value, tz);
    if (!day) return null;
    return edge === "end" ? endOfDay(day, tz) : day;
  }
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * Reads one optional date query parameter. Absent or empty → undefined (an
 * empty <input type="date"> serializes as `to=`, which must mean "not
 * provided", exactly as it did before). Present but invalid → DateParamError.
 */
export function readDateParam(searchParams: URLSearchParams, name: string, edge: DateEdge, tz: string): Date | undefined {
  const raw = searchParams.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const parsed = parseDateInput(raw, edge, tz);
  if (!parsed) throw new DateParamError(name);
  return parsed;
}

/**
 * Reads `from`/`to` with the start-of-day / end-of-day rule and falls back to
 * `defaults` for whichever is absent. Deliberately does NOT reject from > to:
 * that has always simply returned an empty report, and the accounting hub's
 * date pickers can transiently produce it while the user is mid-edit.
 */
export function readDateRange(
  searchParams: URLSearchParams,
  defaults: { from: Date; to: Date },
  tz: string
): { from: Date; to: Date } {
  return {
    from: readDateParam(searchParams, "from", "start", tz) ?? defaults.from,
    to: readDateParam(searchParams, "to", "end", tz) ?? defaults.to,
  };
}

/** The "no filter given" range every report uses: first of this month (in `tz`), 00:00, through right now. */
export function monthToDate(tz: string, now: Date = new Date()): { from: Date; to: Date } {
  return { from: startOfMonthIn(now, tz), to: now };
}

// ----------------------------------------------------------------------------
// Client-safe helpers for <input type="date"> values ("YYYY-MM-DD", in `tz`).
// Replace every `new Date(...).toISOString().slice(0, 10)` – see file header.
// ----------------------------------------------------------------------------

/** Today's calendar date in `tz` as "YYYY-MM-DD". */
export function todayYmd(tz: string, now: Date = new Date()): string {
  return ymd(now, tz);
}

/** First day of `now`'s month in `tz`, shifted by `monthOffset` months (negative = earlier), as "YYYY-MM-DD". */
export function firstOfMonthYmd(tz: string, now: Date = new Date(), monthOffset = 0): string {
  return ymd(startOfMonthIn(now, tz, monthOffset), tz);
}

/** Last day of the month that is `monthOffset` months after `now`'s month (in `tz`), as "YYYY-MM-DD". */
export function lastOfMonthYmd(tz: string, now: Date = new Date(), monthOffset = 0): string {
  // The millisecond before the next month begins is always on the last day of this one.
  return ymd(new Date(startOfMonthIn(now, tz, monthOffset + 1).getTime() - 1), tz);
}

/**
 * Journal-entry date for something that belongs to a whole month ("YYYY-MM"),
 * e.g. depreciation: the end of that month's last day (in `tz`), or `now` when
 * the month hasn't finished yet – never a future-dated entry, so the GL,
 * Balance Sheet and P&L agree on whether it exists today.
 */
export function monthEndEntryDate(period: string, tz: string, now: Date = new Date()): Date {
  const [year, month] = period.split("-").map(Number);
  // month is 1-based, so day 0 of `month` = last day of that month
  const end = endOfDay(zonedDate(year, month, 0, tz), tz);
  return end.getTime() > now.getTime() ? now : end;
}
