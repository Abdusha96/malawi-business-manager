import { zonedDate, zonedParts } from "./timezone";

/**
 * Fiscal-year and fiscal-quarter arithmetic – pure (no Prisma), so it can be
 * verified by scripts/verify-timezone.ts without a database. Split out of
 * src/lib/corporate-tax.ts in Module 35 (which re-exports it, so existing
 * importers are unchanged).
 *
 * Module 35: every date here is the instant a calendar day BEGINS in the
 * business's time zone `tz` (Business.timezone), and "the fiscal year
 * containing referenceDate" is decided by the calendar date in that zone –
 * on a UTC server 23:30 on 31 December is still the old fiscal year, while
 * in Malawi it is already 01:30 on 1 January of the new one.
 */

export interface FiscalPeriod {
  start: Date;
  end: Date;
}

/**
 * The fiscal year (start/end, inclusive) containing referenceDate, given
 * the business's Business.financialYearStartMonth (1-12). A business with
 * the default month 1 (January) simply gets the calendar year – this only
 * matters once a business sets a non-January fiscal year in Tax Settings.
 * `end` is the LAST DAY at 00:00 (use endOfDay() for range queries).
 */
export function getFiscalYear(financialYearStartMonth: number, referenceDate: Date, tz: string): FiscalPeriod {
  const ref = zonedParts(referenceDate, tz);
  const startYear = ref.month >= financialYearStartMonth ? ref.year : ref.year - 1;
  const start = zonedDate(startYear, financialYearStartMonth - 1, 1, tz);
  // Month-overflow normalization gives us "last day of the month before next
  // year's start" for free, including across a December→January wrap.
  const end = zonedDate(startYear, financialYearStartMonth - 1 + 12, 0, tz);
  return { start, end };
}

/** The four 3-month quarters making up a fiscal year, in order. */
export function getFiscalQuarters(fiscalYearStart: Date, tz: string): FiscalPeriod[] {
  const s = zonedParts(fiscalYearStart, tz);
  const quarters: FiscalPeriod[] = [];
  for (let q = 0; q < 4; q++) {
    const start = zonedDate(s.year, s.month - 1 + q * 3, 1, tz);
    const end = zonedDate(s.year, s.month - 1 + q * 3 + 3, 0, tz);
    quarters.push({ start, end });
  }
  return quarters;
}
