import { randomBytes } from "crypto";
import { nanoid } from "nanoid";
import { InvoicePayment, Prisma, PaymentMethod } from "@prisma/client";
import { prisma } from "./prisma";
import { logAudit } from "./audit";
import { decryptSecret, encryptSecret, readEncryptionKey, secretHint } from "./secret-box";
import {
  CHECKOUT_REUSE_MINUTES,
  GATEWAY_CURRENCY,
  GatewayConfig,
  VerifyVerdict,
  buildCheckoutRequest,
  buildInvoiceTxRef,
  checkWebhookSignature,
  computeInvoiceApplication,
  decideSettlement,
  extractWebhookTxRef,
  invoiceChargeMWK,
  isValidInvoiceTxRef,
  isValidPayToken,
  mapChannelToPaymentMethod,
  parseCheckoutResponse,
  parseVerifyResponse,
  readGatewayConfig,
  shouldCheckNow,
} from "./payment-gateway";
import { GatewayDeps, realGatewayDeps } from "./gateway-payments";
import { postCashTransactionForPayment } from "./cashbook";
import { postJournalEntryForPayment } from "./accounting-integrations";

/**
 * Module 74 – customers paying a business's invoice online.
 *
 * Money must reach the BUSINESS, not the platform, so this uses the business's own PayChangu
 * credentials (entered by its Owner on /settings/online-payments, stored AES-256-GCM encrypted,
 * never returned by any route). The flow mirrors the subscription one in gateway-payments.ts and
 * keeps its rules: our own `txRef`, the amount snapshotted at checkout start, and the payment is
 * confirmed ONLY by asking the gateway (with the business's key) about that reference, then compared
 * on reference, currency and amount before anything is booked. A confirmed payment is applied as an
 * ordinary customer Payment (same cashbook receipt and journal entry as one typed in by hand) inside
 * the same transaction that claims the row, so the webhook, the return page and the cron job racing
 * each other apply it exactly once.
 *
 * Access is by an unguessable per-invoice link (SalePayLink.token, 32 URL-safe characters). The link
 * lets anyone holding it pay THAT invoice and shows only the business name, the invoice number and the
 * amount due; it grants no other access.
 */

export class InvoicePaymentError extends Error {
  status = 400;
}

type Db = typeof prisma;

// --- credentials -----------------------------------------------------------------------------

export interface GatewayCredentials {
  secretKey: string;
  webhookSecret: string | null;
}

export async function getBusinessGatewayCredentials(businessId: string, db: Db = prisma): Promise<GatewayCredentials | null> {
  const row = await db.businessGatewayConfig.findUnique({ where: { businessId } });
  if (!row || !row.isActive) return null;
  const k = readEncryptionKey(process.env);
  if (!k.ok) return null;
  const secretKey = decryptSecret(row.secretKeyEnc, k.key);
  if (!secretKey) return null; // key changed or value corrupted: treated as "not set up", never guessed
  const webhookSecret = row.webhookSecretEnc ? decryptSecret(row.webhookSecretEnc, k.key) : null;
  return { secretKey, webhookSecret };
}

