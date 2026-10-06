/**
 * Module 39 – the arithmetic behind a foreign exchange adjustment.
 *
 * PURE: no database, no Prisma import. It is shared by three callers that must
 * agree to the cent – the server (src/lib/foreign-exchange.ts, which is the
 * authority), the record form (a live "this comes to ..." preview), and
 * scripts/verify-foreign-exchange.ts.
 *
 * SIGN CONVENTION. Everything here is expressed as ONE signed number in the
 * business currency: positive = GAIN, negative = LOSS. "Gain" and "loss" are
 * always from the point of view of the CASH ACCOUNT being adjusted, which is an
 * asset: if the foreign currency it holds is now worth more in kwacha, the
 * account's carrying value goes up (a gain); worth less, it goes down (a loss).
 *
 *   gain = foreignAmount × (newRate − bookRate)
 *
 * e.g. USD 1,000 carried at MWK 1,700 and revalued at MWK 1,750 → +50,000.
 * Rates are "business-currency units per 1 unit of foreign currency".
 *
 * NOT COVERED (a liability such as a USD supplier invoice moves the OTHER way –
 * a higher rate is a LOSS). This module adjusts cash accounts only; see the
 * README's KNOWN LIMITATIONS for why receivables/payables are not included.
 */

export function round2(n: number): number {
  // Symmetric rounding (half away from zero) so a gain of +x and a loss of −x
  // always round to the same magnitude – Math.round alone rounds −0.5 the other way.
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round((Math.abs(n) + Number.EPSILON) * 100)) / 100;
}

export interface FxRateInput {
  foreignAmount: number; // how much foreign currency is held / was converted
  bookRate: number; // the rate the account is currently carried at
  newRate: number; // the rate being applied now
}

/** Signed gain (+) / loss (−) in the business currency from a foreign amount and two rates. */
export function computeFxGainLossFromRates(input: FxRateInput): number {
  const { foreignAmount, bookRate, newRate } = input;
  if (!(foreignAmount > 0)) throw new Error("The foreign amount must be greater than zero.");
  if (!(bookRate > 0) || !(newRate > 0)) throw new Error("Exchange rates must be greater than zero.");
  return round2(foreignAmount * (newRate - bookRate));
}

/** Turns a typed "gain/loss of X" into the signed convention above. */
export function signedFromDirection(direction: "GAIN" | "LOSS", amount: number): number {
  if (!(amount > 0)) throw new Error("The amount must be greater than zero.");
  const a = round2(amount);
  return direction === "GAIN" ? a : -a;
}

export interface FxJournalLine {
  accountId: string;
  debit?: number;
  credit?: number;
}

/**
 * The two-line entry for one adjustment. `signedAmount` must be non-zero.
 *
 *   gain: Dr cash account (carrying value up)   / Cr FX gain/loss
 *   loss: Dr FX gain/loss                       / Cr cash account (carrying value down)
 *
 * Always balances by construction (same figure on both sides).
 */
export function buildFxJournalLines(params: {
  cashGlAccountId: string;
  fxAccountId: string;
  signedAmount: number;
}): FxJournalLine[] {
  const { cashGlAccountId, fxAccountId, signedAmount } = params;
  const abs = round2(Math.abs(signedAmount));
  if (abs === 0) throw new Error("An exchange adjustment can't be zero.");
  return signedAmount > 0
    ? [
        { accountId: cashGlAccountId, debit: abs },
        { accountId: fxAccountId, credit: abs },
      ]
    : [
        { accountId: fxAccountId, debit: abs },
        { accountId: cashGlAccountId, credit: abs },
      ];
}

