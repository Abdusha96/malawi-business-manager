/**
 * Module 35 – Business time zone. Pure (no Prisma, no Next, no I/O), so server
 * routes, server components AND client components can all import it, the same
 * way src/lib/tax-period.ts and src/lib/date-range.ts are shared.
 *
 * WHY THIS EXISTS. Module 34 defined a date-only string ("2026-03-31") as a
 * whole LOCAL calendar day, where "local" meant "whatever zone the JavaScript
 * runtime is in". That was right in a browser in Malawi and right on a server
 * started with TZ=Africa/Blantyre – and silently wrong on the usual UTC host
 * (Vercel, most containers): every report's day/month boundary, every daily
 * sales bucket, "today" on the dashboard and the tax calendar's due dates sat
 * two hours off Malawi's clock, so anything rung up between 00:00 and 02:00
 * was filed under the previous day. Module 34's own KNOWN LIMITATIONS named
 * the durable fix: a `Business.timezone` that the date helpers read.
 *
 * THE RULE (documented once, here). Everything that means "a calendar day",
 * "a month" or "a fiscal period" for a business is evaluated in THAT BUSINESS'S
 * zone (Business.timezone, an IANA id), never in the runtime's zone. Nothing in
 * this file, or in the helpers built on it, reads the process time zone: a
 * result is identical under TZ=UTC, TZ=America/New_York or TZ=Africa/Blantyre.
 * scripts/verify-timezone.ts proves that by running the same assertions under
 * several process zones.
 *
 * A "calendar day" as a Date is the INSTANT at which that day starts in the
 * zone (2026-03-01 in Africa/Blantyre is 2026-02-28T22:00:00Z). All helpers
 * that used `new Date(y, m, d)` / `d.getMonth()` before now take a `tz` and
 * use `zonedDate()` / `zonedParts()` instead.
 *
 * WHICH ZONES ARE OFFERED – and why not all of them. User-picked date-only
 * values (an expense date, an acquisition date, a statement date…) are still
 * sent by the browser as `new Date("2026-03-31").toISOString()`, i.e. UTC
 * midnight, and stored that way. UTC midnight falls on the RIGHT calendar day
 * in any zone whose offset is 0 or positive, and on the day BEFORE in any zone
 * west of Greenwich. So SUPPORTED_TIME_ZONES is deliberately limited to
 * zones at UTC+0 or east, with no daylight-saving changes – which covers
 * Malawi and every neighbour this product is sold to. Adding a western zone
 * is a data-model change (store date-only values as a calendar date, not an
 * instant), not a dropdown entry; see the README.
 */

export const DEFAULT_TIME_ZONE = "Africa/Blantyre";

export interface SupportedTimeZone {
  id: string;
  label: string;
  /** Fixed UTC offset in hours (none of these zones observe daylight saving). */
  offsetHours: number;
}

/**
 * Curated, not exhaustive: fixed-offset zones at UTC+0 … UTC+3 (see the file
 * header for why western zones are excluded). Malawi first, as the default.
 */
export const SUPPORTED_TIME_ZONES: readonly SupportedTimeZone[] = [
  { id: "Africa/Blantyre", label: "Malawi (Blantyre)", offsetHours: 2 },
  { id: "Africa/Lusaka", label: "Zambia (Lusaka)", offsetHours: 2 },
  { id: "Africa/Harare", label: "Zimbabwe (Harare)", offsetHours: 2 },
  { id: "Africa/Maputo", label: "Mozambique (Maputo)", offsetHours: 2 },
  { id: "Africa/Gaborone", label: "Botswana (Gaborone)", offsetHours: 2 },
  { id: "Africa/Johannesburg", label: "South Africa (Johannesburg)", offsetHours: 2 },
  { id: "Africa/Lubumbashi", label: "DR Congo – east (Lubumbashi)", offsetHours: 2 },
  { id: "Africa/Kigali", label: "Rwanda (Kigali)", offsetHours: 2 },
  { id: "Africa/Nairobi", label: "Kenya (Nairobi)", offsetHours: 3 },
  { id: "Africa/Dar_es_Salaam", label: "Tanzania (Dar es Salaam)", offsetHours: 3 },
  { id: "Africa/Kampala", label: "Uganda (Kampala)", offsetHours: 3 },
  { id: "Africa/Addis_Ababa", label: "Ethiopia (Addis Ababa)", offsetHours: 3 },
  { id: "Africa/Lagos", label: "Nigeria (Lagos)", offsetHours: 1 },
  { id: "Africa/Kinshasa", label: "DR Congo – west (Kinshasa)", offsetHours: 1 },
  { id: "Africa/Accra", label: "Ghana (Accra)", offsetHours: 0 },
];

export function isSupportedTimeZone(value: unknown): value is string {
  return typeof value === "string" && SUPPORTED_TIME_ZONES.some((z) => z.id === value);
}

/**
 * The zone to actually use for a stored value. Falls back to the default for
 * null/undefined/unsupported so that a bad or stale `Business.timezone` (or a
 * caller that only has a nullable one) degrades to Malawi time rather than to
 * the server's clock – the bug this module exists to remove.
 */
