import { InAppNotification, InAppNotificationSeverity, InAppNotificationType } from "@prisma/client";
import { prisma } from "./prisma";
import { getLowStockProducts } from "./inventory";
import { getTaxCalendar } from "./tax-calendar";
import { getBusinessTimeZone } from "./business-timezone";
import { formatDateIn } from "./timezone";
import { daysInTransit, staleTransferUrgentDays } from "./stale-transfer";
import { resolveNotificationTransition } from "./notification-transition";
import { getAgedServiceCostSummary } from "./service-cost-clearing-run";

/**
 * Module 25 – In-App Notifications (the bell). See the schema comment on
 * `InAppNotification` for why this is a persisted, mutable table rather
 * than a purely computed list like Reports or the Tax Calendar.
 *
 * THE SYNC MODEL – read this before adding a fourth alert type.
 *
 * `syncInAppNotifications()` re-evaluates every alert condition on every
 * call (called from the GET route below, and from the dashboard page –
 * there's no background job in this app, the same choice Depreciation and
 * Bank Reconciliation made). Each alert type owns one deterministic
 * `dedupeKey` per "thing" it might alert about, so re-running the sync
 * finds and updates the SAME row instead of creating duplicates.
 *
 * Module 57 added a fifth type, STALE_TRANSFER – see
 * `syncStaleTransferAlerts()` below for why it's condition-based like
 * LOW_STOCK rather than payment-cleared like TAX_DUE. Module 58 made its
 * day threshold a per-business setting instead of a shared constant.
 *
 * Two kinds of alert:
 *   - CONDITION-BASED (LOW_STOCK, TRIAL_ENDING): the sync itself knows
 *     when the underlying condition clears (stock replenished, trial
 *     converted/cancelled) and calls `resolveIfActive()` to close it out
 *     automatically.
 *   - TAX_DUE: resolves itself only when a RECORDED TaxPayment exists for
 *     that obligation (Module 33 – the Tax Calendar marks such entries
 *     "paid"; voiding the payment brings the alert back fresh). It still
 *     can't detect a payment made to the MRA but never recorded in this
 *     app (Module 20's limitation, narrowed), so dismissing remains the
 *     way to clear one of those.
 *
 * `upsertActive()` is the shared write path for both kinds, and encodes
 * one more rule: if a person DISMISSED an alert and the condition never
 * actually cleared in between (it's still the same continuous
 * occurrence), the sync must NOT resurrect it – that would turn a
 * dismiss button into a five-minute snooze. But if the condition cleared
 * (resolvedAt got set) and has now become true again, that's a genuinely
 * NEW occurrence, so it comes back fresh (unread, un-dismissed) rather
 * than staying hidden forever because of an old dismissal.
 *
 * Module 61: that "leave a dismissed alert alone" rule had its own gap for
 * TAX_DUE specifically – the estimate it quotes can keep moving (a late
 * payroll run, a new withholding-tax expense) for as long as the obligation
 * stays open, and a dismissed alert never re-checked whether the number it
 * was dismissed for is still the number. `AlertInput.amount` (TAX_DUE only)
 * is snapshotted into `InAppNotification.amountSnapshot`; `upsertActive()`
 * now delegates the whole "is this a new occurrence" decision to the pure
 * `resolveNotificationTransition()` in notification-transition.ts, which
 * treats a meaningfully different amount on an otherwise-still-dismissed
 * alert the same as a resolved-then-recurred one: fresh, unread, un-dismissed.
 */

// Module 53: prefix for the branch-scoped low-stock alerts syncBranchLowStockAlerts()
// keys against – shares the "low-stock:" name family but needs its own
// startsWith() search below since it also encodes the branch, not just the
// product.
const BRANCH_LOW_STOCK_PREFIX = "low-stock-branch:";

const TAX_ALERT_WINDOW_DAYS = 7; // overdue entries are always included regardless of this window
const TRIAL_ALERT_WINDOW_DAYS = 7;

export class InAppNotificationError extends Error {}

type AlertInput = {
  type: InAppNotificationType;
  severity: InAppNotificationSeverity;
  title: string;
  body: string;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  linkHref?: string | null;
  // Module 61, TAX_DUE only – the working-estimate amount this alert's
  // content reflects. Omitted (undefined) for every other alert type, which
  // tells resolveNotificationTransition() that type never re-surfaces on an
  // amount change (see notification-transition.ts).
  amount?: number | null;
};

