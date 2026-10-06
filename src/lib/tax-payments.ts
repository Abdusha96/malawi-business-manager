import { prisma } from "./prisma";
import { Prisma } from "@prisma/client";
import { getVatReturn } from "./vat";
import { getWithholdingTaxReturn } from "./withholding-tax";
import { getCorporateTaxEstimate, getFiscalYear, getFiscalQuarters } from "./corporate-tax";
import { postJournalEntryForTaxPayment } from "./accounting-integrations";
import { reverseJournalEntriesForReference } from "./accounting";
import { postCashTransactionForTaxPayment, reverseCashTransactionsForReference, getAccountBalance } from "./cashbook";
import { logAudit } from "./audit";
import {
  TaxPaymentTypeKey,
  TAX_PAYMENT_TYPE_LABELS,
  isMonthlyTaxType,
  parseMonthKey,
  parseYmd,
  ymd,
  monthKey,
  endOfDay,
  monthLabel,
  quarterLabel,
  fiscalYearLabel,
} from "./tax-period";
import { resolveTimeZone, zonedDate, zonedParts } from "./timezone";
import { resolveVatDirection } from "./vat-payment-direction";
import { nextMonthKey, enumerateMonthKeysBetween, sumCarryForward, MAX_CARRY_FORWARD_MONTHS } from "./vat-carry-forward";
import { supportsInstallments, summarizeSettlement, decideInstallment, installmentKey } from "./tax-installments";
import type { TaxPaymentInput } from "./validation";

/**
 * Tax Payments – Module 33. Records an actual remittance to the MRA against
 * one obligation period and posts it to BOTH ledgers in one transaction
 * (Cashbook + GL), the same discipline every money movement in this app
 * follows. Closes the "remittance isn't modeled" limitation Modules 18, 19
 * and 20 each documented, and – via src/lib/tax-calendar.ts – Module 20's
 * "nothing can be marked done" and Module 25's "TAX_DUE never resolves".
 *
 * DESIGN CHOICES, stated plainly:
 *
 * 1. One RECORDED payment per (taxType, periodKey) for VAT. The DB enforces
 *    it (TaxPayment.activePeriodKey); this file turns the resulting
 *    unique-constraint error into a readable one.
 *    Module 67 CLOSED the "no installments" half of this for PAYE,
 *    withholding, provisional and annual income tax: a period can now have
 *    several RECORDED payments (TaxPayment.installmentNo), and
 *    activePeriodKey carries the installment number from the second one on
 *    (see src/lib/tax-installments.ts, which also decides when a period is
 *    settled). VAT is deliberately still one payment - its principal is
 *    computed from the return and cleared against VAT_OUTPUT_PAYABLE /
 *    VAT_INPUT_RECEIVABLE as a whole, so a part-payment has nothing sound to
 *    clear.
 *
 * 2. VAT's principal is computed by the server from the period's VAT
 *    Return (output minus input), never typed in – a hand-typed figure
 *    could not be netted correctly against VAT_INPUT_RECEIVABLE.
 *    Module 45: "input" here means the RECLAIMABLE share of the period's
 *    input VAT (getVatReturn().partialExemption.recoverableInputVat), not
 *    the gross ledger figure – a business with exempt sales apportioned
 *    that period clears only that share from VAT_INPUT_RECEIVABLE here.
 *    The irrecoverable remainder is a separate manual-journal write-off
 *    (src/lib/manual-journal-rules.ts), not part of this remittance.
 *    Module 46: a net-REFUNDABLE period (reclaimable input > output) is now
 *    recordable too, as a REFUND RECEIPT rather than a remittance –
 *    TaxPayment.isRefund true, principal = input − output, cash comes IN.
 *    It's still one row per (taxType, periodKey): a period is either paid
 *    or refunded, never both, so the same activePeriodKey guard covers it.
 *    Module 47 CLOSED the limitation this comment used to document here
 *    (carry-forward netting) – see design choice 2b below.
 *
 * 2b. Module 47: a VAT period the business elects to CARRY forward (no
 *    payment recorded for it, the more common MRA practice in Malawi than
 *    an actual refund receipt) is no longer a dead end. getVatCarryForward
 *    below walks every monthly VAT period between the most recent RECORDED
 *    VAT payment (either direction) and the period now being recorded,
 *    sums the net payable of whichever of those periods still has no
 *    payment against it, and getTaxPaymentPreview folds that sum into the
 *    period's own netPayable BEFORE resolveVatDirection decides remit vs.
 *    refund – so an old unaddressed credit automatically reduces (or, if
 *    large enough, flips) the next remittance, and an old unaddressed
 *    payable automatically adds to it. The clearing amounts posted to
 *    VAT_OUTPUT_PAYABLE/VAT_INPUT_RECEIVABLE are widened the same way (see
 *    createTaxPayment), so the GL genuinely clears the carried amount, not
 *    just the current period's own figure – this is real netting, not a
 *    display-only adjustment. Once a business's payments are all recorded
 *    through Module 47, every future payment re-establishes "everything
 *    before this period is settled" as the new boundary, so the walk stays
 *    short going forward; a business with a long-unrecorded history before
 *    its first Module-47-era payment is capped at MAX_CARRY_FORWARD_MONTHS
 *    (see vat-carry-forward.ts) and flagged via `truncated` rather than
 *    scanning its whole lifetime. KNOWN LIMITATION, still open: this only
 *    reaches periods after the most recent RECORDED VAT payment (or the
 *    cap, whichever is closer) – a gap that predates a business's very
 *    first recorded VAT payment, beyond the cap, is not picked up
 *    retroactively; it would need to be caught up by hand (e.g. by
 *    recording a VAT payment for one of those old periods directly).
 *
 * 3. PAYE and withholding tax can't be paid past what the books say is
 *    owed: principal may not exceed the current balance of PAYE_PAYABLE /
 *    WITHHOLDING_TAX_PAYABLE. That keeps this feature from ever pushing a
 *    liability negative. If the MRA charges more, the excess is a penalty
 *    (recorded separately), or the underlying payroll/expense is wrong.
 *
 * 4. Provisional and annual income tax post to INCOME_TAX_PREPAID (an
 *    asset) – see that account's comment in chart-of-accounts.ts. The
 *    annual suggestion nets off provisional payments already recorded for
 *    the same fiscal year.
 *
 * 5. A payment can only be recorded once its period has ENDED – a VAT/PAYE
 *    figure snapshotted mid-period would miss everything that happens
 *    after, with nothing to top it up (see design choice 1).
 *
 * 6. Penalties/interest are optional and post to their own expense
 *    account; principal must still be > 0 (a penalty-only payment isn't
 *    modeled). Recorded penalties are added back in corporate tax
 *    estimates (src/lib/corporate-tax.ts).
 *
 * 7. Business-wide, branch-null – see the TaxPayment model comment.
 *
 * 8. Period bounds passed to the VAT/withholding/corporate functions are
 *    END-OF-DAY on the period's last day. Those functions treat `to` as an
 *    inclusive bound but compare against timestamps, so passing midnight
 *    (as the accounting-hub report routes do with a date-only `to`) drops
 *    the whole last day – see this module's README "found, not fixed".
 */

