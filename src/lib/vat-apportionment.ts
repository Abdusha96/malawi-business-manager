/**
 * VAT Partial Exemption – Module 45, closing the KNOWN LIMITATION src/lib/vat.ts
 * has documented since Module 18: "the EXEMPT/ZERO_RATED distinction that matters
 * for real MRA input-VAT-reclaim eligibility ... is not enforced here."
 *
 * PURE: no database, no Prisma import – mirrors debit-note-calc.ts / fx-calc.ts so
 * scripts/verify-vat-apportionment.ts can exercise every rule without a connection.
 * getVatReturn() in src/lib/vat.ts is the only caller.
 *
 * THE METHOD, stated plainly (this app is not the source of truth for tax law –
 * same disclaimer every rate in TaxConfiguration already carries):
 *
 * 1. This app has no concept of which purchase relates to which output (no
 *    per-line "this input feeds an exempt sale" attribution – Purchase and Sale
 *    are entirely separate documents). Real MRA partial exemption starts by
 *    directly attributing input VAT to taxable use, exempt use, or "residual"
 *    (overheads used for both) before apportioning only the residual bucket.
 *    Without attribution, this is the SIMPLIFIED method: the period's whole
 *    input VAT is treated as residual and apportioned by the RATIO OF TAXABLE
 *    TO TOTAL SALES for that same period – the same ratio Module 18's own
 *    comment named as the missing piece ("a business's overall exempt/taxable
 *    supply ratio, which this app doesn't compute").
 *
 * 2. Sales mix, not purchases mix, drives the ratio – a business's exempt/
 *    taxable SPLIT is a fact about what it SELLS. STANDARD and ZERO_RATED sales
 *    both count as "taxable" for this purpose (zero-rated is still a taxable
 *    supply at a 0% rate, and its input VAT is reclaimable in full under real
 *    MRA rules – only EXEMPT supplies restrict recovery).
 *
 * 3. DE MINIMIS: a business with only a trivial amount of exempt sales in a
 *    period (at or below TaxConfiguration.vatDeMinimisPercent of total sales)
 *    keeps full recovery for that period – apportioning a full residual-input
 *    calculation over an incidental exempt sale would be disproportionate. This
 *    is a configurable simplification, not a transcription of a specific MRA de
 *    minimis rule (see the isExample-style disclaimer this module's caller
 *    renders) – default 0 means no relief until an Owner/Accountant sets one.
 *
 * 4. A period with NO sales at all (totalSales === 0) can't compute a mix, so it
 *    falls back to full recovery rather than dividing by zero or guessing – the
 *    same "nothing to apportion" outcome as a period with no exempt sales.
 *
 * 5. Per-period, not cumulative. Each VAT Return date range is apportioned on
 *    its own sales mix, exactly like every other figure getVatReturn() computes
 *    for that range. A business whose exempt ratio crosses the de minimis line
 *    mid-year will see some periods apportioned and some not – accurate, if a
 *    business's mix genuinely varies period to period.
 */

export interface ApportionmentInput {
  /** Net STANDARD + ZERO_RATED sales for the period (post credit notes). */
  taxableSales: number;
  /** Net EXEMPT sales for the period (post credit notes). */
  exemptSales: number;
  /** The period's total input VAT already posted to the ledger (net of debit notes). */
  grossInputVat: number;
  /** TaxConfiguration.vatPartialExemptionEnabled. */
  enabled: boolean;
  /** TaxConfiguration.vatDeMinimisPercent. */
  deMinimisPercent: number;
}

export interface ApportionmentResult {
  totalSales: number;
  /** Exempt sales as a percent of total sales this period. 0 when there were no sales. */
  exemptRatioPercent: number;
  /** True when exemptRatioPercent is at or below the configured de minimis threshold. */
  deMinimisMet: boolean;
  /** True when a restriction was actually applied this period. */
  apportioned: boolean;
  /** 100 when not apportioned; otherwise taxableSales / totalSales as a percent. */
  recoveryRatioPercent: number;
  /** The reclaimable share of grossInputVat – what actually offsets output VAT owed. */
  recoverableInputVat: number;
  /** grossInputVat − recoverableInputVat – stays in VAT_INPUT_RECEIVABLE until written off. */
  irrecoverableInputVat: number;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function apportionInputVat(input: ApportionmentInput): ApportionmentResult {
  const taxableSales = round2(input.taxableSales);
  const exemptSales = round2(input.exemptSales);
  const totalSales = round2(taxableSales + exemptSales);
  const exemptRatioPercent = totalSales > 0 ? round2((exemptSales / totalSales) * 100) : 0;
  const deMinimisMet = exemptRatioPercent <= input.deMinimisPercent;

  const apportioned = input.enabled && totalSales > 0 && exemptSales > 0 && !deMinimisMet;

  const recoveryRatioPercent = apportioned ? round2((taxableSales / totalSales) * 100) : 100;
  const recoverableInputVat = apportioned ? round2(input.grossInputVat * (recoveryRatioPercent / 100)) : round2(input.grossInputVat);
  const irrecoverableInputVat = round2(input.grossInputVat - recoverableInputVat);

  return { totalSales, exemptRatioPercent, deMinimisMet, apportioned, recoveryRatioPercent, recoverableInputVat, irrecoverableInputVat };
}