async function upsertActive(businessId: string, dedupeKey: string, data: AlertInput): Promise<void> {
  const { amount, ...fields } = data;
  const existing = await prisma.inAppNotification.findUnique({
    where: { businessId_dedupeKey: { businessId, dedupeKey } },
  });

  if (!existing) {
    await prisma.inAppNotification.create({
      data: { businessId, dedupeKey, ...fields, amountSnapshot: amount ?? null },
    });
    return;
  }

  const transition = resolveNotificationTransition({
    wasResolved: existing.resolvedAt !== null,
    wasDismissed: existing.dismissedAt !== null,
    existingAmountSnapshot: existing.amountSnapshot === null ? null : Number(existing.amountSnapshot),
    newAmount: amount,
  });

  if (transition.leaveAsIs) return;

  await prisma.inAppNotification.update({
    where: { id: existing.id },
    data: {
      ...fields,
      amountSnapshot: transition.nextAmountSnapshot,
      resolvedAt: null,
      // A resolved-then-recurred alert, or a dismissed TAX_DUE whose amount
      // has genuinely moved, is a new occurrence: clear the old dismissal
      // and unread state so it actually gets noticed again.
      dismissedAt: transition.isNewOccurrence ? null : existing.dismissedAt,
      dismissedById: transition.isNewOccurrence ? null : existing.dismissedById,
      isRead: transition.isNewOccurrence ? false : existing.isRead,
    },
  });
}

async function resolveIfActive(businessId: string, dedupeKey: string): Promise<void> {
  const existing = await prisma.inAppNotification.findUnique({
    where: { businessId_dedupeKey: { businessId, dedupeKey } },
  });
  if (existing && !existing.resolvedAt) {
    await prisma.inAppNotification.update({ where: { id: existing.id }, data: { resolvedAt: new Date() } });
  }
}

async function syncLowStockAlerts(businessId: string): Promise<void> {
  const lowStockProducts = await getLowStockProducts(businessId);
  // reorderLevel defaults to 0, meaning "not tracked for reordering" – a
  // 0-vs-0 comparison would otherwise flag every never-configured product
  // the moment it hits zero stock. Only alert where a reorder point was
  // actually set.
  const tracked = lowStockProducts.filter((p) => Number(p.reorderLevel) > 0);
  const trackedIds = new Set(tracked.map((p) => p.id));

  for (const p of tracked) {
    const isOut = Number(p.quantity) <= 0;
    await upsertActive(businessId, `low-stock:${p.id}`, {
      type: "LOW_STOCK",
      severity: isOut ? "URGENT" : "WARNING",
      title: isOut ? `${p.name} is out of stock` : `${p.name} is low on stock`,
      body: `${Number(p.quantity)} ${p.unit} remaining – reorder level is ${Number(p.reorderLevel)} ${p.unit}.`,
      relatedEntityType: "Product",
      relatedEntityId: p.id,
      linkHref: "/inventory",
    });
  }

  const activeLowStockAlerts = await prisma.inAppNotification.findMany({
    where: { businessId, type: "LOW_STOCK", resolvedAt: null, NOT: { dedupeKey: { startsWith: BRANCH_LOW_STOCK_PREFIX } } },
  });
  for (const alert of activeLowStockAlerts) {
    if (!alert.relatedEntityId || !trackedIds.has(alert.relatedEntityId)) {
      await resolveIfActive(businessId, alert.dedupeKey);
    }
  }
}

/**
 * Module 53: the branch-scoped counterpart to syncLowStockAlerts() above.
 * Deliberately narrower – it only ever looks at StockLevel rows that have
 * an explicit reorderLevel override, not every (product, branch) pairing
 * that happens to exist. Without an override, that branch's stock is
 * already covered by the business-wide alert above; alerting again off the
 * same business-wide threshold applied to a branch's smaller number would
 * mostly just be noise. An override is the signal that someone actually
 * wants this specific branch watched.
 */
