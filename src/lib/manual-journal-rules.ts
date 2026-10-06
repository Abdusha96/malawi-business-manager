/**
 * Module 41 – the rules a manual journal entry must satisfy.
 *
 * PURE: no database, no Prisma import. Three callers must agree on every rule to
 * the tambala – the server (src/lib/manual-journal.ts, which is the authority),
 * the journal form (a live "debits / credits / difference" line and per-line
 * warnings) and scripts/verify-manual-journal.ts.
 *
 * MONEY IS COMPARED IN WHOLE TAMBALA (integers). Floating-point sums of 2-decimal
 * amounts do not balance reliably (0.1 + 0.2 !== 0.3), and "does this entry
 * balance" is the one question that must never be answered wrongly, so every
 * amount is converted once with toTambala() and only integers are added.
 */

/** A hand-keyed entry longer than this is almost certainly a data import, not a journal. */
export const MAX_MANUAL_JOURNAL_LINES = 40;

export interface ManualLineInput {
  accountId: string;
  debit?: number | null;
  credit?: number | null;
  memo?: string | null;
}

export interface AccountForValidation {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  systemKey: string | null;
}

/**
 * System accounts a manual line may NOT post to, with the reason shown to the
 * user. Each is the GL mirror of a sub-ledger this app computes from its own rows:
 *
 *   cash / bank / mobile money   CashTransaction (the Cashbook)
 *   accounts receivable          Sale.balance   (customer balances, aging)
 *   accounts payable             Purchase.balance (supplier balances)
 *   inventory                    Product.quantity x cost, StockLevel
 *   customer / supplier credits  Credit records (Module 16)
 *   fixed assets / accumulated depreciation   the FixedAsset register (Module 21)
 *
 * A manual line here would move the GL and leave the sub-ledger untouched, and
 * nothing could ever reconcile the two – the reason Module 39 refused to post a
 * receivable/payable gain or loss without a document-level rate. Classification
 * is by systemKey, never by code or name (the rule in the Account schema comment).
 * A custom (user-created) account has no systemKey and is always allowed.
 */
export const CONTROLLED_ACCOUNTS: Record<string, string> = {
  CASH_ON_HAND: "Cash and bank balances come from the Cashbook. Record the movement in the Cashbook (transfer, expense, payment) so both ledgers move together.",
  BANK: "Cash and bank balances come from the Cashbook. Record the movement in the Cashbook, or use Bank Reconciliation for charges and interest.",
  AIRTEL_MONEY: "Mobile-money balances come from the Cashbook. Record the movement in the Cashbook so both ledgers move together.",
  TNM_MPAMBA: "Mobile-money balances come from the Cashbook. Record the movement in the Cashbook so both ledgers move together.",
  ACCOUNTS_RECEIVABLE: "Receivables are computed from each sale's balance. Record a payment or refund on the sale instead.",
  ACCOUNTS_PAYABLE: "Payables are computed from each purchase's balance. Record a payment or refund on the purchase instead.",
  INVENTORY: "Inventory is computed from stock quantities. Use a stock adjustment or a stock take instead.",
  CUSTOMER_CREDITS_PAYABLE: "Customer credit balances are tracked per customer. Use a refund (credit note) instead.",
  SUPPLIER_CREDITS_RECEIVABLE: "Supplier credit balances are tracked per supplier. Use a refund (credit note) instead.",
  FIXED_ASSETS: "The fixed asset register drives this account. Record the asset, its depreciation or its disposal on the Fixed Assets page.",
  ACCUMULATED_DEPRECIATION: "Depreciation is computed per asset. Run depreciation on the Fixed Assets page instead.",
};

/** Why a manual line can't use this account, or null when it can. */
export function controlledAccountReason(systemKey: string | null | undefined): string | null {
  if (!systemKey) return null;
  return Object.prototype.hasOwnProperty.call(CONTROLLED_ACCOUNTS, systemKey) ? CONTROLLED_ACCOUNTS[systemKey] : null;
}

/**
 * Converts a money amount to whole tambala, or null when it is not a finite
 * number or has more than two decimal places (a typed 10.005 is rejected, never
 * silently rounded into a different figure than the person saw).
 */
export function toTambala(amount: number | null | undefined): number | null {
  if (amount === null || amount === undefined) return 0;
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  const scaled = amount * 100;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6) return null;
  return rounded;
}

export interface CheckedManualJournal {
  ok: boolean;
  /** Every problem found, in line order. Empty when ok. */
  errors: string[];
  /** Whole tambala. */
  totalDebit: number;
  totalCredit: number;
  /** debit − credit; 0 when balanced. */
  difference: number;
  /** Lines that reached the ledger check, in whole-tambala form. Only meaningful when ok. */
  lines: { accountId: string; debit: number; credit: number; memo: string | null }[];
}

/**
 * Checks a set of lines against the accounts they name. Collects every problem
 * rather than stopping at the first, so a form can show them all at once.
 * `accounts` must be the business's own accounts (the server loads them with
 * `businessId` in the filter, so a foreign account id simply isn't found).
 */
