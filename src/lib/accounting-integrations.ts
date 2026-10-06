import { Prisma } from "@prisma/client";
import { buildSettlementJournalLines, cashAmountForPayment } from "./fx-calc";
import { postJournalEntry, getSystemAccountId, getOrCreateSystemAccountId, reverseJournalEntriesForReference } from "./accounting";
import { CASH_ACCOUNT_KEYS, getExpenseAccountKey, accountTypeForPaymentMethod } from "./chart-of-accounts";
import { buildFxJournalLines } from "./fx-calc";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** PaymentMethod -> GL system account key, reusing Cashbook's channel mapping (CARD settles to BANK, CREDIT moves no cash). */
async function cashAccountIdForMethod(
  tx: Prisma.TransactionClient,
  businessId: string,
  method: string
): Promise<string | null> {
  const cashType = accountTypeForPaymentMethod(method as any);
  if (!cashType) return null; // CREDIT
  const systemKey = CASH_ACCOUNT_KEYS[cashType];
  return getSystemAccountId(tx, businessId, systemKey);
}

/**
 * Sale posting – split into two independently-balanced entries so voiding
 * can reverse only the inventory effect (stock really does come back)
 * while leaving revenue and any cash already collected standing, matching
 * what src/lib/sales.ts::voidSale already does to inventory vs. cash (see
 * that function's "KNOWN GAP" comment – this mirrors it rather than
 * pretending accounting can undo money the Cashbook doesn't).
 *
 *   Entry 1 "SaleRevenue": Dr Accounts Receivable (total) / Cr Sales Revenue (total - vat) / Cr VAT Output Payable (vat)
 *   Entry 2 "SaleCOGS":    Dr COGS (cost) / Cr Inventory (cost)
 *
 * The initial payment (if any) is posted separately via
 * postJournalEntryForPayment – the same function used for every later debt
 * payment, so there's exactly one code path for "a customer paid us."
 *
 * Module 18 (VAT): `vatAmount` (0 for a non-VAT-registered business, or any
 * sale made entirely of ZERO_RATED/EXEMPT lines) carves the output VAT
 * portion of `total` out of Sales Revenue and into VAT_OUTPUT_PAYABLE – a
 * liability owed to the MRA, not the business's own revenue. Uses
 * getOrCreateSystemAccountId, not getSystemAccountId, since a business that
 * registered before this module existed won't have this account yet (same
 * backfill pattern Module 16 used for CUSTOMER_CREDITS_PAYABLE).
 */
export async function postJournalEntryForSale(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  saleId: string;
  saleNumber: string;
  total: number;
  vatAmount?: number;
  /** Cost of the goods sold (credited to Inventory). */
  cost: number;
  /** Module 78: cost of the services sold (credited to Service Cost Clearing). Included in neither `cost` nor revenue. */
  serviceCost?: number;
  createdById: string;
}) {
  const { tx, businessId, saleId, saleNumber, total, cost, createdById } = params;
  const vatAmount = round2(params.vatAmount ?? 0);
  const serviceCost = round2(params.serviceCost ?? 0);

  const [arAccountId, revenueAccountId] = await Promise.all([
    getSystemAccountId(tx, businessId, "ACCOUNTS_RECEIVABLE"),
    getSystemAccountId(tx, businessId, "SALES_REVENUE"),
  ]);

  const revenueLines: { accountId: string; debit?: number; credit?: number }[] = [{ accountId: arAccountId, debit: total }];
  const revenueNetOfVat = round2(total - vatAmount);
  if (revenueNetOfVat > 0) revenueLines.push({ accountId: revenueAccountId, credit: revenueNetOfVat });
  if (vatAmount > 0) {
    const vatOutputAccountId = await getOrCreateSystemAccountId(tx, businessId, "VAT_OUTPUT_PAYABLE");
    revenueLines.push({ accountId: vatOutputAccountId, credit: vatAmount });
  }

  await postJournalEntry({
    tx,
    businessId,
    description: `Sale ${saleNumber}`,
    lines: revenueLines,
    referenceType: "SaleRevenue",
    referenceId: saleId,
    createdById,
  });

  if (cost > 0 || serviceCost > 0) {
    const cogsAccountId = await getSystemAccountId(tx, businessId, "COST_OF_GOODS_SOLD");
    const cogsLines: { accountId: string; debit?: number; credit?: number }[] = [
      { accountId: cogsAccountId, debit: round2(cost + serviceCost) },
    ];
    if (cost > 0) cogsLines.push({ accountId: await getSystemAccountId(tx, businessId, "INVENTORY"), credit: cost });
    if (serviceCost > 0) {
      cogsLines.push({ accountId: await getOrCreateSystemAccountId(tx, businessId, "SERVICE_COST_CLEARING"), credit: serviceCost });
    }

    await postJournalEntry({
      tx,
      businessId,
      description: `Cost of goods sold – Sale ${saleNumber}`,
      lines: cogsLines,
      referenceType: "SaleCOGS",
      referenceId: saleId,
      createdById,
    });
  }
}

/** Reverses only the COGS/Inventory entry for a voided sale – see the comment on postJournalEntryForSale. */
export async function reverseJournalEntryForVoidedSale(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  saleId: string;
  saleNumber: string;
  createdById: string;
}) {
  await reverseJournalEntriesForReference({
    tx: params.tx,
    businessId: params.businessId,
    referenceType: "SaleCOGS",
    referenceId: params.saleId,
    createdById: params.createdById,
    reason: `Sale ${params.saleNumber} voided – inventory restored`,
  });
}

/**
 * Purchase posting – same split-entry pattern as Sales, for the same
 * reason: voiding restores inventory but not cash (see
 * src/lib/purchases.ts::voidPurchase).
 *
 *   Entry "PurchaseInventory": Dr Inventory (total - vat) / Dr VAT Input Receivable (vat) / Cr Accounts Payable (total)
 *
 * The initial payment (if any) posts via postJournalEntryForPayment, same
 * as Sales.
 *
 * Module 18 (VAT): mirrors postJournalEntryForSale's split above, on the
 * debit side instead – input VAT isn't part of the inventory's cost basis,
 * it's a reclaimable asset. Same getOrCreateSystemAccountId backfill
 * reasoning as the Sale side.
 */
