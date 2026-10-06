import { prisma } from "./prisma";
import { cashAmountForPayment } from "./fx-calc";
import { Prisma, CashAccountType, PaymentMethod } from "@prisma/client";
import { accountTypeForPaymentMethod } from "./chart-of-accounts";
import { postJournalEntryForTransfer } from "./accounting-integrations";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Maps a PaymentMethod (used throughout Sales/Expenses/Purchases/Payments)
 * to the CashAccountType it settles into – now defined in
 * chart-of-accounts.ts (see that file for why) and re-exported here so
 * every existing import of `accountTypeForPaymentMethod from "./cashbook"`
 * keeps working without touching every call site.
 */
export { accountTypeForPaymentMethod } from "./chart-of-accounts";

const DEFAULT_ACCOUNT_NAMES: Record<CashAccountType, string> = {
  CASH: "Cash",
  BANK: "Bank",
  AIRTEL_MONEY: "Airtel Money",
  TNM_MPAMBA: "TNM Mpamba",
};

/**
 * Resolve the account auto-posting should use. A user-designated account
 * takes precedence; if none exists, use or create a generic non-default
 * fallback so older businesses still have somewhere to post.
 */
export async function getOrCreateDefaultAccount(
  tx: Prisma.TransactionClient,
  businessId: string,
  type: CashAccountType
) {
  const existing = await tx.cashAccount.findFirst({ where: { businessId, type, isDefault: true } });
  if (existing) return existing;

  const fallback = await tx.cashAccount.findFirst({
    where: { businessId, type, name: DEFAULT_ACCOUNT_NAMES[type], isDefault: false },
    orderBy: { createdAt: "asc" },
  });
  if (fallback) return fallback;

  return tx.cashAccount.create({
    data: { businessId, type, name: DEFAULT_ACCOUNT_NAMES[type], isDefault: false, openingBalance: 0 },
  });
}

export class CashAccountSelectionError extends Error {
  constructor(message = "Choose an active cash account that matches the payment method.") {
    super(message);
    this.name = "CashAccountSelectionError";
  }
}

export async function getAccountBalance(accountId: string): Promise<number> {
  const account = await prisma.cashAccount.findUniqueOrThrow({ where: { id: accountId } });
  const agg = await prisma.cashTransaction.aggregate({
    where: { accountId },
    _sum: { amount: true },
  });
  return round2(Number(account.openingBalance) + Number(agg._sum.amount ?? 0));
}

/**
 * Posts one ledger entry and returns the new running balance. Always call
 * within the same transaction as whatever business event caused the money
 * movement (a Payment, an Expense) – see postCashTransactionForPayment and
 * postCashTransactionForExpense below, which are the actual integration
 * points the rest of the app calls.
 */
async function postCashTransaction(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  accountId: string;
  type: "RECEIPT" | "PAYMENT" | "TRANSFER_IN" | "TRANSFER_OUT" | "ADJUSTMENT";
  amount: number; // signed
  relatedAccountId?: string;
  referenceType?: string;
  referenceId?: string;
  description?: string;
  createdById: string;
  // Module 27 (Module 29 extended this to Payroll): which branch's
  // activity this movement is attributable to – derived internally by
  // each postCashTransactionFor*() integration point below from the
  // originating record, never accepted from a caller outside this file.
  // null means "not attributable to one branch" (a transfer, an
  // adjustment, or a payroll run for an employee with no assigned branch)
  // – see the model comment on CashTransaction for why that's a real
  // answer, not a gap.
  branchId?: string | null;
}) {
  const { tx, accountId, amount } = params;

  const account = await tx.cashAccount.findUniqueOrThrow({ where: { id: accountId } });
  const currentAgg = await tx.cashTransaction.aggregate({ where: { accountId }, _sum: { amount: true } });
  const currentBalance = Number(account.openingBalance) + Number(currentAgg._sum.amount ?? 0);
  const balanceAfter = round2(currentBalance + amount);

  return tx.cashTransaction.create({
    data: {
      businessId: params.businessId,
      accountId,
      branchId: params.branchId ?? undefined,
      type: params.type,
      amount: round2(amount),
      balanceAfter,
      relatedAccountId: params.relatedAccountId,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      description: params.description,
      createdById: params.createdById,
    },
  });
}

