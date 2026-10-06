/**
 * Central accounting display formatting (Module 82, spec section 27).
 * Components must call these instead of formatting numbers themselves, so
 * "MWK 1,250,000.00" and "(MWK 250,000.00)" look identical everywhere.
 *
 * Dates are deliberately NOT formatted here: Module 35/36 require every date
 * to be shown in the business time zone via formatDateIn() in
 * src/lib/timezone.ts (enforced by `npm run check:dates`).
 */

const nf = (min: number, max: number) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });

const money = nf(2, 2);
const whole = nf(0, 0);
const pct = nf(2, 2);
const qty = nf(0, 3);

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  return whole.format(value);
}

/** Stock / sold quantity: whole numbers stay whole, fractional units (kg, litres) keep up to 3 decimals. */
export function formatQuantity(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  return qty.format(value);
}

/** MWK 1,250,000.00 – negatives as (MWK 250,000.00). */
export function formatMoney(value: number | null | undefined, currency = "MWK"): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  const body = `${currency} ${money.format(Math.abs(value))}`;
  // Round first so -0.004 does not render as "(MWK 0.00)".
  return Math.round(value * 100) < 0 ? `(${body})` : body;
}

/** Same as formatMoney but without the currency prefix, for table cells under a currency header. */
export function formatAmount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  const body = money.format(Math.abs(value));
  return Math.round(value * 100) < 0 ? `(${body})` : body;
}

/** 15.00% – the input is already a percentage (15), not a ratio (0.15). */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  return `${pct.format(value)}%`;
}

export function isNegativeAmount(value: number | null | undefined): boolean {
  return typeof value === "number" && Math.round(value * 100) < 0;
}
