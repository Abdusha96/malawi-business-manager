import { prisma } from "./prisma";
import { Prisma } from "@prisma/client";
import { getCustomerCreditBalance, getSupplierCreditBalance } from "./refunds";
import { postJournalEntryForCreditRedemption } from "./accounting-integrations";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export class CreditError extends Error {}

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Gross OVERPAYMENT credit for a customer – the sum of every unlinked
 * Payment (no saleId) ever recorded against them, per the "unallocated
 * credit" branch of src/lib/customers.ts::applyCustomerPayment. Gross, not
 * net of redemptions – see getCustomerCreditSummary below for the number
 * that actually matters to a caller.
 */
async function getCustomerOverpaymentGross(db: Db, businessId: string, customerId: string): Promise<number> {
  const agg = await db.payment.aggregate({
    where: { businessId, customerId, saleId: null },
    _sum: { amount: true },
  });
  return round2(Number(agg._sum.amount ?? 0));
}

async function getSupplierOverpaymentGross(db: Db, businessId: string, supplierId: string): Promise<number> {
  const agg = await db.payment.aggregate({
    where: { businessId, supplierId, purchaseId: null },
    _sum: { amount: true },
  });
  return round2(Number(agg._sum.amount ?? 0));
}

async function getRedeemed(
  db: Db,
  businessId: string,
  match: { customerId: string } | { supplierId: string },
  sourceType: "OVERPAYMENT" | "CREDIT_NOTE"
): Promise<number> {
  const agg = await db.creditRedemption.aggregate({
    where: { businessId, sourceType, ...match },
    _sum: { amount: true },
  });
  return round2(Number(agg._sum.amount ?? 0));
}

export interface CreditSummary {
  overpaymentAvailable: number;
  creditNoteAvailable: number;
  totalAvailable: number;
}

/**
 * What a customer actually has left to spend, from both credit sources,
 * net of everything already redeemed. This is the number a profile page or
 * the redemption function itself should read – never the gross totals from
 * getCustomerOverpaymentGross/refunds.ts::getCustomerCreditBalance on their
 * own, which don't know about prior redemptions.
 */
export async function getCustomerCreditSummary(
  businessId: string,
  customerId: string,
  db: Db = prisma
): Promise<CreditSummary> {
  const [overpaymentGross, creditNoteGross, overpaymentRedeemed, creditNoteRedeemed] = await Promise.all([
    getCustomerOverpaymentGross(db, businessId, customerId),
    getCustomerCreditBalance(businessId, customerId, db),
    getRedeemed(db, businessId, { customerId }, "OVERPAYMENT"),
    getRedeemed(db, businessId, { customerId }, "CREDIT_NOTE"),
  ]);

  const overpaymentAvailable = Math.max(0, round2(overpaymentGross - overpaymentRedeemed));
  const creditNoteAvailable = Math.max(0, round2(creditNoteGross - creditNoteRedeemed));

  return {
    overpaymentAvailable,
    creditNoteAvailable,
    totalAvailable: round2(overpaymentAvailable + creditNoteAvailable),
  };
}

export async function getSupplierCreditSummary(
  businessId: string,
  supplierId: string,
  db: Db = prisma
): Promise<CreditSummary> {
  const [overpaymentGross, creditNoteGross, overpaymentRedeemed, creditNoteRedeemed] = await Promise.all([
    getSupplierOverpaymentGross(db, businessId, supplierId),
    getSupplierCreditBalance(businessId, supplierId),
    getRedeemed(db, businessId, { supplierId }, "OVERPAYMENT"),
    getRedeemed(db, businessId, { supplierId }, "CREDIT_NOTE"),
  ]);

  const overpaymentAvailable = Math.max(0, round2(overpaymentGross - overpaymentRedeemed));
  const creditNoteAvailable = Math.max(0, round2(creditNoteGross - creditNoteRedeemed));

  return {
    overpaymentAvailable,
    creditNoteAvailable,
    totalAvailable: round2(overpaymentAvailable + creditNoteAvailable),
  };
}

/**
 * Spends a customer's standing credit against their open sales, oldest
 * first – the same FIFO allocation applyCustomerPayment() uses for a fresh
 * cash payment, because from the customer's side "I have credit" and "I'm
 * paying cash" settle debt the exact same way. Two call sites:
 *
 *  - Manual: a "Apply Credit" action on the customer profile, with an
 *    explicit `amount` the operator chose.
 *  - Automatic: right after createSale() adds a new open balance for this
 *    customer, called with `amount` omitted so it spends as much standing
 *    credit as fits – which may run past the brand-new sale and mop up
 *    older debts too, exactly like a cash payment would.
 *
 * Within one allocation, OVERPAYMENT credit is spent before CREDIT_NOTE
 * credit, since the former needs no GL entry and the latter does – cheapest
 * source first is an arbitrary but harmless tie-break, not a rule the
 * customer would ever notice.
 *
 * All reads happen against `tx` so two concurrent redemptions (or a
 * redemption racing a new CREDIT_NOTE refund) can't both spend the same
 * unresolved credit – same reasoning as createRefund's re-check pattern.
 */