/**
 * Integration point for Sales and Purchases modules: call this right after
 * creating a Payment row. Direction is inferred from which relation is set
 * – a Payment with saleId/customerId is money IN (RECEIPT), a Payment with
 * purchaseId/supplierId is money OUT (PAYMENT). Silently does nothing for
 * PaymentMethod.CREDIT, since a credit sale/purchase hasn't moved any cash
 * yet – the later payment that actually settles it is a separate Payment
 * row with its own real method, which posts normally.
 *
 * Module 27: Payment itself has no branchId of its own – the branch is
 * derived from whichever Sale/Purchase it's attached to (both now carry
 * one). A general customer/supplier payment not tied to one Sale/Purchase
 * (see applyCustomerPayment/applySupplierPayment) has no branch to derive,
 * same as before – it posts branch-null, which is the honest answer for a
 * payment that isn't really "at" any one branch.
 */
export async function postCashTransactionForPayment(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  paymentId: string;
  createdById: string;
  cashAccountId?: string | null;
}) {
  const { tx, businessId, paymentId, createdById, cashAccountId } = params;
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });

  const accountType = accountTypeForPaymentMethod(payment.method);
  if (!accountType) return null; // CREDIT – no cash moved

  const isInflow = !!payment.saleId || !!payment.customerId;
  let account;
  if (cashAccountId) {
    account = await tx.cashAccount.findFirst({
      where: { id: cashAccountId, businessId, isActive: true },
    });
    if (!account || account.type !== accountType) throw new CashAccountSelectionError();
  } else {
    account = await getOrCreateDefaultAccount(tx, businessId, accountType);
  }

  let branchId: string | null = null;
  if (payment.saleId) {
    const sale = await tx.sale.findUnique({ where: { id: payment.saleId }, select: { branchId: true } });
    branchId = sale?.branchId ?? null;
  } else if (payment.purchaseId) {
    const purchase = await tx.purchase.findUnique({ where: { id: payment.purchaseId }, select: { branchId: true } });
    branchId = purchase?.branchId ?? null;
  }

  return postCashTransaction({
    tx,
    businessId,
    accountId: account.id,
    type: isInflow ? "RECEIPT" : "PAYMENT",
    // Module 40: on a foreign-currency settlement the cash that moved differs
    // from the kwacha applied to the document by Payment.fxGainLoss (0 otherwise).
    amount: isInflow
      ? cashAmountForPayment(Number(payment.amount), Number(payment.fxGainLoss ?? 0), "RECEIVE")
      : -cashAmountForPayment(Number(payment.amount), Number(payment.fxGainLoss ?? 0), "PAY"),
    referenceType: "Payment",
    referenceId: payment.id,
    createdById,
    branchId,
  });
}

/**
 * Integration point for the Expenses module: call after creating an
 * Expense row. Always an outflow. Skips CREDIT the same way payments do
 * (though the expense form doesn't currently offer CREDIT as an option).
 *
 * Module 19 (Withholding Tax): the cash that actually leaves to the payee
 * is `amount - withholdingTaxAmount`, NOT the full expense amount – the
 * withheld portion never reaches the payee, it's held back for the MRA
 * (see WITHHOLDING_TAX_PAYABLE in src/lib/accounting-integrations.ts).
 * withholdingTaxAmount defaults to 0 for the (large majority of) Expenses
 * that aren't withholding-tax-eligible, so this is a no-op change for them.
 */
export async function postCashTransactionForExpense(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  expenseId: string;
  createdById: string;
}) {
  const { tx, businessId, expenseId, createdById } = params;
  const expense = await tx.expense.findUniqueOrThrow({ where: { id: expenseId } });

  const accountType = accountTypeForPaymentMethod(expense.paymentMethod);
  if (!accountType) return null;

  const account = await getOrCreateDefaultAccount(tx, businessId, accountType);
  const netCashOut = round2(Number(expense.amount) - Number(expense.withholdingTaxAmount));

  return postCashTransaction({
    tx,
    businessId,
    accountId: account.id,
    type: "PAYMENT",
    amount: -netCashOut,
    referenceType: "Expense",
    referenceId: expense.id,
    createdById,
    branchId: expense.branchId,
  });
}

