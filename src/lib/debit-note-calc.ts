/**
 * Supplier debit-note math, Module 44. PURE: no database, no framework. The server
 * (src/lib/debit-notes.ts), the debit note form (a client component) and
 * scripts/verify-debit-notes.ts all import this one file, so what the form previews is what the
 * server posts and what the script checks.
 *
 * WHAT A DEBIT NOTE IS HERE. The purchase-side mirror of src/lib/credit-note-calc.ts's CreditNote:
 * a document dated today that points at one purchase and gives part of it back to the supplier –
 * goods actually sent back (stockOut), or a price adjustment the supplier agreed to without goods
 * moving, or both. The purchase's own total and amount paid never change. See the
 * SupplierDebitNote model in prisma/schema.prisma.
 *
 * WHERE THIS DIFFERS FROM CREDIT NOTES, stated plainly, since the two are close enough that the
 * differences matter more than the similarities:
 *
 * 1. NO DISCOUNT SHARE. Purchase has no discount field (Sale.discount is a flat lump; nothing
 *    equivalent exists on Purchase), so there is no proportional-discount-return math here –
 *    PurchaseItem.total is already the whole line net. `net` and `netAmount` are the same number
 *    where CreditNote needed `netBeforeDiscount` vs `netAmount` to differ.
 *
 * 2. NO SEPARATE COST FIELD. A credit note reverses COST (Dr Inventory / Cr COGS) only for
 *    restocked units, separately from reversing REVENUE. A purchase has only one asset account –
 *    Inventory – so `netAmount` IS the inventory reversal; there is no second "cost" figure and no
 *    COGS entry. See postJournalEntryForDebitNote in accounting-integrations.ts: ONE entry, not two,
 *    mirroring how Purchase itself posts as one combined entry while Sale splits into two (Module 32
 *    documented this asymmetry when it found the Sale/Purchase refund VAT fix didn't apply evenly).
 *
 * 3. `stockOut` REPLACES `restock`, REVERSED IN MEANING. CreditNoteLine.restock = true means
 *    goods came BACK onto our shelf. SupplierDebitNoteLine.stockOut = true means goods LEFT our
 *    shelf, back to the supplier. Either way it only controls whether Product.quantity/StockLevel
 *    actually moves – the Inventory GL account falls by `net` regardless (see the model comment),
 *    same as CreditNote's Revenue account always falls regardless of `restock`.
 *
 * THE RULES THAT DO CARRY OVER UNCHANGED FROM CREDIT NOTES:
 *
 * - EVERY ITEM HAS A POOL, drawn down by earlier debit notes on the same purchase; a new debit can
 *   never take more than what is left.
 * - A RETURN TAKES A SHARE OF THE POOL LEFT, and the last unit takes exactly what remains, so a run
 *   of small debits ends on the exact purchase total with no rounding drift.
 * - A PRICE ADJUSTMENT NAMES AN AMOUNT (`netAmount`), with VAT following it in proportion to what
 *   is left in the pool.
 * - WHAT WE STILL OWE THE SUPPLIER IS REDUCED FIRST (Purchase.balance). Only the excess – money we
 *   had already paid – needs a decision: collect it in cash, or keep it as supplier credit.
 */

export type DebitVatCategory = "STANDARD" | "ZERO_RATED" | "EXEMPT";
export type DebitSettlementMethod = "CASH" | "SUPPLIER_CREDIT";
export type DebitSettlement = "NONE" | DebitSettlementMethod;

export class DebitNoteCalcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DebitNoteCalcError";
  }
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
export function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

const MONEY_EPS = 0.005;
const QTY_EPS = 0.0005;

export interface PurchaseForDebit {
  total: number;
  balance: number;
}

export interface PurchaseItemForDebit {
  id: string;
  productName: string;
  quantity: number;
  total: number; // PurchaseItem.total: net line total, VAT excluded
  vatAmount: number;
  vatCategory: DebitVatCategory;
  unitCost: number;
  /** Module 78: false = a service. A service line can be debited for money but never "sent back". */
  isStocked: boolean;
}

/** What earlier debit notes on this purchase have already taken from one item. */
export interface PriorDebitLine {
  purchaseItemId: string;
  quantity: number;
  net: number;
  vatAmount: number;
}

export interface DebitRequestLine {
  purchaseItemId: string;
  quantity: number;
  /** Net (before VAT) amount to debit. Omit for a proportional return of `quantity`. */
  netAmount?: number | null;
  stockOut: boolean;
}

