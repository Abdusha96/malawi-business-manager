/**
 * Tax Payment installments – Module 67. Pure and import-free (like
 * stock-transfer-receipt.ts) so the "use client" payment form runs the SAME
 * functions the server does.
 *
 * Money is compared in whole tambala (hundredths), never as floats, so
 * 0.1 + 0.2 against 0.3 is settled, not a phantom 5e-17 shortfall.
 *
 * RULES, stated once here:
 *  - Only PAYE, withholding, provisional and annual income tax can be paid in
 *    installments. VAT's principal is computed from the return, so it stays
 *    one payment (see supportsInstallments).
 *  - A period is SETTLED when any RECORDED payment for it closes it
 *    (settlesPeriod: the default, and what every pre-Module-67 row is), or
 *    when the recorded principals have reached the period's expected figure.
 *    A period whose expected figure is zero is settled by any payment, which
 *    is what "one recorded payment = paid" always meant.
 *  - Part-payments never settle on their own by being labelled; the running
 *    total is computed live, so voiding an earlier installment re-opens the
 *    period correctly instead of leaving a stale flag behind.
 */

export const TAX_INSTALLMENT_TYPES = ["PAYE", "WITHHOLDING_TAX", "PROVISIONAL_TAX", "ANNUAL_INCOME_TAX"] as const;

export function supportsInstallments(taxType: string): boolean {
  return (TAX_INSTALLMENT_TYPES as readonly string[]).includes(taxType);
}

/** Whole tambala. Math.round on a value already scaled by 100 absorbs float noise. */
export function toTambala(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100);
}

export interface InstallmentRow {
  installmentNo: number;
  principalAmount: number;
  settlesPeriod: boolean;
}

export interface PeriodSettlement {
  paid: number; // sum of RECORDED principals, MWK
  expected: number; // the period's working figure, MWK (>= 0)
  remaining: number; // max(0, expected - paid), MWK
  count: number;
  settled: boolean;
  partiallyPaid: boolean; // something recorded, period still open
  nextInstallmentNo: number;
}

/** Summarises a period's RECORDED payments against its expected figure. */
export function summarizeSettlement(expected: number, rows: InstallmentRow[]): PeriodSettlement {
  const expectedT = Math.max(0, toTambala(expected));
  const paidT = rows.reduce((sum, r) => sum + toTambala(r.principalAmount), 0);
  const count = rows.length;
  const closedByFlag = rows.some((r) => r.settlesPeriod);
  const reachedFigure = expectedT > 0 ? paidT >= expectedT : count > 0;
  const settled = count > 0 && (closedByFlag || reachedFigure);
  return {
    paid: paidT / 100,
    expected: expectedT / 100,
    remaining: Math.max(0, expectedT - paidT) / 100,
    count,
    settled,
    partiallyPaid: count > 0 && !settled,
    nextInstallmentNo: rows.reduce((max, r) => Math.max(max, r.installmentNo), 0) + 1,
  };
}

/**
 * The activePeriodKey for an installment. Installment 1 keeps the original
 * "<businessId>|<taxType>|<periodKey>" so every pre-Module-67 row is already
 * correct and no backfill is needed; later ones append "|<n>".
 */
export function installmentKey(businessId: string, taxType: string, periodKey: string, installmentNo: number): string {
  const base = `${businessId}|${taxType}|${periodKey}`;
  return installmentNo <= 1 ? base : `${base}|${installmentNo}`;
}

export type InstallmentDecision =
  | { ok: true; settlesPeriod: boolean; installmentNo: number; principal: number; remainingAfter: number }
  | { ok: false; message: string };

/**
 * Decides whether a non-VAT payment of `principal` may be recorded against a
 * period and whether it settles it. `partial` is the person's own statement
 * that more will be paid later. Never clamps: an overshoot is refused with
 * the amount still owed, because extra is a penalty (recorded separately) or
 * an error, not more tax.
 */
export function decideInstallment(params: {
  taxType: string;
  expected: number;
  rows: InstallmentRow[];
  principal: number;
  partial: boolean;
}): InstallmentDecision {
  const { taxType, expected, rows, principal, partial } = params;
  const principalT = toTambala(principal);
  if (principalT <= 0) return { ok: false, message: "Enter the amount paid toward the tax itself." };

  if (!supportsInstallments(taxType)) {
    if (partial) return { ok: false, message: "VAT is always paid in one payment for the period's net amount - it can't be part-paid." };
    if (rows.length > 0) return { ok: false, message: "A payment is already recorded for this period." };
    return { ok: true, settlesPeriod: true, installmentNo: 1, principal: principalT / 100, remainingAfter: 0 };
  }

  const before = summarizeSettlement(expected, rows);
  if (before.settled) {
    return {
      ok: false,
      message:
        "This period is already fully paid. Record anything extra the MRA charged as a penalty/interest, or void a payment if one was wrong.",
    };
  }

  const remainingT = toTambala(before.remaining);
  const expectedT = toTambala(expected);
  // The first payment keeps its historic freedom (the liability-balance cap in
  // tax-payments.ts still applies). Once a period already has payments, or the
  // person says this is a part-payment, it must fit inside what is still owed.
  const mustFit = (partial || before.count > 0) && expectedT > 0;
  if (mustFit && principalT > remainingT) {
    return {
      ok: false,
      message: `Only MWK ${before.remaining.toLocaleString()} is still owed for this period, so MWK ${(principalT / 100).toLocaleString()} is too much. Record any extra as penalty/interest.`,
    };
  }
  if (partial && expectedT > 0 && principalT === remainingT) {
    // Says "part-payment" but pays exactly what's left: that is the final one.
    return { ok: true, settlesPeriod: true, installmentNo: before.nextInstallmentNo, principal: principalT / 100, remainingAfter: 0 };
  }
  return {
    ok: true,
    settlesPeriod: !partial,
    installmentNo: before.nextInstallmentNo,
    principal: principalT / 100,
    remainingAfter: partial ? Math.max(0, remainingT - principalT) / 100 : 0,
  };
}
