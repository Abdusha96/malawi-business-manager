import { prisma } from "./prisma";
import { Prisma, PaymentMethod } from "@prisma/client";
import { postCashTransactionForPayment } from "./cashbook";
import { postJournalEntryForPayment } from "./accounting-integrations";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Mirrors src/lib/customers.ts::getCustomerSummary – see that file's
 * comment for why these are computed live rather than stored columns.
 */
export async function getSupplierSummary(businessId: string, supplierId: string) {
  const purchases = await prisma.purchase.findMany({
    where: { businessId, supplierId, status: { not: "VOIDED" } },
    select: { total: true, amountPaid: true, balance: true },
  });

  const totalPurchases = purchases.reduce((sum, p) => sum + Number(p.total), 0);
  const amountPaid = purchases.reduce((sum, p) => sum + Number(p.amountPaid), 0);
  const outstandingBalance = purchases.reduce((sum, p) => sum + Number(p.balance), 0);

  return { totalPurchases, amountPaid, outstandingBalance, purchaseCount: purchases.length };
}

export async function getTotalSupplierDebt(businessId: string, branchId?: string | null): Promise<number> {
  const agg = await prisma.purchase.aggregate({
    where: { businessId, status: { in: ["PARTIAL", "CREDIT"] }, ...(branchId ? { branchId } : {}) },
    _sum: { balance: true },
  });
  return round2(Number(agg._sum.balance ?? 0));
}

export async function getSupplierDebtList(businessId: string, branchId?: string | null) {
  // Module 27: optional branchId filters to one branch's open Purchases –
  // Supplier itself stays business-wide (see the model comment on
  // Customer, which this mirrors), so filtering happens on the purchase.
  const openPurchases = await prisma.purchase.findMany({
    where: { businessId, status: { in: ["PARTIAL", "CREDIT"] }, balance: { gt: 0 }, ...(branchId ? { branchId } : {}) },
    include: { supplier: true },
  });

  const bySupplier = new Map<string, { supplierName: string; phone: string | null; totalOutstanding: number }>();
  for (const purchase of openPurchases) {
    const existing = bySupplier.get(purchase.supplierId) ?? {
      supplierName: purchase.supplier.name,
      phone: purchase.supplier.phone,
      totalOutstanding: 0,
    };
    existing.totalOutstanding += Number(purchase.balance);
    bySupplier.set(purchase.supplierId, existing);
  }

  return Array.from(bySupplier.entries())
    .map(([supplierId, v]) => ({ supplierId, ...v, totalOutstanding: round2(v.totalOutstanding) }))
    .sort((a, b) => b.totalOutstanding - a.totalOutstanding);
}

export type SupplierAgingBucket = "current" | "days1to30" | "days31to60" | "days61to90" | "days90plus";

/** Payables aging is measured from Purchase.purchaseDate because purchases
 * do not currently store contractual due dates. */