export interface ItemPool {
  purchaseItemId: string;
  productName: string;
  quantity: number;
  net: number;
  vatAmount: number;
}

/** What is still debitable on every item. Also drives the form's "left to debit" column. */
export function computePools(items: PurchaseItemForDebit[], priors: PriorDebitLine[]): ItemPool[] {
  return items.map((item) => {
    const taken = priors.filter((p) => p.purchaseItemId === item.id);
    const q = taken.reduce((s, p) => s + p.quantity, 0);
    const n = taken.reduce((s, p) => s + p.net, 0);
    const v = taken.reduce((s, p) => s + p.vatAmount, 0);
    return {
      purchaseItemId: item.id,
      productName: item.productName,
      quantity: Math.max(0, round3(item.quantity - q)),
      net: Math.max(0, round2(item.total - n)),
      vatAmount: Math.max(0, round2(item.vatAmount - v)),
    };
  });
}

export interface ComputedDebitLine {
  purchaseItemId: string;
  productName: string;
  quantity: number;
  stockOut: boolean;
  net: number;
  vatAmount: number;
  vatCategory: DebitVatCategory;
  unitCost: number;
  /** Module 78: copied from the item so the ledger can post service lines to Service Cost Clearing. */
  isStocked: boolean;
}

export interface ComputedDebitNote {
  lines: ComputedDebitLine[];
  netAmount: number; // inventory cost basis reversed
  vatAmount: number;
  total: number;
  appliedToBalance: number;
  settledAmount: number;
}

export function computeDebitNote(params: {
  purchase: PurchaseForDebit;
  items: PurchaseItemForDebit[];
  priors: PriorDebitLine[];
  /** Sum of the totals of earlier debit notes on this purchase. */
  priorTotal: number;
  lines: DebitRequestLine[];
}): ComputedDebitNote {
  const { purchase, items, priors, lines } = params;

  if (lines.length === 0) throw new DebitNoteCalcError("Add at least one line to debit.");

  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.purchaseItemId)) {
      throw new DebitNoteCalcError("A purchase item can appear only once on a debit note. Combine the lines.");
    }
    seen.add(l.purchaseItemId);
  }

  const pools = computePools(items, priors);
  const computed: ComputedDebitLine[] = [];

  for (const line of lines) {
    const item = items.find((i) => i.id === line.purchaseItemId);
    const pool = pools.find((p) => p.purchaseItemId === line.purchaseItemId);
    if (!item || !pool) throw new DebitNoteCalcError("A debit line points at an item that is not on this purchase.");

    const qty = round3(line.quantity);
    if (!(qty >= 0)) throw new DebitNoteCalcError(`Quantity for ${item.productName} cannot be negative.`);
    const hasAmount = line.netAmount != null;
    const requestedNet = hasAmount ? round2(line.netAmount as number) : null;
    if (hasAmount && !(requestedNet! > 0)) {
      throw new DebitNoteCalcError(`The debit amount for ${item.productName} must be greater than zero.`);
    }
    if (qty <= QTY_EPS && !hasAmount) {
      throw new DebitNoteCalcError(`Enter a quantity or an amount for ${item.productName}.`);
    }
    if (line.stockOut && !item.isStocked) {
      throw new DebitNoteCalcError(`${item.productName} is a service, so nothing can be sent back. Untick "sent back to supplier".`);
    }
    if (line.stockOut && qty <= QTY_EPS) {
      throw new DebitNoteCalcError(
        `${item.productName}: only units actually sent back can leave stock. Enter a quantity or untick "sent back to supplier".`
      );
    }
    if (qty > pool.quantity + QTY_EPS) {
      throw new DebitNoteCalcError(
        `${item.productName}: only ${pool.quantity} left to debit on this purchase, tried to debit ${qty}.`
      );
    }

    let net: number;
    if (hasAmount) {
      if (requestedNet! > pool.net + MONEY_EPS) {
        throw new DebitNoteCalcError(
          `${item.productName}: only MWK ${pool.net.toLocaleString()} left to debit on this line, tried to debit MWK ${requestedNet!.toLocaleString()}.`
        );
      }
      net = requestedNet! >= pool.net - MONEY_EPS ? pool.net : requestedNet!;
    } else if (qty >= pool.quantity - QTY_EPS) {
      net = pool.net; // the last units: take exactly what is left
    } else {
      net = pool.quantity > 0 ? round2((pool.net * qty) / pool.quantity) : 0;
    }

    let vat: number;
    if (pool.net <= MONEY_EPS) vat = pool.vatAmount;
    else if (net >= pool.net - MONEY_EPS) vat = pool.vatAmount;
    else vat = round2((pool.vatAmount * net) / pool.net);

    computed.push({
      purchaseItemId: item.id,
      productName: item.productName,
      quantity: qty,
      stockOut: !!line.stockOut,
      net,
      vatAmount: vat,
      vatCategory: item.vatCategory,
      unitCost: item.unitCost,
      isStocked: item.isStocked,
    });
  }

  const netAmount = round2(computed.reduce((s, l) => s + l.net, 0));
  const vatAmount = round2(computed.reduce((s, l) => s + l.vatAmount, 0));

  const total = round2(netAmount + vatAmount);
  if (!(total > 0)) throw new DebitNoteCalcError("This debit note would be for nothing. Enter a quantity or an amount above zero.");

  const debitableLeft = round2(purchase.total - params.priorTotal);
  if (total > debitableLeft + 0.01) {
    throw new DebitNoteCalcError(
      `Only MWK ${Math.max(0, debitableLeft).toLocaleString()} of this purchase is left to debit, tried to debit MWK ${total.toLocaleString()}.`
    );
  }

  let appliedToBalance = round2(Math.min(total, Math.max(0, purchase.balance)));
  let settledAmount = round2(total - appliedToBalance);
  if (settledAmount < MONEY_EPS) {
    settledAmount = 0;
    appliedToBalance = total;
  }

  return { lines: computed, netAmount, vatAmount, total, appliedToBalance, settledAmount };
}

