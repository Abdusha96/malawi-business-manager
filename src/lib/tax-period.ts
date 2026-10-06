/**
 * Pure (no Prisma, no I/O) helpers for identifying one MRA tax obligation
 * period – shared by src/lib/tax-calendar.ts (which generates the
 * obligations) and src/lib/tax-payments.ts (Module 33, which records
 * payments against them). Kept in its own file so BOTH can import it
 * without creating a cycle: tax-calendar.ts needs to look up recorded
 * payments (so it imports tax-payments' data), and tax-payments.ts needs
 * the same period-key/label rules the calendar uses.
 *
 * A "period key" is what makes a calendar entry and a TaxPayment row refer
 * to the same obligation without either storing the other's id:
 *
 *   - PAYE / WITHHOLDING_TAX / VAT (monthly):  "YYYY-MM" of the period's
 *     month – the same shape Payroll.payPeriod already uses.
 *   - PROVISIONAL_TAX (quarterly):             "YYYY-MM-DD" of the
 *     quarter's first day.
 *   - ANNUAL_INCOME_TAX (fiscal year):         "YYYY-MM-DD" of the fiscal
 *     year's first day.
 *
 * (taxType, periodKey) together are unique among RECORDED payments – see
 * TaxPayment.activePeriodKey in the schema.
 */

import {
  endOfDayIn,
  formatDateIn,
  monthKeyIn,
  zonedDate,
  zonedParts,
  ymdIn,
} from "./timezone";

export const TAX_PAYMENT_TYPES = ["VAT", "PAYE", "WITHHOLDING_TAX", "PROVISIONAL_TAX", "ANNUAL_INCOME_TAX"] as const;
export type TaxPaymentTypeKey = (typeof TAX_PAYMENT_TYPES)[number];

export const TAX_PAYMENT_TYPE_LABELS: Record<TaxPaymentTypeKey, string> = {
  VAT: "VAT",
  PAYE: "PAYE",
  WITHHOLDING_TAX: "Withholding Tax",
  PROVISIONAL_TAX: "Provisional Tax",
  ANNUAL_INCOME_TAX: "Annual Income Tax",
};

export function isMonthlyTaxType(type: TaxPaymentTypeKey): boolean {
  return type === "VAT" || type === "PAYE" || type === "WITHHOLDING_TAX";
}

/**
 * Module 35: every helper below that turns a Date into a calendar field, or a
 * calendar field into a Date, takes the BUSINESS'S time zone (`tz`, an IANA id
 * from Business.timezone – see src/lib/timezone.ts). Before Module 35 they
 * used the runtime's local zone, which on a UTC server put every day and month
 * boundary two hours off Malawi's. A "period start"/"period end" Date is the
 * instant that calendar day BEGINS in `tz`.
 */

/** "YYYY-MM-DD" of the calendar day `d` falls on in `tz` (never toISOString(), which is UTC). */
export function ymd(d: Date, tz: string): string {
  return ymdIn(d, tz);
}

export function monthKey(d: Date, tz: string): string {
  return monthKeyIn(d, tz);
}

/** The period key for an obligation whose period starts at `periodStart` – see the file header for the per-type shape. */
export function taxPeriodKey(type: TaxPaymentTypeKey, periodStart: Date, tz: string): string {
  return isMonthlyTaxType(type) ? monthKey(periodStart, tz) : ymd(periodStart, tz);
}

/** Parses "YYYY-MM" into the instant that month's first day begins in `tz`, or null if malformed. */
export function parseMonthKey(key: string, tz: string): Date | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key);
  if (!m) return null;
  return zonedDate(Number(m[1]), Number(m[2]) - 1, 1, tz);
}

/** Parses "YYYY-MM-DD" into the instant that day begins in `tz`, or null if malformed / not a real calendar day. */
export function parseYmd(key: string, tz: string): Date | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(key);
  if (!m) return null;
  const d = zonedDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]), tz);
  // Rejects overflow such as 2026-02-31 (which would otherwise roll into March).
  const p = zonedParts(d, tz);
  return p.year === Number(m[1]) && p.month === Number(m[2]) && p.day === Number(m[3]) ? d : null;
}

export function monthLabel(d: Date, tz: string): string {
  return formatDateIn(d, tz, { month: "long", year: "numeric" });
}

export function quarterLabel(start: Date, end: Date, tz: string): string {
  return `${formatDateIn(start, tz, { month: "short" })}–${formatDateIn(end, tz, { month: "short", year: "numeric" })}`;
}

export function fiscalYearLabel(start: Date, end: Date, tz: string): string {
  return `FY ${zonedParts(start, tz).year}\u2013${zonedParts(end, tz).year}`;
}

/** 23:59:59.999 on the day `d` falls on in `tz`. Range queries treat `to` as inclusive but compare timestamps, so a bare midnight `to` silently drops the whole last day. */
export function endOfDay(d: Date, tz: string): Date {
  return endOfDayIn(d, tz);
}

/**
 * Module 34: a deadline is only MISSED once its whole due day has passed. The
 * calendar's due dates are midnight at the START of the due day, so the old
 * `dueDate < now` flagged an obligation "overdue" from 00:00 on the very day
 * it was due – including the 20th at 09:00, when it was still payable for
 * another 15 hours. Module 35: "the whole due day" is the BUSINESS'S day.
 */
export function isPastDue(dueDate: Date, tz: string, now: Date = new Date()): boolean {
  return endOfDay(dueDate, tz).getTime() < now.getTime();
}
