/**
 * Module 73: checks for subscription payment through the gateway.
 *   npx tsx scripts/verify-payment-gateway.ts   (npm run verify:payment-gateway)
 * No database, no network, no gateway account. The pure rules are called directly; the settle
 * path runs against a small in-memory stand-in for Prisma. Exits non-zero on any failure.
 */
import { createHmac } from "crypto";
import {
  readGatewayConfig, paymentRouteFor, planPriceMWK, buildTxRef, isValidTxRef, splitName, buildCheckoutRequest,
  parseCheckoutResponse, parseVerifyResponse, decideSettlement, checkWebhookSignature, extractWebhookTxRef,
  computePaidPeriod, isPendingStale, computeProration, effectiveStatusOf, renewalReminderDue, validateRefund,
  attentionFor, mapChannelToPaymentMethod, computeInvoiceApplication, invoiceChargeMWK, buildInvoiceTxRef,
  isValidInvoiceTxRef, isValidPayToken, receiptNumberFor, shouldCheckNow,
} from "../src/lib/payment-gateway";
import { settleWithVerdict, handleGatewayWebhook, settleGatewayPayment, reconcilePendingSubscriptionPayments, recordRefund, GatewayDeps } from "../src/lib/gateway-payments";
import { settleInvoiceWithVerdict, handleBusinessWebhook, publicInvoiceMessage, LedgerPoster } from "../src/lib/invoice-payments";
import { readEncryptionKey, encryptSecret, decryptSecret, secretHint } from "../src/lib/secret-box";
import { allowRequest } from "../src/lib/rate-limit";
import { renderSubscriptionReceiptHtml } from "../src/lib/subscription-receipt";

export {};

let failed = 0, total = 0;
function check(name: string, actual: unknown, expected: unknown) {
  total++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}

// ---- config & routing ------------------------------------------------------
const none = readGatewayConfig({});
check("no key -> not configured", none.configured, false);
check("no key reason names the variable", none.notConfiguredReason, "PAYCHANGU_SECRET_KEY is not set.");
check("key but no NEXTAUTH_URL", readGatewayConfig({ PAYCHANGU_SECRET_KEY: "k" }).configured, false);
check("key + non-http url", readGatewayConfig({ PAYCHANGU_SECRET_KEY: "k", NEXTAUTH_URL: "example.com" }).configured, false);
const ok = readGatewayConfig({ PAYCHANGU_SECRET_KEY: " k ", NEXTAUTH_URL: "https://app.example.com/", PAYCHANGU_BASE_URL: "https://x.test//" });
check("configured", ok.configured, true);
check("trailing slash trimmed on appUrl", ok.appUrl, "https://app.example.com");
check("base url override trimmed", ok.baseUrl, "https://x.test");
check("default base url", none.baseUrl, "https://api.paychangu.com");
check("requirePayment true", readGatewayConfig({ BILLING_REQUIRE_PAYMENT: "TRUE" }).requirePayment, true);
check("requirePayment default false", none.requirePayment, false);

check("free plan never needs money", paymentRouteFor({ priceMWK: 0, configured: true, requirePayment: true }), "IMMEDIATE");
check("paid + gateway -> checkout", paymentRouteFor({ priceMWK: 5000, configured: true, requirePayment: false }), "CHECKOUT");
check("paid, no gateway -> immediate (legacy)", paymentRouteFor({ priceMWK: 5000, configured: false, requirePayment: false }), "IMMEDIATE");
check("paid, no gateway, required -> blocked", paymentRouteFor({ priceMWK: 5000, configured: false, requirePayment: true }), "BLOCKED");
check("annual price rounds to whole kwacha", planPriceMWK({ monthlyPriceMWK: 5000, annualPriceMWK: 51000.4 }, "ANNUAL"), 51000);
check("monthly price", planPriceMWK({ monthlyPriceMWK: 5000, annualPriceMWK: 51000 }, "MONTHLY"), 5000);

// ---- references ------------------------------------------------------------
const REF = buildTxRef("a1b2c3d4e5f6a1b2c3d4e5f6");
check("tx ref shape", REF, "MBM-SUB-A1B2C3D4E5F6A1B2C3D4E5F6");
check("valid ref", isValidTxRef(REF), true);
check("short ref refused", isValidTxRef("MBM-SUB-ABC"), false);
check("foreign ref refused", isValidTxRef("OTHER-123456789012"), false);
check("non-string refused", isValidTxRef(42), false);
check("lowercase refused", isValidTxRef("mbm-sub-a1b2c3d4e5f6a1b2c3d4e5f6"), false);