export class TaxPaymentError extends Error {}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface ResolvedTaxPeriod {
  start: Date;
  end: Date; // last calendar day, at 00:00 in the business's zone – use endOfDay(end, tz) for range queries
  label: string;
}

/**
 * Turns (type, key) into the period it names, or null if the key isn't a
 * real period for this business – e.g. a provisional key that isn't the
 * first day of one of THIS business's fiscal quarters. Uses the exact same
 * fiscal-year helpers the Tax Calendar uses, so the two can never disagree
 * about where a period starts and ends. Module 35: `tz` is the business's
 * zone – the key names calendar days, and they are that zone's days.
 */
export function resolveTaxPeriod(
  type: TaxPaymentTypeKey,
  key: string,
  financialYearStartMonth: number,
  tz: string
): ResolvedTaxPeriod | null {
  if (isMonthlyTaxType(type)) {
    const start = parseMonthKey(key, tz);
    if (!start) return null;
    const sp = zonedParts(start, tz);
    const end = zonedDate(sp.year, sp.month - 1 + 1, 0, tz);
    return { start, end, label: monthLabel(start, tz) };
  }

  const d = parseYmd(key, tz);
  if (!d) return null;
  const fy = getFiscalYear(financialYearStartMonth, d, tz);

  if (type === "ANNUAL_INCOME_TAX") {
    if (ymd(fy.start, tz) !== key) return null;
    return { start: fy.start, end: fy.end, label: fiscalYearLabel(fy.start, fy.end, tz) };
  }

  const quarter = getFiscalQuarters(fy.start, tz).find((q) => ymd(q.start, tz) === key);
  if (!quarter) return null;
  return { start: quarter.start, end: quarter.end, label: quarterLabel(quarter.start, quarter.end, tz) };
}

