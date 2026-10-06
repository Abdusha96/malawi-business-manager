import { prisma } from "./prisma";
import { getVatReturn } from "./vat";
import { getWithholdingTaxReturn } from "./withholding-tax";
import { getCorporateTaxEstimate, getFiscalYear, getFiscalQuarters } from "./corporate-tax";
import { monthLabel, quarterLabel, fiscalYearLabel, taxPeriodKey, endOfDay, isPastDue, monthKey } from "./tax-period";
import { startOfDay } from "./date-range";
import { resolveTimeZone, zonedDate, zonedParts } from "./timezone";
import { summarizeSettlement } from "./tax-installments";

/**
 * Tax Calendar – Module 20, the second half of "corporate tax estimates
 * and a tax calendar" (spec section 19 beyond PAYE/VAT/withholding tax).
 * Generates a forward-looking (or historical, if asked) list of MRA
 * filing/payment deadlines, each annotated with a working estimate of the
 * amount due pulled from this business's own PAYE, VAT, withholding tax,
 * and corporate tax figures – reusing getVatReturn/getWithholdingTaxReturn/
 * getCorporateTaxEstimate rather than recomputing any of them.
 *
 * DESIGN CHOICES:
 *
 * 1. Due-date DAY-OF-MONTH offsets (14th for PAYE/withholding tax, 25th
 *    for VAT and provisional tax, 6 months after fiscal year-end for the
 *    annual return) are hard-coded constants below, NOT
 *    TaxConfiguration data, unlike every rate in this codebase. That's a
 *    deliberate difference from the "never hard-code a tax rate" rule
 *    Modules 10/18/19 established: a rate is something MRA sets but a
 *    business's own Tax Settings still need to record (because it's used
 *    in a calculation this app performs), whereas a filing deadline is a
 *    structural fact of the tax law with nothing for an Owner to
 *    configure – there's no "your VAT return due day" field on an MRA
 *    form the way there's a rate on a VAT3. Sourced from MRA's own public
 *    payment-due-date reminders at time of writing (see the source cited
 *    below) – MRA has granted blanket extensions before (e.g. an April
 *    2026 PAYE/withholding tax/FBT deadline extension announced on its
 *    Facebook/LinkedIn pages), so treat every date here as a normal-case
 *    default to verify against MRA's current announcements, not a
 *    guarantee.
 *
 * 2. CLOSED by Module 33 (Tax Payments): an entry can now be "paid" – it
 *    is matched, by (type, periodKey – see src/lib/tax-period.ts), to a
 *    RECORDED TaxPayment row that an Owner/Accountant logged when they
 *    actually paid the MRA, and carries that payment's summary. Still a
 *    KNOWN LIMITATION, narrower than before: "paid" means a remittance was
 *    RECORDED in this app, not that a return was FILED – this is a payment
 *    tracker, not a filing tracker (there's still no record of a return
 *    being submitted), and a business that pays the MRA without recording
 *    it here still sees the entry as overdue/upcoming.
 *
 * 3. VAT and provisional/annual corporate tax entries are only generated
 *    when they'd actually apply – VAT entries are skipped entirely for a
 *    non-VAT-registered business (mirrors every other VAT-gated feature
 *    since Module 18). PAYE and withholding tax entries are always
 *    generated (every business is a potential withholding agent and PAYE
 *    filer the moment it has ANY payroll or eligible expense), even if
 *    the computed amount for a given period is zero – a zero-amount
 *    reminder is still useful ("nothing to remit this month") and
 *    consistent with how the Withholding Tax Return tab always shows all
 *    six categories regardless of activity.
 *
 * 4. Module 34: NO OBLIGATION IS GENERATED FOR A PERIOD THAT ENDED BEFORE THE
 *    BUSINESS EXISTED HERE (Business.createdAt). Its estimate can only be
 *    zero – there is no activity to remit – yet the bell's 120-day look-back
 *    used to raise URGENT "PAYE remittance is overdue" alerts for the
 *    months before a brand-new tenant registered. And an obligation is
 *    "overdue" only after its whole due day has passed (see isPastDue in
 *    src/lib/tax-period.ts), not from 00:00 on the due day itself.
 *
 * 5. Module 35: EVERY date in this file – period starts/ends, due dates,
 *    "is it overdue yet", the business's first day – is a calendar day in
 *    Business.timezone (src/lib/timezone.ts), not the server's. A due date is
 *    the instant its day begins in that zone; on a UTC host the old
 *    runtime-local dates were two hours off Malawi's, so a filing deadline
 *    flipped to "overdue" at 02:00 Malawi time on the day AFTER it was due.
 */

