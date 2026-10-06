/**
 * Module 57 – Stale In-Transit Transfer detection.
 * Module 58 – the day threshold moved from a shared constant to a
 * per-business setting (`Business.staleTransferAlertDays`), the same way
 * Module 51 promoted the reopen cap off a constant. What's left here is the
 * bounds/default the Owner can move the setting within, and the pure
 * arithmetic – neither function below reads the business's value itself;
 * the caller (in-app-notifications.ts, the stock-transfers pages) fetches
 * it and passes it in. No default parameter on `isStaleTransfer()`
 * deliberately, for the same reason the timezone helpers take `tz` with no
 * default: a forgotten threshold should be a compile error, not a silent
 * fallback to some baked-in number.
 *
 * Deliberately import-free (no `./prisma`, no other lib) so it's safe to
 * import from BOTH sides that need it: `in-app-notifications.ts` (a server
 * module that imports Prisma at module scope) and the "use client"
 * `StockTransferWorkspace` component, which must never pull a Prisma
 * import into the browser bundle. This is the same split
 * `vat-payment-direction.ts` (Module 46) and `vat-apportionment.ts`
 * (Module 45) already use for pure functions a plain-Node verify script
 * or a client component needs – see the README's "Notes for whoever
 * continues this" entry on that pattern.
 */

// Default a new business gets (matches the Prisma column default) and the
// bounds the Owner can move it within – shared by the settings-form input
// and businessStaleTransferAlertDaysSchema so the three can't drift out of
// sync. Same shape as DEFAULT_MAX_REOPENS/MIN_MAX_REOPENS/MAX_MAX_REOPENS
// in reopen-constants.ts.
export const DEFAULT_STALE_TRANSFER_ALERT_DAYS = 3;
export const MIN_STALE_TRANSFER_ALERT_DAYS = 1;
export const MAX_STALE_TRANSFER_ALERT_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/** Whole days elapsed since `createdAt` (dispatch time), never negative. */
export function daysInTransit(createdAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / MS_PER_DAY));
}

// Doubling the alert threshold is a reasonable "even more overdue"
// escalation point – mirrors TAX_DUE's overdue/due-soon two-tier severity.
// Kept as a fixed multiple of whatever the business configured rather than
// its own separate setting (known limitation below).
export function staleTransferUrgentDays(alertDays: number): number {
  return alertDays * 2;
}

/**
 * True once an IN_TRANSIT transfer has been dispatched at least `alertDays`
 * ago. RECEIVED/CANCELLED transfers are never stale – staleness only
 * describes something still awaiting action.
 */
export function isStaleTransfer(
  status: "IN_TRANSIT" | "RECEIVED" | "CANCELLED",
  createdAt: Date,
  alertDays: number,
  now: Date = new Date()
): boolean {
  return status === "IN_TRANSIT" && daysInTransit(createdAt, now) >= alertDays;
}
