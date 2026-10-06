/**
 * Module 45: standalone checks for VAT Partial Exemption. No database, no framework:
 *   npx tsx scripts/verify-vat-apportionment.ts   (npm run verify:vat-apportionment)
 * Exits non-zero if any check fails.
 *
 * Covers the pure math in src/lib/vat-apportionment.ts: the taxable/exempt sales
 * ratio, de minimis relief, the disabled-flag escape hatch, and the zero-sales edge
 * case. Mirrors the style of scripts/verify-debit-notes.ts / verify-foreign-exchange.ts.
 */
import { apportionInputVat, round2 } from "../src/lib/vat-apportionment";

let failed = 0, total = 0;
function check(name: string, actual: unknown, expected: unknown) {
  total++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}

// ---- 1. No exempt sales at all: full recovery, not apportioned, regardless of de minimis.
check(
  "no exempt sales -> full recovery",
  apportionInputVat({ taxableSales: 10000, exemptSales: 0, grossInputVat: 1650, enabled: true, deMinimisPercent: 0 }),
  { totalSales: 10000, exemptRatioPercent: 0, deMinimisMet: true, apportioned: false, recoveryRatioPercent: 100, recoverableInputVat: 1650, irrecoverableInputVat: 0 }
);

// ---- 2. Exempt sales present, de minimis 0 (no relief) -> apportioned by taxable/total ratio.
// taxable 8,000 / total 10,000 = 80% recovery.
check(
  "80/20 mix, no de minimis -> 80% recovery",
  apportionInputVat({ taxableSales: 8000, exemptSales: 2000, grossInputVat: 1000, enabled: true, deMinimisPercent: 0 }),
  { totalSales: 10000, exemptRatioPercent: 20, deMinimisMet: false, apportioned: true, recoveryRatioPercent: 80, recoverableInputVat: 800, irrecoverableInputVat: 200 }
);

// ---- 3. Exempt ratio exactly AT the de minimis threshold -> relief applies (inclusive boundary).
check(
  "exempt ratio == de minimis threshold -> full recovery",
  apportionInputVat({ taxableSales: 9500, exemptSales: 500, grossInputVat: 1000, enabled: true, deMinimisPercent: 5 }),
  { totalSales: 10000, exemptRatioPercent: 5, deMinimisMet: true, apportioned: false, recoveryRatioPercent: 100, recoverableInputVat: 1000, irrecoverableInputVat: 0 }
);

// ---- 4. Exempt ratio just above the de minimis threshold -> apportioned.
{
  const r = apportionInputVat({ taxableSales: 9489, exemptSales: 511, grossInputVat: 1000, enabled: true, deMinimisPercent: 5 });
  check("exempt ratio just above de minimis -> apportioned", r.apportioned, true);
  check("exempt ratio just above de minimis -> ratio", r.exemptRatioPercent, round2((511 / 10000) * 100));
}

// ---- 5. Disabled entirely -> full recovery even with a large exempt share and no de minimis relief.
check(
  "disabled -> full recovery regardless of mix",
  apportionInputVat({ taxableSales: 1000, exemptSales: 9000, grossInputVat: 500, enabled: false, deMinimisPercent: 0 }),
  { totalSales: 10000, exemptRatioPercent: 90, deMinimisMet: false, apportioned: false, recoveryRatioPercent: 100, recoverableInputVat: 500, irrecoverableInputVat: 0 }
);

// ---- 6. Zero sales this period (e.g. no sales recorded, only purchases) -> can't compute a mix, full recovery.
check(
  "zero sales -> full recovery, no division by zero",
  apportionInputVat({ taxableSales: 0, exemptSales: 0, grossInputVat: 300, enabled: true, deMinimisPercent: 0 }),
  { totalSales: 0, exemptRatioPercent: 0, deMinimisMet: true, apportioned: false, recoveryRatioPercent: 100, recoverableInputVat: 300, irrecoverableInputVat: 0 }
);

// ---- 7. All-exempt business (no taxable sales at all) -> 0% recovery, everything irrecoverable.
check(
  "100% exempt -> 0% recovery",
  apportionInputVat({ taxableSales: 0, exemptSales: 5000, grossInputVat: 800, enabled: true, deMinimisPercent: 0 }),
  { totalSales: 5000, exemptRatioPercent: 100, deMinimisMet: false, apportioned: true, recoveryRatioPercent: 0, recoverableInputVat: 0, irrecoverableInputVat: 800 }
);

// ---- 8. Recoverable + irrecoverable always sum back to the gross figure (rounding-drift check), across a
// deliberately awkward ratio.
{
  const r = apportionInputVat({ taxableSales: 3333, exemptSales: 6667, grossInputVat: 999.99, enabled: true, deMinimisPercent: 0 });
  check("recoverable + irrecoverable == gross", round2(r.recoverableInputVat + r.irrecoverableInputVat), 999.99);
}

// ---- 9. Negative grossInputVat (a period dominated by debit notes reversing prior input VAT) still splits
// proportionally rather than doing something undefined.
check(
  "negative gross input VAT still apportions proportionally",
  apportionInputVat({ taxableSales: 6000, exemptSales: 4000, grossInputVat: -100, enabled: true, deMinimisPercent: 0 }),
  { totalSales: 10000, exemptRatioPercent: 40, deMinimisMet: false, apportioned: true, recoveryRatioPercent: 60, recoverableInputVat: -60, irrecoverableInputVat: -40 }
);

console.log(`${total - failed}/${total} checks passed`);
if (failed > 0) process.exit(1);
