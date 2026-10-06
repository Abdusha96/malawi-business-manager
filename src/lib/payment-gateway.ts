import { createHmac, timingSafeEqual } from "crypto";

/**
 * Module 73 – payment gateway logic, pure: no database, no network, no `prisma` import.
 * Everything here takes plain values and returns plain values so it can be checked by
 * `npm run verify:payment-gateway` without a gateway account, and so the server layer
 * (`gateway-payments.ts`) stays a thin shell of fetch calls and conditional writes.
 *
 * The one rule this file exists to enforce, borrowed from Module 71 (Africa's Talking):
 * "the provider answered" is not "the money arrived". A payment is only PAID when the
 * gateway's verify reply says so in the field that means so, for the transaction
 * reference we issued, in the currency and amount we asked for. Anything unreadable,
 * unknown or short fails CLOSED: the plan is not applied.
 *
 * Gateway: PayChangu (Malawi; hosted checkout covering Airtel Money, TNM Mpamba and
 * cards), reachable over plain HTTPS with no SDK, like the SMS and email providers.
 * Written from PayChangu's published docs (checked again in Module 74 against the Standard
 * Checkout, Transaction verification and Webhooks pages) and never run against a live account
 * (see the README's known limitations).
 */

export const GATEWAY_PROVIDER = "PAYCHANGU";
export const GATEWAY_CURRENCY = "MWK";
export const DEFAULT_GATEWAY_BASE_URL = "https://api.paychangu.com";
/** An open checkout younger than this is handed back instead of creating a second one. */
export const CHECKOUT_REUSE_MINUTES = 15;
/** After this long with no money, a PENDING row is labelled "no payment received". */
export const PENDING_STALE_HOURS = 24;
/** Kwacha: a gateway amount within a tambala of the expected one counts as equal. */
export const AMOUNT_TOLERANCE = 0.01;

export const BILLING_CYCLE_DAYS: Record<"MONTHLY" | "ANNUAL", number> = { MONTHLY: 30, ANNUAL: 365 };

// ---------------------------------------------------------------------------
// Configuration (read from env by the caller, passed in so this stays pure)
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  /** True only when a checkout can really be started (secret key AND a public base URL). */
  configured: boolean;
  /** Why not, in a sentence a deployer can act on. Null when configured. */
  notConfiguredReason: string | null;
  secretKey: string | null;
  webhookSecret: string | null;
  baseUrl: string;
  /** NEXTAUTH_URL without a trailing slash: the public origin the gateway redirects to. */
  appUrl: string | null;
  /** BILLING_REQUIRE_PAYMENT=true: a paid plan can never be taken without a confirmed payment. */
  requirePayment: boolean;
}

