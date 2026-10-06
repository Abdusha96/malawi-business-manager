import { Prisma, Subscription, SubscriptionStatus } from "@prisma/client";
import { prisma } from "./prisma";
import { logAudit } from "./audit";
import { getBusinessTimeZone } from "./business-timezone";
import { startOfMonthIn } from "./timezone";
import { getPlanDefinition, planHasFeature, PLAN_DEFINITIONS, FeatureKey, PlanDefinition } from "./plans";
import { BILLING_CYCLE_DAYS, computeProration, effectiveStatusOf, paymentRouteFor, planPriceMWK, readGatewayConfig } from "./payment-gateway";

export class PlanRestrictionError extends Error {
  status = 403;
}

export class SubscriptionChangeError extends Error {}

/**
 * Module 26 – closes a real bug found while building the billing page: a
 * `TRIAL` subscription whose `trialEndsAt` has passed was never actually
 * blocked. `requirePlanFeature`/`requirePlanCapacity` only ever compared
 * against the literal `EXPIRED`/`CANCELLED` strings, and nothing in this
 * app writes `EXPIRED` – there's no background job (same standing choice
 * as Depreciation, Bank Reconciliation, In-App Notifications), so a trial
 * that ran out just sat there as `status: "TRIAL"` forever, silently
 * keeping full Professional access.
 *
 * The fix follows this app's "computed, never stored" philosophy rather
 * than adding a background job to flip the status: `effectiveStatus` is
 * derived on every read. It is NOT persisted back to `Subscription.status`
 * – persisting it would need its own re-check-on-every-read logic anyway
 * (a person could renew after the computed expiry), so a pure function is
 * simpler and can't race with a write. Every gate in this file, plus the
 * dashboard and the billing page, must call this instead of reading
 * `subscription.status` directly.
 */
export function getEffectiveSubscriptionStatus(subscription: {
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd?: Date | null;
  requiresPayment?: boolean;
  cancelAtPeriodEnd?: boolean;
}): SubscriptionStatus {
  // Module 74: the rule now lives in the pure effectiveStatusOf() (payment-gateway.ts) so it can be
  // checked without a database. Besides the trial rule above, a PAID period that has ended is
  // PAST_DUE for a short grace and then EXPIRED, and a "cancel at period end" becomes CANCELLED
  // when that end passes. An unbilled subscription never lapses, exactly as before.
  return effectiveStatusOf(subscription) as SubscriptionStatus;
}

/**
 * The actual enforcement point for spec section 4's plan feature lists.
 * `planHasFeature()` has existed since Module 1 but nothing called it until
 * now – Payroll is the first Professional-tier feature actually built, so
 * it's the first place this matters. Any future Professional/Enterprise
 * feature (multi-branch, AI assistant, advanced analytics, API access)
 * should call this the same way rather than re-deriving plan checks.
 */
export async function requirePlanFeature(businessId: string, feature: FeatureKey): Promise<void> {
  const subscription = await prisma.subscription.findUnique({
    where: { businessId },
    include: { plan: true },
  });

  if (!subscription) {
    throw new PlanRestrictionError("No active subscription found for this business.");
  }

  const effectiveStatus = getEffectiveSubscriptionStatus(subscription);
  if (effectiveStatus === "EXPIRED" || effectiveStatus === "CANCELLED") {
    throw new PlanRestrictionError(
      `Your subscription is ${effectiveStatus.toLowerCase()}. Choose a plan on the Billing page to continue using this feature.`
    );
  }

  const planDef = getPlanDefinition(subscription.plan.key);
  if (!planHasFeature(planDef, feature)) {
    throw new PlanRestrictionError(
      `This feature requires the Professional plan or higher. Your business is currently on the ${subscription.plan.name} plan.`
    );
  }
}

/**
 * The numeric-limit counterpart to requirePlanFeature() – `maxUsers` and
 * `maxBranches` on PlanDefinition existed since Module 1 but, like
 * `branches.manage`'s multi-branch UI, nothing ever checked them: a Free
 * plan (maxBranches: 1) could create unlimited branches, and a Free plan
 * (maxUsers: 1) could invite unlimited team members. Call this with the
 * count *before* adding the new one (i.e. how many already exist), so a
 * Free-plan business with 1 branch is correctly blocked from adding a 2nd.
 *
 * Module 26 adds a third resource, "sales": `maxSalesPerMonth` was defined
 * on `PlanDefinition`/`SubscriptionPlan` since Module 1 (like maxUsers and
 * maxBranches originally were) but nothing ever checked it either – the
 * exact same class of gap Module 14 found and fixed for users/branches.
 * Pass the count of sales already recorded THIS CALENDAR MONTH.
 */
