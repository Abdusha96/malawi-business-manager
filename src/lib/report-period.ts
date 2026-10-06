import { ymd, monthKey } from "./tax-period";
import { addDaysIn, zonedParts } from "./timezone";

/**
 * Sales-report bucket labels – pure (no Prisma), split out of src/lib/reports.ts
 * in Module 35 so scripts/verify-timezone.ts can exercise it without a database.
 */

export type ReportPeriod = "daily" | "weekly" | "monthly" | "annual";

/**
 * Bucket label for one sale. Module 34: built from calendar fields, not
 * `toISOString()` (UTC), which filed a sale at 01:00 in Malawi (UTC+2) under
 * the previous day. Module 35: those fields are the BUSINESS'S (`tz` =
 * Business.timezone), not the server's – on a UTC host the runtime-local
 * fields were UTC's, i.e. the same bug again.
 */
export function periodKey(date: Date, period: ReportPeriod, tz: string): string {
  if (period === "daily") return ymd(date, tz);
  if (period === "monthly") return monthKey(date, tz);
  if (period === "annual") return String(zonedParts(date, tz).year);

  // weekly: ISO week – Monday-start bucket labeled by that Monday's date
  const day = (zonedParts(date, tz).weekday + 6) % 7; // 0 = Monday
  return ymd(addDaysIn(date, tz, -day), tz);
}