export function readGatewayConfig(env: Record<string, string | undefined>): GatewayConfig {
  const secretKey = (env.PAYCHANGU_SECRET_KEY ?? "").trim() || null;
  const webhookSecret = (env.PAYCHANGU_WEBHOOK_SECRET ?? "").trim() || null;
  const baseUrl = ((env.PAYCHANGU_BASE_URL ?? "").trim() || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, "");
  const rawApp = (env.NEXTAUTH_URL ?? "").trim().replace(/\/+$/, "");
  const appUrl = rawApp || null;
  const requirePayment = (env.BILLING_REQUIRE_PAYMENT ?? "").trim().toLowerCase() === "true";

  let notConfiguredReason: string | null = null;
  if (!secretKey) notConfiguredReason = "PAYCHANGU_SECRET_KEY is not set.";
  else if (!appUrl) notConfiguredReason = "NEXTAUTH_URL is not set, so the gateway has nowhere to send the customer back to.";
  else if (!/^https?:\/\//i.test(appUrl)) notConfiguredReason = "NEXTAUTH_URL must start with http:// or https://.";

  return {
    configured: notConfiguredReason === null,
    notConfiguredReason,
    secretKey,
    webhookSecret,
    baseUrl,
    appUrl,
    requirePayment,
  };
}

// ---------------------------------------------------------------------------
// Which way does a plan change go?
// ---------------------------------------------------------------------------

export type PaymentRoute = "IMMEDIATE" | "CHECKOUT" | "BLOCKED";

/**
 * - price 0 (the Free plan) never needs money: IMMEDIATE.
 * - a paid plan with a working gateway: CHECKOUT (there is no way round it).
 * - a paid plan with NO gateway: IMMEDIATE (the pre-Module-73 unbilled behaviour, so a fresh
 *   clone still works) unless the deployment set BILLING_REQUIRE_PAYMENT=true, then BLOCKED.
 */
export function paymentRouteFor(params: { priceMWK: number; configured: boolean; requirePayment: boolean }): PaymentRoute {
  if (params.priceMWK <= 0) return "IMMEDIATE";
  if (params.configured) return "CHECKOUT";
  return params.requirePayment ? "BLOCKED" : "IMMEDIATE";
}

/** Whole kwacha. The annual price is defined as 12 months less 15%, which is not always a whole number. */
export function planPriceMWK(plan: { monthlyPriceMWK: number; annualPriceMWK: number }, cycle: "MONTHLY" | "ANNUAL"): number {
  return Math.round(cycle === "MONTHLY" ? plan.monthlyPriceMWK : plan.annualPriceMWK);
}

// ---------------------------------------------------------------------------
// Transaction references
// ---------------------------------------------------------------------------

const TX_REF_RE = /^MBM-SUB-[A-Z0-9]{12,40}$/;
const INVOICE_TX_REF_RE = /^MBM-INV-[A-Z0-9]{12,40}$/;
const PAY_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

/** `hex` is caller-supplied randomness (crypto.randomBytes) so this stays deterministic to test. */
export function buildTxRef(hex: string): string {
  return `MBM-SUB-${hex.toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
}

export function isValidTxRef(ref: unknown): ref is string {
  return typeof ref === "string" && TX_REF_RE.test(ref);
}

/** Module 74: references for a customer paying an invoice online (kept distinct from subscription ones). */
export function buildInvoiceTxRef(hex: string): string {
  return `MBM-INV-${hex.toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
}
export function isValidInvoiceTxRef(ref: unknown): ref is string {
  return typeof ref === "string" && INVOICE_TX_REF_RE.test(ref);
}
export function isValidPayToken(token: unknown): token is string {
  return typeof token === "string" && PAY_TOKEN_RE.test(token);
}

/** Printed on a subscription receipt. Derived from the reference, so it needs no counter column. */
export function receiptNumberFor(txRef: string): string {
  return `RCT-${txRef.replace(/^MBM-(SUB|INV)-/, "").slice(-10)}`;
}

// ---------------------------------------------------------------------------
// Checkout request / response
// ---------------------------------------------------------------------------

export function splitName(name: string | null | undefined): { first: string; last: string } {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "Customer", last: "-" };
  if (parts.length === 1) return { first: parts[0], last: "-" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

export interface CheckoutRequestInput {
  amountMWK: number;
  txRef: string;
  /** Omitted when unknown (a customer paying an invoice may not have given one). */
  email?: string | null;
  name: string | null;
  /**
   * Where the gateway sends the customer's BROWSER afterwards, on success (`callback_url`) and on
   * cancel/failure (`return_url`). PayChangu appends `tx_ref` and `status` itself, so this URL must
   * carry the reference in its PATH (not a query string, which it would break) and must be a page,
   * never the POST-only webhook (Module 74 fixed exactly that mistake).
   */
  redirectUrl: string;
  title: string;
  description: string;
}

/** The JSON body PayChangu's `POST /payment` expects. */
export function buildCheckoutRequest(i: CheckoutRequestInput) {
  const { first, last } = splitName(i.name);
  const body: Record<string, unknown> = {
    amount: String(i.amountMWK),
    currency: GATEWAY_CURRENCY,
    first_name: first,
    last_name: last,
    callback_url: i.redirectUrl,
    return_url: i.redirectUrl,
    tx_ref: i.txRef,
    customization: { title: i.title.slice(0, 60), description: i.description.slice(0, 120) },
    meta: { txRef: i.txRef },
  };
  if (i.email && i.email.trim()) body.email = i.email.trim();
  return body;
}

export type CheckoutParse = { ok: true; checkoutUrl: string } | { ok: false; reason: string };

/**
 * A checkout is only usable if the reply carries an https URL. PayChangu answers
 * `{"status":"success","data":{"checkout_url":"https://..."}}`; a `failed` status or a
 * missing/non-https URL is a failure with whatever message the gateway gave.
 */
export function parseCheckoutResponse(httpStatus: number, bodyText: string): CheckoutParse {
  const json = safeJson(bodyText);
  const message = clip(readString(json, ["message"]) ?? "");
  if (httpStatus < 200 || httpStatus >= 300) {
    return { ok: false, reason: `Gateway returned HTTP ${httpStatus}${message ? `: ${message}` : ""}` };
  }
  if (json === null) return { ok: false, reason: "The gateway's reply could not be read." };
  const status = (readString(json, ["status"]) ?? "").toLowerCase();
  const url = readString(json, ["data", "checkout_url"]);
  if (status !== "success") return { ok: false, reason: message || `The gateway did not accept the checkout (status "${status || "missing"}").` };
  if (!url || !/^https:\/\//i.test(url)) return { ok: false, reason: "The gateway accepted the checkout but returned no secure payment link." };
  return { ok: true, checkoutUrl: url };
}

// ---------------------------------------------------------------------------
// Verify reply
// ---------------------------------------------------------------------------

export type VerifyOutcome = "PAID" | "FAILED" | "PENDING" | "UNREADABLE";

export interface VerifyVerdict {
  outcome: VerifyOutcome;
  txRef?: string;
  amount?: number;
  currency?: string;
  providerReference?: string;
  /** How it was paid, e.g. "Card", "Mobile Money" (data.authorization.channel). */
  channel?: string;
  /** The mobile money operator or card brand when given (data.authorization.provider / brand). */
  provider?: string;
  reason?: string;
}

/**
 * Reads PayChangu's `GET /verify-payment/{tx_ref}` reply.
 *   - The OUTER `status` says the lookup worked; the INNER `data.status` says whether money moved.
 *     Only inner "success" is PAID, and only with tx_ref, amount and currency all present,
 *     because without them the amount cannot be checked (fail closed, never assume).
 *   - failed / cancelled / expired = FAILED. pending / processing / initiated = PENDING.
 *   - HTTP 404 = PENDING: a hosted checkout the customer never finished may not exist at the
 *     gateway yet. They may still pay, so it must not be recorded as failed.
 *   - Anything else (other HTTP errors, non-JSON, an unknown status word) = UNREADABLE,
 *     which the caller treats as "leave it pending and say so".
 */
export function parseVerifyResponse(httpStatus: number, bodyText: string): VerifyVerdict {
  const json = safeJson(bodyText);
  const message = clip(readString(json, ["message"]) ?? "");
  if (httpStatus === 404) return { outcome: "PENDING", reason: "The gateway has no record of this payment yet." };
  if (httpStatus < 200 || httpStatus >= 300) {
    return { outcome: "UNREADABLE", reason: `Gateway returned HTTP ${httpStatus}${message ? `: ${message}` : ""}` };
  }
  if (json === null) return { outcome: "UNREADABLE", reason: "The gateway's reply could not be read." };

  const inner = (readString(json, ["data", "status"]) ?? "").toLowerCase();
  const txRef = readString(json, ["data", "tx_ref"]) ?? undefined;
  const currency = readString(json, ["data", "currency"])?.toUpperCase();
  const amount = readNumber(json, ["data", "amount"]);
  const providerReference = readString(json, ["data", "reference"]) ?? readString(json, ["data", "charge_id"]) ?? undefined;

  if (inner === "success") {
    if (!txRef || !currency || amount === undefined) {
      return { outcome: "UNREADABLE", reason: "The gateway says paid but did not return the reference, amount and currency needed to check it." };
    }
    const channel = readString(json, ["data", "authorization", "channel"]) ?? undefined;
    const provider = readString(json, ["data", "authorization", "provider"]) ?? readString(json, ["data", "authorization", "brand"]) ?? undefined;
    return { outcome: "PAID", txRef, amount, currency, providerReference, channel, provider };
  }
  if (["failed", "cancelled", "canceled", "expired", "declined"].includes(inner)) {
    return { outcome: "FAILED", txRef, reason: message || `The gateway reports this payment as ${inner}.` };
  }
  if (["pending", "processing", "initiated", "initialized", "created"].includes(inner)) {
    return { outcome: "PENDING", txRef, reason: "The gateway has not received the money yet." };
  }
  return { outcome: "UNREADABLE", reason: `The gateway returned a payment status this app does not recognise ("${inner || "missing"}").` };
}

// ---------------------------------------------------------------------------
// Settlement decision
// ---------------------------------------------------------------------------

export type SettlementDecision =
  | { action: "APPLY"; providerReference?: string }
  | { action: "FAIL"; reason: string; mismatch: boolean }
  | { action: "KEEP_PENDING"; reason: string };

/**
 * Compares the gateway's answer with what we asked for. Paying MORE than the price is accepted
 * (a gateway may add its fee to what the customer is charged); paying LESS, a different
 * currency, or a different reference is a MISMATCH and is never applied: it is recorded as
 * failed, with both figures in the reason, for a person to sort out.
 */
export function decideSettlement(
  expected: { txRef: string; amount: number; currency: string },
  verdict: VerifyVerdict
): SettlementDecision {
  switch (verdict.outcome) {
    case "PENDING":
      return { action: "KEEP_PENDING", reason: verdict.reason ?? "Waiting for the gateway to confirm." };
    case "UNREADABLE":
      return { action: "KEEP_PENDING", reason: verdict.reason ?? "The gateway's answer could not be read." };
    case "FAILED":
      return { action: "FAIL", reason: verdict.reason ?? "The gateway reports the payment as failed.", mismatch: false };
    case "PAID": {
      if (verdict.txRef !== expected.txRef) {
        return { action: "FAIL", mismatch: true, reason: `The gateway answered for a different reference (${verdict.txRef ?? "none"}).` };
      }
      if ((verdict.currency ?? "").toUpperCase() !== expected.currency.toUpperCase()) {
        return { action: "FAIL", mismatch: true, reason: `The gateway took ${verdict.currency ?? "an unknown currency"}, but ${expected.currency} was expected.` };
      }
      const paid = verdict.amount ?? NaN;
      if (!Number.isFinite(paid) || paid + AMOUNT_TOLERANCE < expected.amount) {
        return {
          action: "FAIL",
          mismatch: true,
          reason: `The gateway took ${expected.currency} ${Number.isFinite(paid) ? paid.toLocaleString("en-US") : "an unreadable amount"}, but ${expected.currency} ${expected.amount.toLocaleString("en-US")} was expected.`,
        };
      }
      return { action: "APPLY", providerReference: verdict.providerReference };
    }
  }
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

export type WebhookCheck = "OK" | "NOT_CONFIGURED" | "MISSING_SIGNATURE" | "BAD_SIGNATURE";

/**
 * HMAC-SHA256 of the RAW request body with the webhook secret, hex, constant-time compared.
 * No secret configured = NOT_CONFIGURED (the route still verifies with the gateway, which is
 * the real authority; the signature is an extra layer, never the only one).
 */
export function checkWebhookSignature(params: { rawBody: string; signature: string | null | undefined; secret: string | null }): WebhookCheck {
  if (!params.secret) return "NOT_CONFIGURED";
  const sig = (params.signature ?? "").trim().toLowerCase();
  if (!sig) return "MISSING_SIGNATURE";
  const expected = createHmac("sha256", params.secret).update(params.rawBody, "utf8").digest("hex");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return "BAD_SIGNATURE";
  return timingSafeEqual(a, b) ? "OK" : "BAD_SIGNATURE";
}

/**
 * The reference a webhook names: `tx_ref` at the top level, under `data`, or the `meta.txRef` we sent
 * with the checkout. PayChangu's documented sample payloads show `reference`/`charge_id` and no
 * `tx_ref`, so a body with none of these is NORMAL, not an error: the caller then reconciles all
 * pending payments instead (see reconcilePendingPayments). Null if absent or not one of ours.
 */
export function extractWebhookTxRef(rawBody: string): string | null {
  const json = safeJson(rawBody);
  const candidates = [readString(json, ["tx_ref"]), readString(json, ["data", "tx_ref"]), readString(json, ["meta", "txRef"]), readString(json, ["data", "meta", "txRef"])];
  for (const c of candidates) {
    if (isValidTxRef(c) || isValidInvoiceTxRef(c)) return c;
  }
  return null;
}

/** Throttle for gateway lookups: skip a payment looked at within the last `minSeconds`. */
export function shouldCheckNow(lastCheckedAt: Date | null, now: Date, minSeconds: number): boolean {
  return !lastCheckedAt || now.getTime() - lastCheckedAt.getTime() >= minSeconds * 1000;
}

// ---------------------------------------------------------------------------
// Period
// ---------------------------------------------------------------------------

/**
 * A paid period. Renewing the SAME plan and cycle while still ACTIVE stacks onto the end of
 * the paid time (paying early never loses days); anything else (first payment, switching plan
 * or cycle, reactivating after a lapse) starts now. No proration: unused time on an old plan
 * is not credited (README known limitation).
 */
export function computePaidPeriod(params: {
  now: Date;
  cycle: "MONTHLY" | "ANNUAL";
  currentPeriodEnd: Date | null;
  sameSubscriptionShape: boolean;
  effectiveStatus: string;
}): { start: Date; end: Date; stacked: boolean } {
  const { now, cycle, currentPeriodEnd, sameSubscriptionShape, effectiveStatus } = params;
  const stacked = sameSubscriptionShape && effectiveStatus === "ACTIVE" && !!currentPeriodEnd && currentPeriodEnd.getTime() > now.getTime();
  const start = stacked ? (currentPeriodEnd as Date) : now;
  return { start, end: new Date(start.getTime() + BILLING_CYCLE_DAYS[cycle] * 86_400_000), stacked };
}

export function isPendingStale(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() > PENDING_STALE_HOURS * 3_600_000;
}

// ---------------------------------------------------------------------------
// Proration, effective lapse, renewal reminders (Module 74)
// ---------------------------------------------------------------------------

/** After a paid period ends, access continues this long (status PAST_DUE) before it is EXPIRED. */
export const PAST_DUE_GRACE_DAYS = 3;
export const RENEWAL_REMINDER_FIRST_DAYS = 7;
export const RENEWAL_REMINDER_FINAL_DAYS = 1;

export interface Proration {
  /** Value of the unused whole days on the plan being left, capped at the new price. */
  credit: number;
  /** What the gateway is asked for: new price less credit. Never negative. */
  due: number;
  remainingDays: number;
}

/**
 * Credit for the unused part of a paid period when moving to a DIFFERENT plan or cycle.
 * Straight-line on the OLD plan's current list price per whole remaining day (a part-day is not
 * credited), capped at the cycle length and at the new price. Uses the list price rather than a
 * stored "amount actually paid" so it needs no extra bookkeeping; if the price changed since the
 * person paid, the credit follows today's price (documented limitation).
 */
export function computeProration(params: {
  now: Date;
  oldPriceMWK: number;
  oldCycle: "MONTHLY" | "ANNUAL";
  periodEnd: Date | null;
  newPriceMWK: number;
}): Proration {
  const { now, oldPriceMWK, oldCycle, periodEnd, newPriceMWK } = params;
  if (!periodEnd || oldPriceMWK <= 0 || periodEnd.getTime() <= now.getTime()) {
    return { credit: 0, due: Math.max(0, newPriceMWK), remainingDays: 0 };
  }
  const cycleDays = BILLING_CYCLE_DAYS[oldCycle];
  const remainingDays = Math.min(cycleDays, Math.max(0, Math.floor((periodEnd.getTime() - now.getTime()) / 86_400_000)));
  const rawCredit = Math.floor((oldPriceMWK * remainingDays) / cycleDays);
  const credit = Math.min(rawCredit, Math.max(0, newPriceMWK));
  return { credit, due: Math.max(0, newPriceMWK - credit), remainingDays };
}

/**
 * The status a subscription is really in right now, pure. Extends Module 26's trial rule:
 *   - A paid (gateway) subscription whose period has ended is PAST_DUE for PAST_DUE_GRACE_DAYS
 *     (access continues; the Billing page asks for payment), then EXPIRED.
 *   - A subscription cancelled "at period end" becomes CANCELLED once that end passes.
 *   - An unbilled legacy subscription (requiresPayment false) never lapses, exactly as before.
 */
export function effectiveStatusOf(
  s: { status: string; trialEndsAt: Date | null; currentPeriodEnd?: Date | null; requiresPayment?: boolean; cancelAtPeriodEnd?: boolean },
  now: Date = new Date()
): string {
  if (s.status === "TRIAL" && s.trialEndsAt && s.trialEndsAt.getTime() < now.getTime()) return "EXPIRED";
  if (s.status === "ACTIVE" && s.currentPeriodEnd && s.currentPeriodEnd.getTime() < now.getTime()) {
    if (s.cancelAtPeriodEnd) return "CANCELLED";
    if (s.requiresPayment) {
      const graceEnd = s.currentPeriodEnd.getTime() + PAST_DUE_GRACE_DAYS * 86_400_000;
      return now.getTime() > graceEnd ? "EXPIRED" : "PAST_DUE";
    }
  }
  return s.status;
}

/**
 * Which renewal reminder (1 = first, 2 = final) is due now, or null. Each stage is sent once per
 * period end: a new period end (after a renewal) resets the count. No reminder for an unbilled
 * subscription, one already set to cancel, or one whose period has ended (its status says so).
 */
export function renewalReminderDue(params: {
  now: Date;
  status: string;
  requiresPayment: boolean;
  cancelAtPeriodEnd: boolean;
  periodEnd: Date | null;
  stage: number;
  stagePeriodEnd: Date | null;
}): 1 | 2 | null {
  const { now, status, requiresPayment, cancelAtPeriodEnd, periodEnd, stage, stagePeriodEnd } = params;
  if (status !== "ACTIVE" || !requiresPayment || cancelAtPeriodEnd || !periodEnd) return null;
  const msLeft = periodEnd.getTime() - now.getTime();
  if (msLeft <= 0) return null;
  const days = Math.ceil(msLeft / 86_400_000);
  const sent = stagePeriodEnd && stagePeriodEnd.getTime() === periodEnd.getTime() ? stage : 0;
  if (days <= RENEWAL_REMINDER_FINAL_DAYS && sent < 2) return 2;
  if (days <= RENEWAL_REMINDER_FIRST_DAYS && sent < 1) return 1;
  return null;
}

// ---------------------------------------------------------------------------
// Refunds and "needs a person" (Module 74)
// ---------------------------------------------------------------------------

export type RefundCheck = { ok: true; remainingAfter: number } | { ok: false; reason: string };

/**
 * The most that may ever be refunded on one payment is what was paid: the amount asked plus any
 * excess the gateway took, less refunds already recorded. A refund is only recorded on a payment
 * the gateway confirmed. This validates the RECORD; the money itself is returned to the payer
 * from the operator's PayChangu account, outside this app.
 */
export function validateRefund(
  p: { status: string; amount: number; excessAmount: number; refundedAmount: number },
  requested: number
): RefundCheck {
  if (p.status !== "SUCCEEDED") return { ok: false, reason: "Only a payment the gateway confirmed can be refunded." };
  if (!Number.isFinite(requested) || requested <= 0) return { ok: false, reason: "The refund amount must be more than zero." };
  const paid = Math.round((p.amount + p.excessAmount) * 100) / 100;
  const left = Math.round((paid - p.refundedAmount) * 100) / 100;
  if (requested > left + AMOUNT_TOLERANCE) {
    return { ok: false, reason: `At most MWK ${left.toLocaleString("en-US")} can still be refunded on this payment (paid ${paid.toLocaleString("en-US")}, refunded ${p.refundedAmount.toLocaleString("en-US")}).` };
  }
  return { ok: true, remainingAfter: Math.max(0, Math.round((left - requested) * 100) / 100) };
}

export type AttentionReason = "PAID_NOT_APPLIED" | "EXCESS_NOT_REFUNDED" | null;

/** A confirmed payment that still needs an operator: money received but nothing applied, or excess kept. */
export function attentionFor(p: { status: string; applyError: string | null; excessAmount: number; refundedAmount: number }): AttentionReason {
  if (p.status !== "SUCCEEDED") return null;
  if (p.applyError) return "PAID_NOT_APPLIED";
  // Under one kwacha is rounding (a gateway charges whole kwacha; an invoice may owe tambala), not money owed back.
  if (p.excessAmount >= 1 && p.refundedAmount + AMOUNT_TOLERANCE < p.excessAmount) return "EXCESS_NOT_REFUNDED";
  return null;
}

// ---------------------------------------------------------------------------
// Customer invoice payments (Module 74)
// ---------------------------------------------------------------------------

export type InvoicePaymentMethod = "CARD" | "AIRTEL_MONEY" | "TNM_MPAMBA" | "BANK";

/**
 * Which ledger method an online payment is booked under, from what the gateway reported. Unknown or
 * missing = BANK: PayChangu settles to the merchant's wallet, which is closest to a bank account, and
 * guessing a mobile money operator from nothing would book to the wrong cash account.
 */
export function mapChannelToPaymentMethod(channel?: string | null, provider?: string | null): InvoicePaymentMethod {
  const text = `${channel ?? ""} ${provider ?? ""}`.toLowerCase();
  if (/airtel/.test(text)) return "AIRTEL_MONEY";
  if (/tnm|mpamba/.test(text)) return "TNM_MPAMBA";
  if (/card|visa|master/.test(text)) return "CARD";
  return "BANK";
}

/**
 * How much of a confirmed payment goes onto the invoice. The invoice may have been (part) paid some
 * other way while the customer was on the gateway's page, so apply no more than what is still owed;
 * anything above that is `excess` (left for a person to refund) and an invoice with nothing owed
 * applies nothing.
 */
export function computeInvoiceApplication(params: { balance: number; paid: number }): { applied: number; excess: number } {
  const balance = Math.max(0, Math.round(params.balance * 100) / 100);
  const paid = Math.max(0, Math.round(params.paid * 100) / 100);
  const applied = Math.min(balance, paid);
  return { applied, excess: Math.round((paid - applied) * 100) / 100 };
}

/** Whole kwacha to ask the gateway for: the invoice balance, rounded UP so it is never short. */
export function invoiceChargeMWK(balance: number): number {
  return Math.ceil(Math.round(balance * 100) / 100 - 1e-9);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function safeJson(text: string): unknown | null {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function dig(json: unknown, path: string[]): unknown {
  let cur: unknown = json;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function readString(json: unknown, path: string[]): string | null {
  const v = dig(json, path);
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function readNumber(json: unknown, path: string[]): number | undefined {
  const v = dig(json, path);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return undefined;
}

function clip(s: string): string {
  return s.length > 300 ? `${s.slice(0, 297)}...` : s;
}
