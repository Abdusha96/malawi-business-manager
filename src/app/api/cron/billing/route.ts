import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { reconcilePendingSubscriptionPayments } from "@/lib/gateway-payments";
import { reconcilePendingInvoicePayments } from "@/lib/invoice-payments";
import { sendRenewalReminders } from "@/lib/subscription-renewal";
import { retryFailedNotifications } from "@/lib/notification-retry-run";

// Module 74 – the one entry point for work that has to happen without a person looking at a page.
// This app has no scheduler of its own (a standing choice since Depreciation); a host's cron, an
// uptime pinger or Vercel Cron calls this URL instead, every 15 minutes to an hour:
//   curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://your.domain/api/cron/billing
// It (1) asks the gateway about pending subscription and invoice payments, which is the polling
// backstop PayChangu's docs recommend, (2) sends renewal reminders, and (3, Module 75) retries emails/SMS that failed for a temporary reason. Every step is idempotent, so
// running it twice, or overlapping runs, is safe. Outside the auth middleware (no session); guarded by
// CRON_SECRET, and switched OFF (503) until that variable is set.
function authorised(req: NextRequest): "OK" | "OFF" | "DENIED" {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return "OFF";
  const header = req.headers.get("authorization") ?? "";
  const given = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : (req.headers.get("x-cron-secret") ?? "").trim();
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b) ? "OK" : "DENIED";
}

async function run(req: NextRequest) {
  const auth = authorised(req);
  if (auth === "OFF") return NextResponse.json({ error: "disabled", message: "CRON_SECRET is not set." }, { status: 503 });
  if (auth === "DENIED") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const subscriptionPayments = await reconcilePendingSubscriptionPayments({ limit: 50, minSecondsBetweenChecks: 120 });
  const invoicePayments = await reconcilePendingInvoicePayments({ limit: 50, minSecondsBetweenChecks: 120 });
  const reminders = await sendRenewalReminders();
  // Module 75: AFTER the reminders, so a reminder that fails in this very run is queued, not retried
  // until the next one. Each step is isolated so one failing cannot starve the next.
  const retries = await retryFailedNotifications();
  return NextResponse.json({ subscriptionPayments, invoicePayments, reminders, retries });
}

export const GET = run;
export const POST = run;
export const dynamic = "force-dynamic";