export async function getPayablesAging(businessId: string, branchId?: string | null) {
  const openPurchases = await prisma.purchase.findMany({
    where: { businessId, status: { in: ["PARTIAL", "CREDIT"] }, balance: { gt: 0 }, ...(branchId ? { branchId } : {}) },
    include: { supplier: true },
  });
  const bucketTotals: Record<SupplierAgingBucket, number> = {
    current: 0, days1to30: 0, days31to60: 0, days61to90: 0, days90plus: 0,
  };
  type SupplierAging = {
    supplierId: string; supplierName: string; phone: string | null; totalOutstanding: number;
    buckets: Record<SupplierAgingBucket, number>;
  };
  const bySupplier = new Map<string, SupplierAging>();
  const now = Date.now();
  for (const purchase of openPurchases) {
    const ageDays = Math.floor((now - purchase.purchaseDate.getTime()) / 86_400_000);
    const bucket: SupplierAgingBucket = ageDays <= 0 ? "current" : ageDays <= 30 ? "days1to30" : ageDays <= 60 ? "days31to60" : ageDays <= 90 ? "days61to90" : "days90plus";
    const balance = Number(purchase.balance);
    bucketTotals[bucket] += balance;
    const existing = bySupplier.get(purchase.supplierId) ?? {
      supplierId: purchase.supplierId,
      supplierName: purchase.supplier.name,
      phone: purchase.supplier.phone,
      totalOutstanding: 0,
      buckets: { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, days90plus: 0 },
    };
    existing.totalOutstanding += balance;
    existing.buckets[bucket] += balance;
    bySupplier.set(purchase.supplierId, existing);
  }
  const suppliers = Array.from(bySupplier.values())
    .map((supplier) => ({
      ...supplier,
      totalOutstanding: round2(supplier.totalOutstanding),
      buckets: Object.fromEntries(Object.entries(supplier.buckets).map(([key, value]) => [key, round2(value)])) as Record<SupplierAgingBucket, number>,
    }))
    .sort((a, b) => b.totalOutstanding - a.totalOutstanding);
  const totalPayables = round2(suppliers.reduce((sum, supplier) => sum + supplier.totalOutstanding, 0));
  for (const bucket of Object.keys(bucketTotals) as SupplierAgingBucket[]) bucketTotals[bucket] = round2(bucketTotals[bucket]);
  return { totalPayables, bucketTotals, suppliers };
}

/**
 * Mirrors src/lib/customers.ts::applyCustomerPayment – a general payment
 * against a supplier (not tied to one purchase order) is allocated FIFO
 * across that supplier's open purchases, oldest first.
 */
export async function applySupplierPayment(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  supplierId: string;
  amount: number;
  method: PaymentMethod;
  reference?: string | null;
  notes?: string | null;
  recordedById: string;
}) {
  const { tx, businessId, supplierId, amount, method, reference, notes, recordedById } = params;

  const openPurchases = await tx.purchase.findMany({
    where: { businessId, supplierId, status: { in: ["PARTIAL", "CREDIT"] }, balance: { gt: 0 } },
    orderBy: { purchaseDate: "asc" },
  });

  let remaining = amount;
  const paymentsCreated = [];

  for (const purchase of openPurchases) {
    if (remaining <= 0) break;

    const purchaseBalance = Number(purchase.balance);
    const allocation = Math.min(remaining, purchaseBalance);
    const newAmountPaid = Number(purchase.amountPaid) + allocation;
    const newBalance = round2(purchaseBalance - allocation);

    await tx.purchase.update({
      where: { id: purchase.id },
      data: {
        amountPaid: newAmountPaid,
        balance: newBalance,
        status: newBalance <= 0.01 ? "PAID" : "PARTIAL",
      },
    });

    const payment = await tx.payment.create({
      data: {
        businessId,
        purchaseId: purchase.id,
        supplierId,
        amount: allocation,
        method,
        reference: reference ?? undefined,
        notes: notes ?? `Applied to purchase ${purchase.purchaseNumber}`,
        recordedById,
      },
    });
    paymentsCreated.push(payment);
    await postCashTransactionForPayment({ tx, businessId, paymentId: payment.id, createdById: recordedById });
    await postJournalEntryForPayment({
      tx,
      businessId,
      paymentId: payment.id,
      amount: allocation,
      method,
      isCustomerSide: false,
      createdById: recordedById,
    });

    remaining = round2(remaining - allocation);
  }

  if (remaining > 0) {
    const payment = await tx.payment.create({
      data: {
        businessId,
        supplierId,
        amount: remaining,
        method,
        reference: reference ?? undefined,
        notes: notes ? `${notes} (unallocated credit)` : "Unallocated credit – exceeds outstanding balance",
        recordedById,
      },
    });
    paymentsCreated.push(payment);
    await postCashTransactionForPayment({ tx, businessId, paymentId: payment.id, createdById: recordedById });
    await postJournalEntryForPayment({
      tx,
      businessId,
      paymentId: payment.id,
      amount: remaining,
      method,
      isCustomerSide: false,
      createdById: recordedById,
    });
  }

  return paymentsCreated;
}
