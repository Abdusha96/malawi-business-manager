/**
 * Module 79 - Service Cost Clearing: per-service balance and settlement rules.
 *
 * PURE and import-free on purpose (same split as `product-kind.ts`, `tax-installments.ts`): the server
 * (`service-cost-clearing-run.ts`), the page, and `scripts/verify-service-cost-clearing.ts` share ONE definition
 * of what the balance is and what a settlement may do.
 *
 * Background. Module 78 gave a service a cost. When a service is SOLD its cost is credited to account 1210
 * Service Cost Clearing; when the supplier's BILL is recorded the cost is debited there; a debit note credits it.
 * The two sides rarely agree to the tambala, and until now the difference just sat in the account forever.
 *
 * Sign convention: DEBIT POSITIVE, in whole TAMBALA (integers). Floating-point sums of 2-decimal amounts do not
 * balance reliably (0.1 + 0.2 !== 0.3), so every figure is converted once and only integers are added.
 *
 *   balance = billed - debited - recognised - costUp + costDown
 *
 *   billed      supplier bills for the service (purchase lines, net of VAT, purchase not voided)
 *   debited     debit notes against those bills (net)
 *   recognised  cost taken on sales (quantity x the unit cost snapshotted on the line, sale not voided)
 *   costUp      settlements that recognised MORE cost  (Dr Cost of Goods Sold / Cr Clearing)
 *   costDown    settlements that recognised LESS cost  (Dr Clearing / Cr Cost of Goods Sold)
 *
 * A debit balance (> 0) means we have been billed for more than we have recognised on sales: cost bought but not
 * yet sold, or sold at a cost lower than the bill. A credit balance (< 0) means we recognised cost on sales that
 * the supplier has not billed (yet). Neither is wrong by itself: both are normal while work is in flight. A
 * settlement is the deliberate decision that the remaining difference is final, so it is never automatic.
 *
 * Module 80 adds three things on the same footing: how long a balance has sat (`balanceAgeDays`), which balances
 * count as "aged" for the bell alert (`isAgedBalance`, `summariseAgedBalances`), and the rules for settling several
 * services in one go (`planBulkSettlement`). Still pure: the clock is passed in as epoch milliseconds.
 */

/** Differences up to this many tambala between the ledger and the per-service total are put down to rounding. */
export const ROUNDING_NOISE_TAMBALA = 10;

export const MAX_SETTLEMENT_REASON_LENGTH = 200;

// Module 80. Bounds are enforced on write (validation.ts::businessServiceCostAlertDaysSchema), not by the column.
export const DEFAULT_SERVICE_COST_ALERT_DAYS = 30;
export const MIN_SERVICE_COST_ALERT_DAYS = 7;
export const MAX_SERVICE_COST_ALERT_DAYS = 365;
/** A leftover under K1.00 is rounding dust, never worth a bell alert (the per-service rounding gap can be a few tambala). */
export const MIN_ALERT_BALANCE_TAMBALA = 100;
/** One bulk settlement names at most this many services. */
export const MAX_BULK_SETTLEMENT_SERVICES = 200;

export type SettlementDirection = "COST_UP" | "COST_DOWN";

