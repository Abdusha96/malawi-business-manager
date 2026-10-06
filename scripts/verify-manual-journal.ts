/**
 * Module 41 – standalone checks for manual journal entries, income tax accounts and
 * custom accounts. No database, no framework:
 *   npx tsx scripts/verify-manual-journal.ts   (npm run verify:journal)
 * Exits non-zero if any check fails.
 *
 * Covers the pure parts: the balance and account rules (src/lib/manual-journal-rules.ts),
 * the P&L / Balance Sheet treatment of income tax (src/lib/pnl-layout.ts), the chart
 * entries, permissions and the request schemas. It does NOT exercise Postgres, the
 * transaction or the void claim – see the README.
 */
import {
  checkManualJournal, toTambala, formatTambala, controlledAccountReason, CONTROLLED_ACCOUNTS,
  MANUAL_JOURNAL_TEMPLATES, TEMPLATE_ACCOUNT_KEYS, MAX_MANUAL_JOURNAL_LINES, AccountForValidation,
} from "../src/lib/manual-journal-rules";
import { buildProfitAndLoss, PnlAccountActivity } from "../src/lib/pnl-layout";
import { SYSTEM_ACCOUNTS, normalBalanceForType } from "../src/lib/chart-of-accounts";
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from "../src/lib/permissions";
import { manualJournalSchema, voidManualJournalSchema, accountCreateSchema, accountUpdateSchema } from "../src/lib/validation";

let failed = 0, total = 0;
function check(name: string, actual: unknown, expected: unknown) {
  total++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}

// ---- 1. Tambala arithmetic
check("toTambala whole", toTambala(12), 1200);
check("toTambala 2dp", toTambala(10.5), 1050);
check("0.1 + 0.2 style amounts are exact", toTambala(0.1)! + toTambala(0.2)!, toTambala(0.3));
check("3 decimals rejected", toTambala(10.005), null);
check("NaN rejected", toTambala(NaN), null);
check("Infinity rejected", toTambala(Infinity), null);
check("null is zero", toTambala(null), 0);
check("undefined is zero", toTambala(undefined), 0);
check("formatTambala", [formatTambala(123456), formatTambala(5), formatTambala(0), formatTambala(-250)], ["1,234.56", "0.05", "0.00", "-2.50"]);

// ---- 2. Line rules
const acc = (id: string, systemKey: string | null = null, isActive = true): AccountForValidation => ({ id, code: id, name: `Account ${id}`, isActive, systemKey });
const accounts = [
  acc("EXP"), acc("PAY", "INCOME_TAX_PAYABLE"), acc("TAXEXP", "INCOME_TAX_EXPENSE"), acc("PREPAID", "INCOME_TAX_PREPAID"),
  acc("OFF", null, false), acc("EQ", "OWNERS_EQUITY"),
  ...Object.keys(CONTROLLED_ACCOUNTS).map((k) => acc("C_" + k, k)),
];
const ok = checkManualJournal([{ accountId: "TAXEXP", debit: 1000 }, { accountId: "PAY", credit: 1000 }], accounts);
check("balanced entry ok", [ok.ok, ok.errors, ok.totalDebit, ok.totalCredit, ok.difference], [true, [], 100000, 100000, 0]);
check("lines come back in tambala", ok.lines.map((l) => [l.debit, l.credit]), [[100000, 0], [0, 100000]]);

