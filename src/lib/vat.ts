import { prisma } from "./prisma";
import { VatCategory } from "@prisma/client";
import { getOrCreateTaxConfiguration } from "./payroll";
import { getCreditNotesInRange } from "./credit-note-queries";
import { rollUpForVat as rollUpCreditNotesForVat } from "./credit-note-calc";
import { getDebitNotesInRange } from "./debit-note-queries";
import { rollUpForVat as rollUpDebitNotesForVat } from "./debit-note-calc";
import { apportionInputVat } from "./vat-apportionment";

/**
 * VAT (Value-Added Tax) – Module 18, closing the "broader tax module"
 * gap the README has flagged since Module 7 ("spec section 19 beyond
 * PAYE"). Sale.tax/Purchase.tax/Quotation.tax existed since Modules 3, 8,
 * and 15 as a manual, cashier-typed number that never fed into accounting
 * at all (grep accounting-integrations.ts before this module – "tax"
 * appears nowhere in it). This file replaces that manual entry with a real
 * calculation and wires the result into the GL.
 *
 * DESIGN CHOICES, stated plainly:
 *
 * 1. Prices are always VAT-EXCLUSIVE (net) in this app. Product.sellingPrice
 *    is the base price; VAT is calculated and displayed on top of it, on
 *    every document (Sale, Purchase, Quotation, Invoice, PDF). This is
 *    simpler and unambiguous for the ledger, at the cost of not matching
 *    how some Malawian retail shelf-tags show a single VAT-inclusive price.
 *    A "prices include VAT" toggle with reverse calculation is a plausible
 *    future addition, deliberately not built now – seeing this app get
 *    used will tell us whether shopkeepers actually want it.
 *
 * 2. VAT is computed PER LINE, from that line's own total (already net of
 *    its own line-level discount) – never from Sale.discount, which is a
 *    flat lump applied to the whole sale afterward, not apportioned back
 *    across lines. A sale-level discount therefore does not reduce the VAT
 *    base. This is accurate for ordinary line discounts and a documented
 *    simplification for whole-sale discounts – the same flat-discount
 *    model Module 3 chose for Sale.discount in the first place.
 *
 * 3. Input VAT on a Purchase assumes the supplier charged VAT at the
 *    product's own vatCategory rate. This app has no concept of "is this
 *    supplier VAT-registered" – an Accountant reclaiming input VAT should
 *    still check the supplier's own invoice/receipt shows VAT was actually
 *    charged before treating it as reclaimable.
 *
 * 4. KNOWN LIMITATION: the EXEMPT/ZERO_RATED distinction that matters for
 *    real MRA input-VAT-reclaim eligibility (a business making only exempt
 *    supplies generally can't reclaim input VAT at all) is not enforced
 *    here – VAT_INPUT_RECEIVABLE always accumulates from purchases
 *    regardless of what the business itself sells. Getting this right
 *    requires knowing a business's overall exempt/taxable supply ratio,
 *    which this app doesn't compute. Flagged rather than silently assumed.
 *
 * 5. CLOSED by Module 32: src/lib/refunds.ts (Module 16) used to debit the
 *    whole refunded amount against SALES_REVENUE without apportioning out
 *    the VAT portion into VAT_OUTPUT_PAYABLE, leaving the original entry's
 *    output VAT standing even though a refund means some of it is no
 *    longer owed. A sale refund's GL posting now splits the same way
 *    postJournalEntryForSale does. The purchase side needed no equivalent
 *    change: postJournalEntryForPurchase posts VAT_INPUT_RECEIVABLE as
 *    part of ONE combined entry with Inventory/AP, and voiding a purchase
 *    reverses that whole entry – so by the time a purchase refund happens,
 *    its VAT input has already been fully unwound, with nothing left to
 *    carve out. See postJournalEntryForRefund in
 *    src/lib/accounting-integrations.ts for the full reasoning.
 *
 * 5b. CLOSED by Module 33: remitting the net VAT to the MRA is recorded via
 *    src/lib/tax-payments.ts, which clears VAT_OUTPUT_PAYABLE netted against
 *    VAT_INPUT_RECEIVABLE in one entry.
 *
 * 5c. CLOSED by Module 44: `purchases.inputVat` below is now NET of supplier debit notes issued in
 *    the period, the same treatment Module 43 gave `sales.outputVat` for credit notes – because
 *    that is what VAT_INPUT_RECEIVABLE actually holds once a debit note has posted, and what
 *    src/lib/tax-payments.ts clears.
 *
 * 6. This app is not the source of truth for tax law (same disclaimer as
 *    Module 10's PAYE bands) – TaxConfiguration.vatStandardRate is seeded
 *    as a clearly-labeled EXAMPLE (Malawi's actual standard VAT rate at
 *    time of writing) and carries the same isExample disclaimer banner
 *    PAYE already uses, until an Owner/Accountant reviews and saves it.
 *
 * 7. CLOSED by Module 45: design choice 4's limitation – VAT_INPUT_RECEIVABLE
 *    accumulating in full regardless of the business's exempt/taxable sales
 *    mix – now has an answer. getVatReturn() apportions the period's input VAT
 *    by that mix (src/lib/vat-apportionment.ts) and netPayable is computed from
 *    the RECLAIMABLE share, not the gross figure. `purchases.inputVat` below is
 *    intentionally left meaning what it always has (the full ledger-posted
 *    figure, net of debit notes) – the apportionment result sits alongside it
 *    in `partialExemption`, and src/lib/tax-payments.ts is what actually reads
 *    the reclaimable figure when clearing VAT_INPUT_RECEIVABLE.
 */