export async function postJournalEntryForPurchase(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  purchaseId: string;
  purchaseNumber: string;
  total: number;
  vatAmount?: number;
  /** Module 78: net (VAT excluded) cost of service lines. Debited to Service Cost Clearing instead of Inventory. */
  serviceNet?: number;
  createdById: string;
}) {
  const { tx, businessId, purchaseId, purchaseNumber, total, createdById } = params;
  const vatAmount = round2(params.vatAmount ?? 0);
  const serviceNet = round2(params.serviceNet ?? 0);

  const [inventoryAccountId, apAccountId] = await Promise.all([
    getSystemAccountId(tx, businessId, "INVENTORY"),
    getSystemAccountId(tx, businessId, "ACCOUNTS_PAYABLE"),
  ]);

  const netOfVat = round2(total - vatAmount);
  const inventoryNetOfVat = round2(netOfVat - serviceNet);
  const lines: { accountId: string; debit?: number; credit?: number }[] = [];
  if (inventoryNetOfVat > 0) lines.push({ accountId: inventoryAccountId, debit: inventoryNetOfVat });
  if (serviceNet > 0) {
    lines.push({ accountId: await getOrCreateSystemAccountId(tx, businessId, "SERVICE_COST_CLEARING"), debit: serviceNet });
  }
  if (vatAmount > 0) {
    const vatInputAccountId = await getOrCreateSystemAccountId(tx, businessId, "VAT_INPUT_RECEIVABLE");
    lines.push({ accountId: vatInputAccountId, debit: vatAmount });
  }
  lines.push({ accountId: apAccountId, credit: total });

  await postJournalEntry({
    tx,
    businessId,
    description: `Purchase ${purchaseNumber}`,
    lines,
    referenceType: "PurchaseInventory",
    referenceId: purchaseId,
    createdById,
  });
}

export async function reverseJournalEntryForVoidedPurchase(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  purchaseId: string;
  purchaseNumber: string;
  createdById: string;
}) {
  await reverseJournalEntriesForReference({
    tx: params.tx,
    businessId: params.businessId,
    referenceType: "PurchaseInventory",
    referenceId: params.purchaseId,
    createdById: params.createdById,
    reason: `Purchase ${params.purchaseNumber} voided – inventory reversed`,
  });
}

/**
 * THE single posting point for every Payment row, customer-side or
 * supplier-side – mirrors src/lib/cashbook.ts::postCashTransactionForPayment
 * exactly, including being called from the same set of integration points
 * (Sales/Purchases' initial payment, the FIFO debt-allocation loops, and
 * the shared /payments route's direct branches). Direction is inferred by
 * the caller (isCustomerSide), matching the same inspection logic
 * postCashTransactionForPayment already does on the Payment row.
 *
 *   Customer-side (we received money):  Dr Cash/Bank / Cr Accounts Receivable
 *   Supplier-side (we paid money out):  Dr Accounts Payable / Cr Cash/Bank
 *
 * Silently does nothing for PaymentMethod.CREDIT, same as the Cashbook
 * integration – no cash moved, nothing to post.
 */
export async function postJournalEntryForPayment(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  paymentId: string;
  amount: number;
  method: string;
  isCustomerSide: boolean;
  createdById: string;
  /**
   * Module 40: signed exchange difference (+ gain / - loss) on a foreign-currency
   * settlement. `amount` stays the kwacha cleared off the document; the cash leg
   * becomes amount +/- this and the difference posts to FOREIGN_EXCHANGE_GAIN_LOSS.
   * Omitted/0 = the original two-line entry, unchanged.
   */
  fxGainLoss?: number;
}) {
  const { tx, businessId, paymentId, amount, method, isCustomerSide, createdById } = params;
  const fxGainLoss = params.fxGainLoss ?? 0;

  const cashAccountId = await cashAccountIdForMethod(tx, businessId, method);
  if (!cashAccountId) return null; // CREDIT – no cash moved, nothing to post

  const otherAccountId = await getSystemAccountId(
    tx,
    businessId,
    isCustomerSide ? "ACCOUNTS_RECEIVABLE" : "ACCOUNTS_PAYABLE"
  );

  if (fxGainLoss !== 0) {
    const fxAccountId = await getOrCreateSystemAccountId(tx, businessId, "FOREIGN_EXCHANGE_GAIN_LOSS");
    const side = isCustomerSide ? "RECEIVE" : "PAY";
    return postJournalEntry({
      tx,
      businessId,
      description: `${isCustomerSide ? "Payment received" : "Payment made"} – exchange ${fxGainLoss > 0 ? "gain" : "loss"} on settlement`,
      lines: buildSettlementJournalLines({
        side,
        cashGlAccountId: cashAccountId,
        controlAccountId: otherAccountId,
        fxAccountId,
        bookAmount: amount,
        cashAmount: cashAmountForPayment(amount, fxGainLoss, side),
        gainLoss: fxGainLoss,
      }),
      referenceType: "Payment",
      referenceId: paymentId,
      createdById,
    });
  }

  return postJournalEntry({
    tx,
    businessId,
    description: isCustomerSide ? "Payment received" : "Payment made",
    lines: isCustomerSide
      ? [{ accountId: cashAccountId, debit: amount }, { accountId: otherAccountId, credit: amount }]
      : [{ accountId: otherAccountId, debit: amount }, { accountId: cashAccountId, credit: amount }],
    referenceType: "Payment",
    referenceId: paymentId,
    createdById,
  });
}

/**
 * Expense posting – a single balanced entry, reversed and reposted on edit
 * (mirrors src/lib/cashbook.ts's Expense integration exactly, including
 * being called from the same three route handlers: create, update, delete).
 */
/**
 * Module 19 (Withholding Tax): when withholdingTaxAmount > 0, the gross
 * Expense amount splits three ways instead of the plain Dr Expense/Cr Cash
 * pair – Dr Expense (full gross, same as always: withholding tax doesn't
 * change what the business is expensing), Cr Cash (only the net amount
 * that actually reached the payee), Cr WITHHOLDING_TAX_PAYABLE (the
 * withheld portion, held for the MRA). Balances by construction since
 * netCash + withholdingTaxAmount = amount. Mirrors how
 * postJournalEntryForSale splits VAT out of the AR debit in Module 18.
 */
export async function postJournalEntryForExpense(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  expenseId: string;
  category: string;
  amount: number;
  withholdingTaxAmount?: number;
  paymentMethod: string;
  createdById: string;
}) {
  const { tx, businessId, expenseId, category, amount, paymentMethod, createdById } = params;
  const withholdingTaxAmount = round2(params.withholdingTaxAmount ?? 0);

  const cashAccountId = await cashAccountIdForMethod(tx, businessId, paymentMethod);
  if (!cashAccountId) return null; // CREDIT

  const expenseAccountId = await getSystemAccountId(tx, businessId, getExpenseAccountKey(category));
  const netCash = round2(amount - withholdingTaxAmount);

  const lines: { accountId: string; debit?: number; credit?: number }[] = [{ accountId: expenseAccountId, debit: amount }];
  if (netCash > 0) lines.push({ accountId: cashAccountId, credit: netCash });
  if (withholdingTaxAmount > 0) {
    const withholdingPayableId = await getOrCreateSystemAccountId(tx, businessId, "WITHHOLDING_TAX_PAYABLE");
    lines.push({ accountId: withholdingPayableId, credit: withholdingTaxAmount });
  }

  return postJournalEntry({
    tx,
    businessId,
    description: "Expense",
    lines,
    referenceType: "Expense",
    referenceId: expenseId,
    createdById,
  });
}

export async function reverseJournalEntriesForExpense(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  expenseId: string;
  createdById: string;
  reason: string;
}) {
  await reverseJournalEntriesForReference({
    tx: params.tx,
    businessId: params.businessId,
    referenceType: "Expense",
    referenceId: params.expenseId,
    createdById: params.createdById,
    reason: params.reason,
  });
}

