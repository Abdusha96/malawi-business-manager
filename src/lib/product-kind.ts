/**
 * Module 77 - Non-stocked (service) products.
 *
 * PURE and import-free on purpose (same split as `quotation-line-mapping.ts`, `tax-installments.ts`): the
 * product form, the API routes and `recordInventoryMovement()` share ONE definition of what a non-stocked
 * product may and may not do.
 *
 * Background. Every product used to be goods: a sale took stock, a quotation line for a service had to be
 * linked to some real product at convert time, and the only way to sell labour or a delivery fee was a product
 * with a fake quantity that someone kept topping up. A non-stocked product is sold like any other, but it has
 * no quantity, no stock level, no reorder level, and costs nothing in cost of goods sold.
 *
 * The rules:
 *   - A SALE or a RETURN_IN (void or credit note restock) against a non-stocked product does nothing to stock.
 *     It must not fail: voiding a sale that included a delivery fee has to work.
 *   - Every other movement (purchase, adjustment, damage, transfer, stock take, opening stock, purchase
 *     return) is refused. There is nothing to move, and silently ignoring it would hide a mistake.
 *   - Module 78: a service has a cost too. `Product.purchasePrice` is what it costs to provide one unit (labour,
 *     a subcontractor, a delivery bill). The sale line snapshots it like any cost, and the ledger recognises it
 *     against Service Cost Clearing instead of Inventory (see `splitLineCosts` and `splitNetByKind`).
 *   - A purchase may buy a service. It adds no stock and debits Service Cost Clearing. A debit note on a
 *     service line is a price adjustment only; no goods can be "sent back".
 *   - A credit note on a service line cannot restock; there is nothing to put back on a shelf.
 *   - A product can become a service only when it holds no stock anywhere. Turning a stocked product into a
 *     service with 40 units on the shelf would strand their value in the ledger.
 */

/** Movement types that a non-stocked product accepts and ignores. Everything else is refused. */
const IGNORED_FOR_NON_STOCKED = new Set(["SALE", "RETURN_IN"]);

export type NonStockedMovementDecision = "SKIP" | "REFUSE";

/** What `recordInventoryMovement()` does for a non-stocked product. */
export function decideNonStockedMovement(type: string): NonStockedMovementDecision {
  return IGNORED_FOR_NON_STOCKED.has(type) ? "SKIP" : "REFUSE";
}

export function nonStockedRefusalMessage(productName: string): string {
  return `${productName} is a service with no stock, so stock can't be recorded against it.`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Module 78: splits the cost of a sale between goods (credited to Inventory) and services (credited to Service
 * Cost Clearing). Each line is quantity x the unit cost snapshotted on it.
 */
export function splitLineCosts(lines: { isStocked: boolean; quantity: number; unitCost: number }[]): {
  goodsCost: number;
  serviceCost: number;
} {
  let goods = 0;
  let service = 0;
  for (const l of lines) {
    const cost = l.quantity * l.unitCost;
    if (l.isStocked) goods += cost;
    else service += cost;
  }
  return { goodsCost: round2(goods), serviceCost: round2(service) };
}

/**
 * Module 78: splits a net (VAT excluded) amount between goods and services, for a purchase or a debit note.
 * The service part posts to Service Cost Clearing, the goods part to Inventory.
 */
export function splitNetByKind(lines: { isStocked: boolean; net: number }[]): { goodsNet: number; serviceNet: number } {
  let goods = 0;
  let service = 0;
  for (const l of lines) {
    if (l.isStocked) goods += l.net;
    else service += l.net;
  }
  return { goodsNet: round2(goods), serviceNet: round2(service) };
}

export type ProductKindInput = {
  isStocked: boolean;
  openingQuantity?: number | null;
  reorderLevel?: number | null;
  expiryDate?: string | null;
};

/**
 * Checks the stock-only fields against the kind. Returns a message for the first problem, or null.
 * A service with an opening quantity, a reorder level or an expiry date is refused rather than having the
 * value silently dropped, so nobody believes a service is being tracked.
 */
export function validateProductKind(input: ProductKindInput): string | null {
  if (input.isStocked) return null;
  if ((input.openingQuantity ?? 0) > 0) {
    return "A service has no stock, so it can't have an opening quantity.";
  }
  if ((input.reorderLevel ?? 0) > 0) {
    return "A service has no stock, so it can't have a reorder level.";
  }
  if (input.expiryDate) {
    return "A service has no stock, so it can't have an expiry date.";
  }
  return null;
}

export type KindChangeFacts = {
  /** Product.quantity, the business-wide total. */
  quantity: number;
  /** Count of StockLevel rows with a non-zero quantity. */
  nonZeroBranchLevels: number;
  /** Count of lines on IN_TRANSIT stock transfers for this product. */
  inTransitLines: number;
  /** Count of IN_PROGRESS stock takes holding a line for this product. */
  openStockTakeLines: number;
};

const QTY_EPS = 0.0005;

/**
 * Whether a product may change kind. Becoming a service needs every stock figure at zero and nothing in
 * flight. Becoming stocked again is always allowed (a service has no quantity to carry over).
 */
export function checkKindChange(currentIsStocked: boolean, nextIsStocked: boolean, facts: KindChangeFacts): string | null {
  if (currentIsStocked === nextIsStocked) return null;
  if (!currentIsStocked) return null;

  if (Math.abs(facts.quantity) > QTY_EPS) {
    return `This product still has ${facts.quantity} in stock. Adjust it to zero (sell it, write it off or transfer it out) before making it a service.`;
  }
  if (facts.nonZeroBranchLevels > 0) {
    return "A branch still holds stock of this product. Bring every branch to zero before making it a service.";
  }
  if (facts.inTransitLines > 0) {
    return "This product is on a stock transfer that is still in transit. Receive or cancel the transfer first.";
  }
  if (facts.openStockTakeLines > 0) {
    return "This product is on a stock take that is still in progress. Finish or delete the stock take first.";
  }
  return null;
}

/** Short label for lists. */
export function describeProductKind(isStocked: boolean): string {
  return isStocked ? "Stocked" : "Service";
}
