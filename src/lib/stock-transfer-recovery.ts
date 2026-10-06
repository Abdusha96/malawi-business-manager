/**
 * MODULE 66 – RECOVERING STOCK WRITTEN OFF AS SHORT (pure logic).
 *
 * Closes the KNOWN LIMITATION Module 65 documented the moment short receipt
 * shipped: "a confirmed shortfall can't be edited or reversed". Real stock
 * that "didn't arrive" often does – the second truck, the bag found behind a
 * pallet, the courier that finally delivers. Until now the only correction
 * was a hand-built Manual Journal plus a stock adjustment; nothing tied the
 * recovered goods back to the transfer that lost them.
 *
 * This file decides, for one recovery, how much of each line's outstanding
 * shortfall the person is bringing back and what that is worth. It is
 * import-free (no Prisma, no framework) so it is safe from server code and
 * from the "use client" workspace alike, and so
 * scripts/verify-stock-transfer-recovery.ts can exercise it without a
 * database – same split as stock-transfer-receipt.ts.
 *
 * WHAT A RECOVERY MEANS. The receipt wrote the shortfall off at
 * dispatch-time cost (Dr Inventory Shrinkage / Cr Inventory) and left the
 * quantity books alone (TRANSFER_OUT had already removed the units). A
 * recovery is the exact mirror: TRANSFER_IN at the destination branch for the
 * recovered quantity, and the write-off reversed for those units at the SAME
 * cost the write-off used (Dr Inventory / Cr Inventory Shrinkage) – never
 * today's cost, or the shrinkage account would keep a residue that no real
 * loss explains.
 *
 * RECOVERY IS CUMULATIVE. A line can come back in several instalments; the
 * schema stores the running total (StockTransferLine.quantityRecovered) and
 * this file works out what is still outstanding: shortfall − recovered.
 *
 * QUANTITIES are Decimal(14,3) in the schema, so they are compared in whole
 * thousandths, never as floats.
 */

export const QUANTITY_DECIMALS = 3;
export const MAX_RECOVERY_NOTE_LENGTH = 200;

const SCALE = 10 ** QUANTITY_DECIMALS;

export interface RecoverableLine {
  id: string;
  productName: string;
  /** Quantity dispatched. */
  quantity: number;
  /** NULL = received before Module 65 (or not yet received): never short. */
  quantityReceived: number | null;
  /** Running total already recovered; NULL / 0 = nothing yet. */
  quantityRecovered: number | null;
  /** Per-unit cost the write-off used (unitCostAtDispatch, else current cost). */
  unitCost: number;
}

export interface RecoveryLineInput {
  lineId: string;
  quantityRecovered: number;
}

export interface ResolvedRecoveryLine {
  lineId: string;
  productName: string;
  /** Quantity brought back by THIS recovery. */
  quantity: number;
  /** Shortfall still missing before this recovery. */
  outstandingBefore: number;
  /** Shortfall still missing after this recovery. */
  outstandingAfter: number;
  /** New running total to store on the line. */
  recoveredTotal: number;
  unitCost: number;
  /** quantity x unitCost, to 2dp – the write-off being reversed. */
  value: number;
  /** true when this recovery closes the line's shortfall completely. */
  fullyRecovered: boolean;
}

export type RecoveryResolution =
  | {
      ok: true;
      lines: ResolvedRecoveryLine[];
      totalValue: number;
      lineCount: number;
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
  if (Math.abs(scaled - rounded) > 1e-6) return null;
  return rounded;
}

/**
 * The quantity of a (RECEIVED) line that is still missing: what arrived short
 * at receipt minus whatever has since been recovered. NULL received means a
 * pre-Module-65 or unreceived line and is never short. Never negative.
 */
export function outstandingShortfall(
  quantity: number,
  quantityReceived: number | null | undefined,
  quantityRecovered: number | null | undefined
): number {
  if (quantityReceived === null || quantityReceived === undefined) return 0;
  const sent = toMilli(quantity);
  const got = toMilli(quantityReceived);
  if (sent === null || got === null) return 0;
  const recovered = quantityRecovered === null || quantityRecovered === undefined ? 0 : toMilli(quantityRecovered);
  if (recovered === null) return 0;
  return Math.max(0, sent - got - recovered) / SCALE;
}