/**
 * Payroll posting – one entry per paid run. Balances by construction: see
 * the netSalary derivation in src/lib/payroll.ts – netSalary =
 * gross+allowances-paye-pensionEmployee-otherDeductions, so
 * Dr(gross+allowances) always equals Cr(paye+pensionEmployee+
 * otherDeductions+netSalary). Employer pension is a separate additional
 * cost+liability pair, not part of that identity.
 */
export async function postJournalEntryForPayroll(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  payrollId: string;
  payPeriod: string;
  employeeName: string;
  grossSalary: number;
  allowances: number;
  paye: number;
  pensionEmployee: number;
  pensionEmployer: number;
  otherDeductions: number;
  netSalary: number;
  paymentMethod: string;
  createdById: string;
}) {
  const { tx, businessId, payrollId, payPeriod, employeeName, createdById } = params;

  const cashAccountId = await cashAccountIdForMethod(tx, businessId, params.paymentMethod);
  if (!cashAccountId) {
    throw new Error("Payroll must be paid via a real cash method, not CREDIT.");
  }

  const [salaryExpenseId, pensionExpenseId, payeAccountId, pensionPayableId, otherDeductionsPayableId] =
    await Promise.all([
      getSystemAccountId(tx, businessId, "SALARY_EXPENSE"),
      getSystemAccountId(tx, businessId, "PENSION_EXPENSE"),
      getSystemAccountId(tx, businessId, "PAYE_PAYABLE"),
      getSystemAccountId(tx, businessId, "PENSION_PAYABLE"),
      getSystemAccountId(tx, businessId, "OTHER_DEDUCTIONS_PAYABLE"),
    ]);

  const lines = [
    { accountId: salaryExpenseId, debit: round2(params.grossSalary + params.allowances) },
    ...(params.pensionEmployer > 0 ? [{ accountId: pensionExpenseId, debit: params.pensionEmployer }] : []),
    ...(params.paye > 0 ? [{ accountId: payeAccountId, credit: params.paye }] : []),
    ...(params.pensionEmployee + params.pensionEmployer > 0
      ? [{ accountId: pensionPayableId, credit: round2(params.pensionEmployee + params.pensionEmployer) }]
      : []),
    ...(params.otherDeductions > 0 ? [{ accountId: otherDeductionsPayableId, credit: params.otherDeductions }] : []),
    { accountId: cashAccountId, credit: params.netSalary },
  ];

  return postJournalEntry({
    tx,
    businessId,
    description: `Payroll ${payPeriod} – ${employeeName}`,
    lines,
    referenceType: "Payroll",
    referenceId: payrollId,
    createdById,
  });
}

/**
 * Refund posting (Module 16; VAT apportionment added Module 32) – the GL
 * half of closing the gap left open by voidSale/voidPurchase. What this
 * reverses depends on what void already left standing:
 *
 *   - A voided Sale still has its full Revenue AND its VAT_OUTPUT_PAYABLE
 *     recognized – postJournalEntryForSale splits the sale into two
 *     independently-balanced entries ("SaleRevenue" and "SaleCOGS")
 *     specifically so voiding can reverse only the "SaleCOGS" (inventory)
 *     entry, leaving "SaleRevenue" (Revenue + VAT_OUTPUT_PAYABLE) standing.
 *     So a sale refund must itself carve the VAT portion back out of
 *     VAT_OUTPUT_PAYABLE – see vatAmount below – rather than debiting
 *     SALES_REVENUE for the whole thing. No separate "Sales Returns"
 *     account is needed; debiting a credit-normal account just reduces the
 *     balance getAccountBalance() reports, which is exactly a revenue (or
 *     VAT liability) reduction.
 *   - A voided Purchase is different: postJournalEntryForPurchase posts
 *     Inventory + VAT_INPUT_RECEIVABLE + Accounts Payable as ONE combined
 *     entry ("PurchaseInventory"), and reverseJournalEntryForVoidedPurchase
 *     reverses that entry in full – so a voided purchase's VAT input has
 *     already been fully unwound by the time a refund happens, with
 *     nothing left standing to carve out. What's left is only the residual
 *     AP debit balance created by whatever cash was paid before voiding
 *     (posted separately via postJournalEntryForPayment) – the books
 *     already show the supplier owing that back. A purchase refund clears
 *     that residual by crediting ACCOUNTS_PAYABLE for the whole refunded
 *     amount; there's no VAT split on this side (Module 32 confirmed this
 *     by tracing what void already reverses, rather than assuming the two
 *     sides are symmetric).
 *
 *   CASH:        Sale → Dr Revenue (net) + Dr VAT Output Payable (vat) / Cr Cash.
 *                Purchase → Dr Cash / Cr AP.
 *   CREDIT_NOTE: Sale → Dr Revenue (net) + Dr VAT Output Payable (vat) / Cr Customer Credits Payable (liability, gross).
 *                Purchase → Dr Supplier Credits Receivable (asset) / Cr AP.
 *   WRITE_OFF:   No entry – a deliberate decision that void's existing
 *                postings should simply stand as-is. See the KNOWN
 *                LIMITATION note in src/lib/refunds.ts for what this means
 *                for the books in that case.
 *
 * vatAmount (Module 32) is the caller-computed VAT portion of this specific
 * refund – src/lib/refunds.ts apportions it from the original Sale's own
 * `tax`/`total` in proportion to how much of the sale is being refunded, so
 * a partial refund (or several refunds against the same sale) only ever
 * carves out its own fair share, never more than the sale's actual
 * `SaleItem.vatAmount` sum. Only meaningful for kind SALE – ignored for
 * PURCHASE per the reasoning above. Always 0 for a non-VAT sale.
 *
 * cashAccountType is required (and only meaningful) for CASH – it's the
 * real CashAccount the operator picked, translated to its GL account via
 * the same CASH_ACCOUNT_KEYS mapping the Cashbook integration uses.
 */
