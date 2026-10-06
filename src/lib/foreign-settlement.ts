import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { postCashTransactionForPayment } from "./cashbook";
import { postJournalEntryForPayment } from "./accounting-integrations";
import { logAudit } from "./audit";
import { computeSettlement, foreignBalance, isBusinessCurrency, round2, type SettlementSide } from "./fx-calc";
import type { ForeignSettlementInput } from "./validation";

/**
 * Foreign-Currency Invoices & Realised Exchange Differences – Module 40.
 *
 * WHAT THIS ADDS ON TOP OF MODULE 39. Module 39 booked an exchange difference on
 * a CASH account. It could not touch receivables/payables, because a USD sale or
 * a ZAR purchase had no currency or rate to measure a difference against. Now a
 * Sale/Purchase can carry `currency` + `exchangeRate` (the BOOK rate), and this
 * file settles it.
 *
 * DESIGN CHOICES, stated plainly:
 *
 * 1. The kwacha document stays the ledger truth. Sale/Purchase `total`, `balance`
 *    and the AR/AP postings are unchanged and in kwacha, so customer/supplier
 *    balances, aging, VAT and the GL still agree with each other (the reason
 *    Module 39 refused to do this without a document-level rate). The foreign
 *    balance is COMPUTED (kwacha balance / book rate), never stored.
 *
 * 2. Booked at the document's rate, settled at the settlement rate. Paying F of
 *    the foreign currency clears F x bookRate off the document; the cash that
 *    actually moves is F x settlementRate; the difference is a REALISED exchange
 *    gain/loss posted to FOREIGN_EXCHANGE_GAIN_LOSS (Other Income / Other
 *    Expenses on the P&L, from Module 37/39). Direction is from the business's
 *    point of view: receiving a stronger currency than booked, or paying a weaker
 *    one, is a gain (see fx-calc.ts).
 *
 * 3. One posting path. The settlement creates an ordinary Payment row (so every
 *    existing balance/receipt/history view keeps working) and posts through the
 *    same postCashTransactionForPayment / postJournalEntryForPayment as every
 *    other payment – those two now honour Payment.fxGainLoss. No hand-rolled
 *    journal entry.
 *
 * 4. Claimed with a conditional write. The document row is updated only if its
 *    balance is still what we read (Module 38's lesson): two simultaneous
 *    settlements can't both clear the same balance.
 *
 * 5. Per-document only. The customer/supplier-level "pay what they owe, oldest
 *    first" payment (applyCustomerPayment / applySupplierPayment) is a KWACHA
 *    payment and clears foreign documents at their book rate – no difference is
 *    computed there. To recognise a difference, settle the document itself.
 */

export class ForeignSettlementError extends Error {}

/** Rejects a document currency that is the business's own – "foreign" must mean foreign. */
export async function assertForeignCurrencyAllowed(
  tx: Prisma.TransactionClient,
  businessId: string,
  currency: string | null | undefined
) {
  if (!currency) return;
  const business = await tx.business.findUnique({ where: { id: businessId }, select: { currency: true } });
  if (business && isBusinessCurrency(currency, business.currency)) {
    throw new ForeignSettlementError(
      `${currency.toUpperCase()} is this business's own currency – leave the currency blank for an ordinary document.`
    );
  }
}

