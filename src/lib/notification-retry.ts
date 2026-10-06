/**
 * Module 75 – automatic retry of a failed email/SMS. Pure and import-free, so the "use client"
 * Notifications page and the standalone verify script can load it (same split as sms-delivery.ts).
 *
 * WHY. Until now a FAILED send stayed failed. Most failures are not about the message at all: the
 * provider had a bad minute (HTTP 503, a dropped connection, a rate limit). For a message nobody is
 * watching (a renewal reminder sent by the cron job, a verification email, an invitation) that meant
 * silent loss. Module 74's reminder code even said so out loud: "a missed reminder beats a duplicate
 * one". A retry queue makes that trade unnecessary, provided it never produces the duplicate.
 *
 * THE RULES THAT KEEP IT SAFE
 *   1. Only a failure the provider said was NOT delivered is retried, and only if it looks like the
 *      provider's problem rather than the message's (TRANSIENT). A refused number, an opted-out
 *      recipient, a bad key, an unreadable reply: never retried automatically. An "accepted but
 *      unconfirmed" send is SENT, not FAILED, so it is never retried either (that is the duplicate).
 *   2. Only templates nobody is watching are retried automatically (RETRY_POLICIES). A reminder a
 *      person clicked "send" on already told them the result on screen; retrying behind their back
 *      could text the customer twice. Those get a Retry button instead (a person decides).
 *   3. A retry is claimed with a conditional write BEFORE it is sent, so overlapping cron runs, or a
 *      person clicking while the cron runs, cannot both send it.
 *   4. A message has a shelf life. A password-reset link dies in 30 minutes; "your plan ends
 *      tomorrow" is wrong once the plan was renewed. Each policy has a maximum age, and a row is
 *      re-checked for relevance at the moment of retrying.
 */

import { classifyDeliveryFailure, canRetryAfterUndelivered } from "./sms-delivery-report";

export type RetryChannel = "EMAIL" | "SMS";

// ---------------------------------------------------------------------------
// Which templates are retried automatically, and how
// ---------------------------------------------------------------------------

export type RetryPolicy = {
  /** Total tries including the first. */
  maxAttempts: number;
  /** Minutes to wait after failed attempt 1, 2, ... (index = attempt - 1). */
  delaysMinutes: number[];
  /** Stop once the FIRST attempt is older than this. */
  maxAgeMinutes: number;
};

export const RETRY_POLICIES: Readonly<Record<string, RetryPolicy>> = {
  // The reset link expires after 30 minutes (tokens.ts), so retrying later than that is pointless.
  password_reset: { maxAttempts: 3, delaysMinutes: [2, 10], maxAgeMinutes: 25 },
  // Verification link lasts 24 hours.
  email_verification: { maxAttempts: 4, delaysMinutes: [5, 30, 120], maxAgeMinutes: 12 * 60 },
  team_invitation: { maxAttempts: 4, delaysMinutes: [10, 60, 240], maxAgeMinutes: 24 * 60 },
  // Sent by the cron job with nobody watching; stale quickly (see isStillRelevant in the server file).
  subscription_renewal_reminder: { maxAttempts: 4, delaysMinutes: [15, 60, 240], maxAgeMinutes: 24 * 60 },
  subscription_receipt: { maxAttempts: 4, delaysMinutes: [10, 60, 240], maxAgeMinutes: 48 * 60 },
};

export function retryPolicyFor(templateKey: string): RetryPolicy | null {
  return RETRY_POLICIES[templateKey] ?? null;
}

// ---------------------------------------------------------------------------
// Reading a failure
// ---------------------------------------------------------------------------

/**
 *  TRANSIENT - the provider or the network had a problem; the same message may well work later.
 *  CONFIG    - the account is the problem (bad key, empty balance, unregistered sender). A person has
 *              to fix it; retrying before then only repeats the failure. A manual Retry is allowed.
 *  RECIPIENT - the address/number itself was refused. Retrying the same one can never work.
 *  UNKNOWN   - not recognised. Not retried automatically (it could even have been delivered).
 */
export type FailureKind = "TRANSIENT" | "CONFIG" | "RECIPIENT" | "UNKNOWN";

export type FailureReading = { kind: FailureKind; reason: string };

const NETWORK_PATTERN = /fetch failed|econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|network|timed? ?out|und_err|other side closed/i;

// Africa's Talking per-recipient status codes (see CODE_LABELS in sms-delivery.ts).
const AT_TRANSIENT = [500, 501, 502];
const AT_CONFIG = [402, 405];
const AT_RECIPIENT = [403, 404, 406, 407, 409];