export function checkManualJournal(input: ManualLineInput[], accounts: AccountForValidation[]): CheckedManualJournal {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const errors: string[] = [];
  const lines: CheckedManualJournal["lines"] = [];
  let totalDebit = 0;
  let totalCredit = 0;

  if (input.length < 2) errors.push("A journal entry needs at least two lines.");
  if (input.length > MAX_MANUAL_JOURNAL_LINES) errors.push(`A journal entry can have at most ${MAX_MANUAL_JOURNAL_LINES} lines.`);

  input.forEach((line, i) => {
    const n = i + 1;
    const account = byId.get(line.accountId);
    if (!line.accountId) {
      errors.push(`Line ${n}: choose an account.`);
    } else if (!account) {
      errors.push(`Line ${n}: that account was not found in this business.`);
    } else if (!account.isActive) {
      errors.push(`Line ${n}: ${account.code} ${account.name} is inactive.`);
    } else {
      const reason = controlledAccountReason(account.systemKey);
      if (reason) errors.push(`Line ${n}: ${account.code} ${account.name} can't be used in a manual entry. ${reason}`);
    }

    const debit = toTambala(line.debit);
    const credit = toTambala(line.credit);
    if (debit === null || credit === null) {
      errors.push(`Line ${n}: amounts can have at most two decimal places.`);
      return;
    }
    if (debit < 0 || credit < 0) {
      errors.push(`Line ${n}: amounts can't be negative. Put a reduction on the opposite side instead.`);
      return;
    }
    if (debit > 0 && credit > 0) {
      errors.push(`Line ${n}: enter either a debit or a credit, not both.`);
      return;
    }
    if (debit === 0 && credit === 0) {
      errors.push(`Line ${n}: enter a debit or a credit amount.`);
      return;
    }
    totalDebit += debit;
    totalCredit += credit;
    lines.push({ accountId: line.accountId, debit, credit, memo: line.memo?.trim() ? line.memo.trim() : null });
  });

  const distinct = new Set(input.map((l) => l.accountId).filter(Boolean));
  if (input.length >= 2 && distinct.size < 2) {
    errors.push("A journal entry needs at least two different accounts – debiting and crediting the same account does nothing.");
  }

  const difference = totalDebit - totalCredit;
  if (errors.length === 0 && difference !== 0) {
    errors.push(`The entry doesn't balance: debits ${formatTambala(totalDebit)} and credits ${formatTambala(totalCredit)} differ by ${formatTambala(Math.abs(difference))}.`);
  }

  // A per-line problem makes the total unreliable, but the running figures are still
  // returned so a form can keep showing them while the user fixes the lines.
  return { ok: errors.length === 0, errors, totalDebit, totalCredit, difference, lines };
}

/** Whole tambala → "1,234.50". */
export function formatTambala(t: number): string {
  const sign = t < 0 ? "-" : "";
  const abs = Math.abs(t);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole.toLocaleString("en-US")}.${frac}`;
}

/** Whole tambala → a JS number in the business currency (exact for any realistic amount). */
export function tambalaToAmount(t: number): number {
  return t / 100;
}

/**
 * One-click starting points for the two entries Modules 20 and 33 tell an
 * Accountant to book by hand. Lines are named by systemKey (never code) and are
 * left without amounts – the Accountant types the figure from the tax assessment.
 * `side` is which column the line starts in.
 */
export interface ManualJournalTemplate {
  key: string;
  label: string;
  description: string;
  lines: { systemKey: string; side: "debit" | "credit"; memo: string }[];
}

export const MANUAL_JOURNAL_TEMPLATES: ManualJournalTemplate[] = [
  {
    key: "ACCRUE_INCOME_TAX",
    label: "Accrue income tax for the year",
    description: "Books the year's company income tax as a charge and as an amount owed to the MRA, once you have a final figure.",
    lines: [
      { systemKey: "INCOME_TAX_EXPENSE", side: "debit", memo: "Income tax charge for the year" },
      { systemKey: "INCOME_TAX_PAYABLE", side: "credit", memo: "Income tax owed to the MRA" },
    ],
  },
  {
    key: "APPLY_PREPAID_INCOME_TAX",
    label: "Apply provisional payments against income tax owed",
    description: "Moves the provisional and annual payments recorded under Tax Payments off 'Income Tax Paid / Prepaid' and against the amount owed.",
    lines: [
      { systemKey: "INCOME_TAX_PAYABLE", side: "debit", memo: "Provisional payments applied" },
      { systemKey: "INCOME_TAX_PREPAID", side: "credit", memo: "Provisional payments applied" },
    ],
  },
  // Module 45 (VAT Partial Exemption): the VAT Return's "irrecoverable input VAT"
  // figure (shown whenever a period is apportioned) is never posted automatically –
  // like INCOME_TAX_EXPENSE above, it needs a period to actually finish and be
  // reviewed first. An Accountant uses this once they're ready to write it off.
  {
    key: "WRITE_OFF_IRRECOVERABLE_VAT",
    label: "Write off irrecoverable input VAT",
    description:
      "Moves input VAT the VAT Return marked as not reclaimable – because of exempt sales – off VAT Input Receivable and into an expense, for a finished period.",
    lines: [
      { systemKey: "IRRECOVERABLE_INPUT_VAT", side: "debit", memo: "Irrecoverable input VAT (partial exemption)" },
      { systemKey: "VAT_INPUT_RECEIVABLE", side: "credit", memo: "Input VAT not reclaimable this period" },
    ],
  },
];

/** The account keys the templates need, so the server can make sure they exist for businesses that registered before Module 41/45. */
export const TEMPLATE_ACCOUNT_KEYS = [
  "INCOME_TAX_EXPENSE",
  "INCOME_TAX_PAYABLE",
  "INCOME_TAX_PREPAID",
  "IRRECOVERABLE_INPUT_VAT",
  "VAT_INPUT_RECEIVABLE",
] as const;