/**
 * Integration point for the Payroll module (Module 10): call after marking
 * a Payroll run PAID. Always an outflow of the net salary – gross salary,
 * PAYE, and pension contributions are payroll's internal breakdown, but
 * only the net amount actually leaves a cash account.
 *
 * Module 29: now takes the branchId already snapshotted onto the Payroll
 * row (Employee.branchId at the time the run was last calculated) and
 * threads it through to the CashTransaction, the same way
 * postCashTransactionForExpense threads Expense.branchId above. A run
 * still attributed to no branch (employee never assigned one, or the run
 * predates this module) posts branch-null exactly as it always has –
 * that's a real answer here, not a gap.
 */
export async function postCashTransactionForPayroll(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  payrollId: string;
  netSalary: number;
  paymentMethod: PaymentMethod;
  createdById: string;
  branchId?: string | null;
}) {
  const { tx, businessId, payrollId, netSalary, paymentMethod, createdById, branchId } = params;

  const accountType = accountTypeForPaymentMethod(paymentMethod);
  if (!accountType) return null;

  const account = await getOrCreateDefaultAccount(tx, businessId, accountType);

  return postCashTransaction({
    tx,
    businessId,
    accountId: account.id,
    type: "PAYMENT",
    amount: -Math.abs(netSalary),
    referenceType: "Payroll",
    referenceId: payrollId,
    createdById,
    branchId: branchId ?? null,
  });
}

/**
 * Integration point for the Refunds module (Module 16): call after
 * creating a CASH-method Refund row. Direction is the mirror image of
 * postCashTransactionForPayment – a sale refund gives cash back to a
 * customer (money OUT), a purchase refund gets cash back from a supplier
 * (money IN) – since it's undoing the original transaction's cash
 * direction, not repeating it. Only ever called for RefundMethod.CASH;
 * CREDIT_NOTE and WRITE_OFF refunds never touch a real cash account.
 *
 * Module 27: branch is derived the same way postCashTransactionForPayment
 * does – from whichever Sale/Purchase this refund is against.
 */
export async function postCashTransactionForRefund(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  refundId: string;
  refundNumber: string;
  accountId: string;
  amount: number;
  kind: "SALE" | "PURCHASE";
  createdById: string;
}) {
  const { tx, businessId, refundId, refundNumber, accountId, amount, kind, createdById } = params;
  const isOutflow = kind === "SALE"; // giving a customer their money back

  const refund = await tx.refund.findUnique({ where: { id: refundId }, select: { saleId: true, purchaseId: true } });
  let branchId: string | null = null;
  if (refund?.saleId) {
    const sale = await tx.sale.findUnique({ where: { id: refund.saleId }, select: { branchId: true } });
    branchId = sale?.branchId ?? null;
  } else if (refund?.purchaseId) {
    const purchase = await tx.purchase.findUnique({ where: { id: refund.purchaseId }, select: { branchId: true } });
    branchId = purchase?.branchId ?? null;
  }

  return postCashTransaction({
    tx,
    businessId,
    accountId,
    type: isOutflow ? "PAYMENT" : "RECEIPT",
    amount: isOutflow ? -Math.abs(amount) : Math.abs(amount),
    referenceType: "Refund",
    referenceId: refundId,
    description: `Refund ${refundNumber}`,
    createdById,
    branchId,
  });
}

/**
 * Integration point for Credit Notes (Module 43): money going back to a customer for the part of a credit
 * they had already paid. Always an outflow. Only called when the note is settled in CASH; a credit note
 * that only reduces what the customer owes, or is kept as customer credit, moves no cash.
 *
 * Branch is the sale's branch, snapshotted onto the credit note by the caller (same derivation
 * postCashTransactionForRefund uses, minus the extra read: the credit note already carries it).
 */