/** A LIABILITY account's current balance (credit minus debit); 0 if the business doesn't have the account yet. */
async function getLiabilityBalance(client: Prisma.TransactionClient, businessId: string, systemKey: string): Promise<number> {
  const account = await client.account.findUnique({ where: { businessId_systemKey: { businessId, systemKey } } });
  if (!account) return 0;
  const agg = await client.journalLine.aggregate({
    where: { accountId: account.id, journalEntry: { businessId } },
    _sum: { debit: true, credit: true },
  });
  return round2(Number(agg._sum.credit ?? 0) - Number(agg._sum.debit ?? 0));
}

const LIABILITY_KEY_BY_TYPE: Partial<Record<TaxPaymentTypeKey, string>> = {
  PAYE: "PAYE_PAYABLE",
  WITHHOLDING_TAX: "WITHHOLDING_TAX_PAYABLE",
};

export interface VatCarryForward {
  amount: number; // same sign convention as getVatReturn().netPayable – 0 when nothing carries forward
  fromPeriodKey: string | null; // oldest unaddressed month included, if any
  toPeriodKey: string | null; // newest unaddressed month included, if any
  monthsIncluded: number;
  truncated: boolean; // true if the gap exceeded MAX_CARRY_FORWARD_MONTHS and older months were left out
}

/**
 * Module 47 – see design choice 2b above. `beforePeriodKey` is the VAT
 * period now being recorded; only strictly earlier monthly periods are
 * ever included. Runs the getVatReturn() computations it needs to in
 * parallel – this is only ever called while previewing/recording a single
 * VAT payment, not a hot path, but there's no reason to serialize
 * independent reads.
 */
async function getVatCarryForward(params: { businessId: string; tz: string; beforePeriodKey: string }): Promise<VatCarryForward> {
  const { businessId, tz, beforePeriodKey } = params;
  const empty: VatCarryForward = { amount: 0, fromPeriodKey: null, toPeriodKey: null, monthsIncluded: 0, truncated: false };

  const lastPayment = await prisma.taxPayment.findFirst({
    where: { businessId, taxType: "VAT", status: "RECORDED" },
    orderBy: { periodEnd: "desc" },
    select: { periodKey: true },
  });

  let startKey: string;
  if (lastPayment) {
    startKey = nextMonthKey(lastPayment.periodKey);
  } else {
    // No VAT payment ever recorded for this business – look back to its
    // earliest sale or purchase (nothing predates the business having any
    // transactions at all, so this is a safe, self-bounding starting point).
    const [firstSale, firstPurchase] = await Promise.all([
      prisma.sale.findFirst({ where: { businessId, status: { not: "VOIDED" } }, orderBy: { saleDate: "asc" }, select: { saleDate: true } }),
      prisma.purchase.findFirst({ where: { businessId, status: { not: "VOIDED" } }, orderBy: { purchaseDate: "asc" }, select: { purchaseDate: true } }),
    ]);
    const candidates = [firstSale?.saleDate, firstPurchase?.purchaseDate].filter((d): d is Date => !!d);
    if (candidates.length === 0) return empty;
    const earliest = candidates.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
    startKey = monthKey(earliest, tz);
  }

  let monthKeys = enumerateMonthKeysBetween(startKey, beforePeriodKey);
  if (monthKeys.length === 0) return empty;
  let truncated = false;
  if (monthKeys.length > MAX_CARRY_FORWARD_MONTHS) {
    monthKeys = monthKeys.slice(monthKeys.length - MAX_CARRY_FORWARD_MONTHS); // keep the most recent months – closest to, and most likely to still matter for, the period being recorded
    truncated = true;
  }

  // Defensive: a payment could in principle have been recorded for one of
  // these months out of chronological order (voided and never re-recorded
  // elsewhere, say) even though `lastPayment` above is the newest one – so
  // don't just trust the boundary, check each month directly.
  const alreadyRecorded = await prisma.taxPayment.findMany({
    where: { businessId, taxType: "VAT", status: "RECORDED", periodKey: { in: monthKeys } },
    select: { periodKey: true },
  });
  const recordedSet = new Set(alreadyRecorded.map((p) => p.periodKey));
  const unaddressed = monthKeys.filter((k) => !recordedSet.has(k));
  if (unaddressed.length === 0) return { ...empty, truncated };

  const netPayables = await Promise.all(
    unaddressed.map(async (key) => {
      const period = resolveTaxPeriod("VAT", key, 1, tz)!; // financialYearStartMonth is irrelevant to a monthly VAT period
      const ret = await getVatReturn(businessId, period.start, endOfDay(period.end, tz));
      return ret.netPayable;
    })
  );

  return {
    amount: sumCarryForward(netPayables),
    fromPeriodKey: unaddressed[0],
    toPeriodKey: unaddressed[unaddressed.length - 1],
    monthsIncluded: unaddressed.length,
    truncated,
  };
}