/** Money to whole tambala. Not finite -> 0 (callers feed it database decimals, never user input). */
export function toTambala(amount: number | null | undefined): number {
  if (amount === null || amount === undefined || typeof amount !== "number" || !Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

/** Whole tambala -> kwacha number. */
export function fromTambala(t: number): number {
  return t / 100;
}

export interface ServiceClearingFacts {
  productId: string;
  name: string;
  sku?: string | null;
  /** Supplier bills, net of VAT, whole tambala. */
  billed: number;
  /** Debit notes, net, whole tambala. */
  debited: number;
  /** Cost recognised on sales, whole tambala. */
  recognised: number;
  /** Recorded (not voided) COST_UP settlements, whole tambala. */
  costUp: number;
  /** Recorded (not voided) COST_DOWN settlements, whole tambala. */
  costDown: number;
  /**
   * Module 80: epoch milliseconds of the latest event that touched this balance (a sale, a supplier bill, a debit
   * note or a recorded settlement). Optional: absent/null = unknown, and an unknown age is never called aged.
   */
  lastActivityMs?: number | null;
}

/** The service's balance in Service Cost Clearing, debit positive, whole tambala. */
export function clearingBalance(f: Pick<ServiceClearingFacts, "billed" | "debited" | "recognised" | "costUp" | "costDown">): number {
  return f.billed - f.debited - f.recognised - f.costUp + f.costDown;
}

export type ClearingState = "SETTLED" | "BILLED_NOT_SOLD" | "SOLD_NOT_BILLED";

/** Plain-language state of one balance. */
export function classifyClearingBalance(balance: number): ClearingState {
  if (balance === 0) return "SETTLED";
  return balance > 0 ? "BILLED_NOT_SOLD" : "SOLD_NOT_BILLED";
}

export function describeClearingState(state: ClearingState): string {
  switch (state) {
    case "SETTLED":
      return "Nothing left over";
    case "BILLED_NOT_SOLD":
      return "Billed by the supplier, cost not yet taken on a sale";
    case "SOLD_NOT_BILLED":
      return "Cost taken on sales, supplier has not billed it";
  }
}

export interface ClearingRow extends ServiceClearingFacts {
  balance: number;
  state: ClearingState;
  /** Whole days since the balance was last touched; null when unknown or when no clock was given. */
  ageDays: number | null;
  /** True when the leftover is big enough to matter and older than the business's alert threshold. */
  aged: boolean;
}

export type UnattributedKind = "NONE" | "ROUNDING" | "REVIEW";

export interface ClearingReport {
  rows: ClearingRow[];
  /** Sum of every per-service balance. */
  productsTotal: number;
  /** What the ledger says account 1210 holds, debit positive. */
  ledgerBalance: number;
  /** ledgerBalance - productsTotal: what the per-service figures cannot explain. */
  unattributed: number;
  unattributedKind: UnattributedKind;
  unattributedNote: string | null;
  /** Services that still have a balance, i.e. the ones a person might settle. */
  openCount: number;
  /** Module 80: how many of those are aged (always 0 when no alert threshold was given). */
  agedCount: number;
}

/**
 * Builds the report. Rows that are fully settled AND never had any activity are dropped; a settled service with
 * history stays visible (balance 0) so the person can see it was cleared. Largest absolute balance first, then
 * name, so the order is stable.
 */
export function buildClearingReport(
  facts: ServiceClearingFacts[],
  ledgerBalance: number,
  clock?: { alertDays: number; nowMs: number }
): ClearingReport {
  const rows: ClearingRow[] = [];
  for (const f of facts) {
    const balance = clearingBalance(f);
    const hasActivity = f.billed !== 0 || f.debited !== 0 || f.recognised !== 0 || f.costUp !== 0 || f.costDown !== 0;
    if (!hasActivity) continue;
    const ageDays = clock ? balanceAgeDays(f.lastActivityMs, clock.nowMs) : null;
    const aged = clock ? isAgedBalance(balance, ageDays, clock.alertDays) : false;
    rows.push({ ...f, balance, state: classifyClearingBalance(balance), ageDays, aged });
  }
  rows.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance) || a.name.localeCompare(b.name));

  const productsTotal = rows.reduce((sum, r) => sum + r.balance, 0);
  const unattributed = ledgerBalance - productsTotal;
  let kind: UnattributedKind = "NONE";
  let note: string | null = null;
  if (unattributed !== 0) {
    if (Math.abs(unattributed) <= ROUNDING_NOISE_TAMBALA) {
      kind = "ROUNDING";
      note =
        "A few tambala of rounding: the ledger rounds each sale's service cost once, this page rounds each service once.";
    } else {
      kind = "REVIEW";
      note =
        "The ledger holds more or less than the services above explain. Likely causes: a journal entry posted straight to " +
        "this account, or a product that was stocked when it was sold or bought and became a service later. " +
        "Look at the account in the Chart of Accounts before settling anything.";
    }
  }

  return {
    rows,
    productsTotal,
    ledgerBalance,
    unattributed,
    unattributedKind: kind,
    unattributedNote: note,
    openCount: rows.filter((r) => r.balance !== 0).length,
    agedCount: rows.filter((r) => r.aged).length,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Module 80 - ageing
// ---------------------------------------------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/**
 * Whole days since `lastActivityMs`. Unknown (null/undefined/not finite) = null, never 0, so a service with no
 * recorded date is not mistaken for a brand-new one OR for an old one. A date in the future (clock skew, a
 * post-dated sale) counts as 0 days, never negative.
 */
export function balanceAgeDays(lastActivityMs: number | null | undefined, nowMs: number): number | null {
  if (lastActivityMs === null || lastActivityMs === undefined || !Number.isFinite(lastActivityMs) || !Number.isFinite(nowMs)) {
    return null;
  }
  return Math.max(0, Math.floor((nowMs - lastActivityMs) / MS_PER_DAY));
}

/** A leftover is aged when it is at least K1.00 (either side) and has sat for `alertDays` or more. Unknown age: never. */
export function isAgedBalance(balance: number, ageDays: number | null, alertDays: number): boolean {
  if (ageDays === null) return false;
  if (!Number.isInteger(alertDays) || alertDays < 1) return false;
  return Math.abs(balance) >= MIN_ALERT_BALANCE_TAMBALA && ageDays >= alertDays;
}

export interface AgedBalanceSummary {
  count: number;
  /** Sum of the absolute leftovers, whole tambala. */
  totalAbs: number;
  oldestDays: number;
  oldestName: string;
  /** Escalates once the oldest has sat for twice the threshold (same fixed 2x rule as the stale-transfer alert). */
  severity: "WARNING" | "URGENT";
}

/** What the bell alert says. null = nothing is aged, so the alert should be resolved. */
export function summariseAgedBalances(rows: ClearingRow[], alertDays: number): AgedBalanceSummary | null {
  const aged = rows.filter((r) => r.aged && r.ageDays !== null);
  if (aged.length === 0) return null;
  let oldest = aged[0];
  for (const r of aged) if ((r.ageDays ?? 0) > (oldest.ageDays ?? 0)) oldest = r;
  const oldestDays = oldest.ageDays ?? 0;
  return {
    count: aged.length,
    totalAbs: aged.reduce((sum, r) => sum + Math.abs(r.balance), 0),
    oldestDays,
    oldestName: oldest.name,
    severity: oldestDays >= alertDays * 2 ? "URGENT" : "WARNING",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Module 80 - settling several services at once
// ---------------------------------------------------------------------------------------------------------------

export interface BulkSettlementRequestItem {
  productId: string;
  /** The leftover the person SAW on screen, in kwacha, debit positive. The server refuses if it has moved since. */
  expectedBalance: number;
}

export type BulkItemPlan =
  | { productId: string; name: string; action: "SETTLE"; balance: number }
  | { productId: string; name: string; action: "SKIP"; message: string };

export type BulkPlan = { ok: true; items: BulkItemPlan[] } | { ok: false; message: string };

/**
 * Decides, per service, whether a bulk settlement will try it. A bulk settlement ALWAYS clears the whole leftover
 * (a part amount per service would be a form per row, and a part settlement is what the single Settle is for),
 * with ONE shared reason.
 *
 * Request-level refusals (nothing is attempted): no services, more than MAX_BULK_SETTLEMENT_SERVICES, the same
 * service named twice, a bad reason, an expected balance that is not a number of kwacha with at most 2 decimals.
 * Item-level skips (the others still go ahead): service unknown or not a service, nothing left over, or the
 * leftover is no longer what the person saw. The server repeats the balance check inside each service's own
 * locked transaction, so this plan is advisory about the first two and the lock is the authority on the third.
 */
export function planBulkSettlement(items: BulkSettlementRequestItem[], current: ClearingRow[], reason: string | null | undefined): BulkPlan {
  const reasonProblem = validateSettlementReason(reason);
  if (reasonProblem) return { ok: false, message: reasonProblem };
  if (!Array.isArray(items) || items.length === 0) return { ok: false, message: "Choose at least one service to settle." };
  if (items.length > MAX_BULK_SETTLEMENT_SERVICES) {
    return { ok: false, message: `Choose at most ${MAX_BULK_SETTLEMENT_SERVICES} services at a time.` };
  }
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.productId)) return { ok: false, message: "A service is listed twice. List each service once." };
    seen.add(it.productId);
    if (typeof it.expectedBalance !== "number" || !Number.isFinite(it.expectedBalance)) {
      return { ok: false, message: "Each service needs the leftover you saw, as a number." };
    }
    const scaled = it.expectedBalance * 100;
    if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
      return { ok: false, message: "A leftover can have at most two decimal places." };
    }
  }

  const byId = new Map(current.map((r) => [r.productId, r]));
  const plans: BulkItemPlan[] = items.map((it) => {
    const row = byId.get(it.productId);
    if (!row) return { productId: it.productId, name: "Unknown service", action: "SKIP", message: "Service not found, or it has no activity in Service Cost Clearing." };
    if (row.balance === 0) return { productId: it.productId, name: row.name, action: "SKIP", message: "Nothing left over to settle." };
    const expected = toTambala(it.expectedBalance);
    if (expected !== row.balance) {
      return {
        productId: it.productId,
        name: row.name,
        action: "SKIP",
        message: `The leftover changed since you looked (you saw ${formatTambala(expected)}, it is now ${formatTambala(row.balance)}). Review it and settle it on its own.`,
      };
    }
    return { productId: it.productId, name: row.name, action: "SETTLE", balance: row.balance };
  });
  return { ok: true, items: plans };
}