export async function requirePlanCapacity(
  businessId: string,
  resource: "users" | "branches" | "sales",
  currentCount: number
): Promise<void> {
  const subscription = await prisma.subscription.findUnique({
    where: { businessId },
    include: { plan: true },
  });

  if (!subscription) {
    throw new PlanRestrictionError("No active subscription found for this business.");
  }

  const effectiveStatus = getEffectiveSubscriptionStatus(subscription);
  if (effectiveStatus === "EXPIRED" || effectiveStatus === "CANCELLED") {
    throw new PlanRestrictionError(
      `Your subscription is ${effectiveStatus.toLowerCase()}. Choose a plan on the Billing page to continue using this feature.`
    );
  }

  const planDef = getPlanDefinition(subscription.plan.key);
  const max = resource === "users" ? planDef.maxUsers : resource === "branches" ? planDef.maxBranches : planDef.maxSalesPerMonth;
  const label = resource === "users" ? "team members" : resource === "branches" ? "branches" : "sales per month";

  if (max !== null && currentCount >= max) {
    throw new PlanRestrictionError(
      `Your ${subscription.plan.name} plan allows up to ${max} ${label}. Upgrade to add more.`
    );
  }
}

/**
 * Start of the current calendar month IN THE BUSINESS'S TIME ZONE, for scoping the "sales"
 * capacity resource. Module 35: it used the server's zone, so on a UTC host a plan's monthly
 * sales allowance reset at 02:00 Malawi time on the 1st instead of at midnight.
 */
export function getCurrentMonthStart(tz: string): Date {
  return startOfMonthIn(new Date(), tz);
}

export async function getSalesThisMonthCount(
  businessId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma
): Promise<number> {
  const tz = await getBusinessTimeZone(businessId, tx);
  return tx.sale.count({
    where: { businessId, createdAt: { gte: getCurrentMonthStart(tz) } },
  });
}

/**
 * Self-service plan list for the billing page – everything except
 * ENTERPRISE, which is `isCustomPricing` and has no fixed price to switch
 * to; it stays a "contact us" card in the UI rather than a button that
 * would silently apply an MWK 0 price.
 */
export function getSelfServicePlans(): PlanDefinition[] {
  return PLAN_DEFINITIONS.filter((p) => !p.isCustomPricing);
}

export interface SubscriptionOverview {
  subscription: Subscription;
  plan: PlanDefinition;
  effectiveStatus: SubscriptionStatus;
  daysLeftInTrial: number | null;
  usage: {
    users: { count: number; max: number | null };
    branches: { count: number; max: number | null };
    salesThisMonth: { count: number; max: number | null };
  };
  selfServicePlans: PlanDefinition[];
  /** Module 74: what each plan/cycle would cost RIGHT NOW after crediting unused paid time. Key `PLAN:CYCLE`. */
  quotes: Record<string, { price: number; credit: number; due: number; remainingDays: number }>;
  cancelAtPeriodEnd: boolean;
  /** True when the current period was paid for through the gateway (so it can lapse and be renewed). */
  paid: boolean;
}

/**
 * Everything the billing page needs in one call – current plan, effective
 * (not raw) status, and usage-vs-limit for all three countable resources,
 * so the page can show "3 / 5 team members" the same way it shows plan
 * price, rather than the page re-deriving any of this itself.
 */