function configFor(creds: GatewayCredentials): GatewayConfig {
  const base = readGatewayConfig(process.env);
  return { ...base, secretKey: creds.secretKey, webhookSecret: creds.webhookSecret, configured: !!base.appUrl && /^https?:\/\//i.test(base.appUrl) };
}

export async function getOnlinePaymentsStatus(businessId: string) {
  const row = await prisma.businessGatewayConfig.findUnique({ where: { businessId } });
  const key = readEncryptionKey(process.env);
  const platform = readGatewayConfig(process.env);
  const appUrl = platform.appUrl;
  return {
    encryptionReady: key.ok,
    encryptionReason: key.ok ? null : key.reason,
    appUrlReady: !!appUrl,
    saved: !!row,
    active: !!row?.isActive,
    secretKeyHint: row?.secretKeyHint ?? null,
    hasWebhookSecret: !!row?.webhookSecretEnc,
    // What the business pastes into its PayChangu dashboard (Settings > API & Webhooks).
    webhookUrl: appUrl ? `${appUrl}/api/webhooks/paychangu/business/${businessId}` : null,
    provider: "PayChangu",
  };
}

export async function saveOnlinePaymentsConfig(params: { businessId: string; userId: string; secretKey: string; webhookSecret?: string | null }) {
  const k = readEncryptionKey(process.env);
  if (!k.ok) throw new InvoicePaymentError(`Online payments can't be set up on this server yet: ${k.reason}`);
  const secretKey = params.secretKey.trim();
  if (secretKey.length < 8) throw new InvoicePaymentError("That doesn't look like a PayChangu secret key.");
  const webhookSecret = (params.webhookSecret ?? "").trim();
  const data = {
    secretKeyEnc: encryptSecret(secretKey, k.key),
    webhookSecretEnc: webhookSecret ? encryptSecret(webhookSecret, k.key) : null,
    secretKeyHint: secretHint(secretKey),
    isActive: true,
    updatedById: params.userId,
  };
  await prisma.$transaction(async (tx) => {
    await tx.businessGatewayConfig.upsert({ where: { businessId: params.businessId }, create: { businessId: params.businessId, ...data }, update: data });
    await logAudit({ tx, businessId: params.businessId, userId: params.userId, action: "online_payments.configured", entityType: "BusinessGatewayConfig", entityId: params.businessId, metadata: { keyHint: data.secretKeyHint, hasWebhookSecret: !!webhookSecret } });
  });
}

export async function removeOnlinePaymentsConfig(params: { businessId: string; userId: string }) {
  await prisma.$transaction(async (tx) => {
    await tx.businessGatewayConfig.deleteMany({ where: { businessId: params.businessId } });
    // Existing links stop working at once: with no credentials there is nothing to charge with.
    await logAudit({ tx, businessId: params.businessId, userId: params.userId, action: "online_payments.removed", entityType: "BusinessGatewayConfig", entityId: params.businessId });
  });
}

// --- pay links -------------------------------------------------------------------------------

export function payLinkUrl(appUrl: string, token: string): string {
  return `${appUrl}/pay/${token}`;
}

/** One link per Sale, created on first request and returned as-is afterwards (a revoked one is re-opened). */
export async function createOrGetPayLink(params: { businessId: string; saleId: string; userId: string }) {
  const { businessId, saleId, userId } = params;
  const platform = readGatewayConfig(process.env);
  if (!platform.appUrl) throw new InvoicePaymentError("NEXTAUTH_URL is not set, so a pay link cannot be built.");
  const creds = await getBusinessGatewayCredentials(businessId);
  if (!creds) throw new InvoicePaymentError("Set up online payments under Settings first.");

  const sale = await prisma.sale.findUnique({ where: { id: saleId } });
  if (!sale || sale.businessId !== businessId) throw Object.assign(new InvoicePaymentError("Sale not found in this business."), { status: 404 });
  if (sale.status === "VOIDED") throw new InvoicePaymentError("A voided sale can't be paid.");
  if (sale.currency) throw new InvoicePaymentError("Online payment is only available for invoices in kwacha.");
  if (Number(sale.balance) < 1) throw new InvoicePaymentError("Nothing is owed on this sale.");

  const existing = await prisma.salePayLink.findUnique({ where: { saleId } });
  const link = existing
    ? existing.revokedAt
      ? await prisma.salePayLink.update({ where: { id: existing.id }, data: { revokedAt: null, createdById: userId } })
      : existing
    : await prisma.salePayLink.create({ data: { businessId, saleId, token: nanoid(32), createdById: userId } });
  return { token: link.token, url: payLinkUrl(platform.appUrl, link.token) };
}

export async function revokePayLink(params: { businessId: string; saleId: string }) {
  await prisma.salePayLink.updateMany({ where: { businessId: params.businessId, saleId: params.saleId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function getPayLinkStatus(businessId: string, saleId: string) {
  const platform = readGatewayConfig(process.env);
  const [link, payments, creds] = await Promise.all([
    prisma.salePayLink.findUnique({ where: { saleId } }),
    prisma.invoicePayment.findMany({ where: { businessId, saleId }, orderBy: { createdAt: "desc" }, take: 10 }),
    getBusinessGatewayCredentials(businessId),
  ]);
  return {
    available: !!creds && !!platform.appUrl,
    url: link && !link.revokedAt && platform.appUrl ? payLinkUrl(platform.appUrl, link.token) : null,
    payments: payments.map((p) => ({
      id: p.id, txRef: p.txRef, amount: Number(p.amount), status: p.status, createdAt: p.createdAt, channel: p.channel,
      excessAmount: Number(p.excessAmount), applyError: p.applyError, failureReason: p.failureReason,
    })),
  };
}

// --- public view -----------------------------------------------------------------------------

export interface PublicInvoice {
  businessName: string;
  saleNumber: string;
  amountDue: number;
  chargeMWK: number;
  canPay: boolean;
  reason: string | null;
}

/** What the public pay page may show: nothing beyond name, number and amount. */
export async function getPublicInvoice(token: string, db: Db = prisma): Promise<PublicInvoice | null> {
  if (!isValidPayToken(token)) return null;
  const link = await db.salePayLink.findUnique({ where: { token } });
  if (!link || link.revokedAt) return null;
  const [sale, business] = await Promise.all([
    db.sale.findUnique({ where: { id: link.saleId } }),
    db.business.findUnique({ where: { id: link.businessId }, select: { name: true } }),
  ]);
  if (!sale || !business) return null;
  const due = Number(sale.balance);
  const creds = await getBusinessGatewayCredentials(link.businessId, db);
  let reason: string | null = null;
  if (sale.status === "VOIDED") reason = "This invoice has been cancelled.";
  else if (sale.currency) reason = "This invoice is not payable online.";
  else if (due < 1) reason = "This invoice has been paid in full. Thank you.";
  else if (!creds) reason = "Online payment is not available for this business right now.";
  return { businessName: business.name, saleNumber: sale.saleNumber, amountDue: due, chargeMWK: invoiceChargeMWK(due), canPay: reason === null, reason };
}

// --- start -----------------------------------------------------------------------------------

export async function startInvoiceCheckout(
  params: { token: string; email?: string | null; name?: string | null },
  deps: GatewayDeps = realGatewayDeps,
  db: Db = prisma
): Promise<{ checkoutUrl: string; txRef: string; reused: boolean }> {
  const platform = readGatewayConfig(process.env);
  if (!platform.appUrl) throw new InvoicePaymentError("Online payment is not available right now.");
  if (!isValidPayToken(params.token)) throw Object.assign(new InvoicePaymentError("This payment link is not valid."), { status: 404 });

  const link = await db.salePayLink.findUnique({ where: { token: params.token } });
  if (!link || link.revokedAt) throw Object.assign(new InvoicePaymentError("This payment link is not valid."), { status: 404 });
  const creds = await getBusinessGatewayCredentials(link.businessId, db);
  if (!creds) throw new InvoicePaymentError("Online payment is not available for this business right now.");

  const sale = await db.sale.findUnique({ where: { id: link.saleId } });
  const business = await db.business.findUnique({ where: { id: link.businessId }, select: { name: true } });
  if (!sale || !business) throw Object.assign(new InvoicePaymentError("This payment link is not valid."), { status: 404 });
  if (sale.status === "VOIDED") throw new InvoicePaymentError("This invoice has been cancelled.");
  if (sale.currency) throw new InvoicePaymentError("This invoice is not payable online.");
  const amount = invoiceChargeMWK(Number(sale.balance));
  if (amount < 1) throw new InvoicePaymentError("This invoice has been paid in full.");

  const email = (params.email ?? "").trim() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InvoicePaymentError("That email address doesn't look right.");

  const since = new Date(Date.now() - CHECKOUT_REUSE_MINUTES * 60_000);
  const open = await db.invoicePayment.findFirst({
    where: { saleId: sale.id, status: "PENDING", amount, createdAt: { gte: since }, checkoutUrl: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  if (open?.checkoutUrl) return { checkoutUrl: open.checkoutUrl, txRef: open.txRef, reused: true };

  const txRef = buildInvoiceTxRef(randomBytes(12).toString("hex"));
  const payment = await db.invoicePayment.create({
    data: { businessId: link.businessId, saleId: sale.id, txRef, amount, currency: GATEWAY_CURRENCY, payerEmail: email, recordedById: link.createdById },
  });

  const config = configFor(creds);
  const body = buildCheckoutRequest({
    amountMWK: amount,
    txRef,
    email,
    name: params.name ?? null,
    redirectUrl: `${platform.appUrl}/pay/${params.token}/return/${txRef}`,
    title: business.name,
    description: `Invoice ${sale.saleNumber}`,
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
    await db.invoicePayment.updateMany({ where: { id: payment.id, status: "PENDING" }, data: { status: "FAILED", failureReason: failure ?? "No payment link was returned.", completedAt: new Date() } });
    throw Object.assign(new InvoicePaymentError("The payment could not be started. Please try again in a moment."), { status: 502 });
  }
  await db.invoicePayment.update({ where: { id: payment.id }, data: { checkoutUrl } });
  return { checkoutUrl, txRef, reused: false };
}

// --- settle ----------------------------------------------------------------------------------

export type InvoiceSettleOutcome = "APPLIED" | "PAID_NOT_APPLIED" | "FAILED" | "PENDING" | "ALREADY_SETTLED" | "NOT_FOUND";
export interface InvoiceSettleResult {
  outcome: InvoiceSettleOutcome;
  payment: InvoicePayment | null;
  message: string;
}

/** Books the cashbook receipt and the journal entry for a Payment: injectable so the settle path can be checked without them. */
export type LedgerPoster = (tx: Prisma.TransactionClient, p: { businessId: string; paymentId: string; amount: number; method: PaymentMethod; userId: string }) => Promise<void>;

export const realLedgerPoster: LedgerPoster = async (tx, p) => {
  await postCashTransactionForPayment({ tx, businessId: p.businessId, paymentId: p.paymentId, createdById: p.userId });
  await postJournalEntryForPayment({ tx, businessId: p.businessId, paymentId: p.paymentId, amount: p.amount, method: p.method, isCustomerSide: true, createdById: p.userId });
};

function alreadySettled(p: InvoicePayment): string {
  if (p.status === "FAILED") return `This payment did not go through${p.failureReason ? `: ${p.failureReason}` : "."}`;
  if (p.applyError) return `Payment received, but it could not be applied to the invoice: ${p.applyError}`;
  return "Payment received. Thank you.";
}

/** Public-safe wording: never reveals more than the payer needs. */
export function publicInvoiceMessage(r: InvoiceSettleResult): string {
  switch (r.outcome) {
    case "APPLIED": return "Payment received. Thank you!";
    case "PAID_NOT_APPLIED": return "Your payment was received. The business will confirm it with you shortly.";
    case "FAILED": return "The payment did not go through. You have not been charged. You can try again from the invoice link.";
    case "PENDING": return "We have not received confirmation of this payment yet. If you have paid, it can take a few minutes; this page will keep checking.";
    case "ALREADY_SETTLED": return r.payment?.status === "SUCCEEDED" ? "Payment received. Thank you!" : "This payment did not go through.";
    default: return "We could not find that payment.";
  }
}

export async function settleInvoicePayment(
  params: { txRef: string; businessId?: string },
  deps: GatewayDeps = realGatewayDeps,
  db: Db = prisma,
  ledger: LedgerPoster = realLedgerPoster
): Promise<InvoiceSettleResult> {
  const payment = await db.invoicePayment.findUnique({ where: { txRef: params.txRef } });
  if (!payment || (params.businessId && payment.businessId !== params.businessId)) return { outcome: "NOT_FOUND", payment: null, message: "No such payment." };
  if (payment.status !== "PENDING") return { outcome: "ALREADY_SETTLED", payment, message: alreadySettled(payment) };

  const creds = await getBusinessGatewayCredentials(payment.businessId, db);
  if (!creds) return { outcome: "PENDING", payment, message: "The business's payment settings are not available, so this can't be checked yet." };

  await db.invoicePayment.update({ where: { id: payment.id }, data: { lastCheckedAt: new Date() } }).catch(() => undefined);
  let verdict: VerifyVerdict;
  try {
    const reply = await deps.verify(configFor(creds), payment.txRef);
    verdict = parseVerifyResponse(reply.status, reply.text);
  } catch (err) {
    verdict = { outcome: "UNREADABLE", reason: `Could not reach the payment gateway (${err instanceof Error ? err.message : String(err)}).` };
  }
  return settleInvoiceWithVerdict(db, payment, verdict, new Date(), ledger);
}

export async function settleInvoiceWithVerdict(db: Db, payment: InvoicePayment, verdict: VerifyVerdict, now: Date = new Date(), ledger: LedgerPoster = realLedgerPoster): Promise<InvoiceSettleResult> {
  const decision = decideSettlement({ txRef: payment.txRef, amount: Number(payment.amount), currency: payment.currency }, verdict);
  if (decision.action === "KEEP_PENDING") return { outcome: "PENDING", payment, message: decision.reason };

  if (decision.action === "FAIL") {
    const r = await db.invoicePayment.updateMany({ where: { id: payment.id, status: "PENDING" }, data: { status: "FAILED", failureReason: decision.reason, completedAt: now } });
    const fresh = await db.invoicePayment.findUnique({ where: { id: payment.id } });
    return r.count === 1 ? { outcome: "FAILED", payment: fresh, message: decision.reason } : { outcome: "ALREADY_SETTLED", payment: fresh, message: fresh ? alreadySettled(fresh) : "Already settled." };
  }

  const paid = verdict.amount ?? Number(payment.amount);
  const method = mapChannelToPaymentMethod(verdict.channel, verdict.provider);

  const result = await db.$transaction(async (tx) => {
    const claim = await tx.invoicePayment.updateMany({
      where: { id: payment.id, status: "PENDING" },
      data: { status: "SUCCEEDED", completedAt: now, providerReference: decision.providerReference ?? null, channel: verdict.channel ?? null },
    });
    if (claim.count !== 1) return "LOST_RACE" as const;

    const sale = await tx.sale.findUnique({ where: { id: payment.saleId } });
    if (!sale || sale.businessId !== payment.businessId || sale.status === "VOIDED") {
      const why = !sale || sale.businessId !== payment.businessId ? "the invoice no longer exists" : "the invoice was cancelled";
      await tx.invoicePayment.update({ where: { id: payment.id }, data: { applyError: `Not applied: ${why}.`, excessAmount: paid } });
      return "PAID_NOT_APPLIED" as const;
    }

    const { applied, excess } = computeInvoiceApplication({ balance: Number(sale.balance), paid });
    if (applied <= 0.005) {
      await tx.invoicePayment.update({ where: { id: payment.id }, data: { applyError: "Not applied: the invoice was already paid in full by the time this payment arrived.", excessAmount: paid } });
      return "PAID_NOT_APPLIED" as const;
    }

    const newPaid = Math.round((Number(sale.amountPaid) + applied) * 100) / 100;
    const newBalance = Math.max(0, Math.round((Number(sale.total) - newPaid) * 100) / 100);
    await tx.sale.update({ where: { id: sale.id }, data: { amountPaid: newPaid, balance: newBalance, status: newBalance <= 0.01 ? "PAID" : "PARTIAL" } });

    const row = await tx.payment.create({
      data: {
        businessId: payment.businessId,
        saleId: sale.id,
        customerId: sale.customerId ?? undefined,
        amount: applied,
        method,
        reference: decision.providerReference ?? payment.txRef,
        notes: `Paid online${verdict.channel ? ` (${verdict.channel})` : ""}, reference ${payment.txRef}`,
        recordedById: payment.recordedById,
      },
    });
    await ledger(tx, { businessId: payment.businessId, paymentId: row.id, amount: applied, method, userId: payment.recordedById });
    await tx.invoicePayment.update({ where: { id: payment.id }, data: { paymentId: row.id, appliedAt: now, excessAmount: excess } });
    await logAudit({ tx, businessId: payment.businessId, userId: payment.recordedById, action: "payment.online_received", entityType: "Sale", entityId: sale.id, metadata: { txRef: payment.txRef, amount: applied, excess, method } });
    return "APPLIED" as const;
  });

  const fresh = await db.invoicePayment.findUnique({ where: { id: payment.id } });
  if (result === "LOST_RACE") return { outcome: "ALREADY_SETTLED", payment: fresh, message: fresh ? alreadySettled(fresh) : "Already settled." };
  if (result === "APPLIED") return { outcome: "APPLIED", payment: fresh, message: "Payment received and applied to the invoice." };
  return { outcome: "PAID_NOT_APPLIED", payment: fresh, message: fresh?.applyError ?? "Payment received but not applied." };
}

export async function reconcilePendingInvoicePayments(
  params: { businessId?: string; limit: number; minSecondsBetweenChecks: number },
  deps: GatewayDeps = realGatewayDeps,
  db: Db = prisma,
  ledger: LedgerPoster = realLedgerPoster
): Promise<{ checked: number; applied: number; failed: number; stillPending: number }> {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const rows = await db.invoicePayment.findMany({
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
    const r = await settleInvoicePayment({ txRef: row.txRef }, deps, db, ledger);
    if (r.outcome === "APPLIED" || r.outcome === "PAID_NOT_APPLIED") out.applied++;
    else if (r.outcome === "FAILED") out.failed++;
    else if (r.outcome === "PENDING") out.stillPending++;
  }
  return out;
}

/** The per-business webhook: signed with THAT business's webhook secret, never the platform's. */
export async function handleBusinessWebhook(
  params: { businessId: string; rawBody: string; signature: string | null },
  deps: GatewayDeps = realGatewayDeps,
  db: Db = prisma,
  ledger: LedgerPoster = realLedgerPoster
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const creds = await getBusinessGatewayCredentials(params.businessId, db);
  if (!creds) return { httpStatus: 200, body: { ignored: true, reason: "no payment settings" } };
  const sig = checkWebhookSignature({ rawBody: params.rawBody, signature: params.signature, secret: creds.webhookSecret });
  if (sig === "MISSING_SIGNATURE" || sig === "BAD_SIGNATURE") return { httpStatus: 401, body: { error: "invalid_signature" } };

  const txRef = extractWebhookTxRef(params.rawBody);
  if (!txRef) {
    const r = await reconcilePendingInvoicePayments({ businessId: params.businessId, limit: 20, minSecondsBetweenChecks: 30 }, deps, db, ledger);
    return { httpStatus: 200, body: { reconciled: r } };
  }
  if (!isValidInvoiceTxRef(txRef)) return { httpStatus: 200, body: { ignored: true, reason: "not an invoice reference" } };
  const r = await settleInvoicePayment({ txRef, businessId: params.businessId }, deps, db, ledger);
  return { httpStatus: 200, body: { outcome: r.outcome } };
}