export type SettlementPlan =
  | { ok: true; direction: SettlementDirection; amount: number; balanceAfter: number }
  | { ok: false; message: string };

export function validateSettlementReason(reason: string | null | undefined): string | null {
  const t = (reason ?? "").trim();
  if (t.length === 0) return "A reason is required, for example \"Supplier bill is final\" or \"Job closed\".";
  if (t.length > MAX_SETTLEMENT_REASON_LENGTH) return `The reason is too long (${MAX_SETTLEMENT_REASON_LENGTH} characters at most).`;
  return null;
}

/**
 * Decides what settling a service's balance does.
 *
 * Rules:
 *   - a balance of exactly 0 has nothing to settle;
 *   - the direction is DERIVED from the balance, never chosen: a debit balance is cleared by recognising more cost
 *     (COST_UP), a credit balance by recognising less (COST_DOWN). A settlement can never push a balance past zero;
 *   - `amount` omitted = the whole balance. A part settlement must be > 0, at most 2 decimals, at most the balance;
 *   - a reason is required (trimmed, max 200).
 *
 * `amount` is in kwacha as typed; `balance` is whole tambala. The returned amount is whole tambala.
 */
export function planSettlement(balance: number, input: { amount?: number | null; reason?: string | null }): SettlementPlan {
  const reasonProblem = validateSettlementReason(input.reason);
  if (reasonProblem) return { ok: false, message: reasonProblem };
  if (!Number.isInteger(balance)) return { ok: false, message: "The balance is not a whole number of tambala." };
  if (balance === 0) return { ok: false, message: "This service has nothing left over to settle." };

  const outstanding = Math.abs(balance);
  let amount = outstanding;
  if (input.amount !== undefined && input.amount !== null) {
    if (typeof input.amount !== "number" || !Number.isFinite(input.amount)) {
      return { ok: false, message: "Enter the amount as a number." };
    }
    const scaled = input.amount * 100;
    const rounded = Math.round(scaled);
    if (Math.abs(scaled - rounded) > 1e-6) {
      return { ok: false, message: "An amount can have at most two decimal places." };
    }
    if (rounded <= 0) return { ok: false, message: "The amount must be more than zero." };
    if (rounded > outstanding) {
      return {
        ok: false,
        message: `The amount is more than what is left over (${formatTambala(outstanding)}). A settlement can only clear the difference, not reverse it.`,
      };
    }
    amount = rounded;
  }

  const direction: SettlementDirection = balance > 0 ? "COST_UP" : "COST_DOWN";
  const balanceAfter = balance > 0 ? balance - amount : balance + amount;
  return { ok: true, direction, amount, balanceAfter };
}

