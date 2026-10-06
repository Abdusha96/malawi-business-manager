import { prisma } from "./prisma";
import { postJournalEntryForForeignExchangeAdjustment } from "./accounting-integrations";
import { reverseJournalEntriesForReference } from "./accounting";
import { postCashTransactionForForeignExchangeAdjustment, reverseCashTransactionsForReference, getAccountBalance } from "./cashbook";
import { logAudit } from "./audit";
import { computeFxGainLossFromRates, signedFromDirection, isBusinessCurrency, round2 } from "./fx-calc";
import type { FxAdjustmentInput } from "./validation";

/**
 * Foreign Exchange Gains & Losses – Module 39.
 *
 * WHY THIS EXISTS. The books are in one currency (Business.currency, MWK by
 * default). A business that holds USD or ZAR – a forex bank account, dollars in
 * the till, an amount received from an export customer – sees the kwacha value
 * of that money move with the exchange rate, and until now had no account to
 * record the difference in and no journal-entry screen to record it by hand.
 * This module adds the account (FOREIGN_EXCHANGE_GAIN_LOSS), the P&L treatment
 * (Other Income / Other Expenses – see src/lib/pnl-layout.ts) and the one
 * posting path.
 *
 * DESIGN CHOICES, stated plainly:
 *
 * 1. NOT multi-currency accounting. Nothing here stores a foreign-currency
 *    balance or converts a transaction. A ForeignExchangeAdjustment records the
 *    KWACHA difference on a CashAccount that holds foreign currency, and the
 *    currency/amount/rates are a memo of how the figure was reached. The
 *    CashAccount is still a kwacha-carrying ledger; this moves its carrying
 *    value.
 *
 * 2. Cash accounts only. A gain/loss on a foreign-currency invoice
 *    (receivable/payable) is NOT handled: posting one to Accounts Receivable /
 *    Payable would make the GL disagree with the Customer/Supplier balances,
 *    which are computed from Sale.balance / Purchase.balance and know nothing
 *    about it. Doing that properly needs a currency and rate on each document –
 *    a separate, larger module. Stated as a KNOWN LIMITATION.
 *
 * 3. Two ledgers, one transaction. Cashbook ADJUSTMENT + GL entry, same
 *    discipline as every money movement here. The cash figure and the GL cash
 *    bucket therefore never diverge because of this module.
 *
 * 4. REALISED vs UNREALISED is a recorded classification, not a calculation.
 *    Both post identically; the kind is kept so an accountant (and, later, the
 *    tax estimate) can tell a period-end revaluation from a real conversion.
 *
 * 5. Two ways to state the figure. RATES: gain = foreignAmount × (newRate −
 *    bookRate), computed here from the memo fields so the stored amount can't
 *    disagree with the rates shown beside it. AMOUNT: the operator types the
 *    difference (e.g. straight off a bank advice). Either way the stored
 *    gainLossAmount is the figure that posted, and voiding reverses exactly it.
 *
 * 6. A loss can't be larger than what the account currently carries, and a gain
 *    can't be voided once the account no longer holds it – either would push the
 *    cashbook balance below zero, which no other function here allows.
 *
 * 7. No edit. Void and re-record, like Tax Payments: an edit would have to
 *    reverse and re-post anyway, and the void row is the audit trail.
 *
 * 8. Business-wide, branch-null – see the ForeignExchangeAdjustment model comment.
 */

export class ForeignExchangeError extends Error {}