export function resolveTimeZone(tz: string | null | undefined): string {
  return isSupportedTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
}

// ----------------------------------------------------------------------------
// Zone arithmetic (Intl-based, so it is correct for any IANA zone even though
// the curated list only offers fixed-offset ones).
// ----------------------------------------------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(tz, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

/** The wall-clock fields of `instant` as seen in `tz`. */
export function zonedParts(instant: Date, tz: string): ZonedParts {
  const map: Record<string, number> = {};
  for (const part of formatterFor(tz).formatToParts(instant)) {
    if (part.type !== "literal") map[part.type] = Number(part.value);
  }
  const year = map.year;
  const month = map.month;
  const day = map.day;
  return {
    year,
    month,
    day,
    hour: map.hour === 24 ? 0 : map.hour,
    minute: map.minute,
    second: map.second,
    millisecond: instant.getUTCMilliseconds(), // no zone offset is a fractional second
    // Weekday of the CALENDAR DATE (independent of time of day), via UTC arithmetic on the date fields.
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** Milliseconds `tz` is ahead of UTC at the given instant (positive east of Greenwich). */
function offsetMsAt(instantMs: number, tz: string): number {
  const p = zonedParts(new Date(instantMs), tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `tz` reads the given fields – the
 * zone-aware equivalent of `new Date(year, month0, day, h, m, s, ms)`, with the
 * same overflow normalisation (month0 = 12 is January of the next year;
 * day 0 is the last day of the previous month), which the calendar code relies
 * on ("last day of month" = `zonedDate(y, m0 + 1, 0, tz)`).
 */
export function zonedDate(
  year: number,
  month0: number,
  day: number,
  tz: string,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0
): Date {
  const wall = Date.UTC(year, month0, day, hour, minute, second, millisecond);
  // Two passes settle any zone whose offset changes between the guess and the answer (DST edges).
  const first = wall - offsetMsAt(wall, tz);
  return new Date(wall - offsetMsAt(first, tz));
}

// ----------------------------------------------------------------------------
// Calendar helpers used everywhere a "day" or "month" is needed.
// ----------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "YYYY-MM-DD" of the calendar day `d` falls on in `tz`. */
export function ymdIn(d: Date, tz: string): string {
  const p = zonedParts(d, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** "YYYY-MM" of the month `d` falls in, in `tz`. */
export function monthKeyIn(d: Date, tz: string): string {
  const p = zonedParts(d, tz);
  return `${p.year}-${pad2(p.month)}`;
}

/** 00:00:00.000 on the day `d` falls on in `tz`. */
export function startOfDayIn(d: Date, tz: string): Date {
  const p = zonedParts(d, tz);
  return zonedDate(p.year, p.month - 1, p.day, tz);
}

/** 23:59:59.999 on the day `d` falls on in `tz`. */
export function endOfDayIn(d: Date, tz: string): Date {
  const p = zonedParts(d, tz);
  return zonedDate(p.year, p.month - 1, p.day, tz, 23, 59, 59, 999);
}

/** The first instant of the month `d` falls in, in `tz`, shifted by `monthOffset` months. */
export function startOfMonthIn(d: Date, tz: string, monthOffset = 0): Date {
  const p = zonedParts(d, tz);
  return zonedDate(p.year, p.month - 1 + monthOffset, 1, tz);
}

/** Start of the day that is `dayOffset` calendar days from the one `d` falls on (negative = earlier), in `tz`. */
export function addDaysIn(d: Date, tz: string, dayOffset: number): Date {
  const p = zonedParts(d, tz);
  return zonedDate(p.year, p.month - 1, p.day + dayOffset, tz);
}

/**
 * A value a page can hold for a date: a real Date (server components), or the
 * ISO string / epoch a Date becomes after crossing into a client component as
 * a prop or JSON.
 */
export type DateInput = Date | string | number;

/**
 * Formats a date for display in `tz`. Uses the runtime's default LOCALE
 * (as every bare `toLocaleDateString()` in this app already did) but pins the
 * ZONE, so a server-rendered page, a PDF and a notification body all show the
 * business's calendar day instead of the server's (or, in a client
 * component, the browser's).
 *
 * Accepts a string/number as well as a Date (Module 36) so a client component
 * that receives `createdAt` as an ISO string can format it directly. An
 * unparseable value renders as "–" rather than the literal "Invalid Date".
 */
export function formatDateIn(d: DateInput, tz: string, options?: Intl.DateTimeFormatOptions): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "–";
  return date.toLocaleDateString(undefined, { ...(options ?? {}), timeZone: tz });
}

/** Date and time, in `tz`, in the runtime's default locale. Same input rules as `formatDateIn`. */
export function formatDateTimeIn(d: DateInput, tz: string, options?: Intl.DateTimeFormatOptions): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "–";
  return date.toLocaleString(undefined, { ...(options ?? {}), timeZone: tz });
}