export async function getSubscriptionOverview(businessId: string): Promise<SubscriptionOverview> {
  const subscription = await prisma.subscription.findUnique({
    where: { businessId },
    include: { plan: true },
  });
  if (!subscription) {
    throw new SubscriptionChangeError("No subscription found for this business.");
  }

  const planDef = getPlanDefinition(subscription.plan.key);
  const effectiveStatus = getEffectiveSubscriptionStatus(subscription);
  const daysLeftInTrial =
    subscription.status === "TRIAL" && subscription.trialEndsAt
      ? Math.max(0, Math.ceil((subscription.trialEndsAt.getTime() - Date.now()) / 86_400_000))
      : null;

  const [userCount, branchCount, salesThisMonth] = await Promise.all([
    prisma.businessMember.count({ where: { businessId, isActive: true } }),
    prisma.branch.count({ where: { businessId } }),
    getSalesThisMonthCount(businessId),
  ]);

  const selfServicePlans = getSelfServicePlans();
  const quotes: SubscriptionOverview["quotes"] = {};
  const oldPrice = planPriceMWK(planDef, subscription.billingCycle);
  for (const p of selfServicePlans) {
    for (const cycle of ["MONTHLY", "ANNUAL"] as const) {
      const price = planPriceMWK(p, cycle);
      const sameShape = p.key === planDef.key && cycle === subscription.billingCycle;
      const eligible = subscription.requiresPayment && effectiveStatus === "ACTIVE" && !sameShape;
      const q = computeProration({
        now: new Date(),
        oldPriceMWK: eligible ? oldPrice : 0,
        oldCycle: subscription.billingCycle,
        periodEnd: subscription.currentPeriodEnd,
        newPriceMWK: price,
      });
      quotes[`${p.key}:${cycle}`] = { price, ...q };
    }
  }

  return {
    subscription,
    plan: planDef,
    effectiveStatus,
    daysLeftInTrial,
    usage: {
      users: { count: userCount, max: planDef.maxUsers },
      branches: { count: branchCount, max: planDef.maxBranches },
      salesThisMonth: { count: salesThisMonth, max: planDef.maxSalesPerMonth },
    },
    selfServicePlans,
    quotes,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    paid: subscription.requiresPayment,
  };
}

type Db = Prisma.TransactionClient | typeof prisma;

export interface ValidatedPlanChange {
  subscription: Subscription & { plan: { key: string; name: string } };
  newPlanRow: { id: string; key: string };
  newPlanDef: PlanDefinition;
  effectiveStatus: SubscriptionStatus;
  /** Same plan and same cycle as today: a renewal, not a change. */
  sameShape: boolean;
}

/**
 * Every rule a plan change must pass, shared by the immediate path below and (Module 73) by
 * the gateway: once when a checkout is STARTED (so nobody pays for a change that would be
 * refused) and again when a confirmed payment is SETTLED (limits can change in between).
 * Throws SubscriptionChangeError; writes nothing.
 *
 * `allowRenewal`: paying again for the plan you are already on is a renewal, which only the
 * gateway offers. Without it, re-selecting the current active plan is still refused.
 */
export async function validatePlanChange(
  params: { businessId: string; newPlanKey: string; billingCycle: "MONTHLY" | "ANNUAL"; allowRenewal?: boolean },
  db: Db = prisma
): Promise<ValidatedPlanChange> {
  const { businessId, newPlanKey, billingCycle, allowRenewal } = params;

  const newPlanRow = await db.subscriptionPlan.findUnique({ where: { key: newPlanKey } });
  if (!newPlanRow || !newPlanRow.isActive) {
    throw new SubscriptionChangeError("That plan is not available.");
  }
  const newPlanDef = getPlanDefinition(newPlanRow.key);
  if (newPlanDef.isCustomPricing) {
    throw new SubscriptionChangeError("Enterprise pricing is custom – contact your account manager instead of switching here.");
  }

  const subscription = await db.subscription.findUnique({ where: { businessId }, include: { plan: true } });
  if (!subscription) {
    throw new SubscriptionChangeError("No subscription found for this business.");
  }

  const effectiveStatus = getEffectiveSubscriptionStatus(subscription);
  const sameShape = subscription.planId === newPlanRow.id && subscription.billingCycle === billingCycle;
  if (sameShape && effectiveStatus === "ACTIVE" && !allowRenewal) {
    throw new SubscriptionChangeError(`You're already on the ${newPlanDef.name} plan.`);
  }

  const [userCount, branchCount] = await Promise.all([
    db.businessMember.count({ where: { businessId, isActive: true } }),
    db.branch.count({ where: { businessId } }),
  ]);
  const overLimits: string[] = [];
  if (newPlanDef.maxUsers !== null && userCount > newPlanDef.maxUsers) {
    overLimits.push(`${userCount} team members (${newPlanDef.name} allows ${newPlanDef.maxUsers})`);
  }
  if (newPlanDef.maxBranches !== null && branchCount > newPlanDef.maxBranches) {
    overLimits.push(`${branchCount} branches (${newPlanDef.name} allows ${newPlanDef.maxBranches})`);
  }
  if (overLimits.length > 0) {
    throw new SubscriptionChangeError(
      `Can't switch to ${newPlanDef.name} – you currently have ${overLimits.join(" and ")}. Reduce these first.`
    );
  }

  return { subscription, newPlanRow, newPlanDef, effectiveStatus, sameShape };
}

