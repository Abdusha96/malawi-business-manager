/**
 * Module 46: turns one VAT period's netPayable (from getVatReturn – output
 * VAT minus reclaimable input VAT; positive means owed to the MRA, negative
 * means the reverse) into the direction and magnitude a TaxPayment records.
 *
 * Deliberately its own file with no imports (mirrors src/lib/vat-apportionment.ts
 * being split out from vat.ts): src/lib/tax-payments.ts pulls in Prisma at
 * module scope, which scripts/verify-vat-refunds.ts can't load in a plain
 * Node process, so the one function worth unit-testing here lives somewhere
 * that import doesn't reach.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function resolveVatDirection(netPayable: number): { isRefund: boolean; magnitude: number } {
  const rounded = round2(netPayable);
  if (Math.abs(rounded) < 0.01) return { isRefund: false, magnitude: 0 };
  return rounded < 0 ? { isRefund: true, magnitude: round2(-rounded) } : { isRefund: false, magnitude: rounded };
}
