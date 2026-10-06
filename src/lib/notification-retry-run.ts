import { prisma } from "./prisma";
import { Prisma } from "@prisma/client";
import { sendEmail, sendSms } from "./notifications";
import {
  processRetryBatch,
  checkManualRetry,
  RetryDeps,
  RetryRow,
  RetryRunResult,
} from "./notification-retry";
import { RENEWAL_REMINDER_FIRST_DAYS } from "./payment-gateway";
import { getEffectiveSubscriptionStatus } from "./subscription";

/**
 * Module 75 – the server side of the retry queue: wires the pure orchestrator in
 * notification-retry.ts to the database and to sendEmail()/sendSms().
 *
 * Every attempt is a NEW NotificationLog row (the log stays a record of what was tried). The row being
 * retried is "taken over" by a conditional update, `retriedAt` null -> now, BEFORE anything is sent, so
 * the cron job, a second cron run and a person clicking Retry can never all send the same message.
 */

type LogRow = Prisma.NotificationLogGetPayload<Record<string, never>>;

function toRetryRow(r: LogRow): RetryRow {
  return {
    id: r.id,
    businessId: r.businessId,
    userId: r.userId,
    channel: r.channel,
    templateKey: r.templateKey,
    recipientAddress: r.recipientAddress,
    subject: r.subject,
    body: r.body,
    attempt: r.attempt,
    // Rows from before Module 75 never get here (no nextRetryAt), but never trust a null.
    firstAttemptAt: r.firstAttemptAt ?? r.createdAt,
    nextRetryAt: r.nextRetryAt ?? r.createdAt,
    relatedEntityType: r.relatedEntityType,
    relatedEntityId: r.relatedEntityId,
  };
}

/** Send the row's message again as a new attempt. Never throws for a provider failure (sendX never does). */
async function resendRow(row: RetryRow): Promise<{ status: "SENT" | "FAILED" | "LOGGED" }> {
  const retry = { attempt: row.attempt + 1, retryOfId: row.id, firstAttemptAt: row.firstAttemptAt };
  if (row.channel === "EMAIL") {
    const r = await sendEmail({
      businessId: row.businessId,
      userId: row.userId,
      to: row.recipientAddress,
      subject: row.subject ?? "",
      body: row.body,
      templateKey: row.templateKey,
      relatedEntityType: row.relatedEntityType ?? undefined,
      relatedEntityId: row.relatedEntityId ?? undefined,
      retry,
    });
    return { status: r.status };
  }
  const r = await sendSms({
    businessId: row.businessId,
    userId: row.userId,
    to: row.recipientAddress,
    body: row.body,
    templateKey: row.templateKey,
    relatedEntityType: row.relatedEntityType ?? undefined,
    relatedEntityId: row.relatedEntityId ?? undefined,
    retry,
  });
  return { status: r.status };
}

/**
 * Is the thing this message was about still true? A "your plan ends tomorrow" text is wrong once the
 * plan was renewed; an invitation email is pointless once it was accepted. Anything not listed is
 * always relevant (a receipt is a receipt).
 */
async function isStillRelevant(row: RetryRow, now: Date): Promise<{ ok: true } | { ok: false; note: string }> {
  if (!row.relatedEntityId) return { ok: true };

  if (row.templateKey === "subscription_renewal_reminder" && row.relatedEntityType === "Subscription") {
    const sub = await prisma.subscription.findUnique({ where: { id: row.relatedEntityId } });
    if (!sub) return { ok: false, note: "the subscription no longer exists." };
    const horizon = now.getTime() + (RENEWAL_REMINDER_FIRST_DAYS + 1) * 86_400_000;
    const stillEnding =
      sub.requiresPayment &&
      !sub.cancelAtPeriodEnd &&
      getEffectiveSubscriptionStatus(sub) === "ACTIVE" &&
      sub.currentPeriodEnd !== null &&
      sub.currentPeriodEnd.getTime() > now.getTime() &&
      sub.currentPeriodEnd.getTime() <= horizon;
    return stillEnding ? { ok: true } : { ok: false, note: "the plan was renewed, cancelled or has already ended." };
  }

  if (row.templateKey === "team_invitation" && row.relatedEntityType === "BusinessInvitation") {
    const inv = await prisma.businessInvitation.findUnique({ where: { id: row.relatedEntityId } });
    if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt.getTime() <= now.getTime()) {
      return { ok: false, note: "the invitation was accepted, withdrawn or has expired." };
    }
    return { ok: true };
  }

  if (row.templateKey === "email_verification" && row.relatedEntityType === "User") {
    const user = await prisma.user.findUnique({ where: { id: row.relatedEntityId }, select: { emailVerifiedAt: true } });
    if (!user || user.emailVerifiedAt) return { ok: false, note: "the email address is already verified." };
    return { ok: true };
  }

  return { ok: true };
}