// ---- checkout request ------------------------------------------------------
check("name split two words", splitName("Musa Stamboli"), { first: "Musa", last: "Stamboli" });
check("name split one word", splitName("Musa"), { first: "Musa", last: "-" });
check("name split empty", splitName("  "), { first: "Customer", last: "-" });
check("name split many", splitName("A B  C"), { first: "A", last: "B C" });
const RETURN = `https://app.example.com/settings/billing/return/${REF}`;
const req: any = buildCheckoutRequest({ amountMWK: 5000, txRef: REF, email: "o@x.mw", name: "Musa Stamboli", redirectUrl: RETURN, title: "Malawi Business Manager", description: "Business plan (monthly) for Shop" });
check("request amount is a string of whole kwacha", req.amount, "5000");
check("request currency", req.currency, "MWK");
// Module 74 fix: PayChangu redirects the customer's BROWSER to callback_url, so it must be a page, never the POST-only webhook.
check("callback_url is the return PAGE with the ref in its path", req.callback_url, RETURN);
check("return_url is the same page", req.return_url, RETURN);
check("callback_url is NOT the webhook", /\/api\/webhooks\//.test(req.callback_url), false);
check("redirect url has no query string for the gateway to break", req.callback_url.includes("?"), false);
check("request tx_ref", req.tx_ref, REF);
check("request meta carries our ref", req.meta, { txRef: REF });
check("request email included", req.email, "o@x.mw");
check("request without email omits the field", "email" in (buildCheckoutRequest({ amountMWK: 1, txRef: REF, email: null, name: null, redirectUrl: RETURN, title: "t", description: "d" }) as any), false);
check("title/description clipped", (buildCheckoutRequest({ amountMWK: 1, txRef: REF, name: null, redirectUrl: RETURN, title: "x".repeat(200), description: "y".repeat(300) }) as any).customization.description.length, 120);

check("checkout ok", parseCheckoutResponse(200, JSON.stringify({ status: "success", data: { checkout_url: "https://checkout.paychangu.com/abc" } })), { ok: true, checkoutUrl: "https://checkout.paychangu.com/abc" });
check("checkout http 401", parseCheckoutResponse(401, JSON.stringify({ message: "Unauthorized" })), { ok: false, reason: "Gateway returned HTTP 401: Unauthorized" });
check("checkout failed status", parseCheckoutResponse(200, JSON.stringify({ status: "failed", message: "Bad amount" })), { ok: false, reason: "Bad amount" });
check("checkout success without url", parseCheckoutResponse(200, JSON.stringify({ status: "success", data: {} })).ok, false);
check("checkout http (not https) url refused", parseCheckoutResponse(200, JSON.stringify({ status: "success", data: { checkout_url: "http://evil.test" } })).ok, false);
check("checkout non-json", parseCheckoutResponse(200, "<html>").ok, false);

// ---- verify parsing --------------------------------------------------------
const paid = (over: Record<string, unknown> = {}) => JSON.stringify({ status: "success", data: { status: "success", tx_ref: REF, amount: 5000, currency: "MWK", reference: "PC123", ...over } });
check("verify paid", parseVerifyResponse(200, paid()), { outcome: "PAID", txRef: REF, amount: 5000, currency: "MWK", providerReference: "PC123" });
// the documented sample reply shape (Transaction verification page): channel under data.authorization
const docSample = JSON.stringify({ status: "success", message: "Payment details retrieved successfully.", data: { event_type: "checkout.payment", tx_ref: REF, mode: "live", type: "API Payment (Checkout)", status: "success", number_of_attempts: 1, reference: "26262633201", currency: "MWK", amount: 1000, charges: 40, authorization: { channel: "Card", brand: "MASTERCARD", provider: null, mobile_number: null }, customer: { email: "a@b.c" } } });
const ds = parseVerifyResponse(200, docSample);
check("documented sample parses as paid", [ds.outcome, ds.amount, ds.currency, ds.providerReference], ["PAID", 1000, "MWK", "26262633201"]);
check("documented sample channel and brand", [ds.channel, ds.provider], ["Card", "MASTERCARD"]);
check("verify paid amount as string", parseVerifyResponse(200, paid({ amount: "5000.00" })).amount, 5000);
check("verify paid lowercase currency", parseVerifyResponse(200, paid({ currency: "mwk" })).currency, "MWK");
check("verify paid missing amount fails closed", parseVerifyResponse(200, paid({ amount: undefined })).outcome, "UNREADABLE");
check("verify paid missing currency fails closed", parseVerifyResponse(200, paid({ currency: undefined })).outcome, "UNREADABLE");
check("verify paid missing ref fails closed", parseVerifyResponse(200, paid({ tx_ref: undefined })).outcome, "UNREADABLE");
check("verify OUTER success but INNER failed", parseVerifyResponse(200, paid({ status: "failed" })).outcome, "FAILED");
check("verify cancelled", parseVerifyResponse(200, paid({ status: "cancelled" })).outcome, "FAILED");
check("verify pending", parseVerifyResponse(200, paid({ status: "pending" })).outcome, "PENDING");
check("verify 404 is pending, not failed", parseVerifyResponse(404, "{}").outcome, "PENDING");
check("verify 500 unreadable", parseVerifyResponse(500, "oops").outcome, "UNREADABLE");
check("verify non-json unreadable", parseVerifyResponse(200, "<html>").outcome, "UNREADABLE");
check("verify unknown status unreadable", parseVerifyResponse(200, paid({ status: "refunded" })).outcome, "UNREADABLE");
check("verify missing inner status unreadable", parseVerifyResponse(200, JSON.stringify({ status: "success", data: {} })).outcome, "UNREADABLE");

// ---- settlement decision ---------------------------------------------------
const exp = { txRef: REF, amount: 5000, currency: "MWK" };
const v = (over: Record<string, unknown> = {}) => ({ outcome: "PAID" as const, txRef: REF, amount: 5000, currency: "MWK", providerReference: "PC123", ...over });
check("exact payment applies", decideSettlement(exp, v()).action, "APPLY");
check("overpayment applies", decideSettlement(exp, v({ amount: 5150 })).action, "APPLY");
check("within a tambala applies", decideSettlement(exp, v({ amount: 4999.995 })).action, "APPLY");
const short = decideSettlement(exp, v({ amount: 4000 }));
check("underpayment fails as mismatch", [short.action, (short as any).mismatch], ["FAIL", true]);
check("underpayment reason has both figures", /4,000/.test((short as any).reason) && /5,000/.test((short as any).reason), true);
check("wrong currency fails", decideSettlement(exp, v({ currency: "USD" })).action, "FAIL");
check("wrong reference fails", decideSettlement(exp, v({ txRef: "MBM-SUB-OTHEROTHEROTHER" })).action, "FAIL");
check("pending keeps pending", decideSettlement(exp, { outcome: "PENDING" }).action, "KEEP_PENDING");
check("unreadable keeps pending", decideSettlement(exp, { outcome: "UNREADABLE" }).action, "KEEP_PENDING");
check("failed fails (not a mismatch)", [decideSettlement(exp, { outcome: "FAILED" }).action, (decideSettlement(exp, { outcome: "FAILED" }) as any).mismatch], ["FAIL", false]);

// ---- webhook signature -----------------------------------------------------
const body = JSON.stringify({ tx_ref: REF, status: "success" });
const sign = (b: string, s: string) => createHmac("sha256", s).update(b, "utf8").digest("hex");
check("sig ok", checkWebhookSignature({ rawBody: body, signature: sign(body, "sec"), secret: "sec" }), "OK");
check("sig ok uppercase hex", checkWebhookSignature({ rawBody: body, signature: sign(body, "sec").toUpperCase(), secret: "sec" }), "OK");
check("sig wrong secret", checkWebhookSignature({ rawBody: body, signature: sign(body, "nope"), secret: "sec" }), "BAD_SIGNATURE");
check("sig tampered body", checkWebhookSignature({ rawBody: body + " ", signature: sign(body, "sec"), secret: "sec" }), "BAD_SIGNATURE");
check("sig missing", checkWebhookSignature({ rawBody: body, signature: null, secret: "sec" }), "MISSING_SIGNATURE");
check("sig short garbage", checkWebhookSignature({ rawBody: body, signature: "abc", secret: "sec" }), "BAD_SIGNATURE");
check("no secret configured", checkWebhookSignature({ rawBody: body, signature: null, secret: null }), "NOT_CONFIGURED");
check("webhook ref top-level", extractWebhookTxRef(body), REF);
check("webhook ref under data", extractWebhookTxRef(JSON.stringify({ data: { tx_ref: REF } })), REF);
check("webhook foreign ref ignored", extractWebhookTxRef(JSON.stringify({ tx_ref: "SOMETHING-ELSE-123456" })), null);
check("webhook ref from meta.txRef", extractWebhookTxRef(JSON.stringify({ meta: { txRef: REF } })), REF);
check("documented sample webhook (no tx_ref) names no ref", extractWebhookTxRef(JSON.stringify({ event_type: "api.charge.payment", currency: "MWK", amount: 1000, status: "success", charge_id: "5d676fg", reference: "71308131545" })), null);
check("invoice reference also recognised", extractWebhookTxRef(JSON.stringify({ tx_ref: buildInvoiceTxRef("a1b2c3d4e5f6a1b2c3d4e5f6") })), "MBM-INV-A1B2C3D4E5F6A1B2C3D4E5F6");
check("webhook garbage ignored", extractWebhookTxRef("not json"), null);

// ---- period ----------------------------------------------------------------
const now = new Date("2026-10-01T00:00:00Z");
const day = (n: number) => new Date(now.getTime() + n * 86_400_000);
check("first payment starts now, 30 days", computePaidPeriod({ now, cycle: "MONTHLY", currentPeriodEnd: null, sameSubscriptionShape: false, effectiveStatus: "TRIAL" }).end.toISOString(), day(30).toISOString());
const stacked = computePaidPeriod({ now, cycle: "MONTHLY", currentPeriodEnd: day(10), sameSubscriptionShape: true, effectiveStatus: "ACTIVE" });
check("early renewal stacks", [stacked.stacked, stacked.end.toISOString()], [true, day(40).toISOString()]);
check("plan switch does not stack", computePaidPeriod({ now, cycle: "MONTHLY", currentPeriodEnd: day(10), sameSubscriptionShape: false, effectiveStatus: "ACTIVE" }).stacked, false);
check("lapsed renewal starts now", computePaidPeriod({ now, cycle: "ANNUAL", currentPeriodEnd: day(-5), sameSubscriptionShape: true, effectiveStatus: "ACTIVE" }).end.toISOString(), day(365).toISOString());
check("expired renewal starts now", computePaidPeriod({ now, cycle: "MONTHLY", currentPeriodEnd: day(10), sameSubscriptionShape: true, effectiveStatus: "EXPIRED" }).stacked, false);
check("stale after a day", isPendingStale(new Date(now.getTime() - 25 * 3_600_000), now), true);
check("not stale within a day", isPendingStale(new Date(now.getTime() - 23 * 3_600_000), now), false);

// ---- Module 74: proration, lapse, reminders ---------------------------------
{
  const n = new Date("2026-10-01T00:00:00Z");
  const d = (x: number) => new Date(n.getTime() + x * 86_400_000);
  check("proration: 15 of 30 days of a 6000 plan = 3000 credit", computeProration({ now: n, oldPriceMWK: 6000, oldCycle: "MONTHLY", periodEnd: d(15), newPriceMWK: 20000 }), { credit: 3000, due: 17000, remainingDays: 15 });
  check("proration: part-day not credited", computeProration({ now: n, oldPriceMWK: 3000, oldCycle: "MONTHLY", periodEnd: new Date(n.getTime() + 10.9 * 86_400_000), newPriceMWK: 20000 }).remainingDays, 10);
  check("proration: credit capped at new price, nothing due", computeProration({ now: n, oldPriceMWK: 60000, oldCycle: "ANNUAL", periodEnd: d(300), newPriceMWK: 5000 }), { credit: 5000, due: 0, remainingDays: 300 });
  check("proration: ended period gives no credit", computeProration({ now: n, oldPriceMWK: 6000, oldCycle: "MONTHLY", periodEnd: d(-1), newPriceMWK: 20000 }).credit, 0);
  check("proration: no old price (unbilled/trial) gives no credit", computeProration({ now: n, oldPriceMWK: 0, oldCycle: "MONTHLY", periodEnd: d(10), newPriceMWK: 20000 }).due, 20000);
  check("proration: remaining days capped at the cycle", computeProration({ now: n, oldPriceMWK: 6000, oldCycle: "MONTHLY", periodEnd: d(90), newPriceMWK: 20000 }).remainingDays, 30);

  const base = { status: "ACTIVE", trialEndsAt: null as Date | null, currentPeriodEnd: d(-1) as Date | null, requiresPayment: true, cancelAtPeriodEnd: false };
  check("status: paid period running stays ACTIVE", effectiveStatusOf({ ...base, currentPeriodEnd: d(5) }, n), "ACTIVE");
  check("status: paid period ended -> PAST_DUE within grace", effectiveStatusOf(base, n), "PAST_DUE");
  check("status: paid period ended past grace -> EXPIRED", effectiveStatusOf({ ...base, currentPeriodEnd: d(-4) }, n), "EXPIRED");
  check("status: unbilled period never lapses (legacy)", effectiveStatusOf({ ...base, requiresPayment: false, currentPeriodEnd: d(-400) }, n), "ACTIVE");
  check("status: cancel-at-period-end becomes CANCELLED when it ends", effectiveStatusOf({ ...base, cancelAtPeriodEnd: true }, n), "CANCELLED");
  check("status: cancel-at-period-end still ACTIVE before the end", effectiveStatusOf({ ...base, cancelAtPeriodEnd: true, currentPeriodEnd: d(5) }, n), "ACTIVE");
  check("status: trial rule unchanged", effectiveStatusOf({ status: "TRIAL", trialEndsAt: d(-1) }, n), "EXPIRED");
  check("status: trial still running", effectiveStatusOf({ status: "TRIAL", trialEndsAt: d(2) }, n), "TRIAL");

  const rd = (over: Record<string, unknown> = {}) => renewalReminderDue({ now: n, status: "ACTIVE", requiresPayment: true, cancelAtPeriodEnd: false, periodEnd: d(6), stage: 0, stagePeriodEnd: null, ...over } as any);
  check("reminder: none 10 days out", rd({ periodEnd: d(10) }), null);
  check("reminder: first at 6 days", rd(), 1);
  check("reminder: first not repeated", rd({ stage: 1, stagePeriodEnd: d(6) }), null);
  check("reminder: final at 1 day", rd({ periodEnd: d(0.5), stage: 1, stagePeriodEnd: d(0.5) }), 2);
  check("reminder: final not repeated", rd({ periodEnd: d(0.5), stage: 2, stagePeriodEnd: d(0.5) }), null);
  check("reminder: a renewed period resets the stages", rd({ periodEnd: d(6), stage: 2, stagePeriodEnd: d(-24) }), 1);
  check("reminder: none for unbilled", rd({ requiresPayment: false }), null);
  check("reminder: none once cancelling", rd({ cancelAtPeriodEnd: true }), null);
  check("reminder: none after the end", rd({ periodEnd: d(-1) }), null);

  // refunds
  const pay = { status: "SUCCEEDED", amount: 5000, excessAmount: 200, refundedAmount: 0 };
  check("refund: partial ok", validateRefund(pay, 1000), { ok: true, remainingAfter: 4200 });
  check("refund: full incl. excess ok", validateRefund(pay, 5200), { ok: true, remainingAfter: 0 });
  check("refund: over what was paid refused", validateRefund(pay, 5300).ok, false);
  check("refund: cumulative limit", validateRefund({ ...pay, refundedAmount: 5000 }, 300).ok, false);
  check("refund: unconfirmed payment refused", validateRefund({ ...pay, status: "PENDING" }, 100).ok, false);
  check("refund: zero/negative refused", [validateRefund(pay, 0).ok, validateRefund(pay, -5).ok, validateRefund(pay, NaN).ok], [false, false, false]);
  check("attention: applyError", attentionFor({ status: "SUCCEEDED", applyError: "x", excessAmount: 0, refundedAmount: 0 }), "PAID_NOT_APPLIED");
  check("attention: unrefunded excess", attentionFor({ status: "SUCCEEDED", applyError: null, excessAmount: 200, refundedAmount: 0 }), "EXCESS_NOT_REFUNDED");
  check("attention: excess refunded", attentionFor({ status: "SUCCEEDED", applyError: null, excessAmount: 200, refundedAmount: 200 }), null);
  check("attention: rounding-size excess ignored", attentionFor({ status: "SUCCEEDED", applyError: null, excessAmount: 0.4, refundedAmount: 0 }), null);
  check("attention: pending is not attention", attentionFor({ status: "PENDING", applyError: null, excessAmount: 0, refundedAmount: 0 }), null);

  // invoice helpers
  check("method: Airtel", mapChannelToPaymentMethod("Mobile Money", "Airtel Money"), "AIRTEL_MONEY");
  check("method: TNM Mpamba", mapChannelToPaymentMethod("Mobile Money", "TNM Mpamba"), "TNM_MPAMBA");
  check("method: card", mapChannelToPaymentMethod("Card", "MASTERCARD"), "CARD");
  check("method: unknown -> BANK", mapChannelToPaymentMethod(undefined, undefined), "BANK");
  check("method: bank transfer -> BANK", mapChannelToPaymentMethod("Mobile Bank Transfer", null), "BANK");
  check("application: exact", computeInvoiceApplication({ balance: 1000, paid: 1000 }), { applied: 1000, excess: 0 });
  check("application: customer overpays (rounded up charge)", computeInvoiceApplication({ balance: 999.5, paid: 1000 }), { applied: 999.5, excess: 0.5 });
  check("application: invoice settled meanwhile", computeInvoiceApplication({ balance: 0, paid: 1000 }), { applied: 0, excess: 1000 });
  check("application: partly settled meanwhile", computeInvoiceApplication({ balance: 400, paid: 1000 }), { applied: 400, excess: 600 });
  check("charge rounds a fractional balance UP", invoiceChargeMWK(999.5), 1000);
  check("charge keeps a whole balance", invoiceChargeMWK(1000), 1000);
  check("charge ignores float dust", invoiceChargeMWK(1000.0000001), 1000);
  check("invoice ref shape", isValidInvoiceTxRef(buildInvoiceTxRef("a1b2c3d4e5f6a1b2c3d4e5f6")), true);
  check("subscription ref is not an invoice ref", isValidInvoiceTxRef(REF), false);
  check("pay token shape", [isValidPayToken("A".repeat(32)), isValidPayToken("short"), isValidPayToken("A".repeat(31) + "/")], [true, false, false]);
  check("receipt number", receiptNumberFor(REF), "RCT-"+REF.replace("MBM-SUB-","").slice(-10))
  check("receipt number is stable and 10 chars after prefix", [receiptNumberFor(REF) === receiptNumberFor(REF), receiptNumberFor(REF).length], [true, 14]);
  check("throttle: never checked", shouldCheckNow(null, n, 60), true);
  check("throttle: just checked", shouldCheckNow(new Date(n.getTime() - 10_000), n, 60), false);
  check("throttle: long ago", shouldCheckNow(new Date(n.getTime() - 120_000), n, 60), true);

  // secret box
  const k64 = "ab".repeat(32);
  const kr = readEncryptionKey({ APP_ENCRYPTION_KEY: k64 });
  check("key: hex accepted", kr.ok, true);
  check("key: base64 accepted", readEncryptionKey({ APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") }).ok, true);
  check("key: missing", readEncryptionKey({}).ok, false);
  check("key: wrong length", readEncryptionKey({ APP_ENCRYPTION_KEY: "abc" }).ok, false);
  if (kr.ok) {
    const box = encryptSecret("sec-LIVE-1234567890", kr.key);
    check("secret: round trip", decryptSecret(box, kr.key), "sec-LIVE-1234567890");
    check("secret: ciphertext hides the plaintext", box.includes("LIVE"), false);
    check("secret: fresh IV each time", encryptSecret("x", kr.key) !== encryptSecret("x", kr.key), true);
    check("secret: tampered value fails closed", decryptSecret(box.slice(0, -2) + (box.endsWith("AA") ? "BB" : "AA"), kr.key), null);
    check("secret: wrong key fails closed", decryptSecret(box, Buffer.alloc(32, 1)), null);
    check("secret: garbage fails closed", decryptSecret("nonsense", kr.key), null);
  }
  check("secret hint is the last four", secretHint("sec-LIVE-1234567890"), "7890");
  check("secret hint hides short keys", secretHint("abc"), "****");

  // rate limit
  const t0 = 1_000_000;
  const results = [1, 2, 3, 4].map((i) => allowRequest("k1", 3, 60_000, t0 + i));
  check("rate limit: 3 allowed then blocked", results, [true, true, true, false]);
  check("rate limit: window passes", allowRequest("k1", 3, 60_000, t0 + 61_000), true);
  check("rate limit: keys are independent", allowRequest("k2", 3, 60_000, t0), true);

  // receipt email
  const html = renderSubscriptionReceiptHtml({ txRef: REF, businessName: "A <b>Shop</b>", planKey: "BUSINESS", billingCycle: "MONTHLY", amount: 5000, prorationCredit: 1000, paidAt: n, applied: true, applyError: null, appUrl: "https://app.example.com" });
  check("receipt html escapes the business name", html.includes("A &lt;b&gt;Shop&lt;/b&gt;") && !html.includes("<b>Shop"), true);
  check("receipt html shows the credit and the link", html.includes("MWK 1,000") && html.includes("https://app.example.com/settings/billing"), true);
  check("receipt html unapplied warns", renderSubscriptionReceiptHtml({ txRef: REF, businessName: "S", planKey: "BUSINESS", billingCycle: "MONTHLY", amount: 5000, prorationCredit: 0, paidAt: n, applied: false, applyError: "too many branches", appUrl: null }).includes("too many branches"), true);
}

// ---- settle path against an in-memory Prisma stand-in ----------------------
type Row = Record<string, any>;
function makeDb(opts: { users?: number; branches?: number; sub?: Row; payment?: Row } = {}) {
  const plans: Row[] = [
    { id: "p-free", key: "FREE", name: "Free", monthlyPriceMWK: 0, annualPriceMWK: 0, isCustomPricing: false, isActive: true },
    { id: "p-biz", key: "BUSINESS", name: "Business", monthlyPriceMWK: 5000, annualPriceMWK: 51000, isCustomPricing: false, isActive: true },
  ];
  const state = {
    sub: { id: "s1", businessId: "b1", planId: "p-free", status: "TRIAL", billingCycle: "MONTHLY", trialEndsAt: new Date(Date.now() + 5 * 86_400_000), currentPeriodStart: null, currentPeriodEnd: null, cancelledAt: null, ...(opts.sub ?? {}) } as Row,
    payment: { id: "g1", businessId: "b1", subscriptionId: "s1", provider: "PAYCHANGU", txRef: REF, planKey: "BUSINESS", billingCycle: "MONTHLY", amount: 5000, currency: "MWK", status: "PENDING", checkoutUrl: "https://x", providerReference: null, failureReason: null, initiatedById: "u1", createdAt: new Date(), completedAt: null, appliedAt: null, applyError: null, prorationCredit: 0, excessAmount: 0, channel: null, lastCheckedAt: null, refundedAmount: 0, refundedAt: null, refundNote: null, ...(opts.payment ?? {}) } as Row,
    audits: [] as Row[],
  };
  const db: any = {
    subscriptionPlan: { findUnique: async ({ where }: any) => plans.find((p) => p.key === where.key) ?? null },
    subscription: {
      findUnique: async () => ({ ...state.sub, plan: plans.find((p) => p.id === state.sub.planId) }),
      update: async ({ data }: any) => { Object.assign(state.sub, data); return { ...state.sub }; },
    },
    businessMember: { count: async () => opts.users ?? 1 },
    branch: { count: async () => opts.branches ?? 1 },
    auditLog: { create: async ({ data }: any) => { state.audits.push(data); return data; } },
    gatewayPayment: {
      findMany: async ({ where }: any) => (state.payment.status === where.status ? [{ ...state.payment }] : []),
      findUnique: async ({ where }: any) => (where.txRef ? (state.payment.txRef === where.txRef ? { ...state.payment } : null) : { ...state.payment }),
      updateMany: async ({ where, data }: any) => {
        if (state.payment.id === where.id && state.payment.status === where.status) { Object.assign(state.payment, data); return { count: 1 }; }
        return { count: 0 };
      },
      update: async ({ data }: any) => { Object.assign(state.payment, data); return { ...state.payment }; },
    },
    $transaction: async (fn: any) => {
      // roll back on throw, like a real transaction
      const snap = JSON.stringify([state.sub, state.payment, state.audits.length]);
      const before = [{ ...state.sub }, { ...state.payment }, state.audits.length] as const;
      try { return await fn(db); } catch (e) { state.sub = before[0] as Row; state.payment = before[1] as Row; state.audits.length = before[2]; void snap; throw e; }
    },
  };
  return { db, state };
}

(async () => {
  // confirmed payment: plan applied, row SUCCEEDED, audit carries the payment
  {
    const { db, state } = makeDb();
    const r = await settleWithVerdict(db, { ...state.payment } as any, v());
    check("apply: outcome", r.outcome, "APPLIED");
    check("apply: subscription active on the paid plan", [state.sub.status, state.sub.planId], ["ACTIVE", "p-biz"]);
    check("apply: period set", state.sub.currentPeriodEnd instanceof Date, true);
    check("apply: payment succeeded + applied", [state.payment.status, state.payment.appliedAt instanceof Date, state.payment.providerReference], ["SUCCEEDED", true, "PC123"]);
    check("apply: one audit with gateway info", [state.audits.length, state.audits[0].action, state.audits[0].metadata.gateway.txRef], [1, "subscription.plan_changed", REF]);
    // the webhook and the return page both arrive: second settle changes nothing
    const again = await settleWithVerdict(db, { ...state.payment, status: "PENDING" } as any, v());
    check("apply twice: second is already settled", again.outcome, "ALREADY_SETTLED");
    check("apply twice: still one audit", state.audits.length, 1);
  }
  // early renewal stacks onto remaining paid time
  {
    const end = new Date(Date.now() + 10 * 86_400_000);
    const { db, state } = makeDb({ sub: { planId: "p-biz", status: "ACTIVE", currentPeriodEnd: end } });
    await settleWithVerdict(db, { ...state.payment } as any, v());
    check("renewal: end moved 30 days past the old end", state.sub.currentPeriodEnd.getTime(), end.getTime() + 30 * 86_400_000);
  }
  // underpayment: recorded failed, plan NOT applied
  {
    const { db, state } = makeDb();
    const r = await settleWithVerdict(db, { ...state.payment } as any, v({ amount: 100 }));
    check("short: outcome", r.outcome, "FAILED");
    check("short: plan untouched", [state.sub.status, state.sub.planId], ["TRIAL", "p-free"]);
    check("short: failed audit says mismatch", [state.audits[0].action, state.audits[0].metadata.mismatch], ["subscription.payment_failed", true]);
  }
  // pending / unreadable: nothing written
  {
    const { db, state } = makeDb();
    const r = await settleWithVerdict(db, { ...state.payment } as any, { outcome: "UNREADABLE", reason: "x" });
    check("unreadable: stays pending", [r.outcome, state.payment.status, state.audits.length], ["PENDING", "PENDING", 0]);
  }
  // money arrived but limits changed meanwhile: money recorded, plan not applied, person told
  {
    const { db, state } = makeDb({ branches: 3, users: 1 });
    // BUSINESS has maxBranches 1 in plans.ts, so 3 branches blocks the change
    const r = await settleWithVerdict(db, { ...state.payment } as any, v());
    check("paid-not-applied: outcome", r.outcome, "PAID_NOT_APPLIED");
    check("paid-not-applied: payment SUCCEEDED with applyError", [state.payment.status, typeof state.payment.applyError, state.payment.appliedAt], ["SUCCEEDED", "string", null]);
    check("paid-not-applied: plan untouched", [state.sub.status, state.sub.planId], ["TRIAL", "p-free"]);
    check("paid-not-applied: audit written", state.audits.map((a) => a.action), ["subscription.payment_apply_failed"]);
  }
  // an unexpected error rolls the claim back so a retry can succeed
  {
    const { db, state } = makeDb();
    const real = db.subscription.update;
    db.subscription.update = async () => { throw new Error("db down"); };
    let threw = false;
    try { await settleWithVerdict(db, { ...state.payment } as any, v()); } catch { threw = true; }
    check("db error: thrown", threw, true);
    check("db error: claim rolled back, still pending", state.payment.status, "PENDING");
    db.subscription.update = real;
    const retry = await settleWithVerdict(db, { ...state.payment } as any, v());
    check("db error: retry succeeds", retry.outcome, "APPLIED");
  }

  // webhook handler + settleGatewayPayment with a fake gateway
  process.env.PAYCHANGU_SECRET_KEY = "k";
  process.env.NEXTAUTH_URL = "https://app.example.com";
  process.env.PAYCHANGU_WEBHOOK_SECRET = "sec";
  let verifyCalls = 0;
  const deps: GatewayDeps = {
    createCheckout: async () => ({ status: 200, text: "{}" }),
    verify: async () => { verifyCalls++; return { status: 200, text: paid() }; },
  };
  {
    const { db, state } = makeDb();
    const bad = await handleGatewayWebhook({ rawBody: body, signature: "deadbeef" }, deps, db);
    check("webhook: bad signature 401, gateway never asked", [bad.httpStatus, verifyCalls], [401, 0]);
    const missing = await handleGatewayWebhook({ rawBody: body, signature: null }, deps, db);
    check("webhook: missing signature 401", missing.httpStatus, 401);
    const good = await handleGatewayWebhook({ rawBody: body, signature: sign(body, "sec") }, deps, db);
    check("webhook: good signature applies", [good.httpStatus, (good.body as any).outcome, state.sub.status], [200, "APPLIED", "ACTIVE"]);
    const stranger = JSON.stringify({ tx_ref: "MBM-SUB-ZZZZZZZZZZZZZZZZ" });
    const unknown = await handleGatewayWebhook({ rawBody: stranger, signature: sign(stranger, "sec") }, deps, db);
    check("webhook: unknown ref is 200 (no retry storm)", [unknown.httpStatus, (unknown.body as any).outcome], [200, "NOT_FOUND"]);
    const noref = await handleGatewayWebhook({ rawBody: "{}", signature: sign("{}", "sec") }, deps, db);
    check("webhook: no ref is 200 and reconciles pending instead (none left here)", [noref.httpStatus, (noref.body as any).reconciled?.checked], [200, 0]);
  }
  {
    // the signature is optional; the webhook body is never believed either way
    delete process.env.PAYCHANGU_WEBHOOK_SECRET;
    const { db, state } = makeDb();
    verifyCalls = 0;
    const lying: GatewayDeps = { ...deps, verify: async () => { verifyCalls++; return { status: 200, text: paid({ status: "failed" }) }; } };
    const forged = JSON.stringify({ tx_ref: REF, status: "success", amount: 5000 });
    const r = await handleGatewayWebhook({ rawBody: forged, signature: null }, lying, db);
    check("forged 'success' webhook: gateway asked, nothing applied", [verifyCalls, (r.body as any).outcome, state.sub.status], [1, "FAILED", "TRIAL"]);
  }
  {
    // another business can't settle (or even see) this payment
    const { db } = makeDb();
    const r = await settleGatewayPayment({ txRef: REF, businessId: "other" }, deps, db);
    check("tenant scoping: other business sees NOT_FOUND", r.outcome, "NOT_FOUND");
    delete process.env.PAYCHANGU_SECRET_KEY;
    const { db: db2 } = makeDb();
    const r2 = await settleGatewayPayment({ txRef: REF }, deps, db2);
    check("not configured: stays pending, says why", [r2.outcome, /PAYCHANGU_SECRET_KEY/.test(r2.message)], ["PENDING", true]);
  }


  // ---- Module 74: reconcile, channel/excess recorded, refunds ------------------
  {
    process.env.PAYCHANGU_SECRET_KEY = "k";
    process.env.NEXTAUTH_URL = "https://app.example.com";
    delete process.env.PAYCHANGU_WEBHOOK_SECRET;
    let calls = 0;
    const d2: GatewayDeps = { ...deps, verify: async () => { calls++; return { status: 200, text: paid({ amount: 5200, authorization: { channel: "Mobile Money", provider: "Airtel Money" } }) }; } };
    const { db, state } = makeDb();
    const r = await reconcilePendingSubscriptionPayments({ limit: 5, minSecondsBetweenChecks: 60 }, d2, db);
    check("reconcile: pending payment settled by polling", [r.checked, r.applied, state.sub.status], [1, 1, "ACTIVE"]);
    check("reconcile: channel and excess recorded", [state.payment.channel, state.payment.excessAmount], ["Mobile Money", 200]);
    check("reconcile: paid plan is flagged requiresPayment", state.sub.requiresPayment, true);
    check("reconcile: second run finds nothing pending", (await reconcilePendingSubscriptionPayments({ limit: 5, minSecondsBetweenChecks: 60 }, d2, db)).checked, 0);
    check("reconcile: gateway asked once", calls, 1);

    const t = makeDb({ payment: { lastCheckedAt: new Date() } });
    calls = 0;
    const th = await reconcilePendingSubscriptionPayments({ limit: 5, minSecondsBetweenChecks: 60 }, d2, t.db);
    check("reconcile: recently checked payment is skipped", [th.checked, calls], [0, 0]);

    // refunds against the fake db
    const rf = makeDb();
    (rf.db as any).invoicePayment = { findUnique: async () => null };
    rf.state.payment = { ...rf.state.payment, status: "SUCCEEDED", excessAmount: 200 };
    const ok1 = await recordRefund({ txRef: REF, amount: 200, note: "Airtel Money to payer", userId: "op" }, rf.db);
    check("refund recorded", [ok1.ok, rf.state.payment.refundedAmount, rf.state.audits[0]?.action], [true, 200, "subscription.payment_refunded"]);
    check("refund over the remainder refused", (await recordRefund({ txRef: REF, amount: 5001, note: "x", userId: "op" }, rf.db)).ok, false);
    check("refund needs a note", (await recordRefund({ txRef: REF, amount: 1, note: " ", userId: "op" }, rf.db)).ok, false);
    check("refund of unknown reference refused", (await recordRefund({ txRef: "MBM-SUB-NOPENOPENOPE", amount: 1, note: "x", userId: "op" }, { ...rf.db, gatewayPayment: { findUnique: async () => null } } as any)).ok, false);
  }

  // ---- Module 74: invoice payments settle path ---------------------------------
  {
    const IREF = buildInvoiceTxRef("a1b2c3d4e5f6a1b2c3d4e5f6");
    const mk = (saleOver: Record<string, unknown> = {}) => {
      const st = {
        sale: { id: "sale1", businessId: "b1", customerId: "c1", saleNumber: "SALE-1", total: 5000, amountPaid: 0, balance: 5000, status: "CREDIT", currency: null, ...saleOver } as Row,
        ip: { id: "i1", businessId: "b1", saleId: "sale1", txRef: IREF, amount: 5000, currency: "MWK", status: "PENDING", recordedById: "u9", providerReference: null, channel: null, excessAmount: 0, applyError: null, paymentId: null, appliedAt: null, completedAt: null, failureReason: null, lastCheckedAt: null, refundedAmount: 0, createdAt: new Date() } as Row,
        payments: [] as Row[], audits: [] as Row[], ledger: [] as Row[],
      };
      const db: any = {
        invoicePayment: {
          findUnique: async () => ({ ...st.ip }),
          updateMany: async ({ where, data }: any) => { if (st.ip.id === where.id && st.ip.status === where.status) { Object.assign(st.ip, data); return { count: 1 }; } return { count: 0 }; },
          update: async ({ data }: any) => { Object.assign(st.ip, data); return { ...st.ip }; },
        },
        sale: { findUnique: async () => ({ ...st.sale }), update: async ({ data }: any) => { Object.assign(st.sale, data); return { ...st.sale }; } },
        payment: { create: async ({ data }: any) => { const row = { id: `pay${st.payments.length + 1}`, ...data }; st.payments.push(row); return row; } },
        auditLog: { create: async ({ data }: any) => { st.audits.push(data); return data; } },
        $transaction: async (fn: any) => {
          const before = [{ ...st.sale }, { ...st.ip }, st.payments.length, st.audits.length, st.ledger.length] as const;
          try { return await fn(db); } catch (e) { st.sale = before[0] as Row; st.ip = before[1] as Row; st.payments.length = before[2]; st.audits.length = before[3]; st.ledger.length = before[4]; throw e; }
        },
      };
      const ledger: LedgerPoster = async (_tx, p) => { st.ledger.push(p as any); };
      return { db, st, ledger };
    };
    const iv = (over: Record<string, unknown> = {}) => ({ outcome: "PAID" as const, txRef: IREF, amount: 5000, currency: "MWK", providerReference: "PCX1", channel: "Mobile Money", provider: "TNM Mpamba", ...over });

    let m = mk();
    let r = await settleInvoiceWithVerdict(m.db, m.st.ip as any, iv(), new Date(), m.ledger);
    check("invoice: applied", r.outcome, "APPLIED");
    check("invoice: sale now PAID, balance 0", [m.st.sale.status, m.st.sale.balance, m.st.sale.amountPaid], ["PAID", 0, 5000]);
    check("invoice: ordinary Payment row, method from channel, booked in the link creator's name", [m.st.payments[0].method, m.st.payments[0].amount, m.st.payments[0].recordedById, m.st.payments[0].saleId], ["TNM_MPAMBA", 5000, "u9", "sale1"]);
    check("invoice: cashbook+journal posted once", m.st.ledger.length, 1);
    check("invoice: payment row linked", [m.st.ip.status, m.st.ip.paymentId, m.st.ip.channel], ["SUCCEEDED", "pay1", "Mobile Money"]);
    const again = await settleInvoiceWithVerdict(m.db, { ...m.st.ip, status: "PENDING" } as any, iv(), new Date(), m.ledger);
    check("invoice: second settle books nothing", [again.outcome, m.st.payments.length, m.st.ledger.length], ["ALREADY_SETTLED", 1, 1]);

    m = mk();
    r = await settleInvoiceWithVerdict(m.db, m.st.ip as any, iv({ amount: 100 }), new Date(), m.ledger);
    check("invoice: underpayment fails, nothing booked", [r.outcome, m.st.payments.length, m.st.sale.balance], ["FAILED", 0, 5000]);
    m = mk();
    r = await settleInvoiceWithVerdict(m.db, m.st.ip as any, { outcome: "UNREADABLE" }, new Date(), m.ledger);
    check("invoice: unreadable stays pending", [r.outcome, m.st.ip.status], ["PENDING", "PENDING"]);
    m = mk({ balance: 0, amountPaid: 5000, status: "PAID" });
    r = await settleInvoiceWithVerdict(m.db, m.st.ip as any, iv(), new Date(), m.ledger);
    check("invoice: already paid meanwhile -> money kept, nothing applied, excess recorded", [r.outcome, m.st.payments.length, m.st.ip.excessAmount, typeof m.st.ip.applyError], ["PAID_NOT_APPLIED", 0, 5000, "string"]);
    m = mk({ balance: 2000, amountPaid: 3000, status: "PARTIAL" });
    r = await settleInvoiceWithVerdict(m.db, m.st.ip as any, iv(), new Date(), m.ledger);
    check("invoice: part-settled meanwhile applies only what is owed", [r.outcome, m.st.payments[0].amount, m.st.sale.status, m.st.ip.excessAmount], ["APPLIED", 2000, "PAID", 3000]);
    m = mk({ status: "VOIDED" });
    r = await settleInvoiceWithVerdict(m.db, m.st.ip as any, iv(), new Date(), m.ledger);
    check("invoice: voided sale -> money kept, not applied", [r.outcome, m.st.payments.length], ["PAID_NOT_APPLIED", 0]);
    m = mk();
    const boom: LedgerPoster = async () => { throw new Error("ledger down"); };
    let threw = false;
    try { await settleInvoiceWithVerdict(m.db, m.st.ip as any, iv(), new Date(), boom); } catch { threw = true; }
    check("invoice: ledger failure rolls everything back, still pending", [threw, m.st.ip.status, m.st.sale.amountPaid, m.st.payments.length], [true, "PENDING", 0, 0]);
    r = await settleInvoiceWithVerdict(m.db, m.st.ip as any, iv(), new Date(), m.ledger);
    check("invoice: retry after rollback succeeds", r.outcome, "APPLIED");
    check("public wording never leaks internals", [publicInvoiceMessage({ outcome: "FAILED", payment: null, message: "secret reason 4,000 vs 5,000" }).includes("secret"), publicInvoiceMessage({ outcome: "PAID_NOT_APPLIED", payment: null, message: "x" }).includes("received")], [false, true]);

    // business webhook: no credentials configured -> ignored 200 (nothing to verify with)
    const nocreds = await handleBusinessWebhook({ businessId: "b1", rawBody: "{}", signature: null }, deps, { businessGatewayConfig: { findUnique: async () => null } } as any);
    check("business webhook: no settings -> 200 ignored", [nocreds.httpStatus, (nocreds.body as any).ignored], [200, true]);
  }

  console.log(failed === 0 ? `OK ${total} checks` : `${failed} of ${total} checks FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