const unbal = checkManualJournal([{ accountId: "TAXEXP", debit: 1000 }, { accountId: "PAY", credit: 999.99 }], accounts);
check("unbalanced by one tambala rejected", [unbal.ok, unbal.difference], [false, 1]);
check("float trap 0.1+0.2 = 0.3 balances", checkManualJournal([{ accountId: "EXP", debit: 0.1 }, { accountId: "EXP", debit: 0.2 }, { accountId: "PAY", credit: 0.3 }], accounts).ok, true);
check("single line rejected", checkManualJournal([{ accountId: "EXP", debit: 5 }], accounts).ok, false);
check("same account both sides rejected", checkManualJournal([{ accountId: "EXP", debit: 5 }, { accountId: "EXP", credit: 5 }], accounts).ok, false);
check("debit and credit on one line rejected", checkManualJournal([{ accountId: "EXP", debit: 5, credit: 5 }, { accountId: "PAY", credit: 5 }], accounts).ok, false);
check("empty line rejected", checkManualJournal([{ accountId: "EXP", debit: 5 }, { accountId: "PAY" }], accounts).ok, false);
check("negative amount rejected", checkManualJournal([{ accountId: "EXP", debit: -5 }, { accountId: "PAY", credit: -5 }], accounts).ok, false);
check("3dp rejected", checkManualJournal([{ accountId: "EXP", debit: 5.001 }, { accountId: "PAY", credit: 5.001 }], accounts).ok, false);
check("missing account rejected", checkManualJournal([{ accountId: "NOPE", debit: 5 }, { accountId: "PAY", credit: 5 }], accounts).ok, false);
check("blank account rejected", checkManualJournal([{ accountId: "", debit: 5 }, { accountId: "PAY", credit: 5 }], accounts).ok, false);
check("inactive account rejected", checkManualJournal([{ accountId: "OFF", debit: 5 }, { accountId: "PAY", credit: 5 }], accounts).ok, false);
check("too many lines rejected", checkManualJournal(Array.from({ length: MAX_MANUAL_JOURNAL_LINES + 1 }, (_, i) => ({ accountId: i % 2 ? "EXP" : "PAY", debit: i % 2 ? 1 : 0, credit: i % 2 ? 0 : 1 })), accounts).ok, false);
check("line memo trimmed, blank becomes null", checkManualJournal([{ accountId: "EXP", debit: 5, memo: "  hi " }, { accountId: "PAY", credit: 5, memo: "  " }], accounts).lines.map((l) => l.memo), ["hi", null]);
check("all problems collected, not just the first", checkManualJournal([{ accountId: "NOPE", debit: 5 }, { accountId: "", credit: 5 }], accounts).errors.length >= 2, true);

// ---- 3. Controlled accounts
for (const key of Object.keys(CONTROLLED_ACCOUNTS)) {
  check(`${key} is blocked`, checkManualJournal([{ accountId: "C_" + key, debit: 5 }, { accountId: "PAY", credit: 5 }], accounts).ok, false);
  check(`${key} has a reason`, typeof controlledAccountReason(key) === "string" && controlledAccountReason(key)!.length > 20, true);
}
check("custom account (no systemKey) allowed", controlledAccountReason(null), null);
check("income tax accounts and equity allowed", ["INCOME_TAX_EXPENSE", "INCOME_TAX_PAYABLE", "INCOME_TAX_PREPAID", "OWNERS_EQUITY", "VAT_OUTPUT_PAYABLE", "PAYE_PAYABLE", "SALES_REVENUE"].map(controlledAccountReason), [null, null, null, null, null, null, null]);
check("every blocked key is a real system account", Object.keys(CONTROLLED_ACCOUNTS).every((k) => SYSTEM_ACCOUNTS.some((a) => a.key === k)), true);

// ---- 4. Templates
for (const t of MANUAL_JOURNAL_TEMPLATES) {
  check(`template ${t.key} uses real accounts`, t.lines.every((l) => SYSTEM_ACCOUNTS.some((a) => a.key === l.systemKey)), true);
  check(`template ${t.key} uses only postable accounts`, t.lines.every((l) => controlledAccountReason(l.systemKey) === null), true);
  check(`template ${t.key} has one debit and one credit`, t.lines.map((l) => l.side).sort(), ["credit", "debit"]);
  check(`template ${t.key} accounts are ensured for old businesses`, t.lines.every((l) => (TEMPLATE_ACCOUNT_KEYS as readonly string[]).includes(l.systemKey)), true);
}