function prismaDeps(): RetryDeps {
  return {
    async findDue(now, limit) {
      const rows = await prisma.notificationLog.findMany({
        where: { status: "FAILED", retriedAt: null, nextRetryAt: { not: null, lte: now } },
        orderBy: { nextRetryAt: "asc" },
        take: limit,
      });
      return rows.map(toRetryRow);
    },
    async claim(row, now) {
      // Conditional on the row still being queued exactly as we read it. Two runs, or a run and a
      // person, race here and exactly one gets count === 1.
      const res = await prisma.notificationLog.updateMany({
        where: { id: row.id, status: "FAILED", retriedAt: null, nextRetryAt: row.nextRetryAt },
        data: { retriedAt: now, nextRetryAt: null },
      });
      return res.count === 1;
    },
    isStillRelevant,
    async annotate(row, note) {
      await prisma.notificationLog.update({ where: { id: row.id }, data: { retryNote: note } });
    },
    resend: resendRow,
  };
}

/**
 * Called by /api/cron/billing. Retries up to `limit` queued messages that are due. Idempotent and safe
 * to overlap with itself.
 */
export async function retryFailedNotifications(opts?: { now?: Date; limit?: number }): Promise<RetryRunResult> {
  return processRetryBatch(prismaDeps(), opts?.now ?? new Date(), opts?.limit ?? 100);
}

export type ManualRetryOutcome =
  | { ok: true; status: "SENT" | "FAILED" | "LOGGED"; logId: string | null }
  | { ok: false; code: "not_found" | "not_allowed" | "already_taken"; message: string };

/**
 * A person pressed Retry on a FAILED row (or, Module 76, a SENT text reported UNDELIVERED) on the Notifications page. Business-scoped (a row belonging to
 * another business is "not found"), refuses a failure that retrying cannot fix, and takes the row over
 * with the same conditional write the cron job uses, so a double click or a race with the cron job
 * sends once. Unlike the cron job there is no age or relevance check: a person who presses Retry has
 * looked at the message and decided.
 */
export async function retryNotificationByPerson(input: {
  businessId: string;
  logId: string;
  userId: string;
}): Promise<ManualRetryOutcome> {
  const row = await prisma.notificationLog.findFirst({ where: { id: input.logId, businessId: input.businessId } });
  if (!row) return { ok: false, code: "not_found", message: "That message was not found." };

  const check = checkManualRetry(row);
  if (!check.ok) return { ok: false, code: "not_allowed", message: check.message };

  // Module 76: the row is either FAILED or a SENT text the network reported as UNDELIVERED; the claim
  // is conditional on whichever it was when read, so a delivery report arriving mid-click cannot
  // turn a retry of a delivered text into a second send (a DELIVERED row no longer matches).
  const claim = await prisma.notificationLog.updateMany({
    where: {
      id: row.id,
      businessId: input.businessId,
      retriedAt: null,
      ...(row.status === "FAILED" ? { status: "FAILED" as const } : { status: "SENT" as const, deliveryState: "UNDELIVERED" as const }),
    },
    data: { retriedAt: new Date(), nextRetryAt: null },
  });
  if (claim.count !== 1) {
    return { ok: false, code: "already_taken", message: "This message was just retried. Reload to see the newer attempt." };
  }

  const result = await resendRow(toRetryRow(row));
  const newest = await prisma.notificationLog.findFirst({
    where: { retryOfId: row.id },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return { ok: true, status: result.status, logId: newest?.id ?? null };
}
