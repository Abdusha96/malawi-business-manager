import { AccountType, NormalBalance, CashAccountType } from "@prisma/client";
import { EXPENSE_CATEGORIES } from "./validation";

/**
 * The standard chart of accounts seeded at business registration and used
 * by the posting engine (src/lib/accounting.ts) to find "the account for
 * X" by a stable key, rather than a fragile name string match. Every
 * SYSTEM_ACCOUNTS entry becomes an isSystemAccount: true row – protected
 * from deletion since the posting engine depends on it existing.
 *
 * Codes follow a conventional numbering scheme (1000s = assets, 2000s =
 * liabilities, 3000s = equity, 4000s = revenue, 5000s+ = expenses) but the
 * numbers themselves carry no logic – src/lib/accounting.ts always looks
 * accounts up by `key`, never by code or name.
 */

export interface SystemAccountDef {
  key: string; // stable lookup key, e.g. "CASH_ON_HAND"
  code: string;
  name: string;
  type: AccountType;
}

const NORMAL_BALANCE_BY_TYPE: Record<AccountType, NormalBalance> = {
  ASSET: "DEBIT",
  EXPENSE: "DEBIT",
  LIABILITY: "CREDIT",
  EQUITY: "CREDIT",
  REVENUE: "CREDIT",
};

export function normalBalanceForType(type: AccountType): NormalBalance {
  return NORMAL_BALANCE_BY_TYPE[type];
}

// Maps 1:1 to the four CashAccountType values (Module 9) – every
// CashAccount of a given type posts to the matching GL account here.
export const CASH_ACCOUNT_KEYS: Record<string, string> = {
  CASH: "CASH_ON_HAND",
  BANK: "BANK",
  AIRTEL_MONEY: "AIRTEL_MONEY",
  TNM_MPAMBA: "TNM_MPAMBA",
};

// Maps 1:1 to ExpenseCategory (Module 4) – one expense account per
// category, so a P&L can break down expenses the same way the Expenses
// report already does, without a second classification scheme.
function expenseAccountKey(category: string): string {
  return `EXPENSE_${category}`;
}