// ---- 5. Chart of accounts
const payable = SYSTEM_ACCOUNTS.find((a) => a.key === "INCOME_TAX_PAYABLE")!;
const expense = SYSTEM_ACCOUNTS.find((a) => a.key === "INCOME_TAX_EXPENSE")!;
check("payable is a liability", [payable.type, normalBalanceForType(payable.type)], ["LIABILITY", "CREDIT"]);
check("expense is a debit-normal expense", [expense.type, normalBalanceForType(expense.type)], ["EXPENSE", "DEBIT"]);
check("account codes stay unique", new Set(SYSTEM_ACCOUNTS.map((a) => a.code)).size, SYSTEM_ACCOUNTS.length);
check("account keys stay unique", new Set(SYSTEM_ACCOUNTS.map((a) => a.key)).size, SYSTEM_ACCOUNTS.length);

// ---- 6. P&L / Balance Sheet: income tax sits below profit before tax, and the sheet still balances
type Ledger = Record<string, { debit: number; credit: number }>;
function post(ledger: Ledger, lines: { key: string; debit?: number; credit?: number }[]) {
  for (const l of lines) {
    ledger[l.key] ??= { debit: 0, credit: 0 };
    ledger[l.key].debit += l.debit ?? 0;
    ledger[l.key].credit += l.credit ?? 0;
  }
}
function pnlOf(ledger: Ledger) {
  const activity: PnlAccountActivity[] = SYSTEM_ACCOUNTS.filter((a) => a.type === "REVENUE" || a.type === "EXPENSE").map((a) => ({
    code: a.code, name: a.name, type: a.type as "REVENUE" | "EXPENSE", normalBalance: normalBalanceForType(a.type) as "DEBIT" | "CREDIT",
    systemKey: a.key, debit: ledger[a.key]?.debit ?? 0, credit: ledger[a.key]?.credit ?? 0,
  }));
  return buildProfitAndLoss(activity);
}
function sheet(ledger: Ledger) {
  const bal = (type: string) => SYSTEM_ACCOUNTS.filter((a) => a.type === type).reduce((s, a) => {
    const l = ledger[a.key] ?? { debit: 0, credit: 0 };
    return s + (normalBalanceForType(a.type) === "DEBIT" ? l.debit - l.credit : l.credit - l.debit);
  }, 0);
  const p = pnlOf(ledger);
  const round = (n: number) => Math.round(n * 100) / 100;
  return { assets: round(bal("ASSET")), le: round(bal("LIABILITY") + bal("EQUITY") + p.profitAfterTax), leWrong: round(bal("LIABILITY") + bal("EQUITY") + p.profitBeforeTax), p };
}

const L: Ledger = {};
post(L, [{ key: "BANK", debit: 50000 }, { key: "OWNERS_EQUITY", credit: 20000 }, { key: "SALES_REVENUE", credit: 30000 }]); // owner capital + a cash sale
post(L, [{ key: "EXPENSE_RENT", debit: 5000 }, { key: "BANK", credit: 5000 }]);
const before = sheet(L);
check("no tax booked: profitAfterTax equals profitBeforeTax", [before.p.incomeTaxExpense, before.p.profitAfterTax], [0, before.p.profitBeforeTax]);
check("no tax booked: sheet balances", before.assets, before.le);

post(L, [{ key: "INCOME_TAX_EXPENSE", debit: 7500 }, { key: "INCOME_TAX_PAYABLE", credit: 7500 }]); // the manual accrual
const accrued = sheet(L);
check("tax charge is its own line", accrued.p.incomeTaxExpense, 7500);
check("tax charge is NOT in operating expenses", accrued.p.operatingExpenses.some((l) => l.name.toLowerCase().includes("income tax")), false);
check("profit before tax is unchanged by the charge", accrued.p.profitBeforeTax, before.p.profitBeforeTax);
check("profit after tax = before − charge", accrued.p.profitAfterTax, before.p.profitBeforeTax - 7500);
check("Balance Sheet still balances with tax booked", accrued.assets, accrued.le);
check("(using profitBeforeTax would NOT balance – why retained earnings changed)", accrued.assets === accrued.leWrong, false);

post(L, [{ key: "INCOME_TAX_PAYABLE", debit: 3000 }, { key: "INCOME_TAX_PREPAID", credit: 3000 }]); // apply prepayments (prepaid was debited by tax payments; seed it)
post(L, [{ key: "INCOME_TAX_PREPAID", debit: 3000 }, { key: "BANK", credit: 3000 }]);
const applied = sheet(L);
check("applying prepayments keeps the sheet balanced", applied.assets, applied.le);
check("applying prepayments does not touch profit", applied.p.profitAfterTax, accrued.p.profitAfterTax);