/**
 * What to do with the part of the debit that was money we'd already paid the supplier.
 * `settledAmount` of 0 needs no decision. Above 0 it needs one: collect it in cash, or keep it as
 * supplier credit. Unlike CreditNote's planSettlement, there is no "no customer to hold credit for"
 * branch – Purchase.supplierId is always set (a purchase always has a supplier), so SUPPLIER_CREDIT
 * is always available.
 */
export function planSettlement(params: {
  settledAmount: number;
  method?: DebitSettlementMethod | null;
  cashAccountId?: string | null;
}): { settlement: DebitSettlement; cashAccountId: string | null } {
  if (params.settledAmount <= MONEY_EPS) return { settlement: "NONE", cashAccountId: null };
  if (!params.method) {
    throw new DebitNoteCalcError(
      `MWK ${params.settledAmount.toLocaleString()} of this debit is money we already paid the supplier. Choose whether to collect it in cash or keep it as supplier credit.`
    );
  }
  if (params.method === "CASH") {
    if (!params.cashAccountId) throw new DebitNoteCalcError("Choose the cash account the money comes back into.");
    return { settlement: "CASH", cashAccountId: params.cashAccountId };
  }
  return { settlement: "SUPPLIER_CREDIT", cashAccountId: null };
}

/** The status a purchase takes after its balance falls: paid off once nothing is owed, otherwise unchanged. */
export function statusAfterBalance(current: "PAID" | "PARTIAL" | "CREDIT", newBalance: number): "PAID" | "PARTIAL" | "CREDIT" {
  return newBalance <= 0.01 ? "PAID" : current;
}

// ----------------------------------------------------------------------------
// Roll-up used by the VAT return, pure so the verify script can check it without a database.
// ----------------------------------------------------------------------------

export interface DebitNoteForRollup {
  issuedAt: Date;
  netAmount: number;
  vatAmount: number;
  total: number;
  lines: {
    net: number;
    vatAmount: number;
    vatCategory: DebitVatCategory;
    quantity: number;
    stockOut: boolean;
    unitCost: number;
    productId?: string;
    productName?: string;
  }[];
}

export function rollUpForVat(notes: DebitNoteForRollup[]) {
  const byCategory: Record<DebitVatCategory, number> = { STANDARD: 0, ZERO_RATED: 0, EXEMPT: 0 };
  let vat = 0;
  let total = 0;
  for (const n of notes) {
    for (const l of n.lines) byCategory[l.vatCategory] = round2(byCategory[l.vatCategory] + l.net);
    vat = round2(vat + n.vatAmount);
    total = round2(total + n.total);
  }
  return { count: notes.length, byCategory, vat, total };
}
