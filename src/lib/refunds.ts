import { prisma } from "./prisma";
import { Prisma, RefundMethod } from "@prisma/client";
import { postCashTransactionForRefund, getAccountBalance } from "./cashbook";
import { postJournalEntryForRefund } from "./accounting-integrations";
import { logAudit } from "./audit";
import { RefundInput } from "./validation";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export class RefundError extends Error {}

/**
 * How much of a voided Sale/Purchase's collected cash is still unresolved
 * – i.e. hasn't yet had a refund DECISION made against it (cash back,
 * credit note, or a deliberate write-off all count as "resolved", since
 * each is a real decision about where that money goes). Computed live from
 * Refund rows rather than a stored running total, same reasoning as every
 * other balance in this app (see the Customer model comment).
 */
export async function getRefundableAmount(params: {
  businessId: string;
  saleId?: string | null;
  purchaseId?: string | null;
}): Promise<{ amountPaid: number; alreadyResolved: number; refundable: number }> {
  const { businessId, saleId, purchaseId } = params;

  if (!!saleId === !!purchaseId) {
    throw new RefundError("Specify exactly one of saleId or purchaseId.");
  }

  const amountPaid = saleId
    ? Number(
        (await prisma.sale.findUniqueOrThrow({ where: { id: saleId }, select: { amountPaid: true } }))
          .amountPaid
      )
    : Number(
        (await prisma.purchase.findUniqueOrThrow({ where: { id: purchaseId! }, select: { amountPaid: true } }))
          .amountPaid
      );

  const refunds = await prisma.refund.findMany({
    where: { businessId, ...(saleId ? { saleId } : { purchaseId }) },
    select: { amount: true },
  });
  const alreadyResolved = round2(refunds.reduce((sum, r) => sum + Number(r.amount), 0));

  return { amountPaid, alreadyResolved, refundable: round2(amountPaid - alreadyResolved) };
}

/**
 * Voided Sales/Purchases that collected real cash and still have no (or an
 * incomplete) refund decision against them – the list a /refunds page
 * shows as "awaiting a decision". Only businessId-scoped, not paginated;
 * at SME volumes voids are rare enough that this stays small.
 */
export async function getPendingRefunds(businessId: string) {
  const [voidedSales, voidedPurchases] = await Promise.all([
    prisma.sale.findMany({
      where: { businessId, status: "VOIDED", amountPaid: { gt: 0 } },
      include: { customer: true, refunds: true },
      orderBy: { voidedAt: "desc" },
    }),
    prisma.purchase.findMany({
      where: { businessId, status: "VOIDED", amountPaid: { gt: 0 } },
      include: { supplier: true, refunds: true },
      orderBy: { voidedAt: "desc" },
    }),
  ]);

  const pendingSales = voidedSales
    .map((sale) => {
      const resolved = round2(sale.refunds.reduce((sum, r) => sum + Number(r.amount), 0));
      const refundable = round2(Number(sale.amountPaid) - resolved);
      return { sale, refundable };
    })
    .filter((s) => s.refundable > 0.01);

  const pendingPurchases = voidedPurchases
    .map((purchase) => {
      const resolved = round2(purchase.refunds.reduce((sum, r) => sum + Number(r.amount), 0));
      const refundable = round2(Number(purchase.amountPaid) - resolved);
      return { purchase, refundable };
    })
    .filter((p) => p.refundable > 0.01);

  return { pendingSales, pendingPurchases };
}