async function syncBranchLowStockAlerts(businessId: string): Promise<void> {
  const overriddenLevels = await prisma.stockLevel.findMany({
    where: { businessId, reorderLevel: { not: null } },
    include: { product: true, branch: true },
  });

  const activeLowKeys = new Set<string>();

  for (const level of overriddenLevels) {
    if (!level.product.isActive || !level.branch.isActive) continue;
    const threshold = Number(level.reorderLevel);
    // Same "0 means not tracked" convention as the business-wide alert.
    if (threshold <= 0) continue;

    const quantity = Number(level.quantity);
    const key = `${BRANCH_LOW_STOCK_PREFIX}${level.productId}:${level.branchId}`;
    if (quantity > threshold) continue;

    activeLowKeys.add(key);
    const isOut = quantity <= 0;
    await upsertActive(businessId, key, {
      type: "LOW_STOCK",
      severity: isOut ? "URGENT" : "WARNING",
      title: isOut
        ? `${level.product.name} is out of stock at ${level.branch.name}`
        : `${level.product.name} is low on stock at ${level.branch.name}`,
      body: `${quantity} ${level.product.unit} remaining at ${level.branch.name} – branch reorder level is ${threshold} ${level.product.unit}.`,
      relatedEntityType: "Product",
      relatedEntityId: level.productId,
      linkHref: `/inventory?branch=${level.branchId}`,
    });
  }

  const activeBranchAlerts = await prisma.inAppNotification.findMany({
    where: { businessId, type: "LOW_STOCK", resolvedAt: null, dedupeKey: { startsWith: BRANCH_LOW_STOCK_PREFIX } },
  });
  for (const alert of activeBranchAlerts) {
    if (!activeLowKeys.has(alert.dedupeKey)) {
      await resolveIfActive(businessId, alert.dedupeKey);
    }
  }
}

async function syncTaxDueAlerts(businessId: string): Promise<void> {
  const tz = await getBusinessTimeZone(businessId);
  const today = new Date();
  const windowEnd = new Date(today.getTime() + TAX_ALERT_WINDOW_DAYS * 86_400_000);
  // Look well back so anything still overdue is caught, but only forward
  // to the alert window – unlike the dashboard's 30-day *preview* widget,
  // the bell is for what needs action now, not a forecast.
  const lookbackStart = new Date(today.getTime() - 120 * 86_400_000);
  const entries = await getTaxCalendar(businessId, lookbackStart, windowEnd);
  // Module 33: an entry with a recorded payment is done – close its alert
  // (if any) and never raise one. `paid` is checked first because a paid
  // entry's dueDate is usually in the past and would otherwise pass the
  // window filter below.
  for (const entry of entries.filter((e) => e.status === "paid")) {
    await resolveIfActive(businessId, `tax:${entry.type}:${entry.periodLabel}`);
  }
  const relevant = entries.filter((e) => e.status !== "paid" && (e.status === "overdue" || e.dueDate <= windowEnd));

  for (const entry of relevant) {
    const dedupeKey = `tax:${entry.type}:${entry.periodLabel}`;
    await upsertActive(businessId, dedupeKey, {
      type: "TAX_DUE",
      severity: entry.status === "overdue" ? "URGENT" : "WARNING",
      title: `${entry.label} ${entry.status === "overdue" ? "is overdue" : "due soon"}`,
      // Module 67: a part-paid period keeps its alert, but says what is still owed and
      // tracks THAT amount, so paying another installment (which changes it) resurfaces a
      // dismissed alert through Module 61's amount snapshot, same as any other estimate move.
      body: entry.partPaid
        ? `${entry.periodLabel} – due ${formatDateIn(entry.dueDate, tz)} – ` +
          `MWK ${entry.partPaid.paid.toLocaleString()} paid in ${entry.partPaid.installmentCount} payment${entry.partPaid.installmentCount === 1 ? "" : "s"}, ` +
          `MWK ${entry.partPaid.remaining.toLocaleString()} still to pay` +
          (entry.isExample ? " (based on example tax rates – review Tax Settings)." : ".")
        : `${entry.periodLabel} – due ${formatDateIn(entry.dueDate, tz)} – ` +
          `working estimate MWK ${entry.amount.toLocaleString()}` +
          (entry.isExample ? " (based on example tax rates – review Tax Settings)." : "."),
      relatedEntityType: "TaxCalendarEntry",
      relatedEntityId: null,
      linkHref: "/accounting",
      amount: entry.partPaid ? entry.partPaid.remaining : entry.amount,
    });
  }
}

/**
 * Module 57 – closes the KNOWN LIMITATION Module 56 flagged as the natural
 * next candidate the moment in-transit visibility shipped: nothing warned
 * about a transfer that's been IN_TRANSIT unusually long (truck never
 * arrived, or a receiving clerk simply never confirmed it). CONDITION-BASED
 * like LOW_STOCK, not payment-cleared like TAX_DUE – there's no separate
 * "resolve" event to watch for; a transfer stops being stale the moment
 * it's no longer IN_TRANSIT (received or cancelled) or, in principle, if it
 * were ever un-dispatched, which can't happen here.
 */