/**
 * Everything the "record a payment" form needs to show for one obligation,
 * computed fresh. Also used by createTaxPayment so the form's numbers and
 * the posted numbers come from one code path.
 */
export async function getTaxPaymentPreview(params: { businessId: string; taxType: TaxPaymentTypeKey; periodKey: string }) {
  const { businessId, taxType, periodKey } = params;

  const business = await prisma.business.findUniqueOrThrow({
    where: { id: businessId },
    select: { vatRegistered: true, financialYearStartMonth: true, timezone: true },
  });
  const tz = resolveTimeZone(business.timezone);

  const period = resolveTaxPeriod(taxType, periodKey, business.financialYearStartMonth, tz);
  if (!period) {
    throw new TaxPaymentError("That isn't a valid period for this tax type.");
  }
  const to = endOfDay(period.end, tz);
  const periodEnded = to.getTime() < Date.now();

  const recordedRows = await prisma.taxPayment.findMany({
    where: { businessId, taxType, periodKey, status: "RECORDED" },
    select: { id: true, paymentNumber: true, paymentDate: true, installmentNo: true, principalAmount: true, settlesPeriod: true },
    orderBy: [{ installmentNo: "asc" }, { createdAt: "asc" }],
  });

  let suggestedPrincipal = 0;
  let isExample = false;
  let isRefund = false;
  let vat: {
    outputVat: number;
    inputVat: number;
    netPayable: number;
    // Module 45: only populated when the period's apportionment actually restricted
    // recovery – lets the form show a note without cluttering every VAT payment.
    irrecoverableInputVat?: number;
    // Module 47: only populated when there's actually something unaddressed to carry –
    // adjustedNetPayable (= netPayable + carryForward.amount) is what suggestedPrincipal/
    // isRefund are actually derived from, and what createTaxPayment clears.
    carryForward?: { amount: number; fromPeriodKey: string; toPeriodKey: string; monthsIncluded: number; truncated: boolean };
    adjustedNetPayable: number;
  } | null = null;
  let provisionalAlreadyPaid: number | null = null;

  if (taxType === "VAT") {
    const vatReturn = await getVatReturn(businessId, period.start, to);
    // Module 47: fold in whatever earlier monthly periods were never recorded (a business
    // that elected to carry a credit forward, or simply hasn't caught up on a remittance)
    // BEFORE deciding remit-vs-refund for this period. See getVatCarryForward and this
    // file's design choice 2b above.
    const carry = await getVatCarryForward({ businessId, tz, beforePeriodKey: periodKey });
    const adjustedNetPayable = round2(vatReturn.netPayable + carry.amount);
    // Module 45: `inputVat` here is the RECLAIMABLE share (vatReturn.partialExemption.
    // recoverableInputVat), not vatReturn.purchases.inputVat's gross ledger figure – this is
    // the amount that actually offsets output VAT and the amount vatInputCleared below clears
    // out of VAT_INPUT_RECEIVABLE. The irrecoverable share stays on the books until an
    // Accountant writes it off by manual journal entry (see manual-journal-rules.ts).
    vat = {
      outputVat: vatReturn.sales.outputVat,
      inputVat: vatReturn.partialExemption.recoverableInputVat,
      netPayable: vatReturn.netPayable,
      irrecoverableInputVat: vatReturn.partialExemption.apportioned ? vatReturn.partialExemption.irrecoverableInputVat : undefined,
      carryForward:
        carry.amount !== 0 && carry.fromPeriodKey && carry.toPeriodKey
          ? { amount: carry.amount, fromPeriodKey: carry.fromPeriodKey, toPeriodKey: carry.toPeriodKey, monthsIncluded: carry.monthsIncluded, truncated: carry.truncated }
          : undefined,
      adjustedNetPayable,
    };
    // Module 46: adjustedNetPayable < 0 means reclaimable input VAT (this period plus any
    // carried-forward credit) exceeded output VAT (plus any carried-forward payable) – a
    // refund, not a remittance. suggestedPrincipal is the magnitude either way so the form
    // always has a positive number to show; isRefund says which direction it flows.
    const direction = resolveVatDirection(adjustedNetPayable);
    isRefund = direction.isRefund;
    suggestedPrincipal = direction.magnitude;
    isExample = vatReturn.isExample;
  } else if (taxType === "PAYE") {
    // PAID runs only: a DRAFT run hasn't posted to PAYE_PAYABLE yet, so
    // counting it would suggest more than the books actually owe.
    const agg = await prisma.payroll.aggregate({
      where: { businessId, payPeriod: periodKey, status: "PAID" },
      _sum: { paye: true },
    });
    suggestedPrincipal = round2(Number(agg._sum.paye ?? 0));
  } else if (taxType === "WITHHOLDING_TAX") {
    const ret = await getWithholdingTaxReturn(businessId, period.start, to);
    suggestedPrincipal = ret.totalWithheld;
    isExample = ret.isExample;
  } else {
    const estimate = await getCorporateTaxEstimate(businessId, period.start, to);
    isExample = estimate.isExample;
    suggestedPrincipal = estimate.estimatedTax;
    if (taxType === "ANNUAL_INCOME_TAX") {
      const agg = await prisma.taxPayment.aggregate({
        where: {
          businessId,
          taxType: "PROVISIONAL_TAX",
          status: "RECORDED",
          periodStart: { gte: period.start },
          periodEnd: { lte: period.end },
        },
        _sum: { principalAmount: true },
      });
      provisionalAlreadyPaid = round2(Number(agg._sum.principalAmount ?? 0));
      suggestedPrincipal = Math.max(0, round2(estimate.estimatedTax - provisionalAlreadyPaid));
    }
  }

  const liabilityKey = LIABILITY_KEY_BY_TYPE[taxType];
  const liabilityBalance = liabilityKey ? await getLiabilityBalance(prisma, businessId, liabilityKey) : null;

  // Module 67: non-VAT periods can be paid in installments, so "already
  // recorded" now means SETTLED, not "has any payment". VAT keeps the old
  // meaning (one payment, always final).
  const installments = summarizeSettlement(
    round2(suggestedPrincipal),
    recordedRows.map((r) => ({ installmentNo: r.installmentNo, principalAmount: Number(r.principalAmount), settlesPeriod: r.settlesPeriod }))
  );
  const alreadyRecorded =
    recordedRows.length === 0 ? null : !supportsInstallments(taxType) || installments.settled ? { id: recordedRows[0].id, paymentNumber: recordedRows[0].paymentNumber } : null;

  return {
    taxType,
    periodKey,
    periodLabel: period.label,
    periodStart: period.start,
    periodEnd: period.end,
    periodEnded,
    vatApplicable: taxType !== "VAT" || business.vatRegistered,
    principalIsFixed: taxType === "VAT",
    suggestedPrincipal: round2(suggestedPrincipal),
    isRefund,
    vat,
    provisionalAlreadyPaid,
    liabilityBalance,
    isExample,
    alreadyRecorded,
    canPayInInstallments: supportsInstallments(taxType),
    installments: {
      count: installments.count,
      paid: installments.paid,
      remaining: installments.remaining,
      settled: installments.settled,
      partiallyPaid: installments.partiallyPaid,
      nextInstallmentNo: installments.nextInstallmentNo,
      payments: recordedRows.map((r) => ({
        id: r.id,
        paymentNumber: r.paymentNumber,
        paymentDate: r.paymentDate,
        installmentNo: r.installmentNo,
        principalAmount: round2(Number(r.principalAmount)),
        settlesPeriod: r.settlesPeriod,
      })),
    },
  };
}

