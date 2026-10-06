/**
 * Module 37 – how account activity is laid out on the Profit & Loss.
 *
 * PURE: no database, no Prisma import, so scripts/verify-profit-and-loss.ts can
 * exercise every rule below without a connection. src/lib/financial-statements.ts
 * (getProfitAndLoss) does the querying and hands the per-account debit/credit
 * totals to buildProfitAndLoss().
 *
 * WHY THIS EXISTS. Modules 21, 22 and 23 each needed an account that is hit in
 * BOTH directions:
 *
 *   GAIN_LOSS_ON_DISPOSAL_OF_ASSETS   gain (credit) / loss (debit)      Module 21
 *   BANK_CHARGES_AND_INTEREST         interest earned (credit) / charges (debit)  Module 22
 *   INVENTORY_SHRINKAGE_AND_ADJUSTMENT found stock (credit) / shrinkage (debit)   Module 23
 *
 * All three were created as EXPENSE accounts, and the P&L had no place for
 * income that wasn't Sales Revenue, so a disposal gain or interest earned printed
 * as a NEGATIVE line inside Operating Expenses (and inflated "Operating Profit"
 * only by shrinking the expense total). Stated as a KNOWN LIMITATION in each of
 * those modules' write-ups. This module closes it for the first two.
 *
 * DESIGN CHOICES
 *
 * 1. No account changed type and no journal row was touched. The accounts stay
 *    EXPENSE / debit-normal, so every posting function, the Trial Balance, the
 *    General Ledger and the Balance Sheet keep working byte-for-byte. Only the
 *    P&L's READING of them changed: it looks at each such account's NET activity
 *    for the period and puts it in "Other Income" (net credit) or "Other
 *    Expenses" (net debit). Existing tenants need no migration and no backfill –
 *    a March disposal gain posted in Module 21 shows as Other Income the moment
 *    this deploys.
 *
 * 2. NET per account, not gross by journal line. Voiding a bank-reconciliation
 *    adjustment or a stock-take line posts a REVERSING entry (debit and credit
 *    swapped). A gross split by line direction would show a voided 500 charge as
 *    500 of expense AND 500 of income. Netting the account is the only reading
 *    that a reversal cannot distort. Cost: two real events of opposite sign in
 *    one period (a 200 gain and a 50 loss on different assets; 40 of interest and
 *    15 of charges) show as one net line (150 income; 25 income), not two.
 *    KNOWN LIMITATION, stated in the README.
 *
 * 3. Only two of the three mixed accounts move. INVENTORY_SHRINKAGE_AND_
 *    ADJUSTMENT deliberately STAYS in Operating Expenses: stock lost or found is
 *    a cost of running the trading business (it is a correction to the cost of
 *    the goods sold), not a non-operating item, and a period where more stock
 *    was found than lost is correctly a negative operating expense. Moving it
 *    would also pull "Operating Profit" away from gross profit for a reason a
 *    shopkeeper would not recognise.
 *
 * 4. "Operating Profit" therefore changes meaning slightly: it now EXCLUDES
 *    disposal gains/losses and bank charges/interest. The bottom line is the new
 *    profitBeforeTax, which is exactly the old operatingProfit (same accounts,
 *    same signs), so nothing that depended on the total – corporate tax, the
 *    Balance Sheet's retained earnings – changes value. Corporate tax and the
 *    Balance Sheet were moved to profitBeforeTax in the same change.
 *    profitBeforeTax is "before tax" because corporate tax is an estimate this
 *    app never posts to the GL (see src/lib/corporate-tax.ts).
 *
 * 5. Classification is by Account.systemKey, never by code or name (the rule in
 *    the Account schema comment). This also replaces the old `code === "5000"`
 *    test for Cost of Goods Sold, which relied on a user-editable field.
 *
 * 6. (Module 41) INCOME_TAX_EXPENSE is its own line BELOW profitBeforeTax. It is
 *    the one account that is booked by hand (a manual journal entry – Modules 20
 *    and 33 tell an Accountant to do that, and Module 41 gave them the screen and
 *    the account) and it must not reduce the profit that corporate tax is computed
 *    from. profitBeforeTax is therefore UNCHANGED by it, and the new
 *    profitAfterTax = profitBeforeTax − incomeTaxExpense is what retained earnings
 *    (the Balance Sheet) must use, because the tax expense IS a debit in the
 *    ledger. The invariant scripts/verify-profit-and-loss.ts and
 *    verify-manual-journal.ts both check: profitAfterTax equals the raw net of
 *    every REVENUE and EXPENSE account (credits − debits), always. For a business
 *    that has booked no income tax, incomeTaxExpense is 0 and profitAfterTax ===
 *    profitBeforeTax, so nothing computed before this module changes value.
 *    Net per account like the others (design choice 2): a voided accrual nets to 0.
 */