export async function postCashTransactionForCreditNote(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  creditNoteId: string;
  creditNoteNumber: string;
  accountId: string;
  amount: number;
  branchId: string | null;
  createdById: string;
}) {
  const { tx, businessId, creditNoteId, creditNoteNumber, accountId, amount, branchId, createdById } = params;
  return postCashTransaction({
    tx,
    businessId,
    accountId,
    type: "PAYMENT",
    amount: -Math.abs(amount),
    referenceType: "CreditNote",
    referenceId: creditNoteId,
    description: `Credit note ${creditNoteNumber}`,
    createdById,
    branchId,
  });
}

/**
 * Integration point for Supplier Debit Notes (Module 44): money coming back from a supplier for
 * the part of a debit they had already been paid for. Always an inflow – the mirror image of
 * postCashTransactionForCreditNote's outflow, since a debit note is money coming FROM the supplier
 * TO us, not the other way around. Only called when the note is settled in CASH; a debit note that
 * only reduces what we owe the supplier, or is kept as supplier credit, moves no cash.
 *
 * Branch is the purchase's branch, snapshotted onto the debit note by the caller (same derivation
 * postCashTransactionForCreditNote uses).
 */
export async function postCashTransactionForDebitNote(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  debitNoteId: string;
  debitNoteNumber: string;
  accountId: string;
  amount: number;
  branchId: string | null;
  createdById: string;
}) {
  const { tx, businessId, debitNoteId, debitNoteNumber, accountId, amount, branchId, createdById } = params;
  return postCashTransaction({
    tx,
    businessId,
    accountId,
    type: "RECEIPT",
    amount: Math.abs(amount),
    referenceType: "SupplierDebitNote",
    referenceId: debitNoteId,
    description: `Debit note ${debitNoteNumber}`,
    createdById,
    branchId,
  });
}

/**
 * Integration point for the Fixed Assets module (Module 21): call after
 * creating a FixedAsset row. Always an outflow, same shape as
 * postCashTransactionForExpense minus the withholding-tax split (fixed
 * asset acquisitions don't carry one). CREDIT is rejected before this is
 * ever called (see the KNOWN LIMITATION on FixedAsset.paymentMethod).
 *
 * Module 27: branch is read straight off the just-created FixedAsset row
 * (which already carries branchId as of Module 21).
 */
export async function postCashTransactionForFixedAsset(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  assetId: string;
  cost: number;
  paymentMethod: PaymentMethod;
  createdById: string;
}) {
  const { tx, businessId, assetId, cost, paymentMethod, createdById } = params;

  const accountType = accountTypeForPaymentMethod(paymentMethod);
  if (!accountType) return null;

  const account = await getOrCreateDefaultAccount(tx, businessId, accountType);
  const asset = await tx.fixedAsset.findUnique({ where: { id: assetId }, select: { branchId: true } });

  return postCashTransaction({
    tx,
    businessId,
    accountId: account.id,
    type: "PAYMENT",
    amount: -Math.abs(cost),
    referenceType: "FixedAssetAcquisition",
    referenceId: assetId,
    createdById,
    branchId: asset?.branchId ?? null,
  });
}

/**
 * Integration point for the Fixed Assets module (Module 21): call after
 * recording a disposal with proceeds > 0. Mirrors
 * postCashTransactionForRefund's shape (operator picks a real CashAccount,
 * not a PaymentMethod, since a disposal isn't tied to one of the four
 * standard channels the way a Sale/Expense is). Only called when proceeds
 * are actually received – a scrapped asset with nothing recovered never
 * calls this.
 */
export async function postCashTransactionForFixedAssetDisposal(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  assetId: string;
  accountId: string;
  proceeds: number;
  createdById: string;
}) {
  const { tx, businessId, assetId, accountId, proceeds, createdById } = params;
  const asset = await tx.fixedAsset.findUnique({ where: { id: assetId }, select: { branchId: true } });

  return postCashTransaction({
    tx,
    businessId,
    accountId,
    type: "RECEIPT",
    amount: Math.abs(proceeds),
    referenceType: "FixedAssetDisposal",
    referenceId: assetId,
    createdById,
    branchId: asset?.branchId ?? null,
  });
}

