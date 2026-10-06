/**
 * Module 46: standalone checks for VAT Refund Receipts. No database, no framework:
 *   npx tsx scripts/verify-vat-refunds.ts   (npm run verify:vat-refunds)
 * Exits non-zero if any check fails.
 *
 * Covers the pure math in src/lib/tax-payments.ts::resolveVatDirection – the
 * function both getTaxPaymentPreview and createTaxPayment call to decide
 * whether a VAT period is a remittance or a refund, and for how much.
 * Mirrors the style of scripts/verify-vat-apportionment.ts.
 */
import { resolveVatDirection } from "../src/lib/vat-payment-direction";

let failed = 0, total = 0;
function check(name: string, actual: unknown, expected: unknown) {
  total++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}

// ---- 1. Ordinary net-payable period: output exceeds input -> a remittance for the positive difference.
check("net payable -> remittance", resolveVatDirection(15000), { isRefund: false, magnitude: 15000 });

// ---- 2. Net-refundable period: input exceeded output (negative netPayable) -> a refund for the magnitude.
check("net refundable -> refund", resolveVatDirection(-4200), { isRefund: true, magnitude: 4200 });

// ---- 3. Exactly zero -> nothing to record either way.
check("exactly zero -> nothing", resolveVatDirection(0), { isRefund: false, magnitude: 0 });

// ---- 4. Within the 1-cent rounding tolerance of zero, either side -> still nothing (avoids a MWK 0.00
// payment/refund from float drift in getVatReturn's own rounding). 0.004 rounds to 0.00 first.
check("just above zero (within tolerance) -> nothing", resolveVatDirection(0.004), { isRefund: false, magnitude: 0 });
check("just below zero (within tolerance) -> nothing", resolveVatDirection(-0.004), { isRefund: false, magnitude: 0 });

// ---- 5. Just outside the tolerance on the payable side -> a real (tiny) remittance.
check("just outside tolerance, payable side", resolveVatDirection(0.02), { isRefund: false, magnitude: 0.02 });

// ---- 6. Just outside the tolerance on the refundable side -> a real (tiny) refund.
check("just outside tolerance, refundable side", resolveVatDirection(-0.02), { isRefund: true, magnitude: 0.02 });

// ---- 7. Magnitude is always positive regardless of direction (the sign only ever lives in isRefund) –
// checked across both directions with the same absolute size.
{
  const payable = resolveVatDirection(9999.99);
  const refund = resolveVatDirection(-9999.99);
  check("magnitude positive, payable", payable.magnitude > 0, true);
  check("magnitude positive, refund", refund.magnitude > 0, true);
  check("same magnitude, opposite direction", payable.magnitude, refund.magnitude);
  check("directions actually differ", payable.isRefund !== refund.isRefund, true);
}

// ---- 8. Rounds to 2 decimal places like every other money figure in this app (float-safe).
check("rounds to 2dp", resolveVatDirection(-1234.5678).magnitude, 1234.57);

console.log(`${total - failed}/${total} checks passed`);
if (failed > 0) process.exit(1);
