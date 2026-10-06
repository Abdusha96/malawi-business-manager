/**
 * MODULE 65 – SHORT / DAMAGED RECEIPT OF A STOCK TRANSFER (pure logic).
 *
 * Closes the KNOWN LIMITATION Module 55 documented the moment the in-transit
 * workflow shipped: receiving was all-or-nothing, so goods that arrived
 * damaged or short still had to be received in full and corrected
 * afterwards. This file decides, for one receipt, what each line actually
 * received and what the shortfall is worth. It is import-free (no Prisma, no
 * framework) so it is safe from server code and from the "use client"
 * workspace component alike, and so scripts/verify-stock-transfer-receipt.ts
 * can exercise it without a database – same split as vat-payment-direction.ts
 * and stale-transfer.ts.
 *
 * WHAT A SHORTFALL MEANS. At dispatch, createStockTransfer() posted a
 * TRANSFER_OUT that already took the goods off fromBranch's StockLevel AND
 * off the business-wide Product.quantity (recordInventoryMovement always
 * moves both). Receiving posts the matching TRANSFER_IN for what arrived. A
 * shortfall is therefore stock that is already gone from the quantity books;
 * the only thing still carrying it is the general ledger's Inventory account
 * (transfers never touched the GL), which is why the caller writes the
 * shortfall off at cost – see postJournalEntryForTransferShortfall().
 *
 * QUANTITIES are Decimal(14,3) in the schema, so they are compared in whole
 * thousandths here rather than as floats (0.1 + 0.2 style drift must never
 * turn a full receipt into a phantom shortfall).
 */

export const QUANTITY_DECIMALS = 3;
export const MAX_SHORTFALL_REASON_LENGTH = 200;

const SCALE = 10 ** QUANTITY_DECIMALS;

export interface DispatchedLine {
  id: string;
  productName: string;
  /** Quantity sent, as dispatched. */
  quantity: number;
  /** Per-unit cost used to value a shortfall (unitCostAtDispatch, else current cost). */
  unitCost: number;
}

export interface ReceiptLineInput {
  lineId: string;
  quantityReceived: number;
  shortfallReason?: string | null;
}

export interface ResolvedReceiptLine {
  lineId: string;
  productName: string;
  quantityDispatched: number;
  quantityReceived: number;
  shortfall: number;
  /** Trimmed reason when short; always null when received in full. */
  shortfallReason: string | null;
  unitCost: number;
  /** shortfall x unitCost, to 2dp. */
  shortfallValue: number;
  isShort: boolean;
}

export type ReceiptResolution =
  | {
      ok: true;
      lines: ResolvedReceiptLine[];
      shortLineCount: number;
      totalShortfallValue: number;
      /** true when EVERY line came in at zero – the whole transfer was lost or unusable. */
      receivedNothing: boolean;
    }
  | { ok: false; error: string };

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Whole thousandths, or null if the number has more than 3 decimals / isn't finite. */
function toMilli(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  const scaled = n * SCALE;
  const rounded = Math.round(scaled);
  // Tolerance well below one thousandth: absorbs binary-float representation
  // of values like 1.005 without letting a real 4th decimal through.
  if (Math.abs(scaled - rounded) > 1e-6) return null;
  return rounded;
}

/**
 * Resolves the per-line receipt for a transfer.
 *
 * `inputs` undefined (or empty) = "everything arrived in full" – exactly what
 * Module 55's body-less POST always meant, so an old client keeps working. A
 * line missing from a non-empty `inputs` also defaults to full: the person
 * only has to say which lines were different.
 *
 * Never guesses: an unknown or duplicated line id, a quantity above what was
 * sent, a negative or over-precise quantity, or a short line with no reason
 * is an error, not something quietly clamped.
 */