export async function settleForeignDocument(params: { businessId: string; userId: string; input: ForeignSettlementInput }) {
  const { businessId, userId, input } = params;
  const side: SettlementSide = input.saleId ? "RECEIVE" : "PAY";

  return prisma.$transaction(async (tx) => {
    const doc =
      side === "RECEIVE"
        ? await tx.sale.findUnique({ where: { id: input.saleId! } })
        : await tx.purchase.findUnique({ where: { id: input.purchaseId! } });
    if (!doc || doc.businessId !== businessId) {
      throw new ForeignSettlementError(`${side === "RECEIVE" ? "Sale" : "Purchase"} not found in this business.`);
    }
    if (doc.status === "VOIDED") throw new ForeignSettlementError("This document has been voided.");
    if (!doc.currency || doc.exchangeRate == null) {
      throw new ForeignSettlementError("This document is in kwacha – record an ordinary payment instead.");
    }

    const balance = Number(doc.balance);
    if (balance <= 0.01) throw new ForeignSettlementError("Nothing is outstanding on this document.");

    let result;
    try {
      result = computeSettlement({
        side,
        foreignAmount: input.foreignAmount,
        bookRate: Number(doc.exchangeRate),
        settlementRate: input.settlementRate,
        balance,
      });
    } catch (err) {
      throw new ForeignSettlementError((err as Error).message);
    }

    const newAmountPaid = round2(Number(doc.amountPaid) + result.bookAmount);
    const newBalance = round2(balance - result.bookAmount);
    const data = { amountPaid: newAmountPaid, balance: newBalance, status: newBalance <= 0.01 ? ("PAID" as const) : ("PARTIAL" as const) };

    // Claim: only proceed if nobody changed the balance since we read it.
    const claimed =
      side === "RECEIVE"
        ? await tx.sale.updateMany({ where: { id: doc.id, businessId, balance: doc.balance, status: { not: "VOIDED" } }, data })
        : await tx.purchase.updateMany({ where: { id: doc.id, businessId, balance: doc.balance, status: { not: "VOIDED" } }, data });
    if (claimed.count === 0) {
      throw new ForeignSettlementError("This document changed while you were recording the payment. Reload and try again.");
    }

    const payment = await tx.payment.create({
      data: {
        businessId,
        ...(side === "RECEIVE"
          ? { saleId: doc.id, customerId: (doc as { customerId: string | null }).customerId ?? undefined }
          : { purchaseId: doc.id, supplierId: (doc as { supplierId: string }).supplierId }),
        amount: result.bookAmount,
        method: input.method,
        reference: input.reference ?? undefined,
        notes: input.notes ?? `${doc.currency} ${input.foreignAmount.toLocaleString()} at ${input.settlementRate}`,
        currency: doc.currency,
        foreignAmount: input.foreignAmount,
        settlementRate: input.settlementRate,
        fxGainLoss: result.gainLoss,
        recordedById: userId,
      },
    });

    await postCashTransactionForPayment({
      tx,
      businessId,
      paymentId: payment.id,
      createdById: userId,
      cashAccountId: side === "RECEIVE" ? input.cashAccountId : undefined,
    });
    await postJournalEntryForPayment({
      tx,
      businessId,
      paymentId: payment.id,
      amount: result.bookAmount,
      method: input.method,
      isCustomerSide: side === "RECEIVE",
      createdById: userId,
      fxGainLoss: result.gainLoss,
    });

    await logAudit({
      tx,
      businessId,
      userId,
      action: "payment.foreign_settlement",
      entityType: "Payment",
      entityId: payment.id,
      metadata: {
        documentId: doc.id,
        currency: doc.currency,
        foreignAmount: input.foreignAmount,
        bookRate: Number(doc.exchangeRate),
        settlementRate: input.settlementRate,
        bookAmount: result.bookAmount,
        cashAmount: result.cashAmount,
        gainLoss: result.gainLoss,
      },
    });

    return { payment, ...result, foreignBalanceAfter: foreignBalance(newBalance, Number(doc.exchangeRate)) };
  });
}

/**
 * Realised exchange differences booked by settlements, for one period – read
 * from Payment.fxGainLoss (a settlement is a Payment row). Voided documents keep
 * their payments, exactly like every other payment in this app (Module 9), so
 * they stay counted, matching what the GL shows.
 */
export async function getSettlementFxSummary(businessId: string, range?: { from?: Date; to?: Date }) {
  const rows = await prisma.payment.findMany({
    where: {
      businessId,
      currency: { not: null },
      ...(range?.from || range?.to
        ? { createdAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
        : {}),
    },
    select: { fxGainLoss: true },
  });
  let gains = 0;
  let losses = 0;
  for (const r of rows) {
    const v = Number(r.fxGainLoss);
    if (v > 0) gains += v;
    else losses += -v;
  }
  return { count: rows.length, gains: round2(gains), losses: round2(losses), net: round2(gains - losses) };
}