/**
 * The write half of a plan change, run inside the caller's transaction so the subscription
 * update and its audit row land together (and, for a gateway payment, together with the
 * payment being marked SUCCEEDED). `period` defaults to "now, for one cycle"; a stacked
 * renewal passes its own (see computePaidPeriod). `auditExtra` is merged into the
 * `subscription.plan_changed` metadata (Module 73 adds the payment reference and amount).
 */
export async function applyPlanChange(
  tx: Prisma.TransactionClient,
  params: {
    businessId: string;
    initiatedById: string;
    validated: ValidatedPlanChange;
    billingCycle: "MONTHLY" | "ANNUAL";
    period?: { start: Date; end: Date };
    auditExtra?: Record<string, unknown>;
    /** Module 74: true only when a confirmed gateway payment (or a proration credit) covers the period. */
    requiresPayment?: boolean;
  }
): Promise<Subscription> {
  const { businessId, initiatedById, validated, billingCycle, auditExtra } = params;
  const now = new Date();
  const period = params.period ?? { start: now, end: new Date(now.getTime() + BILLING_CYCLE_DAYS[billingCycle] * 86_400_000) };
  const fromPlanKey = validated.subscription.plan.key;
  const fromStatus = validated.subscription.status;

  const result = await tx.subscription.update({
    where: { businessId },
    data: {
      planId: validated.newPlanRow.id,
      billingCycle,
      status: "ACTIVE",
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
      cancelledAt: null,
      cancelAtPeriodEnd: false,
      requiresPayment: params.requiresPayment ?? false,
      renewalReminderStage: 0,
      renewalReminderPeriodEnd: null,
    },
  });
  await logAudit({
    tx,
    businessId,
    userId: initiatedById,
    action: "subscription.plan_changed",
    entityType: "Subscription",
    entityId: validated.subscription.id,
    metadata: { fromPlanKey, toPlanKey: validated.newPlanRow.key, fromStatus, toStatus: "ACTIVE", billingCycle, ...(auditExtra ?? {}) },
  });
  return result;
}

/**
 * Self-service plan change (upgrade, downgrade, or reactivation after
 * TRIAL/CANCELLED/PAST_DUE/EXPIRED) that needs no money: the Free plan, and, only when no
 * payment gateway is configured, any plan (the original Module 26 "trust model": the switch
 * takes effect immediately and payment, if any, is settled outside the app).
 *
 * Module 73: once PAYCHANGU_SECRET_KEY is set, a PAID plan can only be taken through
 * `startSubscriptionCheckout()` in gateway-payments.ts, which calls `applyPlanChange()`
 * only after the gateway confirms the money. This function refuses that case with a message
 * saying so, and with BILLING_REQUIRE_PAYMENT=true it refuses a paid plan even when the
 * gateway is not configured, so a misconfigured production deployment cannot hand plans out.
 *
 * Downgrading is blocked if current usage already exceeds the new plan's user/branch limits
 * (validatePlanChange). Sales-this-month is deliberately not checked: past sales already
 * happened and can't be undone by a downgrade, so that limit only applies going forward.
 */
export async function changeSubscriptionPlan(params: {
  businessId: string;
  initiatedById: string;
  newPlanKey: string;
  billingCycle: "MONTHLY" | "ANNUAL";
}): Promise<Subscription> {
  const { businessId, initiatedById, newPlanKey, billingCycle } = params;

  const validated = await validatePlanChange({ businessId, newPlanKey, billingCycle });

  const config = readGatewayConfig(process.env);
  const route = paymentRouteFor({
    priceMWK: planPriceMWK(validated.newPlanDef, billingCycle),
    configured: config.configured,
    requirePayment: config.requirePayment,
  });
  if (route === "CHECKOUT") {
    throw new SubscriptionChangeError(`The ${validated.newPlanDef.name} plan is paid for online. Use "Pay and switch" on the Billing page.`);
  }
  if (route === "BLOCKED") {
    throw new SubscriptionChangeError(
      `The ${validated.newPlanDef.name} plan has to be paid for online, but online payment is not set up on this server (${config.notConfiguredReason}). Ask whoever runs this deployment to configure it.`
    );
  }

  return prisma.$transaction((tx) => applyPlanChange(tx, { businessId, initiatedById, validated, billingCycle }));
}