export async function createTaxPayment(params: { businessId: string; userId: string; input: TaxPaymentInput }) {
  const { businessId, userId, input } = params;
  const taxType = input.taxType as TaxPaymentTypeKey;

  const paymentDate = input.paymentDate ? new Date(input.paymentDate) : new Date();
  if (Number.isNaN(paymentDate.getTime())) throw new TaxPaymentError("Invalid payment date.");
  // One day of slack so a date picked in a time zone ahead of the server's
  // (Malawi is UTC+2) isn't rejected as "the future".
  if (paymentDate.getTime() > Date.now() + 86_400_000) {
    throw new TaxPaymentError("The payment date can't be in the future – record it once it's actually been paid.");
  }

  const preview = await getTaxPaymentPreview({ businessId, taxType, periodKey: input.periodKey });

  if (!preview.periodEnded) {
    throw new TaxPaymentError(`${preview.periodLabel} hasn't ended yet – record the payment once the period is over so the amount is final.`);
  }
  if (!preview.vatApplicable) {
    throw new TaxPaymentError("This business isn't VAT-registered – turn on VAT registration in Tax Settings first.");
  }
  if (preview.alreadyRecorded) {
    throw new TaxPaymentError(
      `${preview.alreadyRecorded.paymentNumber} is already recorded for this ${TAX_PAYMENT_TYPE_LABELS[taxType]} period. Void it first if it was wrong.`
    );
  }

  let principal: number;
  let vatOutputCleared: number | null = null;
  let vatInputCleared: number | null = null;
  let carryForwardApplied: number | null = null;
  let carryForwardPeriods: string | null = null;
  const isRefund = preview.isRefund;
  // Module 67: VAT is always instalment 1 and always final; the non-VAT branch below overwrites these.
  let installmentNo = 1;
  let settlesPeriod = true;

  if (taxType === "VAT") {
    if (input.partial) throw new TaxPaymentError("VAT is always paid in one payment for the period's net amount - it can't be part-paid.");
    const vat = preview.vat!;
    const direction = resolveVatDirection(vat.adjustedNetPayable);
    if (direction.magnitude === 0) {
      throw new TaxPaymentError(
        "This period has no net VAT payable or refundable (output and reclaimable input VAT, plus any carried-forward balance, net to zero), so there's nothing to record."
      );
    }
    // Module 47: widen the amounts actually cleared from each account so the GL clears the
    // carried-forward balance alongside this period's own figure, not just the latter – a
    // positive carry (still owed to the MRA from earlier periods) is added to what's cleared
    // from VAT_OUTPUT_PAYABLE; a negative carry (an earlier net credit) is added to what's
    // cleared from VAT_INPUT_RECEIVABLE. Either way output-cleared minus input-cleared still
    // equals the principal below – postJournalEntryForTaxPayment enforces exactly that.
    const cf = round2(vat.carryForward?.amount ?? 0);
    vatOutputCleared = round2(vat.outputVat + Math.max(cf, 0));
    vatInputCleared = round2(vat.inputVat + Math.max(-cf, 0));
    principal = direction.magnitude;
    if (vat.carryForward) {
      carryForwardApplied = cf;
      carryForwardPeriods = vat.carryForward.fromPeriodKey === vat.carryForward.toPeriodKey ? vat.carryForward.fromPeriodKey : `${vat.carryForward.fromPeriodKey} to ${vat.carryForward.toPeriodKey}`;
    }
    if (isRefund && input.penaltyAmount) {
      // Module 46: net-refundable period – the MRA owes the business, not
      // the other way round. No penalty makes sense on a refund.
      throw new TaxPaymentError("A VAT refund can't include a penalty/interest amount.");
    }
    if (input.principalAmount != null && Math.abs(input.principalAmount - principal) > 0.01) {
      throw new TaxPaymentError(
        isRefund
          ? `A VAT refund is always for the period's net refundable amount, MWK ${principal.toLocaleString()} – it can't be changed.`
          : `A VAT payment is always for the period's net payable, MWK ${principal.toLocaleString()} – it can't be changed.`
      );
    }
  } else {
    principal = round2(input.principalAmount ?? 0);
    if (principal <= 0) throw new TaxPaymentError("Enter the amount paid toward the tax itself.");
    // Module 67: settled periods refuse a further payment; a part-payment (or any payment
    // after the first) must fit inside what's still owed. Nothing is clamped.
    const decision = decideInstallment({
      taxType,
      expected: preview.suggestedPrincipal,
      rows: preview.installments.payments.map((p) => ({
        installmentNo: p.installmentNo,
        principalAmount: p.principalAmount,
        settlesPeriod: p.settlesPeriod,
      })),
      principal,
      partial: !!input.partial,
    });
    if (!decision.ok) throw new TaxPaymentError(decision.message);
    installmentNo = decision.installmentNo;
    settlesPeriod = decision.settlesPeriod;
    if (preview.liabilityBalance !== null && principal > preview.liabilityBalance + 0.01) {
      throw new TaxPaymentError(
        `The books only show MWK ${preview.liabilityBalance.toLocaleString()} of ${TAX_PAYMENT_TYPE_LABELS[taxType]} payable, so MWK ${principal.toLocaleString()} can't be recorded as tax. ` +
          `Record any extra the MRA charged as penalty/interest, or check the underlying payroll/expense records.`
      );
    }
  }

  const penalty = round2(input.penaltyAmount ?? 0);
  const totalPaid = round2(principal + penalty);

  const account = await prisma.cashAccount.findUnique({ where: { id: input.cashAccountId } });
  if (!account || account.businessId !== businessId || !account.isActive) {
    throw new TaxPaymentError("Cash account not found in this business.");
  }
  // Module 46: a refund adds cash to the account, so there's no balance to
  // check – only a remittance can be blocked by insufficient funds.
  if (!isRefund) {
    const balance = await getAccountBalance(account.id);
    if (balance < totalPaid) {
      throw new TaxPaymentError(
        `Insufficient balance in ${account.name}: has MWK ${balance.toLocaleString()}, tried to pay MWK ${totalPaid.toLocaleString()}.`
      );
    }
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const business = await tx.business.update({
        where: { id: businessId },
        data: { nextTaxPaymentNumber: { increment: 1 } },
      });
      const paymentNumber = `${business.taxPaymentPrefix}-${String(business.nextTaxPaymentNumber - 1).padStart(6, "0")}`;

      const payment = await tx.taxPayment.create({
        data: {
          businessId,
          paymentNumber,
          taxType,
          periodKey: input.periodKey,
          periodLabel: preview.periodLabel,
          periodStart: preview.periodStart,
          periodEnd: preview.periodEnd,
          paymentDate,
          accountId: account.id,
          principalAmount: principal,
          penaltyAmount: penalty,
          vatOutputCleared: vatOutputCleared ?? undefined,
          vatInputCleared: vatInputCleared ?? undefined,
          carryForwardApplied: carryForwardApplied ?? undefined,
          carryForwardPeriods: carryForwardPeriods ?? undefined,
          isRefund,
          installmentNo,
          settlesPeriod,
          reference: input.reference ?? undefined,
          notes: input.notes ?? undefined,
          status: "RECORDED",
          activePeriodKey: installmentKey(businessId, taxType, input.periodKey, installmentNo),
          recordedById: userId,
        },
      });

      const label = `${TAX_PAYMENT_TYPE_LABELS[taxType]} (${preview.periodLabel})`;

      await postCashTransactionForTaxPayment({
        tx,
        businessId,
        paymentId: payment.id,
        accountId: account.id,
        amount: totalPaid,
        isRefund,
        description: `${isRefund ? "VAT refund" : "Tax payment"} ${paymentNumber} – ${label}`,
        createdById: userId,
      });

      await postJournalEntryForTaxPayment({
        tx,
        businessId,
        paymentId: payment.id,
        paymentNumber,
        taxType,
        periodLabel: preview.periodLabel,
        principalAmount: principal,
        penaltyAmount: penalty,
        vatOutputCleared,
        vatInputCleared,
        isRefund,
        cashAccountType: account.type,
        paymentDate,
        createdById: userId,
      });

      await logAudit({
        tx,
        businessId,
        userId,
        action: isRefund ? "taxpayment.refund" : "taxpayment.create",
        entityType: "TaxPayment",
        entityId: payment.id,
        metadata: { paymentNumber, taxType, periodKey: input.periodKey, principal, penalty, totalPaid, isRefund, carryForwardApplied, carryForwardPeriods, installmentNo, settlesPeriod },
      });

      return payment;
    });
  } catch (err) {
    // The activePeriodKey unique index is the real guard against two people
    // recording the same period (or the same installment number of it) at
    // once; the check above is only the friendly, common-case message.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new TaxPaymentError("A payment was just recorded for this period by someone else. Refresh to see the new balance.");
    }
    throw err;
  }
}