export interface VatConfig {
  vatRegistered: boolean;
  vatNumber: string | null;
  vatRate: number; // percent
  isExample: boolean;
  // Module 45 (VAT Partial Exemption) – not used by Sale/Purchase/Quotation
  // line-VAT computation (that never depended on the business's overall sales
  // mix), only by getVatReturn() below. Carried here anyway since getVatConfig
  // already loads TaxConfiguration once and every caller of it destructures
  // only the fields it needs.
  partialExemptionEnabled: boolean;
  deMinimisPercent: number;
}

export async function getVatConfig(businessId: string): Promise<VatConfig> {
  const [business, taxConfig] = await Promise.all([
    prisma.business.findUniqueOrThrow({
      where: { id: businessId },
      select: { vatRegistered: true, vatNumber: true },
    }),
    getOrCreateTaxConfiguration(businessId),
  ]);

  return {
    vatRegistered: business.vatRegistered,
    vatNumber: business.vatNumber,
    vatRate: Number(taxConfig.vatStandardRate),
    isExample: taxConfig.isExample,
    partialExemptionEnabled: taxConfig.vatPartialExemptionEnabled,
    deMinimisPercent: Number(taxConfig.vatDeMinimisPercent),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * VAT on a single line, given its own net-of-discount total. Returns 0
 * whenever the business isn't VAT-registered or the line's category isn't
 * STANDARD – ZERO_RATED and EXEMPT both compute to 0, but are kept as
 * distinct categories (rather than collapsing to "not taxed") because a
 * real VAT return reports zero-rated turnover separately from exempt
 * turnover – see getVatReturn below.
 */
export function computeLineVat(lineTotal: number, category: VatCategory, vatRegistered: boolean, vatRate: number): number {
  if (!vatRegistered) return 0;
  if (category !== "STANDARD") return 0;
  return round2(lineTotal * (vatRate / 100));
}

/**
 * Applies computeLineVat across a set of already-priced lines (each with
 * its own net `total`) and returns the per-line VAT amounts plus the sum –
 * the shape src/lib/sales.ts, purchases.ts, and quotations.ts each need to
 * build their line-item `create` arrays and their document-level `tax`
 * total. `category` here is each line's already-resolved VatCategory
 * (Sales/Purchases always have a real product; Quotations may not – see
 * that file's own default-to-STANDARD comment on free-text lines).
 */
export function computeVatForLines(
  lines: { total: number; category: VatCategory }[],
  config: Pick<VatConfig, "vatRegistered" | "vatRate">
): { vatAmounts: number[]; vatTotal: number } {
  const vatAmounts = lines.map((line) => computeLineVat(line.total, line.category, config.vatRegistered, config.vatRate));
  return { vatAmounts, vatTotal: round2(vatAmounts.reduce((sum, v) => sum + v, 0)) };
}

/**
 * The VAT Return: Output VAT (collected on sales) minus Input VAT (paid on
 * purchases) over a period, in the shape an MRA VAT 3 return groups by
 * (standard/zero-rated/exempt turnover, output tax, input tax, net
 * payable/refundable) – presented as a working document for an
 * Accountant to transcribe onto the real MRA form, NOT a filing
 * integration (this app has no connection to MRA systems).
 *
 * VOIDED sales/purchases are excluded – a voided document's tax was never
 * really collected/paid in a way that should appear on a return, mirroring
 * how every other report in this app treats VOIDED (see
 * src/lib/reports.ts).
 */
export async function getVatReturn(businessId: string, from: Date, to: Date) {
  const [config, sales, purchases, creditNotes, debitNotes] = await Promise.all([
    getVatConfig(businessId),
    prisma.sale.findMany({
      where: { businessId, status: { not: "VOIDED" }, saleDate: { gte: from, lte: to } },
      include: { items: true },
    }),
    prisma.purchase.findMany({
      where: { businessId, status: { not: "VOIDED" }, purchaseDate: { gte: from, lte: to } },
      include: { items: true },
    }),
    // Module 43: credit notes count in the period they were ISSUED, not the period of the sale they credit.
    getCreditNotesInRange(businessId, { from, to, toInclusive: true }),
    // Module 44: same rule, purchase side – debit notes count in the period they were issued.
    getDebitNotesInRange(businessId, { from, to, toInclusive: true }),
  ]);

  const salesByCategory = { STANDARD: 0, ZERO_RATED: 0, EXEMPT: 0 } as Record<VatCategory, number>;
  let outputVat = 0;
  for (const sale of sales) {
    for (const item of sale.items) {
      salesByCategory[item.vatCategory] = round2(salesByCategory[item.vatCategory] + Number(item.total));
      outputVat = round2(outputVat + Number(item.vatAmount));
    }
  }

  const purchasesByCategory = { STANDARD: 0, ZERO_RATED: 0, EXEMPT: 0 } as Record<VatCategory, number>;
  let inputVat = 0;
  for (const purchase of purchases) {
    for (const item of purchase.items) {
      purchasesByCategory[item.vatCategory] = round2(purchasesByCategory[item.vatCategory] + Number(item.total));
      inputVat = round2(inputVat + Number(item.vatAmount));
    }
  }

  // Module 43: `sales.outputVat` is now the NET output VAT (sales less credit notes issued in the period),
  // because that is what the ledger holds in VAT_OUTPUT_PAYABLE and what a tax payment clears.
  const credits = rollUpCreditNotesForVat(creditNotes);
  const grossOutputVat = outputVat;
  outputVat = round2(outputVat - credits.vat);
  const netByCategory = {
    STANDARD: round2(salesByCategory.STANDARD - credits.byCategory.STANDARD),
    ZERO_RATED: round2(salesByCategory.ZERO_RATED - credits.byCategory.ZERO_RATED),
    EXEMPT: round2(salesByCategory.EXEMPT - credits.byCategory.EXEMPT),
  } as Record<VatCategory, number>;

  // Module 44: `purchases.inputVat` is now NET of supplier debit notes issued in the period – the
  // purchase-side mirror of the credit-note netting immediately above.
  const debits = rollUpDebitNotesForVat(debitNotes);
  const grossInputVat = inputVat;
  inputVat = round2(inputVat - debits.vat);
  const purchasesNetByCategory = {
    STANDARD: round2(purchasesByCategory.STANDARD - debits.byCategory.STANDARD),
    ZERO_RATED: round2(purchasesByCategory.ZERO_RATED - debits.byCategory.ZERO_RATED),
    EXEMPT: round2(purchasesByCategory.EXEMPT - debits.byCategory.EXEMPT),
  } as Record<VatCategory, number>;

  // Module 45: apportion the period's input VAT by the sales mix (netByCategory
  // above, already net of credit notes) before computing what's actually owed.
  // See src/lib/vat-apportionment.ts for the method and its stated limitations.
  const partialExemption = apportionInputVat({
    taxableSales: round2(netByCategory.STANDARD + netByCategory.ZERO_RATED),
    exemptSales: netByCategory.EXEMPT,
    grossInputVat: inputVat,
    enabled: config.partialExemptionEnabled,
    deMinimisPercent: config.deMinimisPercent,
  });

  const netPayable = round2(outputVat - partialExemption.recoverableInputVat);

  return {
    vatRegistered: config.vatRegistered,
    vatNumber: config.vatNumber,
    vatRate: config.vatRate,
    isExample: config.isExample,
    period: { from, to },
    sales: { byCategory: salesByCategory, netByCategory, grossOutputVat, outputVat },
    creditNotes: credits,
    // purchases.inputVat stays the full ledger-posted figure (net of debit notes only) – see
    // design choice 7 above. partialExemption.recoverableInputVat is what's actually creditable.
    purchases: { byCategory: purchasesByCategory, netByCategory: purchasesNetByCategory, grossInputVat, inputVat },
    debitNotes: debits,
    partialExemption,
    netPayable, // positive = owed to MRA, negative = refundable/carried forward – now net of the irrecoverable share
  };
}

