import { prisma } from "./prisma";
import { NotificationChannel, NotificationStatus, NotificationDeliveryState } from "@prisma/client";
import { parseAfricasTalkingResponse } from "./sms-delivery";
import { checkSmsDeliverable, PHONE_CHECK_PROVIDER } from "./phone";
import { planRetry } from "./notification-retry";

/**
 * Module 24 – spec section 24. This is the single place every outbound
 * email/SMS in this app goes through. Four call sites (registration's
 * verification email, forgot-password's reset email, team invitations, and
 * customer debt reminders) used to `console.log` instead of sending –
 * see the git history / README Modules 1, 5, 14 write-ups. They now call
 * `sendEmail()` / `sendSms()` here instead of hand-rolling a fetch call
 * each, for the same reason every journal posting goes through
 * `postJournalEntry()` rather than writing `JournalLine` rows inline: one
 * place to get delivery, logging, and failure handling right.
 *
 * Provider selection is env-driven and degrades gracefully, the same
 * pattern `ANTHROPIC_API_KEY` already established for the AI assistant:
 * no key configured -> falls back to logging to the console (and to
 * NotificationLog) exactly like this app already did from Module 1, so a
 * fresh clone with no credentials filled in still works end-to-end for
 * local testing. A key configured -> a real provider is called, and
 * failures are recorded rather than thrown, so a flaky email provider can
 * never break registration, an invite, or a reminder.
 *
 * Providers, chosen for being reachable over plain HTTP with no SDK and no
 * dependency beyond `fetch` (already global in Next.js 14's runtime):
 *   - Email: Resend (`EMAIL_PROVIDER_API_KEY`, `EMAIL_FROM` – both already
 *     existed as placeholders in .env.example since Module 1).
 *   - SMS: Africa's Talking (`SMS_PROVIDER_API_KEY`, `SMS_PROVIDER_USERNAME`
 *     – the standard SMS gateway for Malawi; adds one new env var to the
 *     one `SMS_PROVIDER_API_KEY` placeholder that already existed).
 * Swapping either for a different provider later means changing the two
 * `deliver*` functions below – every call site and the NotificationLog
 * shape stay the same.
 */

export const TEMPLATE_KEYS = {
  EMAIL_VERIFICATION: "email_verification",
  PASSWORD_RESET: "password_reset",
  TEAM_INVITATION: "team_invitation",
  CUSTOMER_DEBT_REMINDER: "customer_debt_reminder",
  SUPPLIER_PAYMENT_NOTICE: "supplier_payment_notice",
  EMPLOYEE_PAY_NOTICE: "employee_pay_notice",
  // Module 74 senders (the cron job and the gateway code). Named here since Module 75 keys a retry
  // policy off them; the two call sites still pass the same strings.
  SUBSCRIPTION_RENEWAL_REMINDER: "subscription_renewal_reminder",
  SUBSCRIPTION_RECEIPT: "subscription_receipt",
} as const;

type DeliveryResult = {
  status: NotificationStatus;
  providerName: string;
  // Set for every FAILED. Since Module 71 it can also ride on a SENT: that
  // means the provider accepted the request but its reply could not be read,
  // so delivery is unconfirmed (never set on a confirmed success).
  errorMessage?: string;
  // Module 76: the gateway's id for the recipient (what a later delivery report names) and the cost it
  // printed. Set only on a confirmed, single-recipient SMS accept; never on email.
  providerMessageId?: string;
  providerCost?: string;
};