/**
 * Reverses a recorded payment in BOTH ledgers (equal-and-opposite entries –
 * nothing is deleted, same rule as every other reversal here) and frees the
 * period so a corrected payment can be recorded. The row stays as VOIDED
 * history with who/when/why.
 */
export async function voidTaxPayment(params: { businessId: string; paymentId: string; userId: string; reason: string }) {
  const { businessId, paymentId, userId, reason } = params;

  const payment = await prisma.taxPayment.findFirst({ where: { id: paymentId, businessId } });
  if (!payment) throw new TaxPaymentError("Tax payment not found.");
  if (payment.status !== "RECORDED") throw new TaxPaymentError("This payment has already been voided.");

  return prisma.$transaction(async (tx) => {
    const why = `Tax payment ${payment.paymentNumber} voided – ${reason}`;

    await reverseJournalEntriesForReference({
      tx,
      businessId,
      referenceType: "TaxPayment",
      referenceId: payment.id,
      createdById: userId,
      reason: why,
    });
    await reverseCashTransactionsForReference({
      tx,
      businessId,
      referenceType: "TaxPayment",
      referenceId: payment.id,
      createdById: userId,
      reason: why,
    });

    const voided = await tx.taxPayment.update({
      where: { id: payment.id },
      data: { status: "VOIDED", activePeriodKey: null, voidedAt: new Date(), voidedById: userId, voidReason: reason },
    });

    await logAudit({
      tx,
      businessId,
      userId,
      action: "taxpayment.void",
      entityType: "TaxPayment",
      entityId: payment.id,
      metadata: { paymentNumber: payment.paymentNumber, reason },
    });

    return voided;
  });
}