/** True when a currency code is the business's own currency (case-insensitive) – an "exchange" difference in it is meaningless. */
export function isBusinessCurrency(code: string, businessCurrency: string): boolean {
  return code.trim().toUpperCase() === businessCurrency.trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Module 40 – settling a foreign-currency Sale / Purchase.
//
// A document agreed in a foreign currency carries a BOOK rate (Sale/Purchase
// .exchangeRate). Its kwacha total and balance are the ledger truth. When the
// other party pays (or we pay) F units of the foreign currency at a SETTLEMENT
// rate S:
//
//   bookAmount = F x bookRate        – the kwacha cleared off the document balance
//   cashAmount = F x S               – the kwacha that actually moved
//   gain/loss  = the difference, signed from the BUSINESS's point of view
//
//   receiving (Sale):    gain = cash - book   (a stronger currency than booked is good)
//   paying (Purchase):   gain = book - cash   (a weaker currency than booked is good)
//
// PURE – shared by src/lib/foreign-settlement.ts, the settle form's live
// preview and scripts/verify-foreign-exchange.ts.
// ---------------------------------------------------------------------------

export type SettlementSide = "RECEIVE" | "PAY";

export interface SettlementResult {
  bookAmount: number;
  cashAmount: number;
  /** Signed, business's point of view: + gain, - loss. */
  gainLoss: number;
}

/** Foreign amount still owing on a document: kwacha balance ÷ book rate. */
export function foreignBalance(kwachaBalance: number, bookRate: number): number {
  if (!(bookRate > 0)) throw new Error("The document has no valid exchange rate.");
  return round2(kwachaBalance / bookRate);
}

export function computeSettlement(params: {
  side: SettlementSide;
  foreignAmount: number;
  bookRate: number;
  settlementRate: number;
  /** The document's current kwacha balance – a settlement can't exceed it. */
  balance: number;
}): SettlementResult {
  const { side, foreignAmount, bookRate, settlementRate, balance } = params;
  if (!(foreignAmount > 0)) throw new Error("The foreign amount must be greater than zero.");
  if (!(bookRate > 0) || !(settlementRate > 0)) throw new Error("Exchange rates must be greater than zero.");

  let bookAmount = round2(foreignAmount * bookRate);
  if (bookAmount > balance + 0.05) {
    throw new Error(
      `That is more than is still owing: ${foreignBalance(balance, bookRate).toLocaleString()} (MWK ${balance.toLocaleString()} at the booked rate).`
    );
  }
  // Paying the very last of a balance can miss by a few tambala through rounding
  // the foreign figure – snap so the document actually closes.
  if (Math.abs(bookAmount - balance) <= 0.05) bookAmount = round2(balance);
  if (!(bookAmount > 0)) throw new Error("That amount is too small to settle anything.");

  const cashAmount = round2(foreignAmount * settlementRate);
  const gainLoss = side === "RECEIVE" ? round2(cashAmount - bookAmount) : round2(bookAmount - cashAmount);
  return { bookAmount, cashAmount, gainLoss };
}

/**
 * The journal lines for one settlement. Always balances.
 *   RECEIVE: Dr cash (cashAmount) / Cr Accounts Receivable (bookAmount) / +- FX
 *   PAY:     Dr Accounts Payable (bookAmount) / Cr cash (cashAmount) / +- FX
 * A gain credits FX gain/loss, a loss debits it; zero adds no FX line.
 */
export function buildSettlementJournalLines(params: {
  side: SettlementSide;
  cashGlAccountId: string;
  controlAccountId: string; // Accounts Receivable or Accounts Payable
  fxAccountId: string;
  bookAmount: number;
  cashAmount: number;
  gainLoss: number;
}): FxJournalLine[] {
  const { side, cashGlAccountId, controlAccountId, fxAccountId } = params;
  const book = round2(params.bookAmount);
  const cash = round2(params.cashAmount);
  const g = round2(params.gainLoss);
  const lines: FxJournalLine[] =
    side === "RECEIVE"
      ? [
          { accountId: cashGlAccountId, debit: cash },
          { accountId: controlAccountId, credit: book },
        ]
      : [
          { accountId: controlAccountId, debit: book },
          { accountId: cashGlAccountId, credit: cash },
        ];
  if (g > 0) lines.push({ accountId: fxAccountId, credit: g });
  else if (g < 0) lines.push({ accountId: fxAccountId, debit: Math.abs(g) });
  return lines;
}

/** Cash that actually moved for a stored Payment: `amount` plus/minus its fxGainLoss. */
export function cashAmountForPayment(amount: number, fxGainLoss: number, side: SettlementSide): number {
  return round2(side === "RECEIVE" ? amount + fxGainLoss : amount - fxGainLoss);
}