export async function postJournalEntryForRefund(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  refundId: string;
  refundNumber: string;
  kind: "SALE" | "PURCHASE";
  method: "CASH" | "CREDIT_NOTE" | "WRITE_OFF";
  amount: number;
  vatAmount?: number; // Module 32 – SALE only, see doc comment above
  cashAccountType?: string; // a CashAccountType – required when method is CASH
  createdById: string;
}) {
  const { tx, businessId, refundId, refundNumber, kind, method, amount, createdById } = params;

  if (method === "WRITE_OFF") return null; // deliberately no GL impact – see the doc comment above

  if (kind === "SALE") {
    const vatAmount = round2(params.vatAmount ?? 0);
    const revenueNetOfVat = round2(amount - vatAmount);

    const revenueAccountId = await getSystemAccountId(tx, businessId, "SALES_REVENUE");
    const creditAccountId =
      method === "CASH"
        ? await getSystemAccountId(tx, businessId, CASH_ACCOUNT_KEYS[params.cashAccountType!])
        : await getOrCreateSystemAccountId(tx, businessId, "CUSTOMER_CREDITS_PAYABLE");

    const lines: { accountId: string; debit?: number; credit?: number }[] = [];
    if (revenueNetOfVat > 0) lines.push({ accountId: revenueAccountId, debit: revenueNetOfVat });
    if (vatAmount > 0) {
      // getSystemAccountId (not getOrCreateSystemAccountId): a refund with a
      // real vatAmount can only exist against a sale that itself posted VAT
      // at creation time (postJournalEntryForSale), which already
      // backfilled this account if needed – it's a bug, not a legitimate
      // backfill case, if it's missing now.
      const vatOutputAccountId = await getSystemAccountId(tx, businessId, "VAT_OUTPUT_PAYABLE");
      lines.push({ accountId: vatOutputAccountId, debit: vatAmount });
    }
    lines.push({ accountId: creditAccountId, credit: amount });

    return postJournalEntry({
      tx,
      businessId,
      description: `Refund ${refundNumber}`,
      lines,
      referenceType: "Refund",
      referenceId: refundId,
      createdById,
    });
  }

  // kind === "PURCHASE"
  const apAccountId = await getSystemAccountId(tx, businessId, "ACCOUNTS_PAYABLE");
  const debitAccountId =
    method === "CASH"
      ? await getSystemAccountId(tx, businessId, CASH_ACCOUNT_KEYS[params.cashAccountType!])
      : await getOrCreateSystemAccountId(tx, businessId, "SUPPLIER_CREDITS_RECEIVABLE");

  return postJournalEntry({
    tx,
    businessId,
    description: `Refund ${refundNumber}`,
    lines: [
      { accountId: debitAccountId, debit: amount },
      { accountId: apAccountId, credit: amount },
    ],
    referenceType: "Refund",
    referenceId: refundId,
    createdById,
  });
}

/**
 * Credit note posting (Module 43): the ledger half of giving part of a sale back to the customer. Two
 * independently balanced entries, the same split the sale itself uses, both dated NOW (never an explicit
 * date, so Module 42's closed-period check can never refuse them):
 *
 *   Entry "CreditNote":     Dr Sales Revenue (net, after the sale-discount share)
 *                           Dr VAT Output Payable (vat)
 *                           Cr Accounts Receivable (appliedToBalance: the part the customer still owed)
 *                           Cr Cash/Bank/Mobile money (settledAmount, when settled in CASH)
 *                             OR Cr Customer Credits Payable (settledAmount, when kept as CUSTOMER_CREDIT)
 *   Entry "CreditNoteCOGS": Dr Inventory / Cr Cost of Goods Sold (only for restocked units)
 *
 * Revenue and VAT are debited directly on the same accounts the sale credited, as postJournalEntryForRefund
 * does (Module 32), so the Profit and Loss and the VAT liability both fall in the period of the credit
 * note. The credit side always sums to the debit side because settledAmount = total - appliedToBalance.
 *
 * The VAT account is looked up with getSystemAccountId (throws), not getOrCreate...: a credit note with VAT
 * can only exist against a sale that already posted VAT, which created the account.
 */
export async function postJournalEntryForCreditNote(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  creditNoteId: string;
  creditNoteNumber: string;
  saleNumber: string;
  revenue: number;
  vatAmount: number;
  appliedToBalance: number;
  settledAmount: number;
  settlement: "NONE" | "CASH" | "CUSTOMER_CREDIT";
  cashAccountType?: string; // a CashAccountType, required when settlement is CASH
  costRestored: number;
  createdById: string;
}) {
  const { tx, businessId, creditNoteId, creditNoteNumber, saleNumber, createdById } = params;
  const revenue = round2(params.revenue);
  const vatAmount = round2(params.vatAmount);
  const applied = round2(params.appliedToBalance);
  const settled = round2(params.settledAmount);

  const lines: { accountId: string; debit?: number; credit?: number }[] = [];
  if (revenue > 0) lines.push({ accountId: await getSystemAccountId(tx, businessId, "SALES_REVENUE"), debit: revenue });
  if (vatAmount > 0) lines.push({ accountId: await getSystemAccountId(tx, businessId, "VAT_OUTPUT_PAYABLE"), debit: vatAmount });
  if (applied > 0) lines.push({ accountId: await getSystemAccountId(tx, businessId, "ACCOUNTS_RECEIVABLE"), credit: applied });
  if (settled > 0) {
    const accountId =
      params.settlement === "CASH"
        ? await getSystemAccountId(tx, businessId, CASH_ACCOUNT_KEYS[params.cashAccountType!])
        : await getOrCreateSystemAccountId(tx, businessId, "CUSTOMER_CREDITS_PAYABLE");
    lines.push({ accountId, credit: settled });
  }

  const entry = await postJournalEntry({
    tx,
    businessId,
    description: `Credit note ${creditNoteNumber} – Sale ${saleNumber}`,
    lines,
    referenceType: "CreditNote",
    referenceId: creditNoteId,
    createdById,
  });

  const cost = round2(params.costRestored);
  if (cost > 0) {
    const [inventoryAccountId, cogsAccountId] = await Promise.all([
      getSystemAccountId(tx, businessId, "INVENTORY"),
      getSystemAccountId(tx, businessId, "COST_OF_GOODS_SOLD"),
    ]);
    await postJournalEntry({
      tx,
      businessId,
      description: `Cost of goods returned – credit note ${creditNoteNumber}`,
      lines: [
        { accountId: inventoryAccountId, debit: cost },
        { accountId: cogsAccountId, credit: cost },
      ],
      referenceType: "CreditNoteCOGS",
      referenceId: creditNoteId,
      createdById,
    });
  }

  return entry;
}

/**
 * Supplier debit note posting (Module 44): the ledger half of giving part of a purchase back to the
 * supplier. ONE entry – unlike postJournalEntryForCreditNote's two-entry split – because Purchase
 * itself posts as one combined entry (see postJournalEntryForPurchase above) with only one asset
 * account (Inventory) on the debit side; there's no separate COGS account to split out the way Sale
 * splits Revenue from Inventory/COGS. Dated NOW (never an explicit date), so Module 42's closed-
 * period check can never refuse it:
 *
 *   Entry "SupplierDebitNote": Cr Inventory (netAmount)
 *                              Cr VAT Input Receivable (vatAmount)
 *                              Dr Accounts Payable (appliedToBalance: the part we still owed)
 *                              Dr Cash/Bank/Mobile money (settledAmount, when settled in CASH)
 *                                OR Dr Supplier Credits Receivable (settledAmount, when kept as SUPPLIER_CREDIT)
 *
 * The credit side always sums to the debit side because settledAmount = total - appliedToBalance.
 * The VAT account is looked up with getSystemAccountId (throws), not getOrCreate...: a debit note
 * with VAT can only exist against a purchase that already posted VAT input, which created the
 * account – same reasoning postJournalEntryForCreditNote uses on the sale side.
 */
