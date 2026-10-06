/**
 * Module 47: pure (no Prisma, no I/O) helpers for VAT Carry-Forward Credit
 * Netting. Mirrors src/lib/vat-payment-direction.ts's own reasoning for
 * being import-free: src/lib/tax-payments.ts pulls in Prisma at module
 * scope, which scripts/verify-vat-carry-forward.ts can't load in a plain
 * Node process, so the logic worth unit-testing without a database lives
 * here.
 *
 * CLOSES the KNOWN LIMITATION src/lib/tax-payments.ts has documented since
 * Module 46: each VAT period's net payable was computed fresh from only
 * that period's own sales/purchases, so a period that ended net-refundable
 * and was never recorded (the business elected to carry the credit
 * forward, per the Module 46 form's own guidance) sat unaddressed forever –
 * the NEXT remittance never netted it off. The fix lives in
 * src/lib/tax-payments.ts::getVatCarryForward, which walks every monthly
 * VAT period between the most recent RECORDED VAT payment (of either
 * direction) and the period now being recorded, sums the net payable of
 * whichever of those periods still has no recorded payment, and folds that
 * sum into the current period's own net payable before resolveVatDirection
 * decides remit-vs-refund. This file only holds the calendar-key
 * arithmetic that walk needs – string manipulation on "YYYY-MM" keys, safe
 * to unit-test without touching a timezone or a database.
 */

const MONTH_KEY_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

function parseParts(key: string): { year: number; month: number } {
  const m = MONTH_KEY_RE.exec(key);
  if (!m) throw new Error(`Not a "YYYY-MM" month key: ${key}`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

function format(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/** The "YYYY-MM" key of the calendar month immediately after `key`. */
export function nextMonthKey(key: string): string {
  const { year, month } = parseParts(key);
  return month === 12 ? format(year + 1, 1) : format(year, month + 1);
}

/**
 * Every "YYYY-MM" month key from `fromKeyInclusive` up to (but excluding)
 * `toKeyExclusive`, oldest first. Fixed-width zero-padded keys sort
 * lexicographically the same as chronologically, so plain string
 * comparison is enough – no Date math needed. A hard 1200-iteration guard
 * (100 years) protects against a malformed pair looping forever; it should
 * never bite in practice since callers cap the result separately (see
 * MAX_CARRY_FORWARD_MONTHS below).
 */
export function enumerateMonthKeysBetween(fromKeyInclusive: string, toKeyExclusive: string): string[] {
  const keys: string[] = [];
  let cur = fromKeyInclusive;
  let guard = 0;
  while (cur < toKeyExclusive && guard < 1200) {
    keys.push(cur);
    cur = nextMonthKey(cur);
    guard++;
  }
  return keys;
}

/**
 * How many trailing (most-recent) unaddressed months to actually sum, if
 * the gap since the last recorded VAT payment – or, for a business with no
 * VAT payment ever recorded, since its earliest sale/purchase – is longer
 * than this. Bounds the number of getVatReturn() calls a single "record a
 * VAT payment" preview triggers. A gap this long is itself a sign the
 * business has bigger bookkeeping catch-up to do than this feature can
 * reasonably automate – flagged to the Accountant (see `truncated` on the
 * result) rather than silently capped.
 */
export const MAX_CARRY_FORWARD_MONTHS = 36;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Sums a set of already-fetched period net-payable figures into one carry-
 * forward adjustment, using the SAME sign convention as getVatReturn's own
 * `netPayable`: positive = still owed to the MRA from those periods,
 * negative = a net credit owed to the business. Composes with the current
 * period's own netPayable by plain addition – see
 * src/lib/tax-payments.ts::getVatCarryForward.
 */
export function sumCarryForward(netPayables: number[]): number {
  return round2(netPayables.reduce((sum, n) => sum + n, 0));
}