/**
 * The ledger lines for a settlement. Account ids are passed in so this stays pure.
 *   COST_UP   Dr Cost of Goods Sold / Cr Service Cost Clearing
 *   COST_DOWN Dr Service Cost Clearing / Cr Cost of Goods Sold
 * Amounts are kwacha numbers (what postJournalEntry takes), converted from whole tambala.
 */
export function settlementJournalLines(
  direction: SettlementDirection,
  amountTambala: number,
  accounts: { cogsAccountId: string; clearingAccountId: string }
): { accountId: string; debit?: number; credit?: number; description: string }[] {
  const amount = fromTambala(amountTambala);
  if (direction === "COST_UP") {
    return [
      { accountId: accounts.cogsAccountId, debit: amount, description: "Service cost settled to cost of goods sold" },
      { accountId: accounts.clearingAccountId, credit: amount, description: "Service cost settled from clearing" },
    ];
  }
  return [
    { accountId: accounts.clearingAccountId, debit: amount, description: "Service cost settled from cost of goods sold" },
    { accountId: accounts.cogsAccountId, credit: amount, description: "Service cost settled to clearing" },
  ];
}

/** Whole tambala -> "1,234.50". */
export function formatTambala(t: number): string {
  const sign = t < 0 ? "-" : "";
  const abs = Math.abs(t);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole.toLocaleString("en-US")}.${frac}`;
}

/** One-line summary of a settlement for lists and the audit log. */
export function describeSettlement(direction: SettlementDirection, amountTambala: number): string {
  return direction === "COST_UP"
    ? `Recognised ${formatTambala(amountTambala)} more cost`
    : `Recognised ${formatTambala(amountTambala)} less cost`;
}