export function classifyFailure(input: { providerName: string; errorMessage?: string | null }): FailureReading {
  // Module 72: a number the app itself refused before any provider was called.
  if (input.providerName === "phone-check") {
    return { kind: "RECIPIENT", reason: "the phone number was refused before sending" };
  }
  const msg = input.errorMessage ?? "";

  const http = /HTTP (\d{3})/.exec(msg);
  if (http) {
    const code = Number(http[1]);
    if (code === 408 || code === 425 || code === 429 || code >= 500) {
      return { kind: "TRANSIENT", reason: `the provider answered HTTP ${code}, which is usually temporary` };
    }
    if (code === 401 || code === 403) {
      return { kind: "CONFIG", reason: `the provider refused our credentials (HTTP ${code})` };
    }
    return { kind: "UNKNOWN", reason: `the provider refused the request (HTTP ${code})` };
  }

  const at = /\(code (\d{3})\)/.exec(msg);
  if (at) {
    const code = Number(at[1]);
    if (AT_TRANSIENT.includes(code)) return { kind: "TRANSIENT", reason: `the SMS gateway had a temporary error (code ${code})` };
    if (AT_CONFIG.includes(code)) return { kind: "CONFIG", reason: `the SMS account needs attention (code ${code})` };
    if (AT_RECIPIENT.includes(code)) return { kind: "RECIPIENT", reason: `the gateway will not deliver to this number (code ${code})` };
    return { kind: "UNKNOWN", reason: `the gateway answered code ${code}` };
  }

  if (NETWORK_PATTERN.test(msg)) {
    return { kind: "TRANSIENT", reason: "the provider could not be reached" };
  }
  return { kind: "UNKNOWN", reason: "the failure was not recognised" };
}

// ---------------------------------------------------------------------------
// Deciding what to do about a failed attempt (at the moment it is logged)
// ---------------------------------------------------------------------------

export type RetryPlan =
  | { schedule: true; at: Date }
  | { schedule: false; /** null = this template is never retried automatically (by design), nothing to say. */ note: string | null };

export function planRetry(input: {
  templateKey: string;
  providerName: string;
  errorMessage?: string | null;
  /** The attempt that just failed, 1-based. */
  attempt: number;
  firstAttemptAt: Date;
  now: Date;
}): RetryPlan {
  const policy = retryPolicyFor(input.templateKey);
  if (!policy) return { schedule: false, note: null };

  const reading = classifyFailure(input);
  if (reading.kind !== "TRANSIENT") {
    const tail =
      reading.kind === "CONFIG"
        ? " Fix the cause, then use Retry."
        : reading.kind === "RECIPIENT"
        ? " Retrying the same address would fail again."
        : "";
    return { schedule: false, note: `Not retried automatically: ${reading.reason}.${tail}` };
  }
  if (input.attempt >= policy.maxAttempts) {
    return { schedule: false, note: `Gave up after ${input.attempt} attempt${input.attempt === 1 ? "" : "s"}.` };
  }
  const delay = policy.delaysMinutes[input.attempt - 1];
  if (delay === undefined) {
    return { schedule: false, note: `Gave up after ${input.attempt} attempt${input.attempt === 1 ? "" : "s"}.` };
  }
  const at = new Date(input.now.getTime() + delay * 60_000);
  if (at.getTime() - input.firstAttemptAt.getTime() > policy.maxAgeMinutes * 60_000) {
    return { schedule: false, note: "Gave up: the message would be too old to be useful by the next try." };
  }
  return { schedule: true, at };
}

/** Same age rule, applied again when the retry actually runs (the cron may have been down). */
export function isTooOld(templateKey: string, firstAttemptAt: Date, now: Date): boolean {
  const policy = retryPolicyFor(templateKey);
  if (!policy) return false;
  return now.getTime() - firstAttemptAt.getTime() > policy.maxAgeMinutes * 60_000;
}

// ---------------------------------------------------------------------------
// May a PERSON retry this row from the Notifications page?
// ---------------------------------------------------------------------------

export type ManualRetryCheck = { ok: true } | { ok: false; message: string };

