import { prisma } from "./prisma";
import { getAllAccountBalances } from "./accounting";
import { buildProfitAndLoss } from "./pnl-layout";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Trial Balance: every account's balance, expressed as a debit or credit
 * column depending on its normal balance side. Total debits must equal
 * total credits – if they don't, that's a bug in the posting engine
 * (src/lib/accounting.ts::postJournalEntry already guarantees each entry
 * balances individually, so an out-of-balance trial balance would mean a
 * migration or manual DB edit bypassed that guarantee).
 */
export async function getTrialBalance(businessId: string, asOf?: Date) {
  const balances = await getAllAccountBalances(businessId, asOf);

  const rows = balances
    .filter((a) => a.balance !== 0)
    .map((a) => ({
      code: a.code,
      name: a.name,
      type: a.type,
      debit: a.normalBalance === "DEBIT" && a.balance > 0 ? a.balance : a.normalBalance === "CREDIT" && a.balance < 0 ? -a.balance : 0,
      credit: a.normalBalance === "CREDIT" && a.balance > 0 ? a.balance : a.normalBalance === "DEBIT" && a.balance < 0 ? -a.balance : 0,
    }));

  const totalDebit = round2(rows.reduce((sum, r) => sum + r.debit, 0));
  const totalCredit = round2(rows.reduce((sum, r) => sum + r.credit, 0));

  return { rows, totalDebit, totalCredit, isBalanced: Math.abs(totalDebit - totalCredit) < 0.01 };
}

/**
 * General Ledger for one account: every journal line posted to it, in
 * order, with a running balance – the "why is this account's balance what
 * it is" drill-down from the Trial Balance.
 */
