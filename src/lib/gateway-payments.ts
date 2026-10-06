import { randomBytes } from "crypto";
import { GatewayPayment } from "@prisma/client";
import { getPlanDefinition as getPlanDefinitionForKey } from "./plans";
import { prisma } from "./prisma";
import { logAudit } from "./audit";
import { SubscriptionChangeError, applyPlanChange, validatePlanChange } from "./subscription";
import { sendEmail } from "./notifications";
import { renderSubscriptionReceiptHtml } from "./subscription-receipt";
import {
  CHECKOUT_REUSE_MINUTES,
  GATEWAY_CURRENCY,
  GATEWAY_PROVIDER,
  GatewayConfig,
  VerifyVerdict,
  buildCheckoutRequest,
  buildTxRef,
  checkWebhookSignature,
  computePaidPeriod,
  computeProration,
  shouldCheckNow,
  decideSettlement,
  extractWebhookTxRef,
  isValidTxRef,
  isPendingStale,
  parseCheckoutResponse,
  parseVerifyResponse,
  attentionFor,
  planPriceMWK,
  readGatewayConfig,
  receiptNumberFor,
  validateRefund,
} from "./payment-gateway";

/**
 * Module 73 – the server half of subscription payments. The pure half (what a reply means,
 * whether the amount is right, what a webhook signature is) lives in `payment-gateway.ts`;
 * this file is fetch calls plus conditional writes.
 *
 * The flow:
 *   1. `startSubscriptionCheckout()` validates the plan change NOW (nobody pays for a change
 *      that would be refused), writes a PENDING `GatewayPayment` with the price snapshotted,
 *      asks the gateway for a hosted checkout link, and returns it. Nothing about the
 *      subscription changes yet.
 *   2. The customer pays on the gateway's page. The gateway then does TWO things, and either
 *      one alone is enough: it POSTs our webhook, and it redirects the customer back to
 *      /settings/billing?tx_ref=... (whose page calls the check route). Both end up in
 *      `settleGatewayPayment()`, which NEVER trusts what it was told: it asks the gateway
 *      "did transaction X succeed?" itself and compares reference, currency and amount.
 *   3. On a confirmed, matching payment ONE transaction claims the row (PENDING -> SUCCEEDED,
 *      a conditional `updateMany`, so the webhook and the return page racing each other
 *      apply it exactly once) and applies the plan change. If the plan change is refused at
 *      that moment (limits changed while the customer was paying), the money is still
 *      recorded as received, `applyError` says why, and a person has to sort it out. A
 *      confirmed payment is never silently dropped.
 *
 * Nothing here runs in the background: there is no scheduler in this app (same standing
 * choice as Depreciation, Bank Reconciliation and In-App Notifications). A payment the
 * gateway never tells us about is found when the person opens Billing and presses
 * "Check status".
 */

export class GatewayError extends Error {
  status = 502;
}

export interface GatewayHttpReply {
  status: number;
  text: string;
}

/** The two outbound calls, injectable so a check script can stand in for the gateway. */
export interface GatewayDeps {
  createCheckout(config: GatewayConfig, body: unknown): Promise<GatewayHttpReply>;
  verify(config: GatewayConfig, txRef: string): Promise<GatewayHttpReply>;
  /** Called once, after a payment is confirmed, to send the receipt. Best effort: must never throw into the caller. */
  notify?(payment: GatewayPayment, outcome: "APPLIED" | "PAID_NOT_APPLIED"): Promise<void>;
}

const TIMEOUT_MS = 15_000;