export function checkManualRetry(row: {
  status: string;
  businessId: string | null;
  providerName: string;
  errorMessage?: string | null;
  retriedAt: Date | null;
  /** Module 76: set when the gateway's delivery report said the text did not arrive. */
  deliveryState?: string | null;
  deliveryFailureReason?: string | null;
}): ManualRetryCheck {
  // Module 76: a SENT text the network reported as UNDELIVERED is, for a person, as retryable as a
  // FAILED one. The queue never retries it by itself (see the file header): a person decides.
  const undelivered = row.status === "SENT" && row.deliveryState === "UNDELIVERED";
  if (row.status !== "FAILED" && !undelivered) {
    return { ok: false, message: "Only a failed or undelivered message can be retried." };
  }
  if (!row.businessId) return { ok: false, message: "This message is not tied to a business and cannot be retried here." };
  if (row.retriedAt) return { ok: false, message: "This message has already been retried. Look at the newer attempt." };
  if (undelivered) {
    if (!canRetryAfterUndelivered(row.deliveryFailureReason)) {
      const why = classifyDeliveryFailure(row.deliveryFailureReason);
      return {
        ok: false,
        message: `Not retried: ${why.text}. Fix the number on the record and send it again from there.`,
      };
    }
    return { ok: true };
  }
  const reading = classifyFailure(row);
  if (reading.kind === "RECIPIENT") {
    return {
      ok: false,
      message: `Not retried: ${reading.reason}. Fix the number or address on the record and send it again from there.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// What the Notifications page shows for a row
// ---------------------------------------------------------------------------

export type RetryStateView =
  | { kind: "QUEUED"; at: Date }
  | { kind: "RETRIED"; text: string }
  | { kind: "NOTE"; text: string }
  | null;

export function describeRetryState(row: {
  status: string;
  nextRetryAt: Date | null;
  retriedAt: Date | null;
  retryNote: string | null;
  /** Module 76: an UNDELIVERED SENT row can have been retried by a person too. */
  deliveryState?: string | null;
}): RetryStateView {
  if (row.status !== "FAILED" && !(row.status === "SENT" && row.deliveryState === "UNDELIVERED")) return null;
  if (row.retriedAt) {
    return row.retryNote
      ? { kind: "NOTE", text: row.retryNote }
      : { kind: "RETRIED", text: "Retried. See the newer attempt." };
  }
  if (row.nextRetryAt) return { kind: "QUEUED", at: row.nextRetryAt };
  if (row.retryNote) return { kind: "NOTE", text: row.retryNote };
  return null;
}

// ---------------------------------------------------------------------------
// One run of the retry queue, with every outside effect injected
// ---------------------------------------------------------------------------

export type RetryRow = {
  id: string;
  businessId: string | null;
  userId: string | null;
  channel: RetryChannel;
  templateKey: string;
  recipientAddress: string;
  subject: string | null;
  body: string;
  attempt: number;
  firstAttemptAt: Date;
  nextRetryAt: Date;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
};

export type RetryDeps = {
  /** FAILED rows with nextRetryAt <= now and retriedAt null, oldest first. */
  findDue(now: Date, limit: number): Promise<RetryRow[]>;
  /** Conditional write: true only for the one caller that moved the row from "queued" to "taken". */
  claim(row: RetryRow, now: Date): Promise<boolean>;
  /** Is the thing the message was about still true? */
  isStillRelevant(row: RetryRow, now: Date): Promise<{ ok: true } | { ok: false; note: string }>;
  /** Record on the (already claimed) row why no retry was sent. */
  annotate(row: RetryRow, note: string): Promise<void>;
  /** Send it again as a NEW log row (attempt + 1). Returns that row's status. */
  resend(row: RetryRow): Promise<{ status: "SENT" | "FAILED" | "LOGGED" }>;
};

export type RetryRunResult = {
  considered: number;
  /** Rows another run or a person took first. */
  skipped: number;
  sent: number;
  /** Provider not configured any more, so the new row is a console log. */
  logged: number;
  failedAgain: number;
  dropped: number;
  errors: number;
};

export async function processRetryBatch(deps: RetryDeps, now: Date, limit: number): Promise<RetryRunResult> {
  const out: RetryRunResult = { considered: 0, skipped: 0, sent: 0, logged: 0, failedAgain: 0, dropped: 0, errors: 0 };
  const rows = await deps.findDue(now, limit);
  out.considered = rows.length;

  for (const row of rows) {
    let claimed = false;
    try {
      claimed = await deps.claim(row, now);
      if (!claimed) {
        out.skipped++;
        continue;
      }
      if (isTooOld(row.templateKey, row.firstAttemptAt, now)) {
        await deps.annotate(row, "Dropped: the message was too old to be useful by the time the retry ran.");
        out.dropped++;
        continue;
      }
      const relevance = await deps.isStillRelevant(row, now);
      if (!relevance.ok) {
        await deps.annotate(row, `Dropped: ${relevance.note}`);
        out.dropped++;
        continue;
      }
      const result = await deps.resend(row);
      if (result.status === "SENT") out.sent++;
      else if (result.status === "LOGGED") out.logged++;
      else out.failedAgain++;
    } catch (err) {
      // One bad row must not stop the rest. A claimed row stays claimed on purpose: if the send itself
      // may have happened, a second attempt next run would be the duplicate this queue exists to avoid.
      out.errors++;
      if (claimed) {
        const msg = err instanceof Error ? err.message : String(err);
        await deps.annotate(row, `Retry stopped by an error (${msg.slice(0, 160)}). Use Retry to send it again.`).catch(() => undefined);
      }
    }
  }
  return out;
}