export interface PnlAccountActivity {
  code: string;
  name: string;
  type: "REVENUE" | "EXPENSE";
  normalBalance: "DEBIT" | "CREDIT";
  systemKey: string | null;
  /** Sum of journal-line debits for the period. */
  debit: number;
  /** Sum of journal-line credits for the period. */
  credit: number;
}

export interface PnlLine {
  code: string;
  name: string;
  type: "REVENUE" | "EXPENSE";
  amount: number;
}

export const COST_OF_GOODS_SOLD_KEY = "COST_OF_GOODS_SOLD";
/** Module 41. Read below profit before tax – see design choice 6. */
export const INCOME_TAX_EXPENSE_KEY = "INCOME_TAX_EXPENSE";

/**
 * System accounts read as non-operating on the P&L, keyed by Account.systemKey.
 * Each one is an EXPENSE / debit-normal account: net DEBIT for the period is an
 * expense, net CREDIT is income. The two labels are what the line is called on
 * whichever side it lands, because the account's own name
 * ("Gain/Loss on Disposal of Assets") is wrong for both.
 *
 * Module 39 added FOREIGN_EXCHANGE_GAIN_LOSS to this list from day one, so an
 * exchange gain never appears as a negative operating expense in the first place.
 *
 * Add a key here only for an account that (a) holds both directions and (b) is
 * genuinely outside trading operations – see design choice 3 for why
 * INVENTORY_SHRINKAGE_AND_ADJUSTMENT is not on this list.
 */
export const NON_OPERATING_ACCOUNTS: Record<string, { incomeLabel: string; expenseLabel: string }> = {
  GAIN_LOSS_ON_DISPOSAL_OF_ASSETS: {
    incomeLabel: "Gain on Disposal of Assets",
    expenseLabel: "Loss on Disposal of Assets",
  },
  BANK_CHARGES_AND_INTEREST: {
    incomeLabel: "Bank Interest Earned",
    expenseLabel: "Bank Charges & Interest",
  },
  // Module 39. Exchange differences on foreign currency held are not a cost of
  // trading, so they sit outside operating profit like the two above. Netted per
  // account like them (design choice 2): a 500 gain and a 200 loss in one period
  // show as one 300 gain.
  FOREIGN_EXCHANGE_GAIN_LOSS: {
    incomeLabel: "Foreign Exchange Gain",
    expenseLabel: "Foreign Exchange Loss",
  },
};