export async function getGeneralLedger(businessId: string, accountId: string, from?: Date, to?: Date) {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });

  const lines = await prisma.journalLine.findMany({
    where: {
      accountId,
      journalEntry: {
        businessId,
        ...(from || to ? { entryDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
    },
    include: { journalEntry: true },
    orderBy: { journalEntry: { entryDate: "asc" } },
  });

  let runningBalance = 0;
  const rows = lines.map((line) => {
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    const delta = account.normalBalance === "DEBIT" ? debit - credit : credit - debit;
    runningBalance = round2(runningBalance + delta);

    return {
      date: line.journalEntry.entryDate,
      entryNumber: line.journalEntry.entryNumber,
      description: line.description ?? line.journalEntry.description,
      debit,
      credit,
      balance: runningBalance,
    };
  });

  return { account: { code: account.code, name: account.name, type: account.type }, rows };
}

/**
 * Profit & Loss for a period – computed entirely from REVENUE and EXPENSE
 * account activity within the date range, not from summing Sale/Expense
 * tables directly (spec section 20's explicit requirement). This is the
 * "real" P&L, distinct from the dashboard's revenue-cost estimate (Module
 * 6), which remains useful for the fast day-to-day view but isn't
 * accounting-grade.
 */
export async function getProfitAndLoss(businessId: string, from: Date, to: Date) {
  const accounts = await prisma.account.findMany({
    where: { businessId, isActive: true, type: { in: ["REVENUE", "EXPENSE"] } },
    orderBy: { code: "asc" },
  });

  const activity = await Promise.all(
    accounts.map(async (a) => {
      const agg = await prisma.journalLine.aggregate({
        where: { accountId: a.id, journalEntry: { businessId, entryDate: { gte: from, lte: to } } },
        _sum: { debit: true, credit: true },
      });
      return {
        code: a.code,
        name: a.name,
        type: a.type as "REVENUE" | "EXPENSE",
        normalBalance: a.normalBalance as "DEBIT" | "CREDIT",
        systemKey: a.systemKey,
        debit: Number(agg._sum.debit ?? 0),
        credit: Number(agg._sum.credit ?? 0),
      };
    })
  );

  // Module 37: layout (operating vs other income/expenses, COGS by systemKey)
  // lives in the pure ./pnl-layout so it can be verified without a database.
  return buildProfitAndLoss(activity);
}

/**
 * Cash Flow Statement – spec section 21 asks for Operating / Investing /
 * Financing sections. Built from the Cashbook's CashTransaction ledger
 * (Module 9), grouped by what kind of event caused each movement.
 *
 * Investing and Financing are honestly empty right now: this app doesn't
 * yet model equipment/asset purchases (investing) or owner
 * contributions/loans (financing) as distinct transaction types – both
 * fall into "no data yet" rather than being incorrectly lumped into
 * Operating. A future module adding those transaction types should give
 * them their own CashTransaction.referenceType and update the
 * categorization below, rather than this function guessing.
 */
export async function getCashFlowStatement(businessId: string, from: Date, to: Date) {
  // Module 33: "TaxPayment" joins the operating types, and reversals now
  // count too. A voided Expense/Payroll/TaxPayment is reversed with an
  // ADJUSTMENT row (see reverseCashTransactionsForReference), which the old
  // RECEIPT/PAYMENT-only filter dropped – so a voided outflow stayed in
  // Operating outflows forever. An ADJUSTMENT counts only when it carries
  // one of the operating referenceTypes, i.e. it IS such a reversal; manual
  // and bank-reconciliation adjustments use other referenceTypes.
  // Module 43: "CreditNote" and "Refund" cash paid back to customers are operating outflows too; 'Refund' was
  // missing, so cash refunds never reached the statement. The WHERE clause below already catches any RECEIPT/
  // PAYMENT row regardless of referenceType, but the `operating` filter right after it re-checks referenceType
  // against this exact array – so a type genuinely is dropped silently if left out of this list, the bug Module
  // 43 found and fixed for "Refund".
  // Module 44: "SupplierDebitNote" is the same case again – a cash-settled debit note posts a plain RECEIPT
  // (see postCashTransactionForDebitNote), so without this entry it would pass the WHERE clause but then get
  // silently dropped by the `operating` filter below, same as the pre-fix "Refund" bug.
  const operatingTypeList = ["Payment", "Expense", "Payroll", "TaxPayment", "CreditNote", "Refund", "SupplierDebitNote"];
  const transactions = await prisma.cashTransaction.findMany({
    where: {
      businessId,
      createdAt: { gte: from, lte: to },
      OR: [{ type: { in: ["RECEIPT", "PAYMENT"] } }, { type: "ADJUSTMENT", referenceType: { in: operatingTypeList } }],
    },
  });

  const operatingTypes = new Set(operatingTypeList);
  const operating = transactions.filter((t) => t.referenceType && operatingTypes.has(t.referenceType));

  const operatingInflows = round2(
    operating.filter((t) => Number(t.amount) > 0).reduce((s, t) => s + Number(t.amount), 0)
  );
  const operatingOutflows = round2(
    operating.filter((t) => Number(t.amount) < 0).reduce((s, t) => s + Number(t.amount), 0)
  );
  const netOperating = round2(operatingInflows + operatingOutflows);

  // Module 39: a foreign exchange adjustment moves a cash account's carrying
  // value without any cash changing hands, so it is NOT operating cash – it is
  // reported on its own line ("effect of exchange rate changes"), the way a
  // cash flow statement reconciles opening to closing cash. Reversals (voids)
  // carry the same referenceType, so a voided adjustment nets to zero here.
  const fxRows = await prisma.cashTransaction.findMany({
    where: { businessId, createdAt: { gte: from, lte: to }, type: "ADJUSTMENT", referenceType: "ForeignExchangeAdjustment" },
  });
  const exchangeRateEffect = round2(fxRows.reduce((s, t) => s + Number(t.amount), 0));

  const openingCash = await getTotalCashAcrossAccounts(businessId, from);
  const closingCash = await getTotalCashAcrossAccounts(businessId, to);

  return {
    operating: { inflows: operatingInflows, outflows: operatingOutflows, net: netOperating },
    investing: { inflows: 0, outflows: 0, net: 0, note: "Not yet modeled – no asset purchase/disposal transaction type exists." },
    financing: { inflows: 0, outflows: 0, net: 0, note: "Not yet modeled – no owner contribution/loan transaction type exists." },
    exchangeRateEffect,
    netChangeInCash: round2(netOperating + exchangeRateEffect),
    openingCash,
    closingCash,
  };
}

async function getTotalCashAcrossAccounts(businessId: string, asOf: Date): Promise<number> {
  const accounts = await prisma.cashAccount.findMany({ where: { businessId, isActive: true } });
  let total = 0;
  for (const account of accounts) {
    const agg = await prisma.cashTransaction.aggregate({
      where: { accountId: account.id, createdAt: { lte: asOf } },
      _sum: { amount: true },
    });
    total += Number(account.openingBalance) + Number(agg._sum.amount ?? 0);
  }
  return round2(total);
}

/**
 * Balance Sheet as of a date – Assets = Liabilities + Equity. Retained
 * Earnings is NOT a separately-posted account in normal operation (no
 * period-close entry exists yet – that's a further-out accounting feature,
 * fiscal year closing); instead it's computed here as all-time net income
 * (all REVENUE/EXPENSE activity up to `asOf`), which is what makes the
 * sheet balance without a closing-entry step. This is a standard technique
 * for a system that doesn't yet do formal period closes.
 */
export async function getBalanceSheet(businessId: string, asOf: Date) {
  const balances = await getAllAccountBalances(businessId, asOf);

  const assets = balances.filter((a) => a.type === "ASSET" && a.balance !== 0);
  const liabilities = balances.filter((a) => a.type === "LIABILITY" && a.balance !== 0);
  const equity = balances.filter((a) => a.type === "EQUITY" && a.balance !== 0);

  const totalAssets = round2(assets.reduce((s, a) => s + a.balance, 0));
  const totalLiabilities = round2(liabilities.reduce((s, a) => s + a.balance, 0));
  const statedEquity = round2(equity.reduce((s, a) => s + a.balance, 0));

  // All-time net income = all-time revenue minus all-time expenses, i.e.
  // the P&L with no start date – this becomes the implicit Retained
  // Earnings figure that makes Assets == Liabilities + Equity hold.
  const pnlAllTime = await getProfitAndLoss(businessId, new Date(0), asOf);
  // Module 37: profitBeforeTax, not operating profit – it includes Other Income/Expenses,
  // which is what keeps the sheet balanced now that those accounts sit outside operating expenses.
  // Module 41: profitAfterTax, not profitBeforeTax – an income tax charge booked by manual
  // journal entry (Dr INCOME_TAX_EXPENSE / Cr INCOME_TAX_PAYABLE) is a debit in the ledger, so
  // retained earnings must bear it or Assets != Liabilities + Equity by exactly that amount.
  // Identical to profitBeforeTax for a business that has booked no income tax.
  const retainedEarnings = pnlAllTime.profitAfterTax;

  const totalEquity = round2(statedEquity + retainedEarnings);
  const totalLiabilitiesAndEquity = round2(totalLiabilities + totalEquity);

  return {
    assets,
    totalAssets,
    liabilities,
    totalLiabilities,
    equity,
    retainedEarnings,
    totalEquity,
    totalLiabilitiesAndEquity,
    isBalanced: Math.abs(totalAssets - totalLiabilitiesAndEquity) < 0.01,
  };
}