async function syncStaleTransferAlerts(businessId: string): Promise<void> {
  // Module 58: the threshold is now Business.staleTransferAlertDays, not a
  // shared constant – fetched alongside the existing query, same
  // "one extra small query in the same Promise.all" reasoning Module 51
  // applied to reopenBankReconciliation()/reopenStockTake().
  const [business, inTransit] = await Promise.all([
    prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { staleTransferAlertDays: true } }),
    prisma.stockTransfer.findMany({
      where: { businessId, status: "IN_TRANSIT" },
      include: { fromBranch: true, toBranch: true },
    }),
  ]);
  const alertDays = business.staleTransferAlertDays;
  const urgentDays = staleTransferUrgentDays(alertDays);

  const now = new Date();
  const staleKeys = new Set<string>();

  for (const t of inTransit) {
    const days = daysInTransit(t.createdAt, now);
    if (days < alertDays) continue;

    const key = `stale-transfer:${t.id}`;
    staleKeys.add(key);
    const isUrgent = days >= urgentDays;
    await upsertActive(businessId, key, {
      type: "STALE_TRANSFER",
      severity: isUrgent ? "URGENT" : "WARNING",
      title: `Transfer ${t.transferNumber} has been in transit for ${days} day${days === 1 ? "" : "s"}`,
      body: `Dispatched from ${t.fromBranch.name} to ${t.toBranch.name} and still unconfirmed. Check whether it arrived, or cancel it if it didn't.`,
      relatedEntityType: "StockTransfer",
      relatedEntityId: t.id,
      linkHref: `/stock-transfers/${t.id}`,
    });
  }

  // A transfer that left the IN_TRANSIT set (received or cancelled) since
  // the last sync needs its alert resolved – it won't reappear in
  // `inTransit` above at all, so this pass is the only place that happens.
  const activeStaleAlerts = await prisma.inAppNotification.findMany({
    where: { businessId, type: "STALE_TRANSFER", resolvedAt: null },
  });
  for (const alert of activeStaleAlerts) {
    if (!staleKeys.has(alert.dedupeKey)) {
      await resolveIfActive(businessId, alert.dedupeKey);
    }
  }
}

/**
 * Module 80: services whose leftover in Service Cost Clearing (1210) has sat untouched for
 * Business.serviceCostAlertDays or more. ONE business-wide alert, not one per service, so a busy month can't flood
 * the bell. CONDITION-BASED like LOW_STOCK and STALE_TRANSFER: it resolves itself the moment nothing is aged
 * (everything settled, or new activity touched the balance), and needs no scheduler.
 *
 * No amount snapshot is passed on purpose: a TAX_DUE-style "re-surface when the figure moves" would bring a
 * dismissed alert back after every sale of a service. Dismissing it stays dismissed until it resolves and recurs.
 * The text carries counts and days only, no kwacha figures, because the bell is visible to every member.
 */
async function syncServiceCostClearingAlert(businessId: string): Promise<void> {
  const dedupeKey = "service-cost-clearing-aged";
  const summary = await getAgedServiceCostSummary(businessId);
  if (!summary) {
    await resolveIfActive(businessId, dedupeKey);
    return;
  }
  const plural = summary.count === 1 ? "" : "s";
  await upsertActive(businessId, dedupeKey, {
    type: "SERVICE_COST_CLEARING",
    severity: summary.severity,
    title: `${summary.count} service${plural} ${summary.count === 1 ? "has" : "have"} had cost sitting in Service Cost Clearing for a long time`,
    body: `The oldest, ${summary.oldestName}, has not moved for ${summary.oldestDays} days. Check each one: if the supplier bill or the job is final, settle it so the books stop carrying a leftover.`,
    relatedEntityType: "ServiceCostClearing",
    relatedEntityId: null,
    linkHref: "/service-cost-clearing",
  });
}