export async function postJournalEntryForDebitNote(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  debitNoteId: string;
  debitNoteNumber: string;
  purchaseNumber: string;
  netAmount: number;
  /** Module 78: the part of netAmount taken from service lines. Credited to Service Cost Clearing, not Inventory. */
  serviceNetAmount?: number;
  vatAmount: number;
  appliedToBalance: number;
  settledAmount: number;
  settlement: "NONE" | "CASH" | "SUPPLIER_CREDIT";
  cashAccountType?: string; // a CashAccountType, required when settlement is CASH
  createdById: string;
}) {
  const { tx, businessId, debitNoteId, debitNoteNumber, purchaseNumber, createdById } = params;
  const serviceNet = round2(params.serviceNetAmount ?? 0);
  const netAmount = round2(params.netAmount - serviceNet);
  const vatAmount = round2(params.vatAmount);
  const applied = round2(params.appliedToBalance);
  const settled = round2(params.settledAmount);

  const lines: { accountId: string; debit?: number; credit?: number }[] = [];
  if (netAmount > 0) lines.push({ accountId: await getSystemAccountId(tx, businessId, "INVENTORY"), credit: netAmount });
  if (serviceNet > 0) {
    lines.push({ accountId: await getOrCreateSystemAccountId(tx, businessId, "SERVICE_COST_CLEARING"), credit: serviceNet });
  }
  if (vatAmount > 0) lines.push({ accountId: await getSystemAccountId(tx, businessId, "VAT_INPUT_RECEIVABLE"), credit: vatAmount });
  if (applied > 0) lines.push({ accountId: await getSystemAccountId(tx, businessId, "ACCOUNTS_PAYABLE"), debit: applied });
  if (settled > 0) {
    const accountId =
      params.settlement === "CASH"
        ? await getSystemAccountId(tx, businessId, CASH_ACCOUNT_KEYS[params.cashAccountType!])
        : await getOrCreateSystemAccountId(tx, businessId, "SUPPLIER_CREDITS_RECEIVABLE");
    lines.push({ accountId, debit: settled });
  }

  return postJournalEntry({
    tx,
    businessId,
    description: `Debit note ${debitNoteNumber} – Purchase ${purchaseNumber}`,
    lines,
    referenceType: "SupplierDebitNote",
    referenceId: debitNoteId,
    createdById,
  });
}

/**
 * Credit redemption posting (Module 17) – the GL half of spending a
 * standing CREDIT_NOTE credit (see src/lib/credits.ts) against a later
 * sale/purchase. Reclassifies the credit out of the liability/asset account
 * Module 16 put it in, and into the receivable/payable account the new
 * sale/purchase's own posting (postJournalEntryForSale/Purchase) already
 * put its AR/AP into – the two entries together are what actually clears
 * the new document's balance in the ledger.
 *
 *   Sale side:     Dr Customer Credits Payable / Cr Accounts Receivable
 *   Purchase side: Dr Accounts Payable / Cr Supplier Credits Receivable
 *
 * OVERPAYMENT-sourced redemptions (the other half of src/lib/credits.ts)
 * deliberately post nothing here – see that file's doc comment for why an
 * overpayment credit needs no further GL entry when spent.
 */
export async function postJournalEntryForCreditRedemption(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  redemptionId: string;
  kind: "SALE" | "PURCHASE";
  amount: number;
  createdById: string;
}) {
  const { tx, businessId, redemptionId, kind, amount, createdById } = params;

  if (kind === "SALE") {
    const [creditAccountId, arAccountId] = await Promise.all([
      getOrCreateSystemAccountId(tx, businessId, "CUSTOMER_CREDITS_PAYABLE"),
      getSystemAccountId(tx, businessId, "ACCOUNTS_RECEIVABLE"),
    ]);

    return postJournalEntry({
      tx,
      businessId,
      description: "Customer credit applied to sale",
      lines: [
        { accountId: creditAccountId, debit: amount },
        { accountId: arAccountId, credit: amount },
      ],
      referenceType: "CreditRedemption",
      referenceId: redemptionId,
      createdById,
    });
  }

  const [apAccountId, creditAccountId] = await Promise.all([
    getSystemAccountId(tx, businessId, "ACCOUNTS_PAYABLE"),
    getOrCreateSystemAccountId(tx, businessId, "SUPPLIER_CREDITS_RECEIVABLE"),
  ]);

  return postJournalEntry({
    tx,
    businessId,
    description: "Supplier credit applied to purchase",
    lines: [
      { accountId: apAccountId, debit: amount },
      { accountId: creditAccountId, credit: amount },
    ],
    referenceType: "CreditRedemption",
    referenceId: redemptionId,
    createdById,
  });
}

/**
 * Fixed asset acquisition posting (Module 21) – a single balanced entry,
 * same shape as postJournalEntryForExpense's plain (non-withholding-tax)
 * case: Dr Fixed Assets (cost) / Cr Cash. CREDIT is not accepted here –
 * see the KNOWN LIMITATION on FixedAsset.paymentMethod in the schema –
 * so, unlike postJournalEntryForExpense, there is no "return null for
 * CREDIT" branch; the API route rejects CREDIT before this is ever called.
 */
export async function postJournalEntryForFixedAssetAcquisition(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  assetId: string;
  assetName: string;
  cost: number;
  paymentMethod: string;
  createdById: string;
}) {
  const { tx, businessId, assetId, assetName, cost, paymentMethod, createdById } = params;

  const cashAccountId = await cashAccountIdForMethod(tx, businessId, paymentMethod);
  if (!cashAccountId) {
    throw new Error("Fixed asset acquisition must be paid via a real cash method, not CREDIT.");
  }
  const fixedAssetsAccountId = await getOrCreateSystemAccountId(tx, businessId, "FIXED_ASSETS");

  return postJournalEntry({
    tx,
    businessId,
    description: `Fixed asset acquired – ${assetName}`,
    lines: [
      { accountId: fixedAssetsAccountId, debit: cost },
      { accountId: cashAccountId, credit: cost },
    ],
    referenceType: "FixedAssetAcquisition",
    referenceId: assetId,
    createdById,
  });
}

/** Reverses a fixed asset's acquisition entry – only ever called by a delete before any depreciation has been posted (see src/lib/fixed-assets.ts::deleteFixedAsset). */
export async function reverseJournalEntryForFixedAssetAcquisition(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  assetId: string;
  assetName: string;
  createdById: string;
}) {
  await reverseJournalEntriesForReference({
    tx: params.tx,
    businessId: params.businessId,
    referenceType: "FixedAssetAcquisition",
    referenceId: params.assetId,
    createdById: params.createdById,
    reason: `Fixed asset deleted – ${params.assetName}`,
  });
}

/**
 * Depreciation posting (Module 21) – one entry per asset per period,
 * always Dr Depreciation Expense / Cr Accumulated Depreciation. Balances
 * trivially since it's the same amount on both sides. Idempotency (never
 * posting the same asset+period twice) is enforced by the caller
 * (src/lib/fixed-assets.ts::postDepreciationForPeriod), which checks for
 * an existing JournalEntry with this exact referenceId before calling.
 */