/** Quantity of a line already brought back (0 when none / legacy). */
export function lineRecovered(quantityRecovered: number | null | undefined): number {
  if (quantityRecovered === null || quantityRecovered === undefined) return 0;
  const r = toMilli(quantityRecovered);
  return r === null ? 0 : r / SCALE;
}

/** Does any line of this transfer still have stock missing? */
export function transferHasOutstandingShortfall(
  lines: {
    quantity: number;
    quantityReceived: number | null | undefined;
    quantityRecovered: number | null | undefined;
  }[]
): boolean {
  return lines.some((l) => outstandingShortfall(l.quantity, l.quantityReceived, l.quantityRecovered) > 0);
}

/** Has any of this transfer's lines had stock brought back? */
export function transferHasRecovery(lines: { quantityRecovered: number | null | undefined }[]): boolean {
  return lines.some((l) => lineRecovered(l.quantityRecovered) > 0);
}

/**
 * Resolves one recovery. Unlike a receipt there is no "omitted line means
 * full" default: recovering stock is a positive act, so only the lines the
 * person names are touched, and at least one must be named.
 *
 * Never guesses: an unknown or duplicated line id, a line that never arrived
 * short, a zero / negative / over-precise quantity, or a quantity above what
 * is still missing is an error, not something quietly clamped. One bad line
 * fails the whole recovery so nothing is half-applied.
 */
export function resolveRecovery(
  lines: RecoverableLine[],
  inputs: RecoveryLineInput[] | undefined | null
): RecoveryResolution {
  if (!inputs || inputs.length === 0) {
    return { ok: false, error: "Enter the quantity recovered on at least one line." };
  }

  const byId = new Map(lines.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const resolved: ResolvedRecoveryLine[] = [];

  for (const input of inputs) {
    const line = byId.get(input.lineId);
    if (!line) {
      return { ok: false, error: "A line in the recovery doesn't belong to this transfer." };
    }
    if (seen.has(input.lineId)) {
      return { ok: false, error: `${line.productName} appears more than once in the recovery.` };
    }
    seen.add(input.lineId);

    const parsed = toMilli(input.quantityRecovered);
    if (parsed === null) {
      return {
        ok: false,
        error: `${line.productName}: quantity recovered must be a number with at most ${QUANTITY_DECIMALS} decimal places.`,
      };
    }
    if (parsed <= 0) {
      return { ok: false, error: `${line.productName}: quantity recovered must be greater than zero.` };
    }

    const outstandingBefore = outstandingShortfall(line.quantity, line.quantityReceived, line.quantityRecovered);
    if (outstandingBefore <= 0) {
      return {
        ok: false,
        error: `${line.productName}: nothing is outstanding on this line – it arrived in full, or the shortfall has already been recovered.`,
      };
    }

    const outstandingMilli = toMilli(outstandingBefore)!;
    if (parsed > outstandingMilli) {
      return {
        ok: false,
        error: `${line.productName}: only ${outstandingBefore} is still missing, so ${parsed / SCALE} can't be recovered. Extra stock is a new transfer or a purchase, not a recovery.`,
      };
    }

    const alreadyMilli = toMilli(line.quantityRecovered ?? 0) ?? 0;
    const afterMilli = outstandingMilli - parsed;
    const quantity = parsed / SCALE;
    resolved.push({
      lineId: line.id,
      productName: line.productName,
      quantity,
      outstandingBefore,
      outstandingAfter: afterMilli / SCALE,
      recoveredTotal: (alreadyMilli + parsed) / SCALE,
      unitCost: line.unitCost,
      value: round2(quantity * line.unitCost),
      fullyRecovered: afterMilli === 0,
    });
  }

  return {
    ok: true,
    lines: resolved,
    totalValue: round2(resolved.reduce((sum, l) => sum + l.value, 0)),
    lineCount: resolved.length,
  };
}

/** Trims and validates the free-text note recorded with a recovery. */
export function validateRecoveryNote(note: string | null | undefined): { ok: true; note: string } | { ok: false; error: string } {
  const trimmed = (note ?? "").trim();
  if (!trimmed) {
    return { ok: false, error: "A note is required – say where the missing stock turned up." };
  }
  if (trimmed.length > MAX_RECOVERY_NOTE_LENGTH) {
    return { ok: false, error: `The note is limited to ${MAX_RECOVERY_NOTE_LENGTH} characters.` };
  }
  return { ok: true, note: trimmed };
}