export function isNonOperatingKey(systemKey: string | null | undefined): boolean {
  return !!systemKey && Object.prototype.hasOwnProperty.call(NON_OPERATING_ACCOUNTS, systemKey);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function sum(lines: { amount: number }[]): number {
  return round2(lines.reduce((s, l) => s + l.amount, 0));
}

export interface ProfitAndLossResult {
  revenue: PnlLine[];
  totalRevenue: number;
  costOfGoodsSold: number;
  grossProfit: number;
  operatingExpenses: PnlLine[];
  totalOperatingExpenses: number;
  operatingProfit: number;
  /** Module 37: positive amounts, net credit on a non-operating account. */
  otherIncome: PnlLine[];
  totalOtherIncome: number;
  /** Module 37: positive amounts, net debit on a non-operating account. */
  otherExpenses: PnlLine[];
  totalOtherExpenses: number;
  /**
   * operatingProfit + other income − other expenses. Never reduced by income tax, so it stays the
   * base corporate tax is estimated from (src/lib/corporate-tax.ts).
   */
  profitBeforeTax: number;
  /** Module 41: net income tax charge booked to INCOME_TAX_EXPENSE in the period (0 if none; negative if a reversal exceeds it). */
  incomeTaxExpense: number;
  /** Module 41: profitBeforeTax − incomeTaxExpense. What the Balance Sheet's retained earnings use. */
  profitAfterTax: number;
}

/**
 * Lays per-account period activity out as a Profit & Loss. Zero-amount lines are
 * dropped from every section except the two single-figure ones (COGS and the
 * totals), matching what getProfitAndLoss returned before this module.
 */
export function buildProfitAndLoss(activity: PnlAccountActivity[]): ProfitAndLossResult {
  const revenue: PnlLine[] = [];
  const operatingExpenses: PnlLine[] = [];
  const otherIncome: PnlLine[] = [];
  const otherExpenses: PnlLine[] = [];
  let cogsTotal = 0;
  let incomeTaxTotal = 0;

  for (const a of activity) {
    const debit = Number(a.debit) || 0;
    const credit = Number(a.credit) || 0;
    // Activity in the account's normal-balance direction for this period only
    // (a P&L is period activity, not a running balance).
    const amount = a.normalBalance === "CREDIT" ? round2(credit - debit) : round2(debit - credit);

    if (a.type === "REVENUE") {
      revenue.push({ code: a.code, name: a.name, type: a.type, amount });
      continue;
    }

    if (a.systemKey === COST_OF_GOODS_SOLD_KEY) {
      cogsTotal += amount;
      continue;
    }

    if (a.systemKey === INCOME_TAX_EXPENSE_KEY) {
      // Debit-normal EXPENSE, so `amount` is already debit − credit.
      incomeTaxTotal += amount;
      continue;
    }

    if (isNonOperatingKey(a.systemKey) && a.normalBalance === "DEBIT") {
      const labels = NON_OPERATING_ACCOUNTS[a.systemKey as string];
      // amount is debit − credit here: > 0 net expense, < 0 net income.
      if (amount > 0) otherExpenses.push({ code: a.code, name: labels.expenseLabel, type: a.type, amount });
      else if (amount < 0) otherIncome.push({ code: a.code, name: labels.incomeLabel, type: a.type, amount: -amount });
      continue;
    }

    operatingExpenses.push({ code: a.code, name: a.name, type: a.type, amount });
  }

  const totalRevenue = sum(revenue);
  const costOfGoodsSold = round2(cogsTotal);
  const grossProfit = round2(totalRevenue - costOfGoodsSold);
  const totalOperatingExpenses = sum(operatingExpenses);
  const operatingProfit = round2(grossProfit - totalOperatingExpenses);
  const totalOtherIncome = sum(otherIncome);
  const totalOtherExpenses = sum(otherExpenses);
  const profitBeforeTax = round2(operatingProfit + totalOtherIncome - totalOtherExpenses);
  const incomeTaxExpense = round2(incomeTaxTotal);
  const profitAfterTax = round2(profitBeforeTax - incomeTaxExpense);

  return {
    revenue: revenue.filter((a) => a.amount !== 0),
    totalRevenue,
    costOfGoodsSold,
    grossProfit,
    operatingExpenses: operatingExpenses.filter((a) => a.amount !== 0),
    totalOperatingExpenses,
    operatingProfit,
    otherIncome,
    totalOtherIncome,
    otherExpenses,
    totalOtherExpenses,
    profitBeforeTax,
    incomeTaxExpense,
    profitAfterTax,
  };
}
