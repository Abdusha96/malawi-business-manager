/**
 * Module 35 – standalone checks for src/lib/timezone.ts and the helpers built
 * on it. No test framework, no database. The point of the module is that NO
 * result depends on the process time zone, so run this under several of them –
 * every group must pass identically under each:
 *
 *   TZ=UTC                 npx tsx scripts/verify-timezone.ts   # a typical host
 *   TZ=Africa/Blantyre     npx tsx scripts/verify-timezone.ts   # Malawi
 *   TZ=America/New_York    npx tsx scripts/verify-timezone.ts   # UTC-4/-5, DST
 *   TZ=Pacific/Kiritimati  npx tsx scripts/verify-timezone.ts   # UTC+14
 *
 * All instants below are written as explicit UTC (`Date.UTC` / ISO "Z"), never
 * as process-local `new Date(y, m, d)`, so the inputs are zone-independent too.
 * Exits non-zero if any check fails.
 */
import {
  DEFAULT_TIME_ZONE,
  SUPPORTED_TIME_ZONES,
  isSupportedTimeZone,
  resolveTimeZone,
  zonedParts,
  zonedDate,
  ymdIn,
  monthKeyIn,
  startOfDayIn,
  endOfDayIn,
  startOfMonthIn,
  addDaysIn,
  formatDateIn,
  formatDateTimeIn,
} from "../src/lib/timezone";
import { ymd, monthKey, parseYmd, parseMonthKey, taxPeriodKey, isPastDue, monthLabel, fiscalYearLabel, quarterLabel } from "../src/lib/tax-period";
import {
  parseDateInput,
  readDateParam,
  readDateRange,
  monthToDate,
  todayYmd,
  firstOfMonthYmd,
  lastOfMonthYmd,
  monthEndEntryDate,
  startOfDay,
  DateParamError,
} from "../src/lib/date-range";
import { getFiscalYear, getFiscalQuarters } from "../src/lib/fiscal-period";
import { periodKey } from "../src/lib/report-period";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${name}${detail ? " – " + detail : ""}`);
  } else {
    console.log(`  ok    ${name}`);
  }
}
const iso = (d: Date) => d.toISOString();
const BLZ = "Africa/Blantyre"; // UTC+2, no DST
const ACC = "Africa/Accra"; // UTC+0
const NBO = "Africa/Nairobi"; // UTC+3
const params = (qs: string) => new URLSearchParams(qs);

console.log(`process TZ=${process.env.TZ ?? "(system)"}  – results below must not depend on it`);

// --- zone registry ---------------------------------------------------------
{
  check("default zone is supported", isSupportedTimeZone(DEFAULT_TIME_ZONE) && DEFAULT_TIME_ZONE === BLZ);
  check("unsupported / western zones are rejected", !isSupportedTimeZone("America/New_York") && !isSupportedTimeZone("Europe/London") && !isSupportedTimeZone("Nowhere/Land") && !isSupportedTimeZone(""));
  check("non-strings are rejected", !isSupportedTimeZone(undefined) && !isSupportedTimeZone(null) && !isSupportedTimeZone(2));
  check("resolveTimeZone falls back to the default, never to the runtime zone", resolveTimeZone(null) === BLZ && resolveTimeZone(undefined) === BLZ && resolveTimeZone("Europe/Paris") === BLZ && resolveTimeZone(NBO) === NBO);
  // Every offered zone must be fixed-offset and >= UTC+0 (the date-only-storage constraint in timezone.ts).
  const jan = Date.UTC(2026, 0, 15, 12);
  const jul = Date.UTC(2026, 6, 15, 12);
  const bad = SUPPORTED_TIME_ZONES.filter((z) => {
    const offJan = zonedParts(new Date(jan), z.id).hour - 12;
    const offJul = zonedParts(new Date(jul), z.id).hour - 12;
    return offJan !== z.offsetHours || offJul !== z.offsetHours || z.offsetHours < 0;
  });
  check("every offered zone has its declared fixed, non-negative offset all year", bad.length === 0, bad.map((z) => z.id).join(", "));
}

// --- zonedParts / zonedDate ------------------------------------------------
{
  const p = zonedParts(new Date("2026-02-28T22:00:00.000Z"), BLZ);
  check("22:00Z on 28 Feb is 00:00 on 1 Mar in Blantyre", p.year === 2026 && p.month === 3 && p.day === 1 && p.hour === 0 && p.minute === 0);
  check("weekday of that calendar date (Sun 1 Mar 2026)", p.weekday === 0);
  check("millisecond preserved", zonedParts(new Date("2026-03-01T10:00:00.789Z"), BLZ).millisecond === 789);
  check("hour 24 never leaks (midnight is hour 0)", zonedParts(new Date("2026-02-28T22:00:00.000Z"), BLZ).hour === 0);

  check("zonedDate: 1 Mar 00:00 Blantyre = 28 Feb 22:00Z", iso(zonedDate(2026, 2, 1, BLZ)) === "2026-02-28T22:00:00.000Z");
  check("zonedDate month overflow (month0 = 12 → Jan next year)", iso(zonedDate(2026, 12, 1, BLZ)) === "2026-12-31T22:00:00.000Z");
  check("zonedDate day 0 = last day of previous month", ymdIn(zonedDate(2026, 3, 0, BLZ), BLZ) === "2026-03-31");
  check("zonedDate day 0, February leap year", ymdIn(zonedDate(2028, 2, 0, BLZ), BLZ) === "2028-02-29");
  check("zonedDate with a time of day", iso(zonedDate(2026, 2, 31, BLZ, 23, 59, 59, 999)) === "2026-03-31T21:59:59.999Z");
  check("zonedDate in a UTC+0 zone equals the UTC instant", iso(zonedDate(2026, 2, 1, ACC)) === "2026-03-01T00:00:00.000Z");
  check("zonedDate in UTC+3", iso(zonedDate(2026, 2, 1, NBO)) === "2026-02-28T21:00:00.000Z");
  // Round trip for a spread of dates in every offered zone.
  let roundTripOk = true;
  for (const z of SUPPORTED_TIME_ZONES) {
    for (const [y, m, d] of [[2026, 0, 1], [2026, 1, 28], [2028, 1, 29], [2026, 11, 31], [2027, 5, 15]]) {
      const back = zonedParts(zonedDate(y, m, d, z.id), z.id);
      if (back.year !== y || back.month !== m + 1 || back.day !== d || back.hour !== 0) roundTripOk = false;
    }
  }
  check("zonedDate → zonedParts round-trips in every offered zone", roundTripOk);
}

// --- generic correctness (not offered in the UI, but zonedDate must not assume fixed offsets) ---
{
  const NY = "America/New_York";
  check("DST: midnight before spring-forward is UTC-5", iso(zonedDate(2026, 2, 8, NY)) === "2026-03-08T05:00:00.000Z");
  check("DST: midnight after spring-forward is UTC-4", iso(zonedDate(2026, 2, 9, NY)) === "2026-03-09T04:00:00.000Z");
  check("DST: the spring-forward day is only 23h long", zonedDate(2026, 2, 9, NY).getTime() - zonedDate(2026, 2, 8, NY).getTime() === 23 * 3600_000);
  check("DST: the fall-back day is 25h long", zonedDate(2026, 10, 2, NY).getTime() - zonedDate(2026, 10, 1, NY).getTime() === 25 * 3600_000);
  check("DST: endOfDayIn on a 23h day is still the same calendar day", ymdIn(endOfDayIn(new Date("2026-03-08T12:00:00Z"), NY), NY) === "2026-03-08");
}

// --- the bug this module fixes ----------------------------------------------
{
  // A sale rung up at 01:00 on 1 April in Malawi is 23:00Z on 31 March.
  const sale = new Date("2026-03-31T23:00:00.000Z");
  check("REGRESSION: a 01:00 Malawi sale files under 1 April, not 31 March (UTC server bug)", ymdIn(sale, BLZ) === "2026-04-01" && monthKeyIn(sale, BLZ) === "2026-04");
  check("…while the same instant is still 31 March in UTC+0", ymdIn(sale, ACC) === "2026-03-31");

  // A March report (from=2026-03-01 to=2026-03-31) must contain 15:00 on the 31st and exclude 01:00 on 1 April.
  const from = parseDateInput("2026-03-01", "start", BLZ)!;
  const to = parseDateInput("2026-03-31", "end", BLZ)!;
  const late = new Date("2026-03-31T13:00:00.000Z"); // 15:00 Malawi
  const justInApril = new Date("2026-03-31T22:30:00.000Z"); // 00:30 on 1 April Malawi
  const justInMarch = new Date("2026-02-28T22:00:00.000Z"); // 00:00 on 1 March Malawi
  check("March range is [28 Feb 22:00Z, 31 Mar 21:59:59.999Z]", iso(from) === "2026-02-28T22:00:00.000Z" && iso(to) === "2026-03-31T21:59:59.999Z");
  check("15:00 on the last day is inside", late >= from && late <= to);
  check("00:30 on 1 April is outside", !(justInApril <= to));
  check("00:00 on 1 March is inside (first instant of the range)", justInMarch >= from);
}

// --- calendar helpers --------------------------------------------------------
{
  const d = new Date("2026-06-15T11:45:10.500Z"); // 13:45 Malawi
  check("startOfDayIn", iso(startOfDayIn(d, BLZ)) === "2026-06-14T22:00:00.000Z");
  check("endOfDayIn", iso(endOfDayIn(d, BLZ)) === "2026-06-15T21:59:59.999Z");
  check("startOfDay (date-range) is the same thing", startOfDay(d, BLZ).getTime() === startOfDayIn(d, BLZ).getTime());
  check("startOfMonthIn", iso(startOfMonthIn(d, BLZ)) === "2026-05-31T22:00:00.000Z");
  check("startOfMonthIn, offset -2 crosses to April", ymdIn(startOfMonthIn(d, BLZ, -2), BLZ) === "2026-04-01");
  check("startOfMonthIn, offset +7 crosses the year", ymdIn(startOfMonthIn(d, BLZ, 7), BLZ) === "2027-01-01");
  check("addDaysIn steps calendar days (-1)", ymdIn(addDaysIn(d, BLZ, -1), BLZ) === "2026-06-14");
  check("addDaysIn crosses a month boundary", ymdIn(addDaysIn(new Date("2026-03-01T05:00:00Z"), BLZ, -1), BLZ) === "2026-02-28");
  // Just before local midnight vs just after.
  const before = new Date("2026-06-15T21:59:59.999Z");
  const after = new Date("2026-06-15T22:00:00.000Z");
  check("day flips exactly at 22:00Z in Blantyre", ymdIn(before, BLZ) === "2026-06-15" && ymdIn(after, BLZ) === "2026-06-16");
}

// --- tax-period ---------------------------------------------------------------
{
  check("ymd / monthKey take the zone", ymd(new Date("2026-03-31T23:00:00Z"), BLZ) === "2026-04-01" && monthKey(new Date("2026-03-31T23:00:00Z"), BLZ) === "2026-04");
  const start = parseYmd("2026-03-01", BLZ)!;
  check("parseYmd → start of that day in the zone", iso(start) === "2026-02-28T22:00:00.000Z" && ymd(start, BLZ) === "2026-03-01");
  check("parseYmd rejects overflow and garbage", parseYmd("2026-02-31", BLZ) === null && parseYmd("2026-13-01", BLZ) === null && parseYmd("nope", BLZ) === null);
  check("parseMonthKey", iso(parseMonthKey("2026-03", BLZ)!) === "2026-02-28T22:00:00.000Z" && parseMonthKey("2026-13", BLZ) === null && parseMonthKey("2026-3", BLZ) === null);
  check("taxPeriodKey: monthly vs quarterly shapes", taxPeriodKey("VAT", start, BLZ) === "2026-03" && taxPeriodKey("PROVISIONAL_TAX", start, BLZ) === "2026-03-01");
  check("the period key survives parse → key in every offered zone", SUPPORTED_TIME_ZONES.every((z) => taxPeriodKey("PAYE", parseMonthKey("2026-03", z.id)!, z.id) === "2026-03" && ymd(parseYmd("2026-03-01", z.id)!, z.id) === "2026-03-01"));

  // isPastDue – overdue only after the whole due day IN THE BUSINESS ZONE has passed.
  const due = parseYmd("2026-03-20", BLZ)!;
  check("due today 09:00 Malawi → not overdue", !isPastDue(due, BLZ, new Date("2026-03-20T07:00:00Z")));
  check("due today 23:59 Malawi → not overdue", !isPastDue(due, BLZ, new Date("2026-03-20T21:59:00Z")));
  check("00:00:01 the next day in Malawi → overdue", isPastDue(due, BLZ, new Date("2026-03-20T22:00:01Z")));
  check("REGRESSION: 22:30Z on the 20th is already the 21st in Malawi (a UTC server said 'not overdue')", isPastDue(due, BLZ, new Date("2026-03-20T22:30:00Z")));

  check("monthLabel is rendered in the zone (not the server's)", monthLabel(new Date("2026-02-28T22:00:00Z"), BLZ).includes("March") && monthLabel(new Date("2026-02-28T22:00:00Z"), ACC).includes("February"));
  const fy = getFiscalYear(1, new Date("2026-06-15T10:00:00Z"), BLZ);
  check("fiscalYearLabel / quarterLabel", fiscalYearLabel(fy.start, fy.end, BLZ) === "FY 2026\u20132026" && /Jan/.test(quarterLabel(fy.start, fy.end, BLZ).split("–")[0]));
}

// --- fiscal periods ---------------------------------------------------------------
{
  const jan = getFiscalYear(1, new Date("2026-06-15T10:00:00Z"), BLZ);
  check("calendar fiscal year 2026", ymd(jan.start, BLZ) === "2026-01-01" && ymd(jan.end, BLZ) === "2026-12-31");
  // 21:30Z on 31 Dec 2025 is already 1 Jan 2026 in Malawi → fiscal year 2026, not 2025.
  const edge = getFiscalYear(1, new Date("2025-12-31T23:30:00Z"), BLZ);
  check("REGRESSION: 23:30 on 31 Dec UTC is 01:30 on 1 Jan in Malawi → fiscal year 2026", ymd(edge.start, BLZ) === "2026-01-01");
  const edgeUtc = getFiscalYear(1, new Date("2025-12-31T23:30:00Z"), ACC);
  check("…but still 2025 in a UTC+0 zone", ymd(edgeUtc.start, ACC) === "2025-01-01");
  const july = getFiscalYear(7, new Date("2026-06-15T10:00:00Z"), BLZ);
  check("July fiscal year straddles the calendar year", ymd(july.start, BLZ) === "2025-07-01" && ymd(july.end, BLZ) === "2026-06-30");
  const qs = getFiscalQuarters(july.start, BLZ);
  check("four contiguous quarters", qs.length === 4 && ymd(qs[0].start, BLZ) === "2025-07-01" && ymd(qs[0].end, BLZ) === "2025-09-30" && ymd(qs[3].start, BLZ) === "2026-04-01" && ymd(qs[3].end, BLZ) === "2026-06-30");
  const contiguous = qs.every((q, i) => i === 0 || ymd(new Date(q.start.getTime() - 1), BLZ) === ymd(qs[i - 1].end, BLZ));
  check("each quarter starts the day after the previous one ends", contiguous);
}

// --- date-range parsing --------------------------------------------------------------
{
  check("overflow date rejected", parseDateInput("2026-02-31", "end", BLZ) === null);
  check("garbage / empty rejected", parseDateInput("not-a-date", "start", BLZ) === null && parseDateInput("  ", "start", BLZ) === null);
  check("full timestamp used as given (zone and edge ignored)", iso(parseDateInput("2026-03-31T10:00:00.000Z", "end", BLZ)!) === "2026-03-31T10:00:00.000Z");
  check("absent / empty param → undefined", readDateParam(params(""), "to", "end", BLZ) === undefined && readDateParam(params("to="), "to", "end", BLZ) === undefined);
  let threw: unknown = null;
  try {
    readDateParam(params("to=banana"), "to", "end", BLZ);
  } catch (e) {
    threw = e;
  }
  check("invalid param throws DateParamError naming it", threw instanceof DateParamError && (threw as DateParamError).param === "to");

  const now = new Date("2026-09-19T10:00:00.000Z"); // 12:00 Malawi
  const defaults = monthToDate(BLZ, now);
  check("monthToDate: first of the month in the zone through now", ymd(defaults.from, BLZ) === "2026-09-01" && iso(defaults.from) === "2026-08-31T22:00:00.000Z" && defaults.to.getTime() === now.getTime());
  const r2 = readDateRange(params("from=2026-03-01&to=2026-03-31"), defaults, BLZ);
  check("explicit range → whole days in the zone", iso(r2.from) === "2026-02-28T22:00:00.000Z" && iso(r2.to) === "2026-03-31T21:59:59.999Z");
  const r3 = readDateRange(params("from=&to="), defaults, BLZ);
  check("cleared pickers fall back to defaults", r3.from.getTime() === defaults.from.getTime());
  const r4 = readDateRange(params("from=2026-04-10&to=2026-04-01"), defaults, BLZ);
  check("from > to is NOT rejected", r4.from > r4.to);
  // Same query, different business zone → different instants. That is the whole feature.
  const nbo = readDateRange(params("from=2026-03-01&to=2026-03-31"), defaults, NBO);
  check("the same query means different instants in a different zone", iso(nbo.from) === "2026-02-28T21:00:00.000Z" && iso(nbo.to) === "2026-03-31T20:59:59.999Z");
}

// --- client-side default helpers -------------------------------------------------------
{
  const justAfterMidnightMalawi = new Date("2026-08-31T22:30:00.000Z"); // 00:30 on 1 Sep, Malawi
  check("todayYmd at 00:30 Malawi is that Malawi day (a UTC clock says 31 Aug)", todayYmd(BLZ, justAfterMidnightMalawi) === "2026-09-01" && todayYmd(ACC, justAfterMidnightMalawi) === "2026-08-31");
  check("firstOfMonthYmd", firstOfMonthYmd(BLZ, new Date("2026-09-19T10:00:00Z")) === "2026-09-01");
  check("firstOfMonthYmd, 3 months back crosses a year", firstOfMonthYmd(BLZ, new Date("2026-02-10T10:00:00Z"), -3) === "2025-11-01");
  check("lastOfMonthYmd offset 0 / 2", lastOfMonthYmd(BLZ, new Date("2026-09-19T10:00:00Z"), 0) === "2026-09-30" && lastOfMonthYmd(BLZ, new Date("2026-09-19T10:00:00Z"), 2) === "2026-11-30");
  check("lastOfMonthYmd handles Feb (non-leap 2026 / leap 2028)", lastOfMonthYmd(BLZ, new Date("2026-01-05T10:00:00Z"), 1) === "2026-02-28" && lastOfMonthYmd(BLZ, new Date("2028-01-05T10:00:00Z"), 1) === "2028-02-29");
  check("lastOfMonthYmd when 'now' is late on the last day in UTC but already next month in Malawi", lastOfMonthYmd(BLZ, new Date("2026-09-30T23:00:00Z"), 0) === "2026-10-31");
}

// --- monthEndEntryDate (depreciation dating) ---------------------------------------------
{
  const april = new Date("2026-04-10T07:00:00.000Z");
  const march = monthEndEntryDate("2026-03", BLZ, april);
  check("closed month → 23:59:59.999 on its last day IN THE ZONE", iso(march) === "2026-03-31T21:59:59.999Z" && ymd(march, BLZ) === "2026-03-31");
  check("open month → now (never future-dated)", monthEndEntryDate("2026-04", BLZ, april).getTime() === april.getTime());
  check("February leap year", ymd(monthEndEntryDate("2028-02", BLZ, new Date("2028-06-01T00:00:00Z")), BLZ) === "2028-02-29");
}

// --- sales report buckets ----------------------------------------------------------------
{
  const sale = new Date("2026-03-31T23:00:00.000Z"); // 01:00 Wednesday 1 April in Malawi
  check("daily bucket = the business's day", periodKey(sale, "daily", BLZ) === "2026-04-01" && periodKey(sale, "daily", ACC) === "2026-03-31");
  check("monthly bucket crosses at Malawi midnight", periodKey(sale, "monthly", BLZ) === "2026-04" && periodKey(sale, "monthly", ACC) === "2026-03");
  const nye = new Date("2025-12-31T23:30:00.000Z"); // 01:30 on 1 Jan 2026 in Malawi
  check("annual bucket crosses at Malawi midnight", periodKey(nye, "annual", BLZ) === "2026" && periodKey(nye, "annual", ACC) === "2025");
  // Weekly: Monday-start. Wed 1 Apr 2026 (Malawi) belongs to the week of Mon 30 Mar; Tue 31 Mar in Accra to the same week.
  check("weekly bucket is that week's Monday", periodKey(sale, "weekly", BLZ) === "2026-03-30" && periodKey(sale, "weekly", ACC) === "2026-03-30");
  const sundayLate = new Date("2026-03-29T21:30:00.000Z"); // 23:30 Sun 29 Mar Malawi
  const mondayEarly = new Date("2026-03-29T22:30:00.000Z"); // 00:30 Mon 30 Mar Malawi
  check("weekly: Sunday 23:30 Malawi is still the PREVIOUS week", periodKey(sundayLate, "weekly", BLZ) === "2026-03-23");
  check("weekly: Monday 00:30 Malawi starts the new week (UTC servers filed it under the old one)", periodKey(mondayEarly, "weekly", BLZ) === "2026-03-30");
}

// --- display formatting --------------------------------------------------------------------
{
  const late = new Date("2026-03-31T23:00:00.000Z");
  check("formatDateIn shows the business's day, not the server's", formatDateIn(late, BLZ, { day: "numeric", month: "numeric", year: "numeric" }).includes("4") && formatDateIn(late, ACC, { day: "numeric", month: "numeric", year: "numeric" }).includes("3"));
  check("formatDateIn: 1 April in Malawi vs 31 March in Accra", /1/.test(formatDateIn(late, BLZ, { day: "numeric" })) && /31/.test(formatDateIn(late, ACC, { day: "numeric" })));

  // Module 36: client components receive dates as ISO strings (or epoch numbers), not Date objects.
  const dayOnly = { day: "numeric" } as const;
  check("formatDateIn: an ISO string formats the same as the Date it came from", formatDateIn(late.toISOString(), BLZ) === formatDateIn(late, BLZ));
  check("formatDateIn: an epoch number formats the same as the Date it came from", formatDateIn(late.getTime(), BLZ) === formatDateIn(late, BLZ));
  check("formatDateIn: an unparseable value renders as a dash, not \"Invalid Date\"", formatDateIn("not a date", BLZ) === "–" && formatDateIn(NaN, BLZ) === "–");
  check("formatDateTimeIn: same input rules (string, invalid)", formatDateTimeIn(late.toISOString(), BLZ) === formatDateTimeIn(late, BLZ) && formatDateTimeIn("nope", BLZ) === "–");

  // A user-picked date-only value is stored as UTC midnight. In every zone the picker offers (UTC+0 … +3) it must
  // still display as the SAME calendar day the user picked, whatever zone the process or browser is in.
  const pickedMarch31 = new Date("2026-03-31T00:00:00.000Z");
  const day = (tz: string) => formatDateIn(pickedMarch31, tz, dayOnly);
  check("date-only value (UTC midnight) shows as 31 in every offered zone", SUPPORTED_TIME_ZONES.every((z) => day(z.id) === "31"), SUPPORTED_TIME_ZONES.map((z) => `${z.id}=${day(z.id)}`).join(" "));

  // The bug this module closes: a timestamp at 01:00 Malawi time on 1 April is 23:00 UTC on 31 March. A UTC server
  // (or a UTC- browser) used to print 31 March next to a sale Malawi filed under 1 April.
  const lateSale = new Date("2026-03-31T23:00:00.000Z");
  check("timestamp at 01:00 Malawi time displays as 1 April (not the server's 31 March)", formatDateIn(lateSale, BLZ, dayOnly) === "1");
  const hourIn = (d: Date, tz: string) => formatDateTimeIn(d, tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  check("formatDateTimeIn shows 01:00 in Malawi and 23:00 in Accra for the same instant", /01:00/.test(hourIn(lateSale, BLZ)) && /23:00/.test(hourIn(lateSale, ACC)));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