export async function redeemCustomerCredit(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  customerId: string;
  amount?: number;
  createdById: string;
}) {
  const { tx, businessId, customerId, createdById } = params;

  const summary = await getCustomerCreditSummary(businessId, customerId, tx);

  const openSales = await tx.sale.findMany({
    where: { businessId, customerId, status: { in: ["PARTIAL", "CREDIT"] }, balance: { gt: 0 } },
    orderBy: { saleDate: "asc" },
  });
  const totalOutstanding = round2(openSales.reduce((sum, s) => sum + Number(s.balance), 0));

  const amount = params.amount ?? Math.min(summary.totalAvailable, totalOutstanding);

  if (amount <= 0.01) return { redemptions: [], totalApplied: 0 };

  if (amount > summary.totalAvailable + 0.01) {
    throw new CreditError(
      `Only MWK ${summary.totalAvailable.toLocaleString()} of credit is available for this customer.`
    );
  }
  if (amount > totalOutstanding + 0.01) {
    throw new CreditError(
      `This customer only owes MWK ${totalOutstanding.toLocaleString()} – cannot apply MWK ${amount.toLocaleString()} of credit against it.`
    );
  }

  let remaining = amount;
  let overpaymentPool = summary.overpaymentAvailable;
  let creditNotePool = summary.creditNoteAvailable;
  const redemptions = [];

  for (const sale of openSales) {
    if (remaining <= 0) break;

    const saleBalance = Number(sale.balance);
    const allocation = round2(Math.min(remaining, saleBalance));
    const fromOverpayment = round2(Math.min(allocation, overpaymentPool));
    const fromCreditNote = round2(allocation - fromOverpayment);

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

    if (fromOverpayment > 0) {
      const redemption = await tx.creditRedemption.create({
        data: { businessId, customerId, sourceType: "OVERPAYMENT", saleId: sale.id, amount: fromOverpayment, createdById },
      });
      redemptions.push(redemption);
      overpaymentPool = round2(overpaymentPool - fromOverpayment);
    }

    if (fromCreditNote > 0) {
      const redemption = await tx.creditRedemption.create({
        data: { businessId, customerId, sourceType: "CREDIT_NOTE", saleId: sale.id, amount: fromCreditNote, createdById },
      });
      redemptions.push(redemption);
      creditNotePool = round2(creditNotePool - fromCreditNote);

      await postJournalEntryForCreditRedemption({
        tx,
        businessId,
        redemptionId: redemption.id,
        kind: "SALE",
        amount: fromCreditNote,
        createdById,
      });
    }

    remaining = round2(remaining - allocation);
  }

  return { redemptions, totalApplied: round2(amount - remaining) };
}

/** Mirrors redeemCustomerCredit – see that function's doc comment for the full design. */
export async function redeemSupplierCredit(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  supplierId: string;
  amount?: number;
  createdById: string;
}) {
  const { tx, businessId, supplierId, createdById } = params;

  const summary = await getSupplierCreditSummary(businessId, supplierId, tx);

  const openPurchases = await tx.purchase.findMany({
    where: { businessId, supplierId, status: { in: ["PARTIAL", "CREDIT"] }, balance: { gt: 0 } },
    orderBy: { purchaseDate: "asc" },
  });
  const totalOutstanding = round2(openPurchases.reduce((sum, p) => sum + Number(p.balance), 0));

  const amount = params.amount ?? Math.min(summary.totalAvailable, totalOutstanding);

  if (amount <= 0.01) return { redemptions: [], totalApplied: 0 };

  if (amount > summary.totalAvailable + 0.01) {
    throw new CreditError(
      `Only MWK ${summary.totalAvailable.toLocaleString()} of credit is available for this supplier.`
    );
  }
  if (amount > totalOutstanding + 0.01) {
    throw new CreditError(
      `This supplier is only owed MWK ${totalOutstanding.toLocaleString()} – cannot apply MWK ${amount.toLocaleString()} of credit against it.`
    );
  }

  let remaining = amount;
  let overpaymentPool = summary.overpaymentAvailable;
  let creditNotePool = summary.creditNoteAvailable;
  const redemptions = [];

  for (const purchase of openPurchases) {
    if (remaining <= 0) break;

    const purchaseBalance = Number(purchase.balance);
    const allocation = round2(Math.min(remaining, purchaseBalance));
    const fromOverpayment = round2(Math.min(allocation, overpaymentPool));
    const fromCreditNote = round2(allocation - fromOverpayment);

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

    if (fromOverpayment > 0) {
      const redemption = await tx.creditRedemption.create({
        data: { businessId, supplierId, sourceType: "OVERPAYMENT", purchaseId: purchase.id, amount: fromOverpayment, createdById },
      });
      redemptions.push(redemption);
      overpaymentPool = round2(overpaymentPool - fromOverpayment);
    }

    if (fromCreditNote > 0) {
      const redemption = await tx.creditRedemption.create({
        data: { businessId, supplierId, sourceType: "CREDIT_NOTE", purchaseId: purchase.id, amount: fromCreditNote, createdById },
      });
      redemptions.push(redemption);
      creditNotePool = round2(creditNotePool - fromCreditNote);

      await postJournalEntryForCreditRedemption({
        tx,
        businessId,
        redemptionId: redemption.id,
        kind: "PURCHASE",
        amount: fromCreditNote,
        createdById,
      });
    }

    remaining = round2(remaining - allocation);
  }

  return { redemptions, totalApplied: round2(amount - remaining) };
}