const PAYE_WITHHOLDING_DUE_DAY = 14;
const VAT_PROVISIONAL_DUE_DAY = 25;
const ANNUAL_RETURN_MONTHS_AFTER_YEAR_END = 6;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Module 33: every report this file calls (getVatReturn, getWithholdingTaxReturn,
 * getCorporateTaxEstimate) treats its `to` as an inclusive upper bound, but
 * the calendar used to pass midnight at the START of a period's last day –
 * silently dropping that whole day's activity from every estimate. The
 * amounts below now pass the end of that day instead. (Module 34 closed the
 * matching gap in the accounting-hub report routes themselves – a date-only
 * `to` there now means the end of that day too, so a calendar "Est." and the
 * same month's report tab agree.)
 */
function lastDayOfMonth(year: number, month0: number, tz: string): Date {
  return zonedDate(year, month0 + 1, 0, tz);
}

export type TaxCalendarEntryType = "PAYE" | "WITHHOLDING_TAX" | "VAT" | "PROVISIONAL_TAX" | "ANNUAL_INCOME_TAX";

export interface TaxCalendarEntryPayment {
  id: string;
  paymentNumber: string;
  paymentDate: Date;
  principalAmount: number;
  penaltyAmount: number;
}

export interface TaxCalendarEntry {
  type: TaxCalendarEntryType;
  label: string;
  periodLabel: string;
  // Module 33: identify the obligation to a TaxPayment row without either
  // side storing the other's id – see src/lib/tax-period.ts. periodEnd
  // matters to the UI too: a payment can only be recorded once the period
  // has ended (see createTaxPayment).
  periodKey: string;
  periodStart: Date;
  periodEnd: Date;
  dueDate: Date;
  amount: number; // a working estimate, not a filed/assessed figure – see file header
  isExample: boolean;
  // "paid" (Module 33) takes precedence over overdue/upcoming: it means a
  // RECORDED TaxPayment exists for this exact (type, periodKey).
  // Module 67: "paid" now means SETTLED (see src/lib/tax-installments.ts) - a
  // period with only part-payments recorded keeps its overdue/upcoming status
  // and carries `partPaid` instead, so it never drops off the bell or the
  // dashboard while money is still owed.
  status: "overdue" | "upcoming" | "paid";
  // For a settled entry: the LAST recorded payment. For a part-paid one: the latest part-payment.
  payment: TaxCalendarEntryPayment | null;
  // Module 67: null unless something is recorded but the period isn't settled.
  partPaid: { paid: number; remaining: number; installmentCount: number } | null;
  // Module 67: how many RECORDED payments the period has, settled or not (0 when none).
  installmentCount: number;
}

/**
 * Builds the calendar for every obligation whose due date falls within
 * [from, to]. Scans a window starting 2 months before `from` so that a
 * period month whose due date (in the FOLLOWING month) lands inside the
 * requested range is never missed at the boundary.
 */
export async function getTaxCalendar(businessId: string, from: Date, to: Date): Promise<TaxCalendarEntry[]> {
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: businessId },
    select: { vatRegistered: true, financialYearStartMonth: true, createdAt: true, timezone: true },
  });
  const tz = resolveTimeZone(business.timezone);

  const today = new Date();
  // Module 34 – see design note 4. A period is skipped when it ENDED before
  // the day this business was created (Module 35: that DAY in the business's zone).
  const businessStart = startOfDay(business.createdAt, tz);
  const entries: TaxCalendarEntry[] = [];
  const fromParts = zonedParts(from, tz);
  const scanStart = zonedDate(fromParts.year, fromParts.month - 1 - 2, 1, tz);

  // Steps a month-start cursor forward one calendar month, in the business's zone.
  const nextMonth = (c: Date): Date => {
    const p = zonedParts(c, tz);
    return zonedDate(p.year, p.month - 1 + 1, 1, tz);
  };

  // --- Monthly obligations: PAYE, Withholding Tax, VAT ---
  for (let cursor = new Date(scanStart); cursor <= to; cursor = nextMonth(cursor)) {
    const cp = zonedParts(cursor, tz);
    const periodStart = zonedDate(cp.year, cp.month - 1, 1, tz);
    const periodEnd = lastDayOfMonth(cp.year, cp.month - 1, tz);
    if (endOfDay(periodEnd, tz) < businessStart) continue;
    const payeWithholdingDue = zonedDate(cp.year, cp.month - 1 + 1, PAYE_WITHHOLDING_DUE_DAY, tz);
    const vatDue = zonedDate(cp.year, cp.month - 1 + 1, VAT_PROVISIONAL_DUE_DAY, tz);

    if (payeWithholdingDue >= from && payeWithholdingDue <= to) {
      const payPeriod = monthKey(periodStart, tz);
      const [payeAgg, withholdingReturn] = await Promise.all([
        prisma.payroll.aggregate({ where: { businessId, payPeriod }, _sum: { paye: true } }),
        getWithholdingTaxReturn(businessId, periodStart, endOfDay(periodEnd, tz)),
      ]);

      entries.push({
        type: "PAYE",
        label: "PAYE remittance",
        periodLabel: monthLabel(periodStart, tz),
        periodKey: taxPeriodKey("PAYE", periodStart, tz),
        periodStart,
        periodEnd,
        dueDate: payeWithholdingDue,
        amount: round2(Number(payeAgg._sum.paye ?? 0)),
        isExample: false, // PAYE bands' isExample isn't fetched here; the amount is a real sum of already-computed Payroll.paye rows
        status: isPastDue(payeWithholdingDue, tz, today) ? "overdue" : "upcoming",
        payment: null,
        partPaid: null,
        installmentCount: 0,
      });

      entries.push({
        type: "WITHHOLDING_TAX",
        label: "Withholding tax remittance",
        periodLabel: monthLabel(periodStart, tz),
        periodKey: taxPeriodKey("WITHHOLDING_TAX", periodStart, tz),
        periodStart,
        periodEnd,
        dueDate: payeWithholdingDue,
        amount: withholdingReturn.totalWithheld,
        isExample: withholdingReturn.isExample,
        status: isPastDue(payeWithholdingDue, tz, today) ? "overdue" : "upcoming",
        payment: null,
        partPaid: null,
        installmentCount: 0,
      });
    }

    if (business.vatRegistered && vatDue >= from && vatDue <= to) {
      const vatReturn = await getVatReturn(businessId, periodStart, endOfDay(periodEnd, tz));
      entries.push({
        type: "VAT",
        label: "VAT return & payment",
        periodLabel: monthLabel(periodStart, tz),
        periodKey: taxPeriodKey("VAT", periodStart, tz),
        periodStart,
        periodEnd,
        dueDate: vatDue,
        amount: vatReturn.netPayable,
        isExample: vatReturn.isExample,
        status: isPastDue(vatDue, tz, today) ? "overdue" : "upcoming",
        payment: null,
        partPaid: null,
        installmentCount: 0,
      });
    }
  }

  // --- Quarterly provisional tax + annual income tax, per fiscal year overlapping the window ---
  const seenFiscalYears = new Set<string>();
  for (let cursor = new Date(scanStart); cursor <= to; cursor = nextMonth(cursor)) {
    const fy = getFiscalYear(business.financialYearStartMonth, cursor, tz);
    const key = fy.start.toISOString();
    if (seenFiscalYears.has(key)) continue;
    seenFiscalYears.add(key);

    for (const quarter of getFiscalQuarters(fy.start, tz)) {
      const qe = zonedParts(quarter.end, tz);
      const dueDate = zonedDate(qe.year, qe.month - 1 + 1, VAT_PROVISIONAL_DUE_DAY, tz);
      if (dueDate < from || dueDate > to) continue;
      if (endOfDay(quarter.end, tz) < businessStart) continue;
      const estimate = await getCorporateTaxEstimate(businessId, quarter.start, endOfDay(quarter.end, tz));
      entries.push({
        type: "PROVISIONAL_TAX",
        label: "Provisional (corporate) tax installment",
        periodLabel: quarterLabel(quarter.start, quarter.end, tz),
        periodKey: taxPeriodKey("PROVISIONAL_TAX", quarter.start, tz),
        periodStart: quarter.start,
        periodEnd: quarter.end,
        dueDate,
        amount: estimate.estimatedTax,
        isExample: estimate.isExample,
        status: isPastDue(dueDate, tz, today) ? "overdue" : "upcoming",
        payment: null,
        partPaid: null,
        installmentCount: 0,
      });
    }

    const fe = zonedParts(fy.end, tz);
    const annualDue = zonedDate(fe.year, fe.month - 1 + ANNUAL_RETURN_MONTHS_AFTER_YEAR_END + 1, 0, tz);
    if (annualDue >= from && annualDue <= to && endOfDay(fy.end, tz) >= businessStart) {
      const estimate = await getCorporateTaxEstimate(businessId, fy.start, endOfDay(fy.end, tz));
      entries.push({
        type: "ANNUAL_INCOME_TAX",
        label: "Annual income tax return & balance due",
        periodLabel: fiscalYearLabel(fy.start, fy.end, tz),
        periodKey: taxPeriodKey("ANNUAL_INCOME_TAX", fy.start, tz),
        periodStart: fy.start,
        periodEnd: fy.end,
        dueDate: annualDue,
        amount: estimate.estimatedTax,
        isExample: estimate.isExample,
        status: isPastDue(annualDue, tz, today) ? "overdue" : "upcoming",
        payment: null,
        partPaid: null,
        installmentCount: 0,
      });
    }
  }

  await attachRecordedPayments(businessId, entries);

  return entries.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
}