export async function listTaxPayments(businessId: string, filters: { taxType?: string; status?: string } = {}) {
  return prisma.taxPayment.findMany({
    where: {
      businessId,
      ...(filters.taxType ? { taxType: filters.taxType as TaxPaymentTypeKey } : {}),
      ...(filters.status ? { status: filters.status as "RECORDED" | "VOIDED" } : {}),
    },
    include: { account: { select: { name: true, type: true } } },
    orderBy: [{ paymentDate: "desc" }, { createdAt: "desc" }],
    take: 500,
  });
}

export async function getTaxPayment(params: { businessId: string; paymentId: string }) {
  return prisma.taxPayment.findFirst({
    where: { id: params.paymentId, businessId: params.businessId },
    include: { account: { select: { name: true, type: true } } },
  });
}

/**
 * Module 67: every RECORDED payment for one (taxType, periodKey), oldest installment first - the
 * detail page's "other payments for this period" list. Voided rows are history of a payment, not
 * of the period, so they are left out.
 */
export async function listPeriodInstallments(params: { businessId: string; taxType: string; periodKey: string }) {
  const rows = await prisma.taxPayment.findMany({
    where: { businessId: params.businessId, taxType: params.taxType as TaxPaymentTypeKey, periodKey: params.periodKey, status: "RECORDED" },
    select: { id: true, paymentNumber: true, paymentDate: true, installmentNo: true, principalAmount: true, settlesPeriod: true },
    orderBy: [{ installmentNo: "asc" }, { createdAt: "asc" }],
  });
  return rows.map((r) => ({ ...r, principalAmount: round2(Number(r.principalAmount)) }));
}

/**
 * Fiscal-year and quarter choices for the record form's period picker – the
 * last few fiscal years, newest first. Built server-side from the same
 * helpers resolveTaxPeriod validates against, so every option is a key it
 * will accept.
 */
export function buildIncomeTaxPeriodOptions(financialYearStartMonth: number, tz: string, yearsBack = 4) {
  const current = getFiscalYear(financialYearStartMonth, new Date(), tz);
  const currentStart = zonedParts(current.start, tz);
  const annual: { key: string; label: string }[] = [];
  const quarterly: { key: string; label: string }[] = [];

  for (let i = 0; i < yearsBack; i++) {
    const fyStart = zonedDate(currentStart.year - i, currentStart.month - 1, 1, tz);
    const fy = getFiscalYear(financialYearStartMonth, fyStart, tz);
    annual.push({ key: ymd(fy.start, tz), label: fiscalYearLabel(fy.start, fy.end, tz) });
    for (const q of getFiscalQuarters(fy.start, tz)) {
      quarterly.push({ key: ymd(q.start, tz), label: `${fiscalYearLabel(fy.start, fy.end, tz)} · ${quarterLabel(q.start, q.end, tz)}` });
    }
  }
  return { annual, quarterly };
}
