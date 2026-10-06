/**
 * Credit note math, Module 43. PURE: no database, no framework. The server (src/lib/credit-notes.ts),
 * the credit note form (a client component) and scripts/verify-credit-notes.ts all import this one
 * file, so what the form previews is what the server posts and what the script checks.
 *
 * WHAT A CREDIT NOTE IS HERE. A document dated today that points at one sale and gives back part of
 * it: some units of a line (a return), or an amount off a line (a price adjustment). The sale's own
 * total and paid amount never change. See the CreditNote model in prisma/schema.prisma.
 *
 * THE RULES, stated plainly:
 *
 * 1. EVERY ITEM HAS A POOL. Each sale item starts with its own quantity, its own net (SaleItem.total,
 *    which is net of the line discount) and its own VAT. Earlier credit notes draw the pool down.
 *    A new credit can never take more than what is left.
 *
 * 2. A RETURN TAKES A SHARE OF THE POOL LEFT, not of the original. Returning 1 of 4 units takes a
 *    quarter of what is left, and returning the last unit takes exactly all that is left. That way
 *    a run of small credits ends on the exact sale total with no rounding drift.
 *
 * 3. A PRICE ADJUSTMENT NAMES AN AMOUNT. `netAmount` is the amount off the line, before VAT. VAT
 *    follows it in proportion to what is left in the pool. Quantity can be 0 (a discount given after
 *    the sale) or above 0 (goods returned at an agreed value).
 *
 * 4. THE SALE-LEVEL DISCOUNT COMES BACK IN PROPORTION. Sale.discount is a flat lump taken off the
 *    whole sale (never spread over lines, and it does not reduce VAT: see the vat.ts design notes).
 *    Crediting a line therefore returns a matching share of that discount, so crediting the whole
 *    sale returns exactly Sale.total. The share is worked out on the net credited; the credit that
 *    empties the sale takes whatever discount is still unreturned.
 *
 * 5. THE CUSTOMER'S OWN DEBT IS REDUCED FIRST. The credit is applied to what the customer still owes
 *    on this sale (Sale.balance). Only the excess, the part they had already paid, needs a decision:
 *    give it back in cash or keep it as customer credit.
 *
 * 6. COST COMES BACK ONLY FOR GOODS THAT WENT BACK ON THE SHELF. `restock` reverses the cost of the
 *    units (Dr Inventory, Cr Cost of Goods Sold) and moves stock. A damaged return or a price
 *    adjustment credits the customer but leaves the cost where it is: the goods are gone.
 */

export type CreditVatCategory = "STANDARD" | "ZERO_RATED" | "EXEMPT";
export type CreditSettlementMethod = "CASH" | "CUSTOMER_CREDIT";
export type CreditSettlement = "NONE" | CreditSettlementMethod;

export class CreditNoteCalcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditNoteCalcError";
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

export interface SaleForCredit {
  subtotal: number;
  discount: number;
  total: number;
  balance: number;
}

export interface SaleItemForCredit {
  id: string;
  productName: string;
  quantity: number;
  total: number; // SaleItem.total: net of the line discount, VAT excluded
  vatAmount: number;
  vatCategory: CreditVatCategory;
  unitCost: number;
  /** Module 78: false = a service. A service line can be credited for money but never restocked. */
  isStocked: boolean;
}

/** What earlier credit notes on this sale have already taken from one item. */
export interface PriorCreditLine {
  saleItemId: string;
  quantity: number;
  net: number;
  vatAmount: number;
}

export interface CreditRequestLine {
  saleItemId: string;
  quantity: number;
  /** Net (before VAT) amount to credit. Omit for a proportional return of `quantity`. */
  netAmount?: number | null;
  restock: boolean;
}

export interface ItemPool {
  saleItemId: string;
  productName: string;
  quantity: number;
  net: number;
  vatAmount: number;
}

/** What is still creditable on every item. Also drives the form's "left to credit" column. */
export function computePools(items: SaleItemForCredit[], priors: PriorCreditLine[]): ItemPool[] {
  return items.map((item) => {
    const taken = priors.filter((p) => p.saleItemId === item.id);
    const q = taken.reduce((s, p) => s + p.quantity, 0);
    const n = taken.reduce((s, p) => s + p.net, 0);
    const v = taken.reduce((s, p) => s + p.vatAmount, 0);
    return {
      saleItemId: item.id,
      productName: item.productName,
      quantity: Math.max(0, round3(item.quantity - q)),
      net: Math.max(0, round2(item.total - n)),
      vatAmount: Math.max(0, round2(item.vatAmount - v)),
    };
  });
}