export async function postJournalEntryForDepreciation(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  assetId: string;
  assetName: string;
  period: string; // "YYYY-MM"
  amount: number;
  createdById: string;
  // Module 34: the entry belongs to `period`, not to the moment the run was clicked.
  entryDate?: Date;
}) {
  const { tx, businessId, assetId, assetName, period, amount, createdById, entryDate } = params;

  const [depreciationExpenseId, accumulatedDepreciationId] = await Promise.all([
    getOrCreateSystemAccountId(tx, businessId, "DEPRECIATION_EXPENSE"),
    getOrCreateSystemAccountId(tx, businessId, "ACCUMULATED_DEPRECIATION"),
  ]);

  return postJournalEntry({
    tx,
    businessId,
    description: `Depreciation – ${assetName} (${period})`,
    lines: [
      { accountId: depreciationExpenseId, debit: amount },
      { accountId: accumulatedDepreciationId, credit: amount },
    ],
    referenceType: "Depreciation",
    referenceId: `${assetId}:${period}`,
    createdById,
    entryDate,
  });
}

/**
 * Fixed asset disposal posting (Module 21) – removes the asset from the
 * books and recognizes any gain or loss in one balanced entry:
 *
 *   Dr Accumulated Depreciation (whatever was accumulated so far)
 *   Dr Cash (disposal proceeds, if any)
 *   Dr Gain/Loss on Disposal (only if this is a LOSS)
 *   Cr Fixed Assets (original cost)
 *   Cr Gain/Loss on Disposal (only if this is a GAIN)
 *
 * Balances by construction: proceeds + accumulatedDepreciation - cost is
 * exactly the gain (positive) or loss (negative) – see
 * src/lib/fixed-assets.ts::disposeFixedAsset for the derivation. cashAccountType
 * is omitted entirely when there are no proceeds (a scrapped/written-off
 * asset with nothing recovered) – no zero-amount line is ever posted.
 */
export async function postJournalEntryForFixedAssetDisposal(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  assetId: string;
  assetName: string;
  cost: number;
  accumulatedDepreciation: number;
  proceeds: number;
  // Module 33 fix: this used to be `cashAccountId`, the real CashAccount.id
  // the operator picked, pushed straight into a JournalLine as if it were a
  // GL Account.id – a foreign-key violation on JournalLine.accountId (the
  // two tables have entirely different ids), so ANY disposal with proceeds
  // > 0 failed and rolled back. It takes the CashAccount's TYPE now and
  // resolves the GL bucket through CASH_ACCOUNT_KEYS, exactly how Refunds
  // and Bank Reconciliation already do. Required only when proceeds > 0.
  cashAccountType?: string | null;
  createdById: string;
}) {
  const { tx, businessId, assetId, assetName, cost, accumulatedDepreciation, proceeds, createdById } = params;

  const netBookValue = round2(cost - accumulatedDepreciation);
  const gainLoss = round2(proceeds - netBookValue); // positive = gain, negative = loss

  const [fixedAssetsAccountId, accumulatedDepreciationId] = await Promise.all([
    getSystemAccountId(tx, businessId, "FIXED_ASSETS"),
    getOrCreateSystemAccountId(tx, businessId, "ACCUMULATED_DEPRECIATION"),
  ]);

  const lines: { accountId: string; debit?: number; credit?: number }[] = [];
  if (accumulatedDepreciation > 0) lines.push({ accountId: accumulatedDepreciationId, debit: accumulatedDepreciation });
  if (proceeds > 0) {
    if (!params.cashAccountType) {
      throw new Error("A cash account is required when disposal proceeds are greater than zero.");
    }
    const cashGlAccountId = await getSystemAccountId(tx, businessId, CASH_ACCOUNT_KEYS[params.cashAccountType]);
    lines.push({ accountId: cashGlAccountId, debit: proceeds });
  }

  if (Math.abs(gainLoss) > 0.01) {
    const gainLossAccountId = await getOrCreateSystemAccountId(tx, businessId, "GAIN_LOSS_ON_DISPOSAL_OF_ASSETS");
    if (gainLoss < 0) {
      lines.push({ accountId: gainLossAccountId, debit: -gainLoss }); // loss
    } else {
      lines.push({ accountId: gainLossAccountId, credit: gainLoss }); // gain
    }
  }

  lines.push({ accountId: fixedAssetsAccountId, credit: cost });

  return postJournalEntry({
    tx,
    businessId,
    description: `Disposal – ${assetName}`,
    lines,
    referenceType: "FixedAssetDisposal",
    referenceId: assetId,
    createdById,
  });
}

/**
 * Bank Reconciliation adjustment posting (Module 22) – for a statement
 * line that's on the bank statement but was never recorded in the books
 * (a charge, a fee, interest earned). `amount` is signed the same way
 * CashTransaction.amount is: negative = a charge (money left the
 * account), positive = interest/credit (money arrived).
 *
 *   Charge (amount < 0):   Dr Bank Charges & Interest / Cr <cash GL account>
 *   Interest (amount > 0): Dr <cash GL account> / Cr Bank Charges & Interest
 *
 * `cashAccountType` is the CashAccount's CashAccountType (CASH/BANK/
 * AIRTEL_MONEY/TNM_MPAMBA), not its id – reused the same way Transfer's
 * fromCashType/toCashType map to one shared GL bucket per type, so two
 * different bank CashAccounts still post to the single BANK system
 * account (an existing simplification, not a new one this module adds).
 */
export async function postJournalEntryForBankReconciliationAdjustment(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  lineId: string;
  cashAccountType: string;
  amount: number; // signed
  description: string;
  createdById: string;
}) {
  const { tx, businessId, lineId, cashAccountType, amount, description, createdById } = params;

  const [cashGlAccountId, bankChargesAccountId] = await Promise.all([
    getSystemAccountId(tx, businessId, CASH_ACCOUNT_KEYS[cashAccountType]),
    getOrCreateSystemAccountId(tx, businessId, "BANK_CHARGES_AND_INTEREST"),
  ]);

  const abs = round2(Math.abs(amount));
  const lines =
    amount < 0
      ? [
          { accountId: bankChargesAccountId, debit: abs },
          { accountId: cashGlAccountId, credit: abs },
        ]
      : [
          { accountId: cashGlAccountId, debit: abs },
          { accountId: bankChargesAccountId, credit: abs },
        ];

  return postJournalEntry({
    tx,
    businessId,
    description,
    lines,
    referenceType: "BankReconciliationAdjustment",
    referenceId: lineId,
    createdById,
  });
}

/**
 * Stock Take adjustment posting (Module 23) – for a counted line whose
 * physical quantity genuinely differs from what the books said. `variance`
 * is signed the same way InventoryMovement.quantity is: positive = found
 * stock (counted more than the books), negative = shrinkage (counted
 * less). `unitCost` is the line's snapshotted Product.purchasePrice (see
 * StockTakeLine's schema comment for why it's snapshotted, not live).
 *
 *   Shrinkage (variance < 0): Dr Inventory Shrinkage & Adjustment / Cr Inventory
 *   Found stock (variance > 0): Dr Inventory / Cr Inventory Shrinkage & Adjustment
 */