async function syncTrialEndingAlert(businessId: string): Promise<void> {
  const dedupeKey = "trial-ending";
  const subscription = await prisma.subscription.findUnique({ where: { businessId } });

  if (!subscription || subscription.status !== "TRIAL" || !subscription.trialEndsAt) {
    await resolveIfActive(businessId, dedupeKey);
    return;
  }

  const daysLeft = Math.ceil((subscription.trialEndsAt.getTime() - Date.now()) / 86_400_000);
  if (daysLeft > TRIAL_ALERT_WINDOW_DAYS) {
    await resolveIfActive(businessId, dedupeKey);
    return;
  }

  const isExpired = daysLeft <= 0;
  await upsertActive(businessId, dedupeKey, {
    type: "TRIAL_ENDING",
    severity: isExpired || daysLeft <= 2 ? "URGENT" : "WARNING",
    title: isExpired ? "Your free trial has ended" : `Your free trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
    body: isExpired
      ? "Upgrade your subscription to keep using all features without interruption."
      : "Choose a plan before your trial ends to avoid any interruption.",
    // Module 26: the billing page now exists – deep-link there instead of
    // the dashboard's plain status text.
    linkHref: "/settings/billing",
  });
}

// Module 74: a gateway-paid subscription with a week or less of paid time left. Condition-based like
// the trial alert: it resolves itself once the period is renewed (or cancelled), and needs no scheduler.
async function syncRenewalAlert(businessId: string): Promise<void> {
  const dedupeKey = "subscription-renewal";
  const sub = await prisma.subscription.findUnique({ where: { businessId } });
  const end = sub?.currentPeriodEnd ?? null;
  const live = !!sub && sub.requiresPayment && sub.status === "ACTIVE" && !sub.cancelAtPeriodEnd && !!end;
  if (!live || !end) {
    await resolveIfActive(businessId, dedupeKey);
    return;
  }
  const msLeft = end.getTime() - Date.now();
  const daysLeft = Math.ceil(msLeft / 86_400_000);
  if (daysLeft > 7) {
    await resolveIfActive(businessId, dedupeKey);
    return;
  }
  const lapsed = msLeft <= 0;
  await upsertActive(businessId, dedupeKey, {
    type: "SUBSCRIPTION_RENEWAL",
    severity: lapsed || daysLeft <= 2 ? "URGENT" : "WARNING",
    title: lapsed ? "Your paid plan has ended" : `Your plan ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
    body: lapsed ? "Renew now to avoid losing access. You have a few days of grace." : "Renew from the Billing page to keep every feature without a break.",
    linkHref: "/settings/billing",
  });
}

export async function syncInAppNotifications(businessId: string): Promise<void> {
  await Promise.all([
    syncLowStockAlerts(businessId),
    syncBranchLowStockAlerts(businessId),
    syncTaxDueAlerts(businessId),
    syncStaleTransferAlerts(businessId),
    syncServiceCostClearingAlert(businessId),
    syncTrialEndingAlert(businessId),
    syncRenewalAlert(businessId),
  ]);
}

export async function listInAppNotifications(
  businessId: string,
  opts: { includeInactive?: boolean } = {}
): Promise<InAppNotification[]> {
  await syncInAppNotifications(businessId);
  return prisma.inAppNotification.findMany({
    where: opts.includeInactive ? { businessId } : { businessId, resolvedAt: null, dismissedAt: null },
    orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
  });
}

export async function getInAppNotificationCounts(businessId: string): Promise<{ active: number; unread: number }> {
  await syncInAppNotifications(businessId);
  const [active, unread] = await Promise.all([
    prisma.inAppNotification.count({ where: { businessId, resolvedAt: null, dismissedAt: null } }),
    prisma.inAppNotification.count({ where: { businessId, resolvedAt: null, dismissedAt: null, isRead: false } }),
  ]);
  return { active, unread };
}

export async function markInAppNotificationRead(params: {
  businessId: string;
  notificationId: string;
  userId: string;
}): Promise<InAppNotification> {
  const notification = await prisma.inAppNotification.findFirst({
    where: { id: params.notificationId, businessId: params.businessId },
  });
  if (!notification) throw new InAppNotificationError("Notification not found");
  if (notification.isRead) return notification;
  return prisma.inAppNotification.update({
    where: { id: notification.id },
    data: { isRead: true, readAt: new Date(), readById: params.userId },
  });
}

export async function markAllInAppNotificationsRead(params: { businessId: string; userId: string }): Promise<void> {
  await prisma.inAppNotification.updateMany({
    where: { businessId: params.businessId, resolvedAt: null, dismissedAt: null, isRead: false },
    data: { isRead: true, readAt: new Date(), readById: params.userId },
  });
}

export async function dismissInAppNotification(params: {
  businessId: string;
  notificationId: string;
  userId: string;
}): Promise<InAppNotification> {
  const notification = await prisma.inAppNotification.findFirst({
    where: { id: params.notificationId, businessId: params.businessId },
  });
  if (!notification) throw new InAppNotificationError("Notification not found");
  return prisma.inAppNotification.update({
    where: { id: notification.id },
    data: { dismissedAt: new Date(), dismissedById: params.userId, isRead: true },
  });
}