export async function listRefunds(businessId: string) {
  return prisma.refund.findMany({
    where: { businessId },
    include: {
      sale: { include: { customer: true } },
      purchase: { include: { supplier: true } },
      cashAccount: true,
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export async function getRefund(params: { businessId: string; refundId: string }) {
  const refund = await prisma.refund.findUnique({
    where: { id: params.refundId },
    include: {
      sale: { include: { customer: true } },
      purchase: { include: { supplier: true } },
      cashAccount: true,
    },
  });
  if (!refund || refund.businessId !== params.businessId) return null;
  return refund;
}

/**
 * THE only place a Refund is created – mirrors every other module's "one
 * function, one transaction" pattern (see createSale/createPurchase).
 *
 * A refund can only be issued against a Sale/Purchase that is already
 * VOIDED. That's a deliberate ordering, not a technical limitation: voiding
 * is "this transaction shouldn't count" (stock comes back, no cash
 * decision made), and a refund is the separate, explicit "and here's what
 * happens to the cash" decision – see the KNOWN GAP comments on
 * voidSale/voidPurchase this module closes.
 *
 * CREDIT_NOTE refunds post a real GL liability/asset (Customer Credits
 * Payable / Supplier Credits Receivable – see
 * src/lib/accounting-integrations.ts::postJournalEntryForRefund). Spending
 * that credit against a future sale/purchase – along with the older
 * "unallocated credit" overpayment gap from src/lib/customers.ts – is
 * handled by src/lib/credits.ts (Module 17), not here or in
 * applyCustomerPayment()/applySupplierPayment() directly.
 *
 * KNOWN LIMITATION (Module 18, VAT) – CLOSED by Module 32: a sale refund's
 * GL entry now apportions the VAT portion of the original sale out of
 * SALES_REVENUE and into VAT_OUTPUT_PAYABLE, computed below in proportion
 * to how much of the sale this refund covers (so a partial refund, or
 * several refunds against the same sale, only ever carve out their own
 * fair share of the sale's total VAT). A purchase refund needed no
 * equivalent change – see postJournalEntryForRefund's doc comment in
 * src/lib/accounting-integrations.ts for why voiding a Purchase already
 * fully reverses its VAT_INPUT_RECEIVABLE, leaving nothing for a refund to
 * carve out on that side.
 */
export async function createRefund(params: {
  businessId: string;
  userId: string;
  input: RefundInput;
}) {
  const { businessId, userId, input } = params;
  const kind: "SALE" | "PURCHASE" = input.saleId ? "SALE" : "PURCHASE";

  return prisma.$transaction(async (tx) => {
    let customerId: string | null = null;
    let supplierId: string | null = null;
    // Module 32: the original sale's own total/tax, kept from this same
    // fetch (both are immutable once a sale is created, unlike
    // amountPaid/balance) so createRefund doesn't need a second query just
    // to apportion VAT below.
    let saleTotal = 0;
    let saleTax = 0;

    if (kind === "SALE") {
      const sale = await tx.sale.findUnique({ where: { id: input.saleId! } });
      if (!sale || sale.businessId !== businessId) {
        throw new RefundError("Sale not found in this business.");
      }
      if (sale.status !== "VOIDED") {
        throw new RefundError("A sale must be voided before it can be refunded.");
      }
      customerId = sale.customerId;
      saleTotal = Number(sale.total);
      saleTax = Number(sale.tax);
    } else {
      const purchase = await tx.purchase.findUnique({ where: { id: input.purchaseId! } });
      if (!purchase || purchase.businessId !== businessId) {
        throw new RefundError("Purchase not found in this business.");
      }
      if (purchase.status !== "VOIDED") {
        throw new RefundError("A purchase must be voided before it can be refunded.");
      }
      supplierId = purchase.supplierId;
    }

    // Refundable amount check happens inside the transaction so two
    // concurrent refund requests against the same voided document can't
    // both succeed against the same "unresolved" balance.
    const existingRefunds = await tx.refund.findMany({
      where: { businessId, ...(kind === "SALE" ? { saleId: input.saleId! } : { purchaseId: input.purchaseId! }) },
      select: { amount: true },
    });
    const alreadyResolved = round2(existingRefunds.reduce((sum, r) => sum + Number(r.amount), 0));

    const amountPaid =
      kind === "SALE"
        ? Number(
            (await tx.sale.findUniqueOrThrow({ where: { id: input.saleId! }, select: { amountPaid: true } }))
              .amountPaid
          )
        : Number(
            (
              await tx.purchase.findUniqueOrThrow({
                where: { id: input.purchaseId! },
                select: { amountPaid: true },
              })
            ).amountPaid
          );

    const refundable = round2(amountPaid - alreadyResolved);
    if (input.amount > refundable + 0.01) {
      throw new RefundError(
        `Only MWK ${refundable.toLocaleString()} of this ${kind === "SALE" ? "sale" : "purchase"} remains unresolved – cannot refund MWK ${input.amount.toLocaleString()}.`
      );
    }

    let cashAccountType: string | undefined;
    if (input.method === "CASH") {
      const account = await tx.cashAccount.findUnique({ where: { id: input.cashAccountId! } });
      if (!account || account.businessId !== businessId || !account.isActive) {
        throw new RefundError("Cash account not found in this business.");
      }
      if (kind === "SALE") {
        // Money is leaving the business – make sure the account actually
        // holds it, same check transferBetweenAccounts does.
        const balance = await getAccountBalance(account.id);
        if (balance < input.amount) {
          throw new RefundError(
            `Insufficient balance in ${account.name}: has MWK ${balance.toLocaleString()}, tried to refund MWK ${input.amount.toLocaleString()}.`
          );
        }
      }
      cashAccountType = account.type;
    }

    // Atomically claim the next refund number – same numbering pattern as
    // every other document (Sale, Purchase, Invoice, Quotation, Journal Entry).
    const business = await tx.business.update({
      where: { id: businessId },
      data: { nextRefundNumber: { increment: 1 } },
    });
    const refundNumber = `${business.refundPrefix}-${String(business.nextRefundNumber - 1).padStart(6, "0")}`;

    const refund = await tx.refund.create({
      data: {
        businessId,
        refundNumber,
        saleId: input.saleId ?? undefined,
        purchaseId: input.purchaseId ?? undefined,
        amount: input.amount,
        method: input.method as RefundMethod,
        reason: input.reason,
        cashAccountId: input.method === "CASH" ? input.cashAccountId! : undefined,
        processedById: userId,
      },
    });

    if (input.method === "CASH") {
      await postCashTransactionForRefund({
        tx,
        businessId,
        refundId: refund.id,
        refundNumber,
        accountId: input.cashAccountId!,
        amount: input.amount,
        kind,
        createdById: userId,
      });
    }

    // Module 32: apportion this refund's share of the original sale's VAT
    // – e.g. a MWK 5,000 refund against a MWK 20,000 sale that included
    // MWK 2,400 VAT carves out MWK 600 (5,000/20,000 * 2,400), leaving the
    // remaining MWK 1,800 correctly still owed on the unrefunded MWK
    // 15,000. Always 0 for a non-VAT sale (saleTax is 0) and always 0 for
    // a purchase (saleTotal/saleTax are never set in that branch above).
    const vatAmount = saleTotal > 0 ? round2((input.amount / saleTotal) * saleTax) : 0;

    await postJournalEntryForRefund({
      tx,
      businessId,
      refundId: refund.id,
      refundNumber,
      kind,
      method: input.method,
      amount: input.amount,
      vatAmount,
      cashAccountType,
      createdById: userId,
    });

    await logAudit({
      tx,
      businessId,
      userId,
      action: "refund.create",
      entityType: "Refund",
      entityId: refund.id,
      metadata: {
        refundNumber,
        kind,
        method: input.method,
        amount: input.amount,
        saleId: input.saleId ?? null,
        purchaseId: input.purchaseId ?? null,
        customerId,
        supplierId,
      },
    });

    return tx.refund.findUniqueOrThrow({
      where: { id: refund.id },
      include: { sale: { include: { customer: true } }, purchase: { include: { supplier: true } }, cashAccount: true },
    });
  });
}

/**
 * Gross (not net-of-redemptions) CREDIT_NOTE total for a customer/supplier.
 * src/lib/credits.ts subtracts CreditRedemption rows from this to get what's
 * still available to spend – see that file for the full picture, including
 * the OVERPAYMENT credit source this function doesn't cover.
 */
export async function getCustomerCreditBalance(
  businessId: string,
  customerId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma
): Promise<number> {
  const refunds = await db.refund.findMany({
    where: { businessId, method: "CREDIT_NOTE", sale: { customerId } },
    select: { amount: true },
  });
  // Module 43: a credit note settled as CUSTOMER_CREDIT is the same kind of standing credit as a
  // CREDIT_NOTE refund. It sits in the same GL account (Customer Credits Payable), so it belongs in the
  // same pool and is spent by the same redemption (src/lib/credits.ts), which reads this function.
  const notes = await db.creditNote.aggregate({
    where: { businessId, customerId, settlement: "CUSTOMER_CREDIT" },
    _sum: { settledAmount: true },
  });
  return round2(refunds.reduce((sum, r) => sum + Number(r.amount), 0) + Number(notes._sum.settledAmount ?? 0));
}

export async function getSupplierCreditBalance(businessId: string, supplierId: string): Promise<number> {
  const refunds = await prisma.refund.findMany({
    where: { businessId, method: "CREDIT_NOTE", purchase: { supplierId } },
    select: { amount: true },
  });
  // Module 44: a supplier debit note settled as SUPPLIER_CREDIT is the same kind of standing credit
  // as a CREDIT_NOTE refund – mirrors the CreditNote/CUSTOMER_CREDIT extension above exactly. It sits
  // in the same GL account (Supplier Credits Receivable), so it belongs in the same pool and is spent
  // by the same redemption (src/lib/credits.ts::redeemSupplierCredit), which reads this function.
  const notes = await prisma.supplierDebitNote.aggregate({
    where: { businessId, supplierId, settlement: "SUPPLIER_CREDIT" },
    _sum: { settledAmount: true },
  });
  return round2(refunds.reduce((sum, r) => sum + Number(r.amount), 0) + Number(notes._sum.settledAmount ?? 0));
}