/**
 * Integration point for the Bank Reconciliation module (Module 22): posts
 * the book-side entry for a statement line that's on the bank statement
 * but was never recorded (a charge, a fee, interest earned). `amount` is
 * signed the same way every CashTransaction.amount is – negative = money
 * left the account, positive = money arrived – so this is a direct,
 * un-transformed post of what the bank statement line says.
 *
 * Module 27: posts branch-null – a bank charge or interest line is a
 * whole-account event (the bank doesn't attribute its own fees to one
 * branch's activity), not something to guess a branch for.
 */
export async function postCashTransactionForBankReconciliationAdjustment(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  accountId: string;
  lineId: string;
  amount: number; // signed
  description: string;
  createdById: string;
}) {
  const { tx, businessId, accountId, lineId, amount, description, createdById } = params;

  return postCashTransaction({
    tx,
    businessId,
    accountId,
    type: "ADJUSTMENT",
    amount,
    referenceType: "BankReconciliationAdjustment",
    referenceId: lineId,
    description,
    createdById,
  });
}

/**
 * Integration point for the Tax Payments module (Module 33): posts the cash
 * movement on a CashAccount when a tax remittance to (or, since Module 46, a
 * refund from) the MRA is recorded. `amount` is always a positive number –
 * the TOTAL cash paid (tax + any penalty/interest) for a remittance, or the
 * refund received for a refund; this function applies the sign.
 *
 * Mirrors postCashTransactionForRefund's shape: the operator picks a real
 * CashAccount, not a PaymentMethod, since a tax payment isn't tied to one of
 * the standard sale/expense channels. Posts branch-null on purpose – an
 * MRA tax is owed by the taxpayer, not by a branch (see the TaxPayment
 * model comment), the same "not one branch's activity" reasoning transfers
 * and bank-reconciliation adjustments already use.
 *
 * Voiding a payment reverses this through reverseCashTransactionsForReference
 * with referenceType "TaxPayment".
 */
export async function postCashTransactionForTaxPayment(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  paymentId: string;
  accountId: string;
  amount: number;
  isRefund?: boolean; // Module 46: true = money coming IN from the MRA
  description: string;
  createdById: string;
}) {
  const { tx, businessId, paymentId, accountId, amount, isRefund, description, createdById } = params;

  return postCashTransaction({
    tx,
    businessId,
    accountId,
    type: isRefund ? "RECEIPT" : "PAYMENT",
    amount: isRefund ? Math.abs(amount) : -Math.abs(amount),
    referenceType: "TaxPayment",
    referenceId: paymentId,
    description,
    createdById,
  });
}

/**
 * Integration point for Foreign Exchange Gains & Losses (Module 39): moves the
 * carrying value of ONE CashAccount by a signed amount (+ gain, − loss) so the
 * cashbook agrees with the GL entry postJournalEntryForForeignExchangeAdjustment
 * makes in the same transaction. Posted as an ADJUSTMENT with its own
 * referenceType so that:
 *   - src/lib/financial-statements.ts::getCashFlowStatement can pick it out and
 *     show it as "Effect of exchange rate changes" instead of counting it as
 *     operating cash (it is a revaluation, no cash moved), and
 *   - voiding reverses it through reverseCashTransactionsForReference.
 * Branch-null on purpose – see the ForeignExchangeAdjustment model comment.
 */
export async function postCashTransactionForForeignExchangeAdjustment(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  adjustmentId: string;
  accountId: string;
  signedAmount: number;
  description: string;
  createdById: string;
}) {
  const { tx, businessId, adjustmentId, accountId, signedAmount, description, createdById } = params;

  return postCashTransaction({
    tx,
    businessId,
    accountId,
    type: "ADJUSTMENT",
    amount: signedAmount,
    referenceType: "ForeignExchangeAdjustment",
    referenceId: adjustmentId,
    description,
    createdById,
  });
}

export class CashbookError extends Error {}