export async function createForeignExchangeAdjustment(params: { businessId: string; userId: string; input: FxAdjustmentInput }) {
  const { businessId, userId, input } = params;

  const adjustmentDate = input.adjustmentDate ? new Date(input.adjustmentDate) : new Date();
  if (Number.isNaN(adjustmentDate.getTime())) throw new ForeignExchangeError("Invalid adjustment date.");
  // One day of slack so a date picked in a time zone ahead of the server's
  // (Malawi is UTC+2) isn't rejected as "the future". Same rule as Tax Payments.
  if (adjustmentDate.getTime() > Date.now() + 86_400_000) {
    throw new ForeignExchangeError("The adjustment date can't be in the future – record it once the rate is known.");
  }

  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { currency: true } });
  if (!business) throw new ForeignExchangeError("Business not found.");
  const currencyCode = input.currencyCode.trim().toUpperCase();
  if (isBusinessCurrency(currencyCode, business.currency)) {
    throw new ForeignExchangeError(`${currencyCode} is this business's own currency – an exchange difference needs a foreign currency (USD, ZAR, GBP, ...).`);
  }

  const account = await prisma.cashAccount.findUnique({ where: { id: input.cashAccountId } });
  if (!account || account.businessId !== businessId || !account.isActive) {
    throw new ForeignExchangeError("Cash account not found in this business.");
  }

  let signedAmount: number;
  let foreignAmount: number | null = null;
  let bookRate: number | null = null;
  let newRate: number | null = null;

  if (input.method === "RATES") {
    foreignAmount = input.foreignAmount ?? null;
    bookRate = input.bookRate ?? null;
    newRate = input.newRate ?? null;
    if (foreignAmount == null || bookRate == null || newRate == null) {
      throw new ForeignExchangeError("Enter the foreign amount and both exchange rates.");
    }
    try {
      signedAmount = computeFxGainLossFromRates({ foreignAmount, bookRate, newRate });
    } catch (err) {
      throw new ForeignExchangeError((err as Error).message);
    }
    if (signedAmount === 0) {
      throw new ForeignExchangeError("Those rates give no difference (or less than one tambala), so there is nothing to record.");
    }
  } else {
    if (input.direction == null || input.amount == null) throw new ForeignExchangeError("Choose gain or loss and enter the amount.");
    try {
      signedAmount = signedFromDirection(input.direction, input.amount);
    } catch (err) {
      throw new ForeignExchangeError((err as Error).message);
    }
    if (signedAmount === 0) throw new ForeignExchangeError("The amount is too small to record.");
  }

  if (signedAmount < 0) {
    const balance = await getAccountBalance(account.id);
    if (balance < Math.abs(signedAmount)) {
      throw new ForeignExchangeError(
        `A loss of MWK ${Math.abs(signedAmount).toLocaleString()} is more than the MWK ${balance.toLocaleString()} ${account.name} currently carries. ` +
          `Check the rates or the amount.`
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.business.update({
      where: { id: businessId },
      data: { nextFxAdjustmentNumber: { increment: 1 } },
    });
    const adjustmentNumber = `${updated.fxAdjustmentPrefix}-${String(updated.nextFxAdjustmentNumber - 1).padStart(6, "0")}`;

    const adjustment = await tx.foreignExchangeAdjustment.create({
      data: {
        businessId,
        adjustmentNumber,
        adjustmentDate,
        kind: input.kind,
        accountId: account.id,
        currencyCode,
        foreignAmount: foreignAmount ?? undefined,
        bookRate: bookRate ?? undefined,
        newRate: newRate ?? undefined,
        gainLossAmount: signedAmount,
        reference: input.reference ?? undefined,
        notes: input.notes ?? undefined,
        status: "RECORDED",
        recordedById: userId,
      },
    });

    await postCashTransactionForForeignExchangeAdjustment({
      tx,
      businessId,
      adjustmentId: adjustment.id,
      accountId: account.id,
      signedAmount,
      description: `Exchange ${signedAmount > 0 ? "gain" : "loss"} on ${currencyCode} – ${adjustmentNumber}`,
      createdById: userId,
    });

    await postJournalEntryForForeignExchangeAdjustment({
      tx,
      businessId,
      adjustmentId: adjustment.id,
      adjustmentNumber,
      kind: input.kind,
      currencyCode,
      cashAccountType: account.type,
      signedAmount,
      adjustmentDate,
      createdById: userId,
    });

    await logAudit({
      tx,
      businessId,
      userId,
      action: "forex.create",
      entityType: "ForeignExchangeAdjustment",
      entityId: adjustment.id,
      metadata: { adjustmentNumber, kind: input.kind, currencyCode, accountId: account.id, gainLossAmount: signedAmount },
    });

    return adjustment;
  });
}