export const SYSTEM_ACCOUNTS: SystemAccountDef[] = [
  // Assets
  { key: "CASH_ON_HAND", code: "1000", name: "Cash on Hand", type: "ASSET" },
  { key: "BANK", code: "1010", name: "Bank", type: "ASSET" },
  { key: "AIRTEL_MONEY", code: "1020", name: "Airtel Money", type: "ASSET" },
  { key: "TNM_MPAMBA", code: "1030", name: "TNM Mpamba", type: "ASSET" },
  { key: "ACCOUNTS_RECEIVABLE", code: "1100", name: "Accounts Receivable", type: "ASSET" },
  { key: "INVENTORY", code: "1200", name: "Inventory", type: "ASSET" },
  // Module 78: the Inventory equivalent for services. A purchase of a service (labour, a subcontractor, a
  // delivery bill) debits it; a sale of a service credits it at the service's cost, the same way a sale of goods
  // credits Inventory. A debit balance is service cost bought but not yet sold. A credit balance is service cost
  // recognised on sales but not yet billed by the supplier. Created on first use for older businesses.
  { key: "SERVICE_COST_CLEARING", code: "1210", name: "Service Cost Clearing", type: "ASSET" },
  // Module 16 (Refunds): a CREDIT_NOTE purchase refund reclassifies the
  // residual "supplier owes us cash" balance (left in Accounts Payable by
  // voiding a paid purchase – see src/lib/refunds.ts) into a dedicated
  // asset account, since it's now owed as credit toward a future purchase,
  // not cash.
  { key: "SUPPLIER_CREDITS_RECEIVABLE", code: "1110", name: "Supplier Credits Receivable", type: "ASSET" },
  // Module 18 (VAT): input VAT paid on purchases, reclaimable against
  // output VAT owed – nets against VAT_OUTPUT_PAYABLE on the VAT Return
  // (src/lib/vat.ts), not automatically offset in the GL itself.
  { key: "VAT_INPUT_RECEIVABLE", code: "1120", name: "VAT Input Receivable", type: "ASSET" },
  // Module 33 (Tax Payments): provisional and annual income tax paid to
  // the MRA. Typed ASSET (a prepayment against the final annual
  // liability), NOT an expense, on purpose: this app never accrues an
  // "Income Tax Payable" liability or an income tax expense (see the
  // corporate-tax.ts header, design choice 4), so there is nothing yet to
  // settle – and expensing the payment would feed straight back into the
  // P&L that getCorporateTaxEstimate() computes tax FROM. An Accountant
  // who finalizes the year's tax books Dr Income Tax Expense / Cr this
  // account by manual journal entry, exactly the manual step Module 20
  // already documents.
  { key: "INCOME_TAX_PREPAID", code: "1130", name: "Income Tax Paid / Prepaid", type: "ASSET" },
  // Module 21 (Fixed Assets & Depreciation): capitalized cost of equipment,
  // vehicles, furniture, buildings, land, etc. – see src/lib/fixed-assets.ts.
  { key: "FIXED_ASSETS", code: "1300", name: "Fixed Assets (at cost)", type: "ASSET" },
  // A contra-asset WITHOUT a dedicated AccountType: normalBalanceForType()
  // hard-codes ASSET -> DEBIT, so crediting this account (every
  // depreciation run does) drives its balance negative under that
  // DEBIT-normal convention – getAccountBalance() reports that negative
  // number as-is, getTrialBalance() already recognizes a DEBIT-normal
  // account with a negative balance and places it in the credit column
  // (see that function's second ternary branch), and getBalanceSheet()'s
  // sum-of-asset-balances subtracts it automatically. No engine change was
  // needed – this is a deliberate reuse of behavior the posting engine
  // already had to support correctly, not a special case.
  { key: "ACCUMULATED_DEPRECIATION", code: "1310", name: "Accumulated Depreciation", type: "ASSET" },

  // Liabilities
  { key: "ACCOUNTS_PAYABLE", code: "2000", name: "Accounts Payable", type: "LIABILITY" },
  { key: "PAYE_PAYABLE", code: "2100", name: "PAYE Payable", type: "LIABILITY" },
  { key: "PENSION_PAYABLE", code: "2200", name: "Pension Payable", type: "LIABILITY" },
  { key: "OTHER_DEDUCTIONS_PAYABLE", code: "2300", name: "Other Payroll Deductions Payable", type: "LIABILITY" },
  // Module 16 (Refunds): a CREDIT_NOTE sale refund – see
  // SUPPLIER_CREDITS_RECEIVABLE above for the mirror-image reasoning on the
  // purchase side.
  { key: "CUSTOMER_CREDITS_PAYABLE", code: "2400", name: "Customer Credits Payable", type: "LIABILITY" },
  // Module 18 (VAT): output VAT collected on sales, owed to the MRA until
  // the VAT return is filed and paid. This app doesn't model the filing/
  // payment itself (see src/lib/vat.ts) – an Owner/Accountant clears this
  // liability by recording an Expense or a manual journal entry when they
  // actually pay their VAT return, same as any other real-world tax remittance
  // this app doesn't have a dedicated workflow for yet.
  // CLOSED by Module 33: recording a VAT payment (src/lib/tax-payments.ts)
  // now clears this liability, netted against VAT_INPUT_RECEIVABLE, in one
  // journal entry – see postJournalEntryForTaxPayment.
  { key: "VAT_OUTPUT_PAYABLE", code: "2500", name: "VAT Output Payable", type: "LIABILITY" },
  // Module 19 (Withholding Tax): tax withheld from Expense payments to
  // payees (rent, commission, professional fees, ...), owed to the MRA
  // until remitted. Same non-automated remittance story as
  // VAT_OUTPUT_PAYABLE above – an Owner/Accountant clears this by
  // recording a regular Expense or manual journal entry when they actually
  // pay it over. See src/lib/withholding-tax.ts.
  // CLOSED by Module 33 (the same tax-payment flow clears PAYE_PAYABLE too).
  { key: "WITHHOLDING_TAX_PAYABLE", code: "2600", name: "Withholding Tax Payable", type: "LIABILITY" },
  // Module 41 (Manual Journal Entries): the liability an Accountant books when a
  // real company income tax figure is finalised – Dr INCOME_TAX_EXPENSE / Cr this.
  // Modules 20 and 33 both tell the Accountant to do exactly that "by manual
  // journal entry" but no such account existed, so the instruction could not be
  // followed. Provisional/annual payments recorded through Module 33 debit
  // INCOME_TAX_PREPAID; the Accountant then clears this liability against it
  // (Dr this / Cr INCOME_TAX_PREPAID) – the "Income tax payable" template on the
  // manual journal form does both steps. Nothing in the app posts to it
  // automatically: it is only ever written by a manual journal entry.
  { key: "INCOME_TAX_PAYABLE", code: "2700", name: "Income Tax Payable", type: "LIABILITY" },

  // Equity
  { key: "OWNERS_EQUITY", code: "3000", name: "Owner's Equity", type: "EQUITY" },
  { key: "RETAINED_EARNINGS", code: "3100", name: "Retained Earnings", type: "EQUITY" },

  // Revenue
  { key: "SALES_REVENUE", code: "4000", name: "Sales Revenue", type: "REVENUE" },

  // Cost of sales
  { key: "COST_OF_GOODS_SOLD", code: "5000", name: "Cost of Goods Sold", type: "EXPENSE" },

  // Payroll expense (separate from the Expense-category accounts below,
  // since payroll has its own dedicated module and cost structure)
  { key: "SALARY_EXPENSE", code: "5100", name: "Salary Expense", type: "EXPENSE" },
  { key: "PENSION_EXPENSE", code: "5110", name: "Pension Expense (Employer)", type: "EXPENSE" },

  // Module 21 (Fixed Assets & Depreciation)
  { key: "DEPRECIATION_EXPENSE", code: "5120", name: "Depreciation Expense", type: "EXPENSE" },
  // Holds both gains (credited) and losses (debited) on disposal – see
  // src/lib/fixed-assets.ts::disposeFixedAsset. Typed EXPENSE rather than a
  // separate "Other Income" section: this app's Profit & Loss (src/lib/
  // financial-statements.ts::getProfitAndLoss) has no such section (the
  // same simplification Cash Flow's Investing/Financing gap uses), so a
  // gain shows as a negative Operating Expense line rather than income –
  // stated plainly here and in this module's README write-up as a KNOWN
  // LIMITATION rather than silently misclassified.
  // CLOSED by Module 37: the P&L now reads this account's net activity as
  // Other Income (gain) or Other Expenses (loss) – see src/lib/pnl-layout.ts.
  // The account itself is unchanged.
  { key: "GAIN_LOSS_ON_DISPOSAL_OF_ASSETS", code: "5130", name: "Gain/Loss on Disposal of Assets", type: "EXPENSE" },

  // Module 22 (Bank Reconciliation): holds both bank charges/fees
  // (debited) and interest earned (credited), exactly the same
  // "contra-flow inside one EXPENSE-typed account" reuse
  // GAIN_LOSS_ON_DISPOSAL_OF_ASSETS established above – interest income
  // shows as a negative expense line rather than Other Income, for the
  // same reason (no Other Income P&L section yet). See
  // src/lib/accounting-integrations.ts::postJournalEntryForBankReconciliationAdjustment.
  // CLOSED by Module 37: net credit now shows as "Bank Interest Earned" under
  // Other Income (src/lib/pnl-layout.ts).
  { key: "BANK_CHARGES_AND_INTEREST", code: "5140", name: "Bank Charges & Interest", type: "EXPENSE" },

  // Module 23 (Stock Take): holds both shrinkage (debited – counted less
  // than the books said) and found stock (credited – counted more), the
  // same "one account, both directions" reuse BANK_CHARGES_AND_INTEREST
  // and GAIN_LOSS_ON_DISPOSAL_OF_ASSETS above established. Found stock
  // shows as a negative expense line rather than Other Income, for the
  // same stated-not-hidden simplification. See
  // src/lib/accounting-integrations.ts::postJournalEntryForStockTakeAdjustment.
  // Module 37 deliberately leaves this one in Operating Expenses (stock lost
  // or found is a trading cost) – see design choice 3 in src/lib/pnl-layout.ts.
  { key: "INVENTORY_SHRINKAGE_AND_ADJUSTMENT", code: "5150", name: "Inventory Shrinkage & Adjustment", type: "EXPENSE" },

  // Module 33 (Tax Payments): late-payment penalties and interest the MRA
  // charges on top of the tax itself. A real expense, but generally NOT a
  // tax-deductible one – src/lib/corporate-tax.ts adds this account's
  // activity back when estimating corporate tax, so the penalty doesn't
  // shrink the very tax base it's a penalty on.
  { key: "TAX_PENALTIES_AND_INTEREST", code: "5160", name: "Tax Penalties & Interest", type: "EXPENSE" },

  // Module 39 (Foreign Exchange Gains & Losses): holds both exchange gains
  // (credited) and exchange losses (debited), the same "one EXPENSE-typed
  // account, both directions" shape as GAIN_LOSS_ON_DISPOSAL_OF_ASSETS and
  // BANK_CHARGES_AND_INTEREST above. The books are in one currency (MWK) and
  // nothing here converts between currencies, so this account is only ever
  // posted by an explicit ForeignExchangeAdjustment (src/lib/foreign-exchange.ts)
  // – realised (foreign currency converted/received at a different rate) or
  // unrealised (a period-end revaluation of foreign currency still held).
  // The P&L reads its net activity as Other Income / Other Expenses, never as
  // an operating cost – see NON_OPERATING_ACCOUNTS in src/lib/pnl-layout.ts.
  { key: "FOREIGN_EXCHANGE_GAIN_LOSS", code: "5170", name: "Foreign Exchange Gain/Loss", type: "EXPENSE" },

  // Module 41 (Manual Journal Entries): the income tax charge for a period, booked by
  // manual journal entry (Dr this / Cr INCOME_TAX_PAYABLE). An EXPENSE-typed account
  // but NOT an operating cost and NOT part of profit before tax: corporate tax is
  // computed FROM profit before tax (src/lib/corporate-tax.ts), so an income tax
  // charge left inside operating expenses would shrink the very base it is charged
  // on. src/lib/pnl-layout.ts reads it as its own line below Profit Before Tax
  // ("Income Tax Expense" -> "Profit After Tax"), and the Balance Sheet's retained
  // earnings use profit AFTER tax so the sheet still balances once tax is booked.
  { key: "INCOME_TAX_EXPENSE", code: "5180", name: "Income Tax Expense", type: "EXPENSE" },

  // Module 45 (VAT Partial Exemption): the portion of a period's input VAT that
  // getVatReturn() determined isn't reclaimable because of the business's exempt
  // sales mix. VAT_INPUT_RECEIVABLE still accumulates the FULL amount at
  // purchase time (Module 18) – nothing at posting time knows the period's
  // eventual sales mix – so an Accountant writes off the irrecoverable share by
  // manual journal entry (Dr this / Cr VAT_INPUT_RECEIVABLE) once a VAT Return
  // period is finalized, the same "period-end figure, booked by hand" pattern
  // INCOME_TAX_EXPENSE above established. An ordinary operating EXPENSE – unlike
  // INCOME_TAX_EXPENSE it needs no special P&L placement, since irrecoverable
  // input VAT is genuinely a cost of running the business, not a tax on profit.
  { key: "IRRECOVERABLE_INPUT_VAT", code: "5185", name: "Irrecoverable Input VAT (Partial Exemption)", type: "EXPENSE" },

  // One expense account per ExpenseCategory (Module 4), generated below
  ...EXPENSE_CATEGORIES.map((category, i) => ({
    key: expenseAccountKey(category),
    code: String(5200 + i * 10),
    name: `Expense – ${category.replace("_", " ")}`,
    type: "EXPENSE" as AccountType,
  })),
];

export function getExpenseAccountKey(category: string): string {
  return expenseAccountKey(category);
}

/**
 * Maps a PaymentMethod to the CashAccountType it settles into. Lives here
 * (not in src/lib/cashbook.ts, where it originated) because both
 * cashbook.ts AND accounting-integrations.ts need it – putting it in
 * cashbook.ts would create a circular import once cashbook.ts needed to
 * call into accounting-integrations.ts for the Transfer posting. CARD
 * settles to BANK (a simplification, stated plainly); CREDIT moves no cash
 * at all.
 */
export function accountTypeForPaymentMethod(method: string): CashAccountType | null {
  switch (method) {
    case "CASH": return "CASH";
    case "BANK": return "BANK";
    case "CARD": return "BANK";
    case "AIRTEL_MONEY": return "AIRTEL_MONEY";
    case "TNM_MPAMBA": return "TNM_MPAMBA";
    case "CREDIT": return null;
    default: return null;
  }
}