post(L, [{ key: "INCOME_TAX_PAYABLE", debit: 7500 }, { key: "INCOME_TAX_EXPENSE", credit: 7500 }]); // a void: equal and opposite
const voided = sheet(L);
check("voided accrual nets the charge to zero", voided.p.incomeTaxExpense, 0);
check("voided accrual restores profit after tax", voided.p.profitAfterTax, voided.p.profitBeforeTax);

// Invariant: profitAfterTax equals the raw net of every revenue and expense account, always.
const raw = SYSTEM_ACCOUNTS.filter((a) => a.type === "REVENUE" || a.type === "EXPENSE").reduce((s, a) => s + (L[a.key]?.credit ?? 0) - (L[a.key]?.debit ?? 0), 0);
check("profitAfterTax equals raw net of all P&L accounts", voided.p.profitAfterTax, Math.round(raw * 100) / 100);

// ---- 7. Permissions (no new key, so no re-seed)
check("accounting.manage already exists", "accounting.manage" in PERMISSIONS, true);
check("Owner and Accountant can post; Manager and Cashier can't", [
  DEFAULT_ROLE_PERMISSIONS.OWNER.includes("accounting.manage"), DEFAULT_ROLE_PERMISSIONS.ACCOUNTANT.includes("accounting.manage"),
  DEFAULT_ROLE_PERMISSIONS.MANAGER.includes("accounting.manage"), DEFAULT_ROLE_PERMISSIONS.CASHIER.includes("accounting.manage"),
], [true, true, false, false]);

// ---- 8. Request schemas
const base = { description: "Accrue tax", lines: [{ accountId: "a", debit: 10 }, { accountId: "b", credit: 10 }] };
check("valid journal request", manualJournalSchema.safeParse(base).success, true);
check("date must be a bare calendar date", [manualJournalSchema.safeParse({ ...base, entryDate: "2026-03-31" }).success, manualJournalSchema.safeParse({ ...base, entryDate: "2026-03-31T10:00:00Z" }).success, manualJournalSchema.safeParse({ ...base, entryDate: "31/03/2026" }).success], [true, false, false]);
check("date may be omitted or null", [manualJournalSchema.safeParse({ ...base, entryDate: null }).success, manualJournalSchema.safeParse(base).success], [true, true]);
check("narration required", manualJournalSchema.safeParse({ ...base, description: " " }).success, false);
check("one line rejected", manualJournalSchema.safeParse({ ...base, lines: [base.lines[0]] }).success, false);
check("41 lines rejected", manualJournalSchema.safeParse({ ...base, lines: Array.from({ length: 41 }, () => base.lines[0]) }).success, false);
check("negative amount rejected", manualJournalSchema.safeParse({ ...base, lines: [{ accountId: "a", debit: -1 }, base.lines[1]] }).success, false);
check("void needs a reason", [voidManualJournalSchema.safeParse({ reason: "" }).success, voidManualJournalSchema.safeParse({ reason: "Wrong year" }).success], [false, true]);
check("account create: valid", accountCreateSchema.safeParse({ code: "1450", name: "Prepaid Rent", type: "ASSET" }).success, true);
check("account create: bad code / type", [accountCreateSchema.safeParse({ code: "14", name: "X1", type: "ASSET" }).success, accountCreateSchema.safeParse({ code: "1450", name: "Prepaid", type: "COST" }).success], [false, false]);
check("account create can't set a systemKey or normal balance", Object.keys(accountCreateSchema.parse({ code: "1450", name: "Prepaid Rent", type: "ASSET", systemKey: "BANK", normalBalance: "CREDIT" })).sort(), ["code", "name", "type"]);
check("account update needs a change", [accountUpdateSchema.safeParse({}).success, accountUpdateSchema.safeParse({ isActive: false }).success], [false, true]);
check("account update can't change type", "type" in accountUpdateSchema.parse({ name: "New name", type: "ASSET" }), false);

console.log(`${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
