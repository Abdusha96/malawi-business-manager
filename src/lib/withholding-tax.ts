import { prisma } from "./prisma";
import { WithholdingTaxCategory } from "@prisma/client";
import { getOrCreateTaxConfiguration } from "./payroll";
import { WITHHOLDING_TAX_CATEGORIES } from "./validation";

/**
 * Withholding Tax – Module 19, the "withholding tax and corporate tax
 * estimates, whenever built, must follow [the configurable-data] pattern
 * too" gap flagged in Module 18's write-up on TaxConfiguration.
 *
 * DESIGN CHOICES, stated plainly (same spirit as the numbered list at the
 * top of src/lib/vat.ts):
 *
 * 1. Withholding tax here is deducted FROM a payment the business makes,
 *    not added ON TOP of one – the opposite direction from VAT. Recording
 *    an Expense of amount K100,000 against a withholding-tax-eligible
 *    category doesn't cost the business any more than K100,000; it changes
 *    HOW that K100,000 splits: some of it goes to the payee in cash, the
 *    rest is held back and owed to the MRA (WITHHOLDING_TAX_PAYABLE)
 *    instead of the payee's pocket. Expense.amount stays the gross figure
 *    the P&L expenses either way – see the schema comment on Expense.
 *
 * 2. Scoped to Expense only, NOT Purchase (Module 8). A goods Purchase from
 *    a Supplier is not one of the payment types Malawi's withholding tax
 *    regime targets the way rent, commission, professional fees, contractor
 *    fees, casual labour, and public entertainment fees are – those are
 *    services/payments a business more naturally records as an Expense in
 *    this app already (RENT is already an ExpenseCategory). KNOWN
 *    LIMITATION: a real subcontractor arrangement invoiced and paid through
 *    the Purchases module (e.g. a construction subcontractor set up as a
 *    Supplier) won't have withholding tax applied here – record it as an
 *    Expense instead if it needs to be withheld from.
 *
 * 3. The rate is a flat percentage per category (TaxConfiguration.
 *    withholdingTaxRates), not progressive like PAYE bands – this matches
 *    how Malawi's withholding tax actually works (a flat rate per payment
 *    type), so there's no "band" concept to model here at all.
 *
 * 4. withholdingTaxCategory/Rate/Amount are snapshotted onto Expense at
 *    creation time (mirrors SaleItem.vatAmount from Module 18) – editing
 *    the business's configured rate later never rewrites a past Expense's
 *    numbers, and voiding/deleting an Expense correctly reverses exactly
 *    what was originally posted, not whatever the rate happens to be today.
 *
 * 5. This app is not the source of truth for tax law (same disclaimer as
 *    PAYE bands and the VAT standard rate) – the six rates in
 *    src/lib/payroll.ts::EXAMPLE_WITHHOLDING_TAX_RATES are clearly-labeled
 *    EXAMPLE placeholders and carry the same isExample disclaimer banner,
 *    shared with PAYE/pension/VAT rather than a fourth separate flag.
 *
 * 6. Remittance CLOSED by Module 33 (src/lib/tax-payments.ts records the
 *    payment and clears WITHHOLDING_TAX_PAYABLE). Still a KNOWN LIMITATION
 *    below: no real MRA certificate. Original text: like VAT_OUTPUT_PAYABLE, this app does not model
 *    actually remitting withheld tax to the MRA, or issuing the payee a
 *    real MRA withholding tax certificate (a downloadable PDF exists – see
 *    the expense withholding-certificate route – but it is a working
 *    document for an Accountant to transcribe from, not a filing or an
 *    MRA-recognized certificate). An Owner/Accountant clears
 *    WITHHOLDING_TAX_PAYABLE the same way they clear VAT_OUTPUT_PAYABLE:
 *    a regular Expense or manual journal entry when they actually pay it
 *    over.
 */

export interface WithholdingTaxConfig {
  rates: Record<WithholdingTaxCategory, number>; // percent, keyed by category
  isExample: boolean;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function getWithholdingTaxConfig(businessId: string): Promise<WithholdingTaxConfig> {
  const taxConfig = await getOrCreateTaxConfiguration(businessId);
  const stored = (taxConfig.withholdingTaxRates as unknown as { category: string; rate: number }[]) ?? [];

  const rates = {} as Record<WithholdingTaxCategory, number>;
  for (const category of WITHHOLDING_TAX_CATEGORIES) {
    const found = stored.find((r) => r.category === category);
    rates[category] = found ? Number(found.rate) : 0;
  }

  return { rates, isExample: taxConfig.isExample };
}

/**
 * Tax withheld from a single gross payment. Returns { rate: 0, amount: 0 }
 * whenever category is null/undefined (the far more common case – most
 * Expenses aren't a withholding-tax-eligible payment type at all) – mirrors
 * computeLineVat's "not STANDARD → 0" behavior in src/lib/vat.ts.
 */
export function computeWithholdingTax(
  grossAmount: number,
  category: WithholdingTaxCategory | null | undefined,
  config: Pick<WithholdingTaxConfig, "rates">
): { rate: number; amount: number } {
  if (!category) return { rate: 0, amount: 0 };
  const rate = config.rates[category] ?? 0;
  return { rate, amount: round2(grossAmount * (rate / 100)) };
}

/**
 * The Withholding Tax Return: total gross payments and tax withheld, broken
 * down by category, over a period – a working document for an Accountant
 * to transcribe onto the relevant MRA withholding tax return, NOT a filing
 * integration (same framing as getVatReturn in src/lib/vat.ts). Uses each
 * Expense's own snapshotted withholdingTaxAmount/Category rather than
 * recomputing from today's configured rates, so a return for a past period
 * stays correct even after rates are later changed.
 */
export async function getWithholdingTaxReturn(businessId: string, from: Date, to: Date) {
  const [config, expenses] = await Promise.all([
    getWithholdingTaxConfig(businessId),
    prisma.expense.findMany({
      where: {
        businessId,
        expenseDate: { gte: from, lte: to },
        withholdingTaxCategory: { not: null },
      },
    }),
  ]);

  const byCategory = {} as Record<WithholdingTaxCategory, { grossPayments: number; taxWithheld: number; count: number }>;
  for (const category of WITHHOLDING_TAX_CATEGORIES) {
    byCategory[category] = { grossPayments: 0, taxWithheld: 0, count: 0 };
  }

  let totalWithheld = 0;
  for (const expense of expenses) {
    const category = expense.withholdingTaxCategory as WithholdingTaxCategory;
    const bucket = byCategory[category];
    bucket.grossPayments = round2(bucket.grossPayments + Number(expense.amount));
    bucket.taxWithheld = round2(bucket.taxWithheld + Number(expense.withholdingTaxAmount));
    bucket.count += 1;
    totalWithheld = round2(totalWithheld + Number(expense.withholdingTaxAmount));
  }

  return {
    isExample: config.isExample,
    rates: config.rates,
    period: { from, to },
    byCategory,
    totalWithheld, // owed to the MRA – see KNOWN LIMITATION 6 above
    paymentCount: expenses.length,
  };
}
