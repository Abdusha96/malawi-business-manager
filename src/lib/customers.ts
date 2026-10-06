import { prisma } from "./prisma";
import { postCashTransactionForPayment } from "./cashbook";
import { postJournalEntryForPayment } from "./accounting-integrations";

/**
 * All figures here are computed live from Sale/Payment on every call. This
 * is deliberately not cached or denormalized onto Customer – see the
 * comment on the Customer model in schema.prisma. At SME transaction
 * volumes this is fast; if a business ever has tens of thousands of sales,
 * revisit with a materialized view rather than reaching for a stored
 * running balance (which is what causes debt figures to quietly go wrong).
 */
export async function getCustomerSummary(businessId: string, customerId: string) {
  const sales = await prisma.sale.findMany({
    where: { businessId, customerId, status: { not: "VOIDED" } },
    select: { total: true, amountPaid: true, balance: true },
  });

  const totalPurchases = sales.reduce((sum, s) => sum + Number(s.total), 0);
  const amountPaid = sales.reduce((sum, s) => sum + Number(s.amountPaid), 0);
  const outstandingBalance = sales.reduce((sum, s) => sum + Number(s.balance), 0);

  return { totalPurchases, amountPaid, outstandingBalance, salesCount: sales.length };
}

export type AgingBucket = "current" | "days1to30" | "days31to60" | "days61to90" | "days90plus";

interface CustomerAging {
  customerId: string;
  customerName: string;
  phone: string | null;
  totalOutstanding: number;
  buckets: Record<AgingBucket, number>;
  oldestSaleDate: Date;
}

/**
 * Aging is computed from Sale.saleDate, since regular sales in this app
 * don't carry a separate due date (unlike an Invoice with payment terms,
 * which the Business Documents module will add later). "Current" means the
 * sale is within the last 24 hours; that boundary can be revisited once
 * invoice due-date terms exist.
 */
export async function getReceivablesAging(
  businessId: string,
  branchId?: string | null
): Promise<{
  totalReceivables: number;
  bucketTotals: Record<AgingBucket, number>;
  customers: CustomerAging[];
}> {
  // Module 27: optional branchId filters to one branch's open Sales – Sale
  // already carries branchId (Module 13); Customer itself deliberately does
  // NOT (a customer can buy from any branch – see the model comment), so
  // filtering happens on the sale, not the customer.
  const openSales = await prisma.sale.findMany({
    where: {
      businessId,
      status: { in: ["PARTIAL", "CREDIT"] },
      balance: { gt: 0 },
      ...(branchId ? { branchId } : {}),
    },
    include: { customer: true },
  });

  const now = Date.now();
  const byCustomer = new Map<string, CustomerAging>();
  const bucketTotals: Record<AgingBucket, number> = {
    current: 0,
    days1to30: 0,
    days31to60: 0,
    days61to90: 0,
    days90plus: 0,
  };

  for (const sale of openSales) {
    if (!sale.customerId || !sale.customer) continue; // shouldn't happen – sale schema requires a customer for open balances

    const ageDays = Math.floor((now - sale.saleDate.getTime()) / 86_400_000);
    const bucket: AgingBucket =
      ageDays <= 0 ? "current" : ageDays <= 30 ? "days1to30" : ageDays <= 60 ? "days31to60" : ageDays <= 90 ? "days61to90" : "days90plus";

    const balance = Number(sale.balance);
    bucketTotals[bucket] += balance;

    const existing = byCustomer.get(sale.customerId) ?? {
      customerId: sale.customerId,
      customerName: sale.customer.name,
      phone: sale.customer.phone,
      totalOutstanding: 0,
      buckets: { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, days90plus: 0 },
      oldestSaleDate: sale.saleDate,
    };

    existing.totalOutstanding += balance;
    existing.buckets[bucket] += balance;
    if (sale.saleDate < existing.oldestSaleDate) existing.oldestSaleDate = sale.saleDate;

    byCustomer.set(sale.customerId, existing);
  }

  const customers = Array.from(byCustomer.values()).sort((a, b) => b.totalOutstanding - a.totalOutstanding);
  const totalReceivables = customers.reduce((sum, c) => sum + c.totalOutstanding, 0);

  return { totalReceivables, bucketTotals, customers };
}