export async function postJournalEntryForStockTakeAdjustment(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  lineId: string;
  productName: string;
  variance: number; // signed quantity, never zero – caller guards this
  unitCost: number;
  createdById: string;
}) {
  const { tx, businessId, lineId, productName, variance, unitCost, createdById } = params;

  const [inventoryAccountId, shrinkageAccountId] = await Promise.all([
    getSystemAccountId(tx, businessId, "INVENTORY"),
    getOrCreateSystemAccountId(tx, businessId, "INVENTORY_SHRINKAGE_AND_ADJUSTMENT"),
  ]);

  const value = round2(Math.abs(variance) * unitCost);
  const lines =
    variance > 0
      ? [
          { accountId: inventoryAccountId, debit: value },
          { accountId: shrinkageAccountId, credit: value },
        ]
      : [
          { accountId: shrinkageAccountId, debit: value },
          { accountId: inventoryAccountId, credit: value },
        ];

  return postJournalEntry({
    tx,
    businessId,
    description: `Stock take adjustment – ${productName}`,
    lines,
    referenceType: "StockTakeAdjustment",
    referenceId: lineId,
    createdById,
  });
}

/**
 * Stock Transfer shortfall posting (Module 65) – for the part of a transfer
 * that did not arrive (damaged in transit, missing from the load).
 *
 * The quantity books already lost these units when the transfer was
 * dispatched (TRANSFER_OUT moves the branch StockLevel AND the business-wide
 * Product.quantity), but a transfer never touches the GL, so the Inventory
 * account still carries their cost. Written off at the cost snapshotted at
 * dispatch (StockTransferLine.unitCostAtDispatch, falling back to current
 * cost for a pre-Module-59 line), into the same account Stock Take
 * shrinkage uses so every "stock we no longer have" figure lands together:
 *
 *   Dr Inventory Shrinkage & Adjustment / Cr Inventory
 *
 * Dated "now" (no explicit entryDate), so it can never land in a closed
 * period – the same reasoning credit notes and stock-take adjustments use.
 * One entry per short line, keyed to the line, so a single product's write-off
 * is traceable on its own.
 */
export async function postJournalEntryForTransferShortfall(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  lineId: string;
  transferNumber: string;
  productName: string;
  shortfall: number; // positive quantity that did not arrive
  unitCost: number;
  createdById: string;
}) {
  const { tx, businessId, lineId, transferNumber, productName, shortfall, unitCost, createdById } = params;

  const [inventoryAccountId, shrinkageAccountId] = await Promise.all([
    getSystemAccountId(tx, businessId, "INVENTORY"),
    getOrCreateSystemAccountId(tx, businessId, "INVENTORY_SHRINKAGE_AND_ADJUSTMENT"),
  ]);

  const value = round2(Math.abs(shortfall) * unitCost);

  return postJournalEntry({
    tx,
    businessId,
    description: `Transfer ${transferNumber} short-received – ${productName}`,
    lines: [
      { accountId: shrinkageAccountId, debit: value },
      { accountId: inventoryAccountId, credit: value },
    ],
    referenceType: "StockTransferShortfall",
    referenceId: lineId,
    createdById,
  });
}

/**
 * Stock Transfer shortfall RECOVERY posting (Module 66) – the mirror image of
 * postJournalEntryForTransferShortfall() for units that were written off as
 * short at receipt and later turned up.
 *
 *   Dr Inventory / Cr Inventory Shrinkage & Adjustment
 *
 * `unitCost` MUST be the same cost the original write-off used
 * (StockTransferLine.unitCostAtDispatch, falling back to current cost for a
 * pre-Module-59 line): recovering at today's cost would leave a residue in the
 * shrinkage account that no real loss explains. Dated "now" (no explicit
 * entryDate) so it can never land in a closed period – the write-off it
 * reverses may sit in one, and reopening a period just to undo it would be
 * disproportionate. One entry per recovered line per recovery, keyed to the
 * line, so a single product's recovery is traceable on its own.
 */
export async function postJournalEntryForTransferRecovery(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  lineId: string;
  transferNumber: string;
  productName: string;
  quantity: number; // positive quantity that turned up
  unitCost: number;
  createdById: string;
}) {
  const { tx, businessId, lineId, transferNumber, productName, quantity, unitCost, createdById } = params;

  const [inventoryAccountId, shrinkageAccountId] = await Promise.all([
    getSystemAccountId(tx, businessId, "INVENTORY"),
    getOrCreateSystemAccountId(tx, businessId, "INVENTORY_SHRINKAGE_AND_ADJUSTMENT"),
  ]);

  const value = round2(Math.abs(quantity) * unitCost);

  return postJournalEntry({
    tx,
    businessId,
    description: `Transfer ${transferNumber} short-received stock recovered – ${productName}`,
    lines: [
      { accountId: inventoryAccountId, debit: value },
      { accountId: shrinkageAccountId, credit: value },
    ],
    referenceType: "StockTransferRecovery",
    referenceId: lineId,
    createdById,
  });
}

/**
 * Tax payment posting (Module 33) – one balanced entry per payment to the
 * MRA, clearing the liability (or prepaying the income tax) the earlier
 * modules built up. `principalAmount` is the tax itself; `penaltyAmount`
 * is late-payment penalty/interest charged on top; the cash leg is always
 * principal + penalty.
 *
 *   PAYE:            Dr PAYE Payable (principal)
 *   WITHHOLDING_TAX: Dr Withholding Tax Payable (principal)
 *   VAT (net payable, isRefund false):
 *                    Dr VAT Output Payable (vatOutputCleared)
 *                    Cr VAT Input Receivable (vatInputCleared, if any)
 *                    – netted in ONE entry because the amount owed the MRA
 *                    is output minus input (see getVatReturn in
 *                    src/lib/vat.ts, whose netPayable this mirrors). Clearing
 *                    only the output side would leave input VAT standing as
 *                    a receivable that was in fact just used.
 *   VAT (net refundable, isRefund true – Module 46):
 *                    Dr VAT Output Payable (vatOutputCleared, if any)
 *                    Cr VAT Input Receivable (vatInputCleared)
 *                    Dr <cash> (vatInputCleared − vatOutputCleared)
 *                    – the mirror image: both VAT accounts are still fully
 *                    cleared for the period, but since input exceeded
 *                    output the balancing line is cash coming IN, not out.
 *                    No penalty is possible on a refund (see design choice
 *                    in tax-payments.ts) – the cash line below only adds
 *                    penalty for the remittance case.
 *   PROVISIONAL_TAX / ANNUAL_INCOME_TAX:
 *                    Dr Income Tax Paid / Prepaid (principal) – see the
 *                    account's comment in chart-of-accounts.ts for why this
 *                    is an asset, not an expense.
 *   any type, penalty > 0:  Dr Tax Penalties & Interest (penalty)
 *   remittance (isRefund false):  Cr <cash GL account> (principal + penalty)
 *   refund (isRefund true):       Dr <cash GL account> (principal)
 *
 * `cashAccountType` is the CashAccount's CashAccountType, not its id – the
 * same "one shared GL bucket per type" mapping Refunds, Transfers and Bank
 * Reconciliation use. `paymentDate` becomes the entry's entryDate (unlike
 * most postings, which default to "now") so a payment recorded a few days
 * late still lands in the right accounting period.
 *
 * Reversal (voiding a payment) goes through
 * reverseJournalEntriesForReference with referenceType "TaxPayment".
 */