/**
 * Module 33: marks every entry that has a RECORDED TaxPayment as "paid"
 * (mutating in place, since getTaxCalendar owns the array it just built).
 * One query for the whole window, matched on (taxType, periodKey). A VOIDED
 * payment is never matched (status filter), so voiding one puts the entry
 * straight back to overdue/upcoming, computed fresh from today's date like
 * every other entry.
 *
 * Module 67: a period can now have several RECORDED payments (installments),
 * so they are grouped per entry and run through summarizeSettlement() against
 * the entry's own working estimate. Settled -> "paid"; anything recorded but
 * not settled -> partPaid, status untouched.
 */
async function attachRecordedPayments(businessId: string, entries: TaxCalendarEntry[]): Promise<void> {
  if (entries.length === 0) return;

  const payments = await prisma.taxPayment.findMany({
    where: {
      businessId,
      status: "RECORDED",
      OR: entries.map((e) => ({ taxType: e.type, periodKey: e.periodKey })),
    },
    select: {
      id: true,
      paymentNumber: true,
      paymentDate: true,
      taxType: true,
      periodKey: true,
      principalAmount: true,
      penaltyAmount: true,
      installmentNo: true,
      settlesPeriod: true,
    },
    orderBy: [{ installmentNo: "asc" }, { createdAt: "asc" }],
  });
  const byKey = new Map<string, typeof payments>();
  for (const p of payments) {
    const k = `${p.taxType}:${p.periodKey}`;
    const list = byKey.get(k);
    if (list) list.push(p);
    else byKey.set(k, [p]);
  }

  for (const entry of entries) {
    const rows = byKey.get(`${entry.type}:${entry.periodKey}`);
    if (!rows || rows.length === 0) continue;
    // VAT is always one final payment, whatever its amount: its "expected" is a signed net figure that
    // can be zero or negative (a refund), which the installment maths isn't meant to interpret.
    const settlement =
      entry.type === "VAT"
        ? { settled: true, paid: 0, remaining: 0, count: rows.length }
        : summarizeSettlement(
            entry.amount,
            rows.map((r) => ({ installmentNo: r.installmentNo, principalAmount: Number(r.principalAmount), settlesPeriod: r.settlesPeriod }))
          );
    const last = rows[rows.length - 1];
    entry.installmentCount = rows.length;
    entry.payment = {
      id: last.id,
      paymentNumber: last.paymentNumber,
      paymentDate: last.paymentDate,
      principalAmount: round2(Number(last.principalAmount)),
      penaltyAmount: round2(Number(last.penaltyAmount)),
    };
    if (settlement.settled) {
      entry.status = "paid";
    } else {
      entry.partPaid = { paid: settlement.paid, remaining: settlement.remaining, installmentCount: rows.length };
    }
  }
}
