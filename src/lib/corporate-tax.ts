import { getOrCreateTaxConfiguration } from "./payroll";
import { getProfitAndLoss } from "./financial-statements";
import { prisma } from "./prisma";

/**
 * Corporate (Company) Income Tax – Module 20, closing the last piece of
 * the "broader tax module" gap flagged since Module 18's own writeup
 * ("Withholding tax, corporate tax estimates, and a tax calendar remain
 * deferred") and repeated in the README's outstanding-gaps list ever
 * since. See src/lib/tax-calendar.ts for the compliance-deadline half of
 * this module.
 *
 * DESIGN CHOICES, stated plainly (same discipline vat.ts and
 * withholding-tax.ts use):
 *
 * 1. "Taxable profit" here IS accounting operating profit
 *    (getProfitAndLoss's profitBeforeTax – Revenue − COGS − Operating
 *    Expenses + Other Income − Other Expenses, already VAT-exclusive since
 *    Module 18; Module 37 split Other Income/Expenses out of operating
 *    profit without changing this total). A real MRA company
 *    income tax computation starts from accounting profit but then adds
 *    back disallowed expenses (e.g. entertainment, some depreciation) and
 *    subtracts capital allowances the Income Tax Act permits instead of
 *    accounting depreciation. This app does not model any of those
 *    adjustments – there's no concept of a disallowed expense or a
 *    capital allowance schedule anywhere in the codebase (Expense has no
 *    "disallowed" flag, and Purchases of fixed assets aren't distinguished
 *    from stock purchases). KNOWN LIMITATION, not silently assumed: treat
 *    every figure this file produces as a rough estimate from the books
 *    as recorded, not a real tax computation – an Accountant still needs
 *    to do the add-back/allowance schedule by hand before filing.
 *
 * 2. Corporate tax never applies to a loss – computeCorporateTax floors
 *    the taxable base at 0 rather than producing a negative "tax", which
 *    would read as a refund this app has no mechanism to track.
 *
 * 3. The quarterly "provisional tax" estimate in getTaxCalendar applies
 *    the rate to that QUARTER'S OWN actual operating profit, not an
 *    equal-installment forecast off a prior-year assessment (the
 *    methodology MRA's PTF1/PTF2 forms actually use, per form
 *    "Provisional Tax" filings due the 25th alongside VAT). Using actual
 *    quarter-to-date profit is simpler, needs no assessment history this
 *    app doesn't store, and gives an honest "if you were taxed on exactly
 *    what this quarter earned" figure – but it will not match the real
 *    equal-installment amount MRA expects, especially in a business's
 *    first year or after a big swing in profit. Flagged in the Tax
 *    Calendar UI, same as every other "working estimate, not a filing"
 *    disclaimer in this codebase.
 *
 * 4. Like VAT_OUTPUT_PAYABLE and WITHHOLDING_TAX_PAYABLE before it, this
 *    app does NOT post an automatic "Income Tax Payable" liability to the
 *    GL – there's no ACCRUED_INCOME_TAX system account. Unlike VAT/WHT,
 *    corporate tax was never carved out of an individual Sale/Purchase/
 *    Expense transaction in the first place, so there's no natural
 *    posting point analogous to postJournalEntryForSale – it's a
 *    period-end estimate computed from already-posted P&L activity, not a
 *    transaction of its own. An Owner/Accountant who wants it on the
 *    Balance Sheet records a manual journal entry (Dr Income Tax Expense /
 *    Cr Income Tax Payable) when they've finalized a real figure; when
 *    they actually pay MRA, that's a regular Expense or manual journal
 *    entry, the same "remittance isn't modeled" pattern Modules 18 and 19
 *    already established for VAT_OUTPUT_PAYABLE and
 *    WITHHOLDING_TAX_PAYABLE.
 *
 *    CLOSED by Module 33 for the payment itself: provisional/annual
 *    payments are now recorded (src/lib/tax-payments.ts) and debit
 *    INCOME_TAX_PREPAID. Accruing the expense/payable is still the
 *    Accountant's manual journal entry.
 *    CLOSED by Module 41 for that manual entry: the Income Tax Expense and
 *    Income Tax Payable accounts now exist and the manual journal screen
 *    (src/lib/manual-journal.ts) can post to them. Income Tax Expense is read
 *    BELOW profit before tax on the P&L (src/lib/pnl-layout.ts), so booking the
 *    charge does not lower the profit this estimate starts from.
 *
 * 5a. Late-payment penalties/interest recorded through Module 33 post to
 *    TAX_PENALTIES_AND_INTEREST, a normal expense account that therefore
 *    lowers the P&L profit this file starts from. Penalties aren't
 *    deductible, so getCorporateTaxEstimate ADDS THEM BACK (see
 *    getNonDeductibleTaxPenalties) – the one add-back this app models, and
 *    only for penalties booked through that account.
 *
 * 5. This app is not the source of truth for tax law (same disclaimer as
 *    every other rate in this codebase) – TaxConfiguration.corporateTaxRate
 *    is seeded as a clearly-labeled EXAMPLE (Malawi's standard resident
 *    company rate at time of writing) and shares isExample with PAYE, VAT,
 *    and withholding tax – one Tax Settings review now covers all four.
 */

