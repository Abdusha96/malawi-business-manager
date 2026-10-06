import { receiptNumberFor } from "./payment-gateway";
import { renderBusinessDocumentPdf } from "./pdf";

/**
 * Module 74 – the receipt for a subscription payment, as the PDF a person downloads from Billing and
 * as the HTML in the "payment received" email. The seller is the PLATFORM (this app's operator), not
 * the tenant, so its name and contact details come from env (`PLATFORM_NAME`, `PLATFORM_EMAIL`,
 * `PLATFORM_PHONE`, `PLATFORM_ADDRESS`) with a generic default. No tax line is printed: this app does
 * not know the operator's VAT position, and printing a made-up one would be worse than none.
 */

export interface SubscriptionReceiptData {
  txRef: string;
  businessName: string;
  planKey: string;
  billingCycle: "MONTHLY" | "ANNUAL";
  amount: number;
  prorationCredit: number;
  paidAt: Date;
  applied: boolean;
  applyError: string | null;
  appUrl: string | null;
}

const PLAN_NAMES: Record<string, string> = { FREE: "Free", BUSINESS: "Business", PROFESSIONAL: "Professional", ENTERPRISE: "Enterprise" };

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function mwk(n: number): string {
  return `MWK ${n.toLocaleString("en-US")}`;
}

export function renderSubscriptionReceiptHtml(d: SubscriptionReceiptData): string {
  const plan = PLAN_NAMES[d.planKey] ?? d.planKey;
  const cycle = d.billingCycle === "MONTHLY" ? "monthly" : "annual";
  const link = d.appUrl ? `<p><a href="${esc(d.appUrl)}/settings/billing">Open Billing</a> to download your receipt.</p>` : "";
  return [
    `<p>Thank you. We received your payment of <strong>${esc(mwk(d.amount))}</strong> for <strong>${esc(d.businessName)}</strong>.</p>`,
    `<p>Receipt ${esc(receiptNumberFor(d.txRef))} · ${esc(plan)} plan (${cycle}) · reference ${esc(d.txRef)}</p>`,
    d.prorationCredit > 0 ? `<p>A credit of ${esc(mwk(d.prorationCredit))} for unused time on your previous plan was taken off the price.</p>` : "",
    d.applied
      ? `<p>Your ${esc(plan)} plan is now active.</p>`
      : `<p><strong>Your payment is safe, but we could not switch your plan yet:</strong> ${esc(d.applyError ?? "unknown reason")}. Please contact support and quote the reference above.</p>`,
    link,
  ].join("\n");
}

export interface PlatformSeller {
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
}

export function readPlatformSeller(env: Record<string, string | undefined>): PlatformSeller {
  return {
    name: (env.PLATFORM_NAME ?? "").trim() || "Malawi Business Manager",
    email: (env.PLATFORM_EMAIL ?? "").trim() || null,
    phone: (env.PLATFORM_PHONE ?? "").trim() || null,
    address: (env.PLATFORM_ADDRESS ?? "").trim() || null,
  };
}

export function renderSubscriptionReceiptPdf(params: {
  data: SubscriptionReceiptData;
  seller: PlatformSeller;
  timeZone: string;
  payer: { name: string; email: string | null; phone: string | null };
  channel: string | null;
  refundedAmount: number;
}): Promise<Buffer> {
  const { data, seller, timeZone, payer, channel, refundedAmount } = params;
  const plan = PLAN_NAMES[data.planKey] ?? data.planKey;
  const cycle = data.billingCycle === "MONTHLY" ? "monthly" : "annual";
  const gross = data.amount + data.prorationCredit;
  const meta = [
    { label: "Reference", value: data.txRef },
    ...(channel ? [{ label: "Paid by", value: channel }] : []),
  ];
  return renderBusinessDocumentPdf({
    documentTitle: "PAYMENT RECEIPT",
    documentNumber: receiptNumberFor(data.txRef),
    documentDate: data.paidAt,
    timeZone,
    currency: "MWK",
    business: { name: seller.name, phone: seller.phone, email: seller.email, physicalAddress: seller.address },
    billTo: { name: payer.name, phone: payer.phone, email: payer.email },
    metaLines: meta,
    items: [{ description: `${plan} plan, ${cycle} subscription for ${data.businessName}`, quantity: 1, unitPrice: gross, discount: data.prorationCredit, total: data.amount }],
    subtotal: gross,
    discount: data.prorationCredit,
    tax: 0,
    total: data.amount,
    amountPaid: data.amount,
    balance: 0,
    notes: refundedAmount > 0 ? `Refunded: ${mwk(refundedAmount)}.` : data.applied ? null : "Payment received; the plan change is pending. Contact support.",
    footerNote: data.prorationCredit > 0 ? "Discount shown is the credit for unused time on your previous plan." : undefined,
  });
}