/**
 * Builds the reminder message in the exact shape spec section 10 asks for.
 * Actual delivery (SMS/WhatsApp) is stubbed until the Notifications module
 * wires up a real provider – see the reminder route for the audit-log stub.
 */
export function buildReminderMessage(params: {
  customerName: string;
  businessName: string;
  outstandingBalance: number;
}) {
  return `Hello ${params.customerName}, your outstanding balance with ${params.businessName} is MWK ${params.outstandingBalance.toLocaleString()}. Please make payment at your earliest convenience.`;
}

/**
 * A customer-level debt payment (spec section 9: "record payments against
 * outstanding debts") has nowhere to land unless it's applied to specific
 * sales – Customer carries no balance column (see the model comment), the
 * computed outstandingBalance is a SUM over Sale.balance. So a payment not
 * tied to one Sale must be allocated across that customer's open sales,
 * oldest first, updating each Sale's amountPaid/balance/status as it goes.
 * Any amount left over after every open sale is fully paid is recorded as
 * an unlinked Payment (an advance / credit for future purchases) rather
 * than silently dropped.
 */
export async function applyCustomerPayment(params: {
  tx: import("@prisma/client").Prisma.TransactionClient;
  businessId: string;
  customerId: string;
  amount: number;
  method: import("@prisma/client").PaymentMethod;
  cashAccountId?: string | null;
  reference?: string | null;
  notes?: string | null;
  recordedById: string;
}) {
  const { tx, businessId, customerId, amount, method, cashAccountId, reference, notes, recordedById } = params;

  const openSales = await tx.sale.findMany({
    where: { businessId, customerId, status: { in: ["PARTIAL", "CREDIT"] }, balance: { gt: 0 } },
    orderBy: { saleDate: "asc" }, // oldest debt first
  });

  let remaining = amount;
  const paymentsCreated = [];

  for (const sale of openSales) {
    if (remaining <= 0) break;

    const saleBalance = Number(sale.balance);
    const allocation = Math.min(remaining, saleBalance);
    const newAmountPaid = Number(sale.amountPaid) + allocation;
    const newBalance = round2(saleBalance - allocation);

    await tx.sale.update({
      where: { id: sale.id },
      data: {
        amountPaid: newAmountPaid,
        balance: newBalance,
        status: newBalance <= 0.01 ? "PAID" : "PARTIAL",
      },
    });

    const payment = await tx.payment.create({
      data: {
        businessId,
        saleId: sale.id,
        customerId,
        amount: allocation,
        method,
        reference: reference ?? undefined,
        notes: notes ?? `Applied to sale ${sale.saleNumber}`,
        recordedById,
      },
    });
    paymentsCreated.push(payment);
    await postCashTransactionForPayment({ tx, businessId, paymentId: payment.id, createdById: recordedById, cashAccountId });
    await postJournalEntryForPayment({
      tx,
      businessId,
      paymentId: payment.id,
      amount: allocation,
      method,
      isCustomerSide: true,
      createdById: recordedById,
    });

    remaining = round2(remaining - allocation);
  }

  if (remaining > 0) {
    // Overpayment beyond all outstanding sales – recorded as an unlinked
    // credit against the customer rather than lost. A future Purchases/
    // Accounting module can decide how to surface "customer has credit".
    const payment = await tx.payment.create({
      data: {
        businessId,
        customerId,
        amount: remaining,
        method,
        reference: reference ?? undefined,
        notes: notes ? `${notes} (unallocated credit)` : "Unallocated credit – exceeds outstanding balance",
        recordedById,
      },
    });
    paymentsCreated.push(payment);
    await postCashTransactionForPayment({ tx, businessId, paymentId: payment.id, createdById: recordedById, cashAccountId });
    await postJournalEntryForPayment({
      tx,
      businessId,
      paymentId: payment.id,
      amount: remaining,
      method,
      isCustomerSide: true,
      createdById: recordedById,
    });
  }

  return paymentsCreated;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