export interface CorporateTaxConfig {
  corporateTaxRate: number; // percent
  isExample: boolean;
}

export async function getCorporateTaxConfig(businessId: string): Promise<CorporateTaxConfig> {
  const taxConfig = await getOrCreateTaxConfiguration(businessId);
  return {
    corporateTaxRate: Number(taxConfig.corporateTaxRate),
    isExample: taxConfig.isExample,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Flat-rate corporate tax on a (possibly negative) accounting profit
 * figure. Floored at 0 – see design choice 2 above.
 */
export function computeCorporateTax(accountingProfit: number, rate: number): number {
  return round2(Math.max(0, accountingProfit) * (rate / 100));
}

/**
 * Net activity (debits minus credits, so a voided payment's reversal nets
 * out) on TAX_PENALTIES_AND_INTEREST within the period – the amount to add
 * back to accounting profit. 0 for a business with no such account yet.
 */
export async function getNonDeductibleTaxPenalties(businessId: string, from: Date, to: Date): Promise<number> {
  const agg = await prisma.journalLine.aggregate({
    where: {
      account: { businessId, systemKey: "TAX_PENALTIES_AND_INTEREST" },
      journalEntry: { businessId, entryDate: { gte: from, lte: to } },
    },
    _sum: { debit: true, credit: true },
  });
  return round2(Number(agg._sum.debit ?? 0) - Number(agg._sum.credit ?? 0));
}

/**
 * A working corporate tax estimate for a period, built directly from the
 * Double-Entry Accounting module's Profit & Loss (Module 11) so it stays
 * consistent with the P&L an Accountant is already looking at – see design
 * choice 1 above for what this figure does and doesn't account for.
 */
export async function getCorporateTaxEstimate(businessId: string, from: Date, to: Date) {
  const [config, pnl, penaltiesAddedBack] = await Promise.all([
    getCorporateTaxConfig(businessId),
    getProfitAndLoss(businessId, from, to),
    getNonDeductibleTaxPenalties(businessId, from, to),
  ]);

  const estimatedTax = computeCorporateTax(round2(pnl.profitBeforeTax + penaltiesAddedBack), config.corporateTaxRate);

  return {
    period: { from, to },
    accountingProfit: pnl.profitBeforeTax, // Module 37: profit before tax (includes Other Income/Expenses)
    penaltiesAddedBack, // Module 33 – 0 unless tax penalties/interest were recorded in the period
    // Module 41: income tax already CHARGED in the books for this period by manual journal entry.
    // Shown beside the estimate for comparison; never subtracted from accountingProfit above (the
    // estimate is computed from profit BEFORE tax, so booking the charge cannot shrink its own base).
    incomeTaxBooked: pnl.incomeTaxExpense,
    corporateTaxRate: config.corporateTaxRate,
    estimatedTax,
    isExample: config.isExample,
  };
}

// Fiscal-year/quarter arithmetic lives in ./fiscal-period (pure, Module 35); re-exported so existing importers are unchanged.
export { getFiscalYear, getFiscalQuarters } from "./fiscal-period";
export type { FiscalPeriod } from "./fiscal-period";