/**
 * Posts an equal-and-opposite ADJUSTMENT for every CashTransaction tied to
 * a given reference (referenceType + referenceId) – e.g. all the entries an
 * Expense posted. Used when the underlying record is edited or deleted, so
 * the ledger doesn't keep a stale entry around. Does NOT delete the
 * original CashTransaction rows – they stay as history; the ADJUSTMENT
 * rows explain why the balance changed back.
 *
 * Module 27: each reversal carries the SAME branchId as the entry it's
 * reversing (not re-derived from the, possibly already-changed, source
 * record) – a branch's cashbook activity should net back to zero for a
 * fully-reversed reference, not silently move to "unattributed".
 */
export async function reverseCashTransactionsForReference(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  referenceType: string;
  referenceId: string;
  createdById: string;
  reason: string;
}) {
  const { tx, businessId, referenceType, referenceId, createdById, reason } = params;

  const original = await tx.cashTransaction.findMany({ where: { businessId, referenceType, referenceId } });
  const reversals = [];

  for (const entry of original) {
    const reversal = await postCashTransaction({
      tx,
      businessId,
      accountId: entry.accountId,
      type: "ADJUSTMENT",
      amount: -Number(entry.amount), // exact opposite of what was posted
      referenceType,
      referenceId,
      description: reason,
      createdById,
      branchId: entry.branchId,
    });
    reversals.push(reversal);
  }

  return reversals;
}

// Module 27: transfers post branch-null on both legs – moving money
// between a business's own accounts isn't one branch's activity, even when
// initiated by a branch-restricted user, so nothing is guessed here.
export async function transferBetweenAccounts(params: {
  businessId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  description?: string;
  createdById: string;
}) {
  const { businessId, fromAccountId, toAccountId, amount, description, createdById } = params;

  if (fromAccountId === toAccountId) {
    throw new CashbookError("Cannot transfer an account to itself.");
  }
  if (amount <= 0) {
    throw new CashbookError("Transfer amount must be greater than zero.");
  }

  return prisma.$transaction(async (tx) => {
    const [fromAccount, toAccount] = await Promise.all([
      tx.cashAccount.findUnique({ where: { id: fromAccountId } }),
      tx.cashAccount.findUnique({ where: { id: toAccountId } }),
    ]);

    if (!fromAccount || fromAccount.businessId !== businessId) {
      throw new CashbookError("Source account not found in this business.");
    }
    if (!toAccount || toAccount.businessId !== businessId) {
      throw new CashbookError("Destination account not found in this business.");
    }

    const fromBalance = await getAccountBalance(fromAccountId);
    if (fromBalance < amount) {
      throw new CashbookError(
        `Insufficient balance in ${fromAccount.name}: has MWK ${fromBalance.toLocaleString()}, tried to transfer MWK ${amount.toLocaleString()}.`
      );
    }

    const outTxn = await postCashTransaction({
      tx,
      businessId,
      accountId: fromAccountId,
      type: "TRANSFER_OUT",
      amount: -amount,
      relatedAccountId: toAccountId,
      referenceType: "Transfer",
      description,
      createdById,
    });

    const inTxn = await postCashTransaction({
      tx,
      businessId,
      accountId: toAccountId,
      type: "TRANSFER_IN",
      amount,
      relatedAccountId: fromAccountId,
      referenceType: "Transfer",
      referenceId: outTxn.id,
      description,
      createdById,
    });

    await postJournalEntryForTransfer({
      tx,
      businessId,
      fromCashType: fromAccount.type,
      toCashType: toAccount.type,
      amount,
      description: description ?? `Transfer: ${fromAccount.name} → ${toAccount.name}`,
      createdById,
    });

    return { outTxn, inTxn };
  });
}

export async function getCashbookSummary(businessId: string) {
  const accounts = await prisma.cashAccount.findMany({ where: { businessId, isActive: true } });

  const balances = await Promise.all(
    accounts.map(async (a) => ({
      accountId: a.id,
      name: a.name,
      type: a.type,
      openingBalance: Number(a.openingBalance),
      balance: await getAccountBalance(a.id),
    }))
  );

  const totalBalance = round2(balances.reduce((sum, b) => sum + b.balance, 0));

  return { accounts: balances, totalBalance };
}