export interface ComputedCreditLine {
  saleItemId: string;
  productName: string;
  quantity: number;
  restock: boolean;
  net: number;
  vatAmount: number;
  vatCategory: CreditVatCategory;
  unitCost: number;
  cost: number; // cost reversed for this line: 0 unless restock
}

export interface ComputedCreditNote {
  lines: ComputedCreditLine[];
  netBeforeDiscount: number;
  discountShare: number;
  netAmount: number; // revenue reversed
  vatAmount: number;
  total: number;
  appliedToBalance: number;
  settledAmount: number;
  costRestored: number;
}

export function computeCreditNote(params: {
  sale: SaleForCredit;
  items: SaleItemForCredit[];
  priors: PriorCreditLine[];
  /** Sum of Sale.discount shares returned by earlier credit notes on this sale. */
  priorDiscountShare: number;
  /** Sum of the totals of earlier credit notes on this sale. */
  priorTotal: number;
  lines: CreditRequestLine[];
}): ComputedCreditNote {
  const { sale, items, priors, lines } = params;

  if (lines.length === 0) throw new CreditNoteCalcError("Add at least one line to credit.");

  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.saleItemId)) {
      throw new CreditNoteCalcError("A sale item can appear only once on a credit note. Combine the lines.");
    }
    seen.add(l.saleItemId);
  }

  const pools = computePools(items, priors);
  const computed: ComputedCreditLine[] = [];

  for (const line of lines) {
    const item = items.find((i) => i.id === line.saleItemId);
    const pool = pools.find((p) => p.saleItemId === line.saleItemId);
    if (!item || !pool) throw new CreditNoteCalcError("A credit line points at an item that is not on this sale.");

    const qty = round3(line.quantity);
    if (!(qty >= 0)) throw new CreditNoteCalcError(`Quantity for ${item.productName} cannot be negative.`);
    const hasAmount = line.netAmount != null;
    const requestedNet = hasAmount ? round2(line.netAmount as number) : null;
    if (hasAmount && !(requestedNet! > 0)) {
      throw new CreditNoteCalcError(`The credit amount for ${item.productName} must be greater than zero.`);
    }
    if (qty <= QTY_EPS && !hasAmount) {
      throw new CreditNoteCalcError(`Enter a quantity or an amount for ${item.productName}.`);
    }
    if (line.restock && !item.isStocked) {
      throw new CreditNoteCalcError(`${item.productName} is a service, so nothing can go back into stock. Untick restock.`);
    }
    if (line.restock && qty <= QTY_EPS) {
      throw new CreditNoteCalcError(`${item.productName}: only returned units can go back into stock. Enter a quantity or untick restock.`);
    }
    if (qty > pool.quantity + QTY_EPS) {
      throw new CreditNoteCalcError(
        `${item.productName}: only ${pool.quantity} left to credit on this sale, tried to credit ${qty}.`
      );
    }

    let net: number;
    if (hasAmount) {
      if (requestedNet! > pool.net + MONEY_EPS) {
        throw new CreditNoteCalcError(
          `${item.productName}: only MWK ${pool.net.toLocaleString()} left to credit on this line, tried to credit MWK ${requestedNet!.toLocaleString()}.`
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
      saleItemId: item.id,
      productName: item.productName,
      quantity: qty,
      restock: !!line.restock,
      net,
      vatAmount: vat,
      vatCategory: item.vatCategory,
      unitCost: item.unitCost,
      cost: line.restock ? round2(qty * item.unitCost) : 0,
    });
  }

  const netBeforeDiscount = round2(computed.reduce((s, l) => s + l.net, 0));
  const vatAmount = round2(computed.reduce((s, l) => s + l.vatAmount, 0));
  const costRestored = round2(computed.reduce((s, l) => s + l.cost, 0));

  // Rule 4: the sale-level discount comes back in proportion, and the credit that empties the sale
  // takes whatever share is still unreturned.
  const discountLeft = Math.max(0, round2(sale.discount - params.priorDiscountShare));
  const poolNetBefore = round2(pools.reduce((s, p) => s + p.net, 0));
  const poolNetAfter = round2(poolNetBefore - netBeforeDiscount);
  let discountShare = 0;
  if (sale.discount > MONEY_EPS && sale.subtotal > MONEY_EPS) {
    discountShare =
      poolNetAfter <= MONEY_EPS ? discountLeft : Math.min(discountLeft, round2((sale.discount * netBeforeDiscount) / sale.subtotal));
    discountShare = Math.min(discountShare, netBeforeDiscount);
  }

  const netAmount = round2(netBeforeDiscount - discountShare);
  const total = round2(netAmount + vatAmount);
  if (!(total > 0)) throw new CreditNoteCalcError("This credit note would be for nothing. Enter a quantity or an amount above zero.");

  const creditableLeft = round2(sale.total - params.priorTotal);
  if (total > creditableLeft + 0.01) {
    throw new CreditNoteCalcError(
      `Only MWK ${Math.max(0, creditableLeft).toLocaleString()} of this sale is left to credit, tried to credit MWK ${total.toLocaleString()}.`
    );
  }

  let appliedToBalance = round2(Math.min(total, Math.max(0, sale.balance)));
  let settledAmount = round2(total - appliedToBalance);
  if (settledAmount < MONEY_EPS) {
    settledAmount = 0;
    appliedToBalance = total;
  }

  return { lines: computed, netBeforeDiscount, discountShare, netAmount, vatAmount, total, appliedToBalance, settledAmount, costRestored };
}