export async function postJournalEntryForTaxPayment(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  paymentId: string;
  paymentNumber: string;
  taxType: "VAT" | "PAYE" | "WITHHOLDING_TAX" | "PROVISIONAL_TAX" | "ANNUAL_INCOME_TAX";
  periodLabel: string;
  principalAmount: number;
  penaltyAmount: number;
  vatOutputCleared?: number | null; // VAT only
  vatInputCleared?: number | null; // VAT only
  isRefund?: boolean; // VAT only – Module 46
  cashAccountType: string;
  paymentDate: Date;
  createdById: string;
}) {
  const { tx, businessId, paymentId, paymentNumber, taxType, periodLabel, cashAccountType, paymentDate, createdById } = params;
  const principal = round2(params.principalAmount);
  const penalty = round2(params.penaltyAmount);
  const isRefund = !!params.isRefund;
  if (isRefund && penalty > 0) {
    throw new Error("A VAT refund can't carry a penalty – a bug in the calling code, not a user error.");
  }

  const cashGlAccountId = await getSystemAccountId(tx, businessId, CASH_ACCOUNT_KEYS[cashAccountType]);
  const lines: { accountId: string; debit?: number; credit?: number }[] = [];

  if (taxType === "VAT") {
    const output = round2(params.vatOutputCleared ?? 0);
    const input = round2(params.vatInputCleared ?? 0);
    const expected = isRefund ? round2(input - output) : round2(output - input);
    if (Math.abs(expected - principal) > 0.01) {
      throw new Error(
        isRefund
          ? "VAT refund principal must equal input VAT cleared minus output VAT cleared – a bug in the calling code, not a user error."
          : "VAT payment principal must equal output VAT cleared minus input VAT cleared – a bug in the calling code, not a user error."
      );
    }
    // getOrCreateSystemAccountId (not getSystemAccountId): a payment for a
    // period whose sales all predate VAT registration can only happen for a
    // business that registered before Module 18's accounts existed, and the
    // period's own postings would have backfilled them anyway – but a
    // missing account here should self-heal, not block a real payment.
    if (output > 0) {
      const outputAccountId = await getOrCreateSystemAccountId(tx, businessId, "VAT_OUTPUT_PAYABLE");
      lines.push({ accountId: outputAccountId, debit: output });
    }
    if (input > 0) {
      const inputAccountId = await getOrCreateSystemAccountId(tx, businessId, "VAT_INPUT_RECEIVABLE");
      lines.push({ accountId: inputAccountId, credit: input });
    }
  } else if (taxType === "PAYE") {
    lines.push({ accountId: await getSystemAccountId(tx, businessId, "PAYE_PAYABLE"), debit: principal });
  } else if (taxType === "WITHHOLDING_TAX") {
    lines.push({ accountId: await getOrCreateSystemAccountId(tx, businessId, "WITHHOLDING_TAX_PAYABLE"), debit: principal });
  } else {
    lines.push({ accountId: await getOrCreateSystemAccountId(tx, businessId, "INCOME_TAX_PREPAID"), debit: principal });
  }

  if (penalty > 0) {
    lines.push({ accountId: await getOrCreateSystemAccountId(tx, businessId, "TAX_PENALTIES_AND_INTEREST"), debit: penalty });
  }

  if (isRefund) {
    lines.push({ accountId: cashGlAccountId, debit: principal });
  } else {
    lines.push({ accountId: cashGlAccountId, credit: round2(principal + penalty) });
  }

  return postJournalEntry({
    tx,
    businessId,
    description: `${isRefund ? "VAT refund" : "Tax payment"} ${paymentNumber} – ${taxType.replace(/_/g, " ")} (${periodLabel})`,
    lines,
    referenceType: "TaxPayment",
    referenceId: paymentId,
    createdById,
    entryDate: paymentDate,
  });
}

/** Cash transfer posting – always balances (moving money between two asset accounts nets to zero). */
export async function postJournalEntryForTransfer(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  fromCashType: string;
  toCashType: string;
  amount: number;
  description: string;
  createdById: string;
}) {
  const { tx, businessId, amount, createdById } = params;

  const [fromAccountId, toAccountId] = await Promise.all([
    getSystemAccountId(tx, businessId, CASH_ACCOUNT_KEYS[params.fromCashType]),
    getSystemAccountId(tx, businessId, CASH_ACCOUNT_KEYS[params.toCashType]),
  ]);

  return postJournalEntry({
    tx,
    businessId,
    description: params.description,
    lines: [
      { accountId: toAccountId, debit: amount },
      { accountId: fromAccountId, credit: amount },
    ],
    referenceType: "Transfer",
    createdById,
  });
}

/**
 * Foreign exchange adjustment posting (Module 39) – one balanced two-line
 * entry between a cash account's shared GL bucket and FOREIGN_EXCHANGE_GAIN_LOSS.
 * `signedAmount` is positive for a gain, negative for a loss (see
 * src/lib/fx-calc.ts for the convention and the line shapes). Uses
 * getOrCreateSystemAccountId for the FX account because a business that
 * registered before this module has no such account yet – the same backfill
 * pattern Modules 16/18/21/22/23/33 used for their own new accounts.
 *
 * Voiding reverses this entry in full through reverseJournalEntriesForReference
 * (referenceType "ForeignExchangeAdjustment"), like a tax payment.
 */
export async function postJournalEntryForForeignExchangeAdjustment(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  adjustmentId: string;
  adjustmentNumber: string;
  kind: string; // "REALISED" | "UNREALISED" – wording only
  currencyCode: string;
  cashAccountType: string;
  signedAmount: number;
  adjustmentDate: Date;
  createdById: string;
}) {
  const { tx, businessId, adjustmentId, adjustmentNumber, kind, currencyCode, cashAccountType, signedAmount, adjustmentDate, createdById } = params;

  const [cashGlAccountId, fxAccountId] = await Promise.all([
    getSystemAccountId(tx, businessId, CASH_ACCOUNT_KEYS[cashAccountType]),
    getOrCreateSystemAccountId(tx, businessId, "FOREIGN_EXCHANGE_GAIN_LOSS"),
  ]);

  return postJournalEntry({
    tx,
    businessId,
    description: `${kind === "REALISED" ? "Realised" : "Unrealised"} exchange ${signedAmount > 0 ? "gain" : "loss"} on ${currencyCode} – ${adjustmentNumber}`,
    lines: buildFxJournalLines({ cashGlAccountId, fxAccountId, signedAmount }),
    referenceType: "ForeignExchangeAdjustment",
    referenceId: adjustmentId,
    createdById,
    entryDate: adjustmentDate,
  });
}