/**
 * Reverses a recorded adjustment in BOTH ledgers (equal-and-opposite entries –
 * nothing is deleted) and keeps the row as VOIDED history. A conditional write
 * claims the row first, so two people voiding the same adjustment at once can't
 * both reverse it (the same read-then-write race Module 38 closed on quotations).
 */
export async function voidForeignExchangeAdjustment(params: { businessId: string; adjustmentId: string; userId: string; reason: string }) {
  const { businessId, adjustmentId, userId, reason } = params;

  const existing = await prisma.foreignExchangeAdjustment.findFirst({ where: { id: adjustmentId, businessId } });
  if (!existing) throw new ForeignExchangeError("Exchange adjustment not found.");
  if (existing.status !== "RECORDED") throw new ForeignExchangeError("This adjustment has already been voided.");

  const amount = Number(existing.gainLossAmount);
  if (amount > 0) {
    // Reversing a gain takes that much back out of the account.
    const balance = await getAccountBalance(existing.accountId);
    if (balance < amount) {
      throw new ForeignExchangeError(
        `Voiding this gain would take MWK ${amount.toLocaleString()} out of an account that now carries only MWK ${balance.toLocaleString()}. ` +
          `Record a corrected adjustment instead once the balance is restored.`
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.foreignExchangeAdjustment.updateMany({
      where: { id: adjustmentId, businessId, status: "RECORDED" },
      data: { status: "VOIDED", voidedAt: new Date(), voidedById: userId, voidReason: reason },
    });
    if (claimed.count === 0) throw new ForeignExchangeError("This adjustment has already been voided.");

    const why = `Exchange adjustment ${existing.adjustmentNumber} voided – ${reason}`;
    await reverseJournalEntriesForReference({
      tx,
      businessId,
      referenceType: "ForeignExchangeAdjustment",
      referenceId: existing.id,
      createdById: userId,
      reason: why,
    });
    await reverseCashTransactionsForReference({
      tx,
      businessId,
      referenceType: "ForeignExchangeAdjustment",
      referenceId: existing.id,
      createdById: userId,
      reason: why,
    });

    await logAudit({
      tx,
      businessId,
      userId,
      action: "forex.void",
      entityType: "ForeignExchangeAdjustment",
      entityId: existing.id,
      metadata: { adjustmentNumber: existing.adjustmentNumber, reason },
    });

    return tx.foreignExchangeAdjustment.findUniqueOrThrow({ where: { id: existing.id } });
  });
}

export async function listForeignExchangeAdjustments(businessId: string, filters: { kind?: string; status?: string } = {}) {
  return prisma.foreignExchangeAdjustment.findMany({
    where: {
      businessId,
      ...(filters.kind === "REALISED" || filters.kind === "UNREALISED" ? { kind: filters.kind } : {}),
      ...(filters.status === "RECORDED" || filters.status === "VOIDED" ? { status: filters.status } : {}),
    },
    include: { account: { select: { name: true, type: true } } },
    orderBy: [{ adjustmentDate: "desc" }, { createdAt: "desc" }],
    take: 500,
  });
}

export async function getForeignExchangeAdjustment(params: { businessId: string; adjustmentId: string }) {
  return prisma.foreignExchangeAdjustment.findFirst({
    where: { id: params.adjustmentId, businessId: params.businessId },
    include: { account: { select: { name: true, type: true } } },
  });
}

/** Totals over RECORDED adjustments only, split the way an accountant reads them. Pure over its input so the page and any report agree. */
export function summariseAdjustments(rows: { kind: string; status: string; gainLossAmount: unknown }[]) {
  let realisedNet = 0;
  let unrealisedNet = 0;
  for (const r of rows) {
    if (r.status !== "RECORDED") continue;
    const amt = Number(r.gainLossAmount);
    if (r.kind === "REALISED") realisedNet += amt;
    else unrealisedNet += amt;
  }
  return { realisedNet: round2(realisedNet), unrealisedNet: round2(unrealisedNet), net: round2(realisedNet + unrealisedNet) };
}