/**
 * What to do with the part of the credit the customer had already paid. `settledAmount` of 0 needs no
 * decision. Above 0 it needs one: cash out of an account, or customer credit (which needs a customer to
 * hold it against).
 */
export function planSettlement(params: {
  settledAmount: number;
  method?: CreditSettlementMethod | null;
  hasCustomer: boolean;
  cashAccountId?: string | null;
}): { settlement: CreditSettlement; cashAccountId: string | null } {
  if (params.settledAmount <= MONEY_EPS) return { settlement: "NONE", cashAccountId: null };
  if (!params.method) {
    throw new CreditNoteCalcError(
      `MWK ${params.settledAmount.toLocaleString()} of this credit is money the customer already paid. Choose whether to refund it in cash or keep it as customer credit.`
    );
  }
  if (params.method === "CASH") {
    if (!params.cashAccountId) throw new CreditNoteCalcError("Choose the cash account the refund is paid from.");
    return { settlement: "CASH", cashAccountId: params.cashAccountId };
  }
  if (!params.hasCustomer) {
    throw new CreditNoteCalcError("A walk-in sale has no customer to hold credit for. Refund the money in cash instead.");
  }
  return { settlement: "CUSTOMER_CREDIT", cashAccountId: null };
}

/** The status a sale takes after its balance falls: paid off once nothing is owed, otherwise unchanged. */
export function statusAfterBalance(current: "PAID" | "PARTIAL" | "CREDIT", newBalance: number): "PAID" | "PARTIAL" | "CREDIT" {
  return newBalance <= 0.01 ? "PAID" : current;
}

// ----------------------------------------------------------------------------
// Roll-ups used by the VAT return, the reports and the dashboard. Pure so the verify script can
// check them without a database.
// ----------------------------------------------------------------------------

export interface CreditNoteForRollup {
  issuedAt: Date;
  netAmount: number;
  vatAmount: number;
  total: number;
  costRestored: number;
  lines: {
    net: number;
    vatAmount: number;
    vatCategory: CreditVatCategory;
    quantity: number;
    restock: boolean;
    unitCost: number;
    productId?: string;
    productName?: string;
  }[];
}

export function rollUpForVat(notes: CreditNoteForRollup[]) {
  const byCategory: Record<CreditVatCategory, number> = { STANDARD: 0, ZERO_RATED: 0, EXEMPT: 0 };
  let vat = 0;
  let total = 0;
  for (const n of notes) {
    for (const l of n.lines) byCategory[l.vatCategory] = round2(byCategory[l.vatCategory] + l.net);
    vat = round2(vat + n.vatAmount);
    total = round2(total + n.total);
  }
  return { count: notes.length, byCategory, vat, total };
}