/**
 * Cancellation. Module 74: a PAID period that is still running is kept to its end, so a business
 * that already paid for the month is not thrown out the same day: `cancelAtPeriodEnd` is set and
 * the status turns CANCELLED by itself once `currentPeriodEnd` passes (getEffectiveSubscriptionStatus).
 * Anything else (a trial, an unbilled plan, a lapsed period) has no paid time to keep and is
 * cancelled immediately as before. `immediate: true` forces the immediate form. No refund of paid
 * time either way; that is an operator decision (scripts/gateway-payments.ts).
 */
export async function cancelSubscription(params: {
  businessId: string;
  initiatedById: string;
  reason?: string | null;
  immediate?: boolean;
}): Promise<Subscription & { scheduled: boolean }> {
  const { businessId, initiatedById, reason, immediate } = params;
  const subscription = await prisma.subscription.findUnique({ where: { businessId }, include: { plan: true } });
  if (!subscription) {
    throw new SubscriptionChangeError("No subscription found for this business.");
  }
  const effectiveStatus = getEffectiveSubscriptionStatus(subscription);
  if (effectiveStatus === "CANCELLED") {
    throw new SubscriptionChangeError("This subscription is already cancelled.");
  }
  if (subscription.cancelAtPeriodEnd && !immediate) {
    throw new SubscriptionChangeError("This subscription is already set to cancel at the end of the paid period.");
  }

  const fromStatus = subscription.status;
  const now = new Date();
  const hasPaidTimeLeft =
    subscription.requiresPayment &&
    effectiveStatus === "ACTIVE" &&
    !!subscription.currentPeriodEnd &&
    subscription.currentPeriodEnd.getTime() > now.getTime();
  const scheduled = hasPaidTimeLeft && !immediate;

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.subscription.update({
      where: { businessId },
      data: scheduled
        ? { cancelAtPeriodEnd: true, cancelledAt: now }
        : { status: "CANCELLED", cancelledAt: now, cancelAtPeriodEnd: false },
    });
    await logAudit({
      tx,
      businessId,
      userId: initiatedById,
      action: scheduled ? "subscription.cancel_scheduled" : "subscription.cancelled",
      entityType: "Subscription",
      entityId: subscription.id,
      metadata: {
        fromPlanKey: subscription.plan.key,
        fromStatus,
        toStatus: scheduled ? fromStatus : "CANCELLED",
        reason: reason ?? null,
        ...(scheduled ? { accessUntil: subscription.currentPeriodEnd } : {}),
      },
    });
    return result;
  });

  return { ...updated, scheduled };
}

/** Undoes a scheduled cancellation while the paid period is still running. */
export async function resumeSubscription(params: { businessId: string; initiatedById: string }): Promise<Subscription> {
  const { businessId, initiatedById } = params;
  const subscription = await prisma.subscription.findUnique({ where: { businessId }, include: { plan: true } });
  if (!subscription) throw new SubscriptionChangeError("No subscription found for this business.");
  const effectiveStatus = getEffectiveSubscriptionStatus(subscription);
  if (!subscription.cancelAtPeriodEnd || effectiveStatus !== "ACTIVE") {
    throw new SubscriptionChangeError("There is no scheduled cancellation to undo.");
  }
  return prisma.$transaction(async (tx) => {
    const result = await tx.subscription.update({ where: { businessId }, data: { cancelAtPeriodEnd: false, cancelledAt: null } });
    await logAudit({
      tx,
      businessId,
      userId: initiatedById,
      action: "subscription.cancel_undone",
      entityType: "Subscription",
      entityId: subscription.id,
      metadata: { planKey: subscription.plan.key },
    });
    return result;
  });
}

/**
 * Billing history for the billing page. Deliberately reuses the existing
 * `AuditLog` (append-only, generic `action`/`metadata` audit trail) rather
 * than a new dedicated model – unlike Module 25's InAppNotification (which
 * needed its own table because it's MUTABLE read/dismissed state),
 * subscription history is exactly what AuditLog already models: an
 * immutable record of "what changed, who did it, when". No schema
 * migration was needed for any of Module 26 as a result.
 */
export async function getSubscriptionHistory(businessId: string, limit = 20) {
  return prisma.auditLog.findMany({
    where: { businessId, entityType: "Subscription" },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { user: { select: { name: true } } },
  });
}