export function resolveReceipt(
  dispatched: DispatchedLine[],
  inputs: ReceiptLineInput[] | undefined | null
): ReceiptResolution {
  const byId = new Map(dispatched.map((l) => [l.id, l]));
  const supplied = new Map<string, ReceiptLineInput>();

  for (const input of inputs ?? []) {
    if (!byId.has(input.lineId)) {
      return { ok: false, error: "A line in the receipt doesn't belong to this transfer." };
    }
    if (supplied.has(input.lineId)) {
      return {
        ok: false,
        error: `${byId.get(input.lineId)!.productName} appears more than once in the receipt.`,
      };
    }
    supplied.set(input.lineId, input);
  }

  const lines: ResolvedReceiptLine[] = [];

  for (const line of dispatched) {
    const sentMilli = toMilli(line.quantity);
    if (sentMilli === null) {
      // Can't happen for data written through the schema; fail loud, not silent.
      return { ok: false, error: `${line.productName} has an unreadable dispatched quantity.` };
    }

    const input = supplied.get(line.id);
    let receivedMilli = sentMilli;
    let reason: string | null = null;

    if (input) {
      const parsed = toMilli(input.quantityReceived);
      if (parsed === null) {
        return {
          ok: false,
          error: `${line.productName}: quantity received must be a number with at most ${QUANTITY_DECIMALS} decimal places.`,
        };
      }
      if (parsed < 0) {
        return { ok: false, error: `${line.productName}: quantity received can't be negative.` };
      }
      if (parsed > sentMilli) {
        return {
          ok: false,
          error: `${line.productName}: can't receive more than was dispatched (${line.quantity}). Extra stock is a new transfer or a purchase, not a receipt.`,
        };
      }
      receivedMilli = parsed;

      if (receivedMilli < sentMilli) {
        reason = (input.shortfallReason ?? "").trim();
        if (!reason) {
          return {
            ok: false,
            error: `${line.productName}: a reason is required when less than the dispatched quantity arrived.`,
          };
        }
        if (reason.length > MAX_SHORTFALL_REASON_LENGTH) {
          return {
            ok: false,
            error: `${line.productName}: the shortfall reason is limited to ${MAX_SHORTFALL_REASON_LENGTH} characters.`,
          };
        }
      }
      // A reason supplied on a line that arrived in full is discarded, not
      // stored: there is no shortfall for it to explain.
    }

    const shortfallMilli = sentMilli - receivedMilli;
    const shortfall = shortfallMilli / SCALE;
    lines.push({
      lineId: line.id,
      productName: line.productName,
      quantityDispatched: sentMilli / SCALE,
      quantityReceived: receivedMilli / SCALE,
      shortfall,
      shortfallReason: shortfallMilli > 0 ? reason : null,
      unitCost: line.unitCost,
      shortfallValue: round2(shortfall * line.unitCost),
      isShort: shortfallMilli > 0,
    });
  }

  const shortLines = lines.filter((l) => l.isShort);
  return {
    ok: true,
    lines,
    shortLineCount: shortLines.length,
    totalShortfallValue: round2(shortLines.reduce((sum, l) => sum + l.shortfallValue, 0)),
    receivedNothing: lines.length > 0 && lines.every((l) => l.quantityReceived === 0),
  };
}

/**
 * Did this (already RECEIVED) line arrive short? `quantityReceived` NULL is a
 * receipt from before Module 65 (or a transfer that was never received) and
 * always means "in full" – the same null-means-legacy convention as
 * StockTransferLine.unitCostAtDispatch.
 */
export function lineShortfall(quantity: number, quantityReceived: number | null | undefined): number {
  if (quantityReceived === null || quantityReceived === undefined) return 0;
  const sent = toMilli(quantity);
  const got = toMilli(quantityReceived);
  if (sent === null || got === null) return 0;
  return Math.max(0, sent - got) / SCALE;
}

export function transferHasShortfall(
  lines: { quantity: number; quantityReceived: number | null | undefined }[]
): boolean {
  return lines.some((l) => lineShortfall(l.quantity, l.quantityReceived) > 0);
}