export const realGatewayDeps: GatewayDeps = {
  async createCheckout(config, body) {
    const res = await fetch(`${config.baseUrl}/payment`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: res.status, text: await res.text().catch(() => "") };
  },
  async verify(config, txRef) {
    const res = await fetch(`${config.baseUrl}/verify-payment/${encodeURIComponent(txRef)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.secretKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: res.status, text: await res.text().catch(() => "") };
  },
  async notify(payment, outcome) {
    try {
      const user = await prisma.user.findUnique({ where: { id: payment.initiatedById }, select: { email: true, name: true } });
      const business = await prisma.business.findUnique({ where: { id: payment.businessId }, select: { name: true } });
      if (!user?.email) return;
      const html = renderSubscriptionReceiptHtml({
        txRef: payment.txRef,
        businessName: business?.name ?? "your business",
        planKey: payment.planKey,
        billingCycle: payment.billingCycle,
        amount: Number(payment.amount),
        prorationCredit: Number(payment.prorationCredit),
        paidAt: payment.completedAt ?? new Date(),
        applied: outcome === "APPLIED",
        applyError: payment.applyError,
        appUrl: readGatewayConfig(process.env).appUrl,
      });
      await sendEmail({
        businessId: payment.businessId,
        userId: payment.initiatedById,
        to: user.email,
        subject: outcome === "APPLIED" ? "Payment received – your plan is active" : "Payment received – action needed",
        body: html,
        templateKey: "subscription_receipt",
        relatedEntityType: "GatewayPayment",
        relatedEntityId: payment.id,
      });
    } catch (err) {
      console.error("[subscription receipt email]", err);
    }
  },
};

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function startSubscriptionCheckout(
  params: { businessId: string; userId: string; planKey: string; billingCycle: "MONTHLY" | "ANNUAL" },
  deps: GatewayDeps = realGatewayDeps
): Promise<
  | { kind: "CHECKOUT"; payment: GatewayPayment; reused: boolean }
  | { kind: "COVERED_BY_CREDIT"; credit: number }
> {
  const { businessId, userId, planKey, billingCycle } = params;

  const config = readGatewayConfig(process.env);
  if (!config.configured || !config.appUrl) {
    throw new SubscriptionChangeError(`Online payment is not set up on this server (${config.notConfiguredReason}).`);
  }

  // Same rules as an immediate change, plus "renewing the plan you are on is allowed".
  const validated = await validatePlanChange({ businessId, newPlanKey: planKey, billingCycle, allowRenewal: true });
  const price = planPriceMWK(validated.newPlanDef, billingCycle);
  if (price <= 0) {
    throw new SubscriptionChangeError("The Free plan needs no payment. Switch to it directly.");
  }

  // Module 74: moving to a DIFFERENT plan or cycle mid-way through a paid period credits the unused
  // whole days of the old one. A renewal of the same plan and cycle is not a change: it stacks.
  const sub = validated.subscription;
  const proration = computeProration({
    now: new Date(),
    oldPriceMWK: sub.requiresPayment && validated.effectiveStatus === "ACTIVE" && !validated.sameShape ? planPriceMWK(getPlanDefinitionForKey(sub.plan.key), sub.billingCycle) : 0,
    oldCycle: sub.billingCycle,
    periodEnd: sub.currentPeriodEnd,
    newPriceMWK: price,
  });
  const amount = proration.due;

  if (amount <= 0) {
    // The unused time on the old plan covers the whole new price: no money to ask for, so the change
    // is applied now, as a paid period (it can lapse and be renewed), with the credit in the audit row.
    await prisma.$transaction((tx) =>
      applyPlanChange(tx, {
        businessId,
        initiatedById: userId,
        validated,
        billingCycle,
        requiresPayment: true,
        auditExtra: { proration: { creditMWK: proration.credit, remainingDays: proration.remainingDays, priceMWK: price, coveredByCredit: true } },
      })
    );
    return { kind: "COVERED_BY_CREDIT", credit: proration.credit };
  }

  // Pressing the button twice (or reloading) must not create a second checkout.
  const since = new Date(Date.now() - CHECKOUT_REUSE_MINUTES * 60_000);
  const open = await prisma.gatewayPayment.findFirst({
    where: { businessId, status: "PENDING", planKey: validated.newPlanRow.key, billingCycle, amount, createdAt: { gte: since }, checkoutUrl: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  if (open) return { kind: "CHECKOUT", payment: open, reused: true };

  const [user, business] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } }),
    prisma.business.findUnique({ where: { id: businessId }, select: { name: true } }),
  ]);
  if (!user || !business) throw new SubscriptionChangeError("Could not find your account details.");

  const txRef = buildTxRef(randomBytes(12).toString("hex"));
  const payment = await prisma.gatewayPayment.create({
    data: {
      businessId,
      subscriptionId: validated.subscription.id,
      provider: GATEWAY_PROVIDER,
      txRef,
      planKey: validated.newPlanRow.key,
      billingCycle,
      amount,
      prorationCredit: proration.credit,
      currency: GATEWAY_CURRENCY,
      initiatedById: userId,
    },
  });

  const body = buildCheckoutRequest({
    amountMWK: amount,
    txRef,
    email: user.email,
    name: user.name,
    // The browser comes back to a PAGE that carries the reference in its path (never the webhook).
    redirectUrl: `${config.appUrl}/settings/billing/return/${txRef}`,
    title: "Malawi Business Manager",
    description: `${validated.newPlanDef.name} plan (${billingCycle === "MONTHLY" ? "monthly" : "annual"}) for ${business.name}`,
  });

  let failure: string | null = null;
  let checkoutUrl: string | null = null;
  try {
    const reply = await deps.createCheckout(config, body);
    const parsed = parseCheckoutResponse(reply.status, reply.text);
    if (parsed.ok) checkoutUrl = parsed.checkoutUrl;
    else failure = parsed.reason;
  } catch (err) {
    failure = `Could not reach the payment gateway (${err instanceof Error ? err.message : String(err)}).`;
  }

  if (failure || !checkoutUrl) {
    await prisma.$transaction(async (tx) => {
      const r = await tx.gatewayPayment.updateMany({
        where: { id: payment.id, status: "PENDING" },
        data: { status: "FAILED", failureReason: failure ?? "No payment link was returned.", completedAt: new Date() },
      });
      if (r.count === 1) {
        await logAudit({
          tx,
          businessId,
          userId,
          action: "subscription.payment_failed",
          entityType: "Subscription",
          entityId: validated.subscription.id,
          metadata: { txRef, planKey: validated.newPlanRow.key, billingCycle, amount, stage: "checkout", reason: failure },
        });
      }
    });
    throw new GatewayError(`The payment gateway could not start this payment: ${failure}`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.gatewayPayment.update({ where: { id: payment.id }, data: { checkoutUrl } });
    await logAudit({
      tx,
      businessId,
      userId,
      action: "subscription.payment_started",
      entityType: "Subscription",
      entityId: validated.subscription.id,
      metadata: { txRef, planKey: validated.newPlanRow.key, billingCycle, amount, currency: GATEWAY_CURRENCY, prorationCredit: proration.credit },
    });
    return row;
  });
  return { kind: "CHECKOUT", payment: updated, reused: false };
}

// ---------------------------------------------------------------------------
// Settle
// ---------------------------------------------------------------------------

export type SettleOutcome =
  | "APPLIED" // money confirmed and the plan is now active
  | "PAID_NOT_APPLIED" // money confirmed, plan change refused: needs a person
  | "FAILED" // the gateway says it did not go through (or the amount did not match)
  | "PENDING" // not paid yet / could not be confirmed: still open
  | "ALREADY_SETTLED" // settled earlier (by the webhook, say): nothing to do
  | "NOT_FOUND";

export interface SettleResult {
  outcome: SettleOutcome;
  payment: GatewayPayment | null;
  message: string;
}

type SettleDb = typeof prisma;

/**
 * Looks up a payment by the reference we issued, asks the gateway what happened, and settles.
 * `businessId` is given by the signed-in person's route (a payment of another business reads
 * as NOT_FOUND, same as any tenant-scoped lookup) and omitted by the webhook, which has no
 * session and identifies the payment by its unguessable reference alone.
 */
export async function settleGatewayPayment(
  params: { txRef: string; businessId?: string },
  deps: GatewayDeps = realGatewayDeps,
  db: SettleDb = prisma
): Promise<SettleResult> {
  const payment = await db.gatewayPayment.findUnique({ where: { txRef: params.txRef } });
  if (!payment || (params.businessId && payment.businessId !== params.businessId)) {
    return { outcome: "NOT_FOUND", payment: null, message: "No such payment." };
  }
  if (payment.status !== "PENDING") {
    return { outcome: "ALREADY_SETTLED", payment, message: alreadySettledMessage(payment) };
  }

  const config = readGatewayConfig(process.env);
  if (!config.configured) {
    return { outcome: "PENDING", payment, message: `Can't check this payment: online payment is not set up on this server (${config.notConfiguredReason}).` };
  }

  await db.gatewayPayment.update({ where: { id: payment.id }, data: { lastCheckedAt: new Date() } }).catch(() => undefined);

  let verdict: VerifyVerdict;
  try {
    const reply = await deps.verify(config, payment.txRef);
    verdict = parseVerifyResponse(reply.status, reply.text);
  } catch (err) {
    verdict = { outcome: "UNREADABLE", reason: `Could not reach the payment gateway (${err instanceof Error ? err.message : String(err)}).` };
  }
  const result = await settleWithVerdict(db, payment, verdict);
  if ((result.outcome === "APPLIED" || result.outcome === "PAID_NOT_APPLIED") && result.payment && deps.notify) {
    await deps.notify(result.payment, result.outcome).catch(() => undefined);
  }
  return result;
}

function alreadySettledMessage(p: GatewayPayment): string {
  if (p.status === "FAILED") return `This payment did not go through${p.failureReason ? `: ${p.failureReason}` : "."}`;
  if (p.applyError) return `Payment received, but the plan change could not be applied: ${p.applyError}`;
  return "This payment was already confirmed and applied.";
}

/**
 * The decision-and-write half, separated from the gateway call so it can be checked with a
 * hand-made verdict. Everything that changes state is a conditional write on `status = PENDING`,
 * so two callers settling the same payment at once cannot both succeed.
 */
export async function settleWithVerdict(db: SettleDb, payment: GatewayPayment, verdict: VerifyVerdict, now: Date = new Date()): Promise<SettleResult> {
  const decision = decideSettlement({ txRef: payment.txRef, amount: Number(payment.amount), currency: payment.currency }, verdict);

  if (decision.action === "KEEP_PENDING") {
    return { outcome: "PENDING", payment, message: decision.reason };
  }

  if (decision.action === "FAIL") {
    const done = await db.$transaction(async (tx) => {
      const r = await tx.gatewayPayment.updateMany({
        where: { id: payment.id, status: "PENDING" },
        data: { status: "FAILED", failureReason: decision.reason, completedAt: now },
      });
      if (r.count === 1) {
        await logAudit({
          tx,
          businessId: payment.businessId,
          userId: payment.initiatedById,
          action: "subscription.payment_failed",
          entityType: "Subscription",
          entityId: payment.subscriptionId ?? payment.businessId,
          metadata: { txRef: payment.txRef, planKey: payment.planKey, billingCycle: payment.billingCycle, amount: Number(payment.amount), stage: "settle", mismatch: decision.mismatch, reason: decision.reason },
        });
      }
      return r.count === 1;
    });
    const fresh = await db.gatewayPayment.findUnique({ where: { id: payment.id } });
    return done
      ? { outcome: "FAILED", payment: fresh, message: decision.reason }
      : { outcome: "ALREADY_SETTLED", payment: fresh, message: fresh ? alreadySettledMessage(fresh) : "Already settled." };
  }

  // APPLY
  const result = await db.$transaction(async (tx) => {
    const claim = await tx.gatewayPayment.updateMany({
      where: { id: payment.id, status: "PENDING" },
      data: {
        status: "SUCCEEDED",
        completedAt: now,
        providerReference: decision.providerReference ?? null,
        channel: verdict.channel ?? null,
        excessAmount: Math.max(0, Math.round(((verdict.amount ?? 0) - Number(payment.amount)) * 100) / 100),
      },
    });
    if (claim.count !== 1) return "LOST_RACE" as const;

    try {
      const validated = await validatePlanChange(
        { businessId: payment.businessId, newPlanKey: payment.planKey, billingCycle: payment.billingCycle, allowRenewal: true },
        tx
      );
      const period = computePaidPeriod({
        now,
        cycle: payment.billingCycle,
        currentPeriodEnd: validated.subscription.currentPeriodEnd,
        sameSubscriptionShape: validated.sameShape,
        effectiveStatus: validated.effectiveStatus,
      });
      await applyPlanChange(tx, {
        businessId: payment.businessId,
        initiatedById: payment.initiatedById,
        validated,
        billingCycle: payment.billingCycle,
        period: { start: period.start, end: period.end },
        requiresPayment: true,
        auditExtra: {
          gateway: { provider: payment.provider, txRef: payment.txRef, amountMWK: Number(payment.amount), stackedRenewal: period.stacked },
          ...(Number(payment.prorationCredit) > 0 ? { proration: { creditMWK: Number(payment.prorationCredit) } } : {}),
        },
      });
      await tx.gatewayPayment.update({ where: { id: payment.id }, data: { appliedAt: now } });
      return "APPLIED" as const;
    } catch (err) {
      // Only OUR refusal (thrown before any write, so the transaction is still healthy).
      // Anything else propagates and rolls the claim back: the payment stays PENDING and the
      // next webhook retry or "Check status" press tries again.
      if (!(err instanceof SubscriptionChangeError)) throw err;
      await tx.gatewayPayment.update({ where: { id: payment.id }, data: { applyError: err.message } });
      await logAudit({
        tx,
        businessId: payment.businessId,
        userId: payment.initiatedById,
        action: "subscription.payment_apply_failed",
        entityType: "Subscription",
        entityId: payment.subscriptionId ?? payment.businessId,
        metadata: { txRef: payment.txRef, planKey: payment.planKey, billingCycle: payment.billingCycle, amount: Number(payment.amount), reason: err.message },
      });
      return "PAID_NOT_APPLIED" as const;
    }
  });

  const fresh = await db.gatewayPayment.findUnique({ where: { id: payment.id } });
  if (result === "LOST_RACE") {
    return { outcome: "ALREADY_SETTLED", payment: fresh, message: fresh ? alreadySettledMessage(fresh) : "Already settled." };
  }
  if (result === "APPLIED") {
    return { outcome: "APPLIED", payment: fresh, message: "Payment received. Your plan is now active." };
  }
  return {
    outcome: "PAID_NOT_APPLIED",
    payment: fresh,
    message: `Payment received, but the plan change could not be applied: ${fresh?.applyError ?? "unknown reason"}. Your payment is recorded; contact support to have it applied or refunded.`,
  };
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

/**
 * Settles every recent PENDING subscription payment (all businesses, or one) that has not been looked
 * at in `minSecondsBetweenChecks`. This is the polling backstop PayChangu's own docs ask for ("don't
 * rely solely on webhooks"): run by the cron route, by a webhook that names no reference, and, for
 * one business, when its Billing page opens. Bounded by `limit`; payments older than 7 days are
 * left alone (an abandoned checkout). Returns how each ended up.
 */
export async function reconcilePendingSubscriptionPayments(
  params: { businessId?: string; limit: number; minSecondsBetweenChecks: number },
  deps: GatewayDeps = realGatewayDeps,
  db: SettleDb = prisma
): Promise<{ checked: number; applied: number; failed: number; stillPending: number }> {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const rows = await db.gatewayPayment.findMany({
    where: { status: "PENDING", createdAt: { gte: since }, ...(params.businessId ? { businessId: params.businessId } : {}) },
    orderBy: { lastCheckedAt: "asc" },
    take: params.limit * 3,
  });
  const now = new Date();
  const out = { checked: 0, applied: 0, failed: 0, stillPending: 0 };
  for (const row of rows) {
    if (out.checked >= params.limit) break;
    if (!shouldCheckNow(row.lastCheckedAt, now, params.minSecondsBetweenChecks)) continue;
    out.checked++;
    const r = await settleGatewayPayment({ txRef: row.txRef, businessId: params.businessId }, deps, db);
    if (r.outcome === "APPLIED" || r.outcome === "PAID_NOT_APPLIED") out.applied++;
    else if (r.outcome === "FAILED") out.failed++;
    else if (r.outcome === "PENDING") out.stillPending++;
  }
  return out;
}

/**
 * Everything the webhook route does, minus the `Request`/`Response` plumbing.
 *   - Signature: when PAYCHANGU_WEBHOOK_SECRET is set, a missing or wrong signature is 401.
 *     When it is not set the call is still accepted, because the gateway is asked directly
 *     afterwards (a forged call can at most make us ask about real references).
 *   - A body naming one of our subscription references settles that payment.
 *   - A body naming NO reference is normal (PayChangu's documented sample payloads carry `reference`
 *     and `charge_id`, not our `tx_ref`), so the pending payments are reconciled instead, throttled
 *     so a flood of calls cannot become a flood of gateway lookups.
 *   - A reference that is not a subscription one (an invoice reference sent to the wrong endpoint) or
 *     one we never issued is 200: there is nothing to retry, and a non-200 makes the gateway retry
 *     three times for nothing.
 *   - A genuine failure while settling throws, and the route turns that into a 500 so the gateway
 *     retries (the claim rolled back, so a retry is safe).
 */
export async function handleGatewayWebhook(
  params: { rawBody: string; signature: string | null },
  deps: GatewayDeps = realGatewayDeps,
  db: SettleDb = prisma
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const config = readGatewayConfig(process.env);
  const sig = checkWebhookSignature({ rawBody: params.rawBody, signature: params.signature, secret: config.webhookSecret });
  if (sig === "MISSING_SIGNATURE" || sig === "BAD_SIGNATURE") {
    return { httpStatus: 401, body: { error: "invalid_signature" } };
  }

  const txRef = extractWebhookTxRef(params.rawBody);
  if (!txRef) {
    const r = await reconcilePendingSubscriptionPayments({ limit: 20, minSecondsBetweenChecks: 30 }, deps, db);
    return { httpStatus: 200, body: { reconciled: r } };
  }
  if (!isValidTxRef(txRef)) return { httpStatus: 200, body: { ignored: true, reason: "not a subscription reference" } };

  const result = await settleGatewayPayment({ txRef }, deps, db);
  return { httpStatus: 200, body: { outcome: result.outcome } };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface GatewayPaymentRow {
  id: string;
  txRef: string;
  planKey: string;
  billingCycle: "MONTHLY" | "ANNUAL";
  amount: number;
  currency: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  createdAt: Date;
  completedAt: Date | null;
  appliedAt: Date | null;
  failureReason: string | null;
  applyError: string | null;
  checkoutUrl: string | null;
  /** PENDING for over a day: shown as "no payment received". Computed, never stored. */
  stale: boolean;
  prorationCredit: number;
  excessAmount: number;
  refundedAmount: number;
  channel: string | null;
  receiptNo: string | null;
}

export async function getGatewayPayments(businessId: string, limit = 20): Promise<GatewayPaymentRow[]> {
  const rows = await prisma.gatewayPayment.findMany({ where: { businessId }, orderBy: { createdAt: "desc" }, take: limit });
  const now = new Date();
  return rows.map((r) => ({
    id: r.id,
    txRef: r.txRef,
    planKey: r.planKey,
    billingCycle: r.billingCycle,
    amount: Number(r.amount),
    currency: r.currency,
    status: r.status,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    appliedAt: r.appliedAt,
    failureReason: r.failureReason,
    applyError: r.applyError,
    checkoutUrl: r.status === "PENDING" ? r.checkoutUrl : null,
    stale: r.status === "PENDING" && isPendingStale(r.createdAt, now),
    prorationCredit: Number(r.prorationCredit),
    excessAmount: Number(r.excessAmount),
    refundedAmount: Number(r.refundedAmount),
    channel: r.channel,
    receiptNo: r.status === "SUCCEEDED" ? receiptNumberFor(r.txRef) : null,
  }));
}

/** What the Billing page may know about the server's gateway setup. Never includes a key. */
export function getGatewayStatus() {
  const c = readGatewayConfig(process.env);
  return { configured: c.configured, requirePayment: c.requirePayment, notConfiguredReason: c.notConfiguredReason, provider: "PayChangu" };
}

// ---------------------------------------------------------------------------
// Operator actions (Module 74): run from scripts/gateway-payments.ts, never from a tenant route.
// ---------------------------------------------------------------------------

export interface AttentionItem {
  kind: "SUBSCRIPTION" | "INVOICE";
  txRef: string;
  businessId: string;
  reason: "PAID_NOT_APPLIED" | "EXCESS_NOT_REFUNDED";
  amount: number;
  excess: number;
  detail: string;
  createdAt: Date;
}

/** Every confirmed payment, subscription or invoice, that still needs a person. */
export async function listPaymentsNeedingAttention(db: SettleDb = prisma): Promise<AttentionItem[]> {
  const [subs, invs] = await Promise.all([
    db.gatewayPayment.findMany({ where: { status: "SUCCEEDED" }, orderBy: { createdAt: "desc" }, take: 500 }),
    db.invoicePayment.findMany({ where: { status: "SUCCEEDED" }, orderBy: { createdAt: "desc" }, take: 500 }),
  ]);
  const out: AttentionItem[] = [];
  for (const p of subs) {
    const reason = attentionFor({ status: p.status, applyError: p.applyError, excessAmount: Number(p.excessAmount), refundedAmount: Number(p.refundedAmount) });
    if (reason) out.push({ kind: "SUBSCRIPTION", txRef: p.txRef, businessId: p.businessId, reason, amount: Number(p.amount), excess: Number(p.excessAmount), detail: p.applyError ?? "excess over the price", createdAt: p.createdAt });
  }
  for (const p of invs) {
    const reason = attentionFor({ status: p.status, applyError: p.applyError, excessAmount: Number(p.excessAmount), refundedAmount: Number(p.refundedAmount) });
    if (reason) out.push({ kind: "INVOICE", txRef: p.txRef, businessId: p.businessId, reason, amount: Number(p.amount), excess: Number(p.excessAmount), detail: p.applyError ?? "excess over the balance", createdAt: p.createdAt });
  }
  return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Records that money was handed back to the payer. This app can't move that money (PayChangu's hosted
 * checkout has no refund call; only direct card charges do), so the operator refunds from their
 * PayChangu account and records it here so the books and the Billing page agree. Validated against
 * what was actually paid, and cumulative: two partial refunds can never exceed the payment.
 */
export async function recordRefund(
  params: { txRef: string; amount: number; note: string; userId: string },
  db: SettleDb = prisma
): Promise<{ ok: true; remaining: number } | { ok: false; reason: string }> {
  const note = params.note.trim();
  if (!note) return { ok: false, reason: "A refund needs a note saying how it was paid back." };
  const sub = await db.gatewayPayment.findUnique({ where: { txRef: params.txRef } });
  const inv = sub ? null : await db.invoicePayment.findUnique({ where: { txRef: params.txRef } });
  const p = sub ?? inv;
  if (!p) return { ok: false, reason: "No payment with that reference." };
  const check = validateRefund({ status: p.status, amount: Number(p.amount), excessAmount: Number(p.excessAmount), refundedAmount: Number(p.refundedAmount) }, params.amount);
  if (!check.ok) return check;

  const when = new Date();
  const refundedAmount = Math.round((Number(p.refundedAmount) + params.amount) * 100) / 100;
  const refundNote = [p.refundNote, `${when.toISOString().slice(0, 10)}: MWK ${params.amount} - ${note}`].filter(Boolean).join("\n");
  await db.$transaction(async (tx) => {
    if (sub) await tx.gatewayPayment.update({ where: { id: sub.id }, data: { refundedAmount, refundedAt: when, refundNote } });
    else if (inv) await tx.invoicePayment.update({ where: { id: inv.id }, data: { refundedAmount, refundedAt: when, refundNote } });
    await logAudit({
      tx,
      businessId: p.businessId,
      userId: params.userId,
      action: "subscription.payment_refunded",
      entityType: sub ? "Subscription" : "Sale",
      entityId: sub ? (sub.subscriptionId ?? sub.businessId) : (inv as { saleId: string }).saleId,
      metadata: { txRef: params.txRef, amount: params.amount, totalRefunded: refundedAmount, note },
    });
  });
  return { ok: true, remaining: check.remainingAfter };
}

/** Applies a payment that arrived but was refused (limits fixed since): the same validate and apply as settlement. */
export async function applyPaidNotAppliedSubscription(txRef: string, db: SettleDb = prisma): Promise<{ ok: true } | { ok: false; reason: string }> {
  const payment = await db.gatewayPayment.findUnique({ where: { txRef } });
  if (!payment) return { ok: false, reason: "No payment with that reference." };
  if (payment.status !== "SUCCEEDED" || payment.appliedAt || !payment.applyError) return { ok: false, reason: "That payment is not waiting to be applied." };
  const now = new Date();
  try {
    await db.$transaction(async (tx) => {
      const validated = await validatePlanChange({ businessId: payment.businessId, newPlanKey: payment.planKey, billingCycle: payment.billingCycle, allowRenewal: true }, tx);
      const period = computePaidPeriod({ now, cycle: payment.billingCycle, currentPeriodEnd: validated.subscription.currentPeriodEnd, sameSubscriptionShape: validated.sameShape, effectiveStatus: validated.effectiveStatus });
      await applyPlanChange(tx, {
        businessId: payment.businessId,
        initiatedById: payment.initiatedById,
        validated,
        billingCycle: payment.billingCycle,
        period: { start: period.start, end: period.end },
        requiresPayment: true,
        auditExtra: { gateway: { provider: payment.provider, txRef: payment.txRef, amountMWK: Number(payment.amount), stackedRenewal: period.stacked, appliedByOperator: true } },
      });
      await tx.gatewayPayment.update({ where: { id: payment.id }, data: { appliedAt: now, applyError: null } });
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof SubscriptionChangeError) return { ok: false, reason: err.message };
    throw err;
  }
}