async function deliverEmail(to: string, subject: string, body: string): Promise<DeliveryResult> {
  const apiKey = process.env.EMAIL_PROVIDER_API_KEY;
  const from = process.env.EMAIL_FROM || "no-reply@malawibusinessmanager.com";

  if (!apiKey) {
    console.log(`[email:console] To: ${to} – Subject: ${subject}\n${body}`);
    return { status: "LOGGED", providerName: "console" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, html: body }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        status: "FAILED",
        providerName: "resend",
        errorMessage: `Resend returned HTTP ${res.status}: ${text.slice(0, 300)}`,
      };
    }

    return { status: "SENT", providerName: "resend" };
  } catch (err) {
    return {
      status: "FAILED",
      providerName: "resend",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

async function deliverSms(to: string, message: string): Promise<DeliveryResult> {
  const apiKey = process.env.SMS_PROVIDER_API_KEY;
  const username = process.env.SMS_PROVIDER_USERNAME;

  if (!apiKey || !username) {
    console.log(`[sms:console] To: ${to} – ${message}`);
    return { status: "LOGGED", providerName: "console" };
  }

  try {
    const res = await fetch("https://api.africastalking.com/version1/messaging", {
      method: "POST",
      headers: {
        apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ username, to, message }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        status: "FAILED",
        providerName: "africastalking",
        errorMessage: `Africa's Talking returned HTTP ${res.status}: ${text.slice(0, 300)}`,
      };
    }

    // Africa's Talking answers 200/201 when it accepted the REQUEST and puts
    // each recipient's outcome in the body (an invalid number, a low balance
    // or an opted-out recipient all still come back as HTTP 200). Module 71:
    // read that body instead of assuming success - see src/lib/sms-delivery.ts.
    const verdict = parseAfricasTalkingResponse(await res.text().catch(() => ""));
    // Module 76: keep the message id (and cost) of a confirmed single-recipient accept. sendSms() only
    // ever dials one number, so more than one recipient, or an unconfirmed reply, stores nothing: a
    // delivery report could not be matched to a row safely.
    const only = verdict.status === "SENT" && verdict.confirmed && verdict.recipients.length === 1 ? verdict.recipients[0] : null;
    return {
      status: verdict.status,
      providerName: "africastalking",
      errorMessage: verdict.errorMessage,
      providerMessageId: only?.messageId ?? undefined,
      providerCost: only?.cost ?? undefined,
    };
  } catch (err) {
    return {
      status: "FAILED",
      providerName: "africastalking",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

type SendParams = {
  businessId?: string | null;
  userId?: string | null;
  to: string;
  body: string;
  templateKey: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  /**
   * Module 75: set ONLY by the retry code (notification-retry-run.ts) when this send is a later try of
   * a FAILED row. Every other caller leaves it out and gets attempt 1.
   */
  retry?: { attempt: number; retryOfId: string; firstAttemptAt: Date };
};

/**
 * Module 75: the retry bookkeeping columns for one attempt. A FAILED attempt of a template that has a
 * retry policy and failed in a way that may pass (the provider's bad minute) is queued with
 * `nextRetryAt`; any other FAILED gets a `retryNote` saying why it will not be retried; SENT/LOGGED
 * rows carry only the attempt chain. Pure given `now`, so it is easy to reason about.
 */
function retryColumns(
  params: SendParams,
  result: DeliveryResult,
  now: Date
): {
  attempt: number;
  firstAttemptAt: Date;
  retryOfId: string | null;
  nextRetryAt: Date | null;
  retryNote: string | null;
} {
  const attempt = params.retry?.attempt ?? 1;
  const firstAttemptAt = params.retry?.firstAttemptAt ?? now;
  let nextRetryAt: Date | null = null;
  let retryNote: string | null = null;
  if (result.status === "FAILED") {
    const plan = planRetry({
      templateKey: params.templateKey,
      providerName: result.providerName,
      errorMessage: result.errorMessage,
      attempt,
      firstAttemptAt,
      now,
    });
    if (plan.schedule) nextRetryAt = plan.at;
    else retryNote = plan.note;
  }
  return { attempt, firstAttemptAt, retryOfId: params.retry?.retryOfId ?? null, nextRetryAt, retryNote };
}

/**
 * Sends an email and records the attempt (sent, failed, or console-logged)
 * in NotificationLog. Never throws – a provider outage should never break
 * the registration/invite/reset flow that triggered it; check the returned
 * `status` if the caller needs to react to a failure.
 */
export async function sendEmail(params: SendParams & { subject: string }) {
  const result = await deliverEmail(params.to, params.subject, params.body);

  const log = await prisma.notificationLog.create({
    data: {
      businessId: params.businessId ?? undefined,
      userId: params.userId ?? undefined,
      channel: NotificationChannel.EMAIL,
      templateKey: params.templateKey,
      recipientAddress: params.to,
      subject: params.subject,
      body: params.body,
      status: result.status,
      providerName: result.providerName,
      errorMessage: result.errorMessage,
      relatedEntityType: params.relatedEntityType,
      relatedEntityId: params.relatedEntityId,
      ...retryColumns(params, result, new Date()),
    },
  });

  return { ...result, logId: log.id };
}

/**
 * Sends an SMS and records the attempt the same way `sendEmail()` does.
 * Never throws, for the same reason.
 */
export async function sendSms(params: SendParams) {
  // Module 72: read the number the way a person typed it ("0999 123 456") and
  // dial the international form the gateway needs. A number that can't be read
  // as exactly one phone number is refused HERE, before any provider is
  // called, and logged as FAILED with the reason; guessing could text the
  // wrong phone. A readable landline is refused the same way: a fixed line cannot
  // receive a text, so there is nothing for a gateway to deliver.
  const phone = checkSmsDeliverable(params.to);
  const result: DeliveryResult = phone.ok
    ? await deliverSms(phone.e164, params.body)
    : { status: "FAILED", providerName: PHONE_CHECK_PROVIDER, errorMessage: phone.reason };
  // recipientAddress documents the number "actually dialed".
  const dialed = phone.ok ? phone.e164 : params.to;

  const log = await prisma.notificationLog.create({
    data: {
      businessId: params.businessId ?? undefined,
      userId: params.userId ?? undefined,
      channel: NotificationChannel.SMS,
      templateKey: params.templateKey,
      recipientAddress: dialed,
      body: params.body,
      status: result.status,
      providerName: result.providerName,
      errorMessage: result.errorMessage,
      relatedEntityType: params.relatedEntityType,
      relatedEntityId: params.relatedEntityId,
      providerMessageId: result.providerMessageId,
      providerCost: result.providerCost,
      ...retryColumns(params, result, new Date()),
    },
  });

  return { ...result, dialedTo: dialed, logId: log.id };
}

/**
 * Which provider is actually wired up right now, for the /notifications
 * page's status banner – an Owner shouldn't have to guess from a stream of
 * "LOGGED" rows whether SMS is configured or just quiet.
 */
export function getNotificationProviderStatus() {
  return {
    email: process.env.EMAIL_PROVIDER_API_KEY ? ("resend" as const) : ("console" as const),
    sms:
      process.env.SMS_PROVIDER_API_KEY && process.env.SMS_PROVIDER_USERNAME
        ? ("africastalking" as const)
        : ("console" as const),
    // Module 76: is the delivery-report endpoint switched on? (It answers 503 until the secret is set.)
    smsDeliveryReports: (process.env.AT_DELIVERY_REPORT_SECRET ?? "").trim() !== "",
  };
}

/**
 * Business-scoped delivery history for the /notifications page – most
 * recent first, capped at 200 rows (this is an operational log to skim,
 * not a report to paginate deeply through; narrow with `channel`/`status`
 * if the list needs to go further back than that).
 */
export async function listNotificationLogs(
  businessId: string,
  filters?: {
    channel?: NotificationChannel;
    status?: NotificationStatus;
    // Module 76: e.g. UNDELIVERED, to list the texts the network reported as not arrived.
    deliveryState?: NotificationDeliveryState;
  }
) {
  return prisma.notificationLog.findMany({
    where: {
      businessId,
      channel: filters?.channel,
      status: filters?.status,
      deliveryState: filters?.deliveryState,
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}
