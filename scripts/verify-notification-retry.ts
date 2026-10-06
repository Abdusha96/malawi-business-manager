/**
 * Module 75: standalone checks for the notification retry queue. No database, no network:
 *   npx tsx scripts/verify-notification-retry.ts   (npm run verify:notification-retry)
 * Covers src/lib/notification-retry.ts (pure, import-free), including the batch orchestrator against an
 * in-memory queue that has the same conditional-claim behaviour as the Prisma implementation.
 */
import {
  classifyFailure,
  planRetry,
  isTooOld,
  checkManualRetry,
  describeRetryState,
  processRetryBatch,
  retryPolicyFor,
  RETRY_POLICIES,
  RetryRow,
  RetryDeps,
} from "../src/lib/notification-retry";

export {};

let failed = 0,
  total = 0;
function check(name: string, actual: unknown, expected: unknown) {
  total++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}
function has(name: string, hay: string | null | undefined, needle: string) {
  total++;
  if (!hay || !hay.includes(needle)) {
    failed++;
    console.error(`FAIL ${name}\n  expected to contain ${JSON.stringify(needle)}\n  actual ${JSON.stringify(hay)}`);
  }
}

const T0 = new Date("2026-10-01T08:00:00Z");
const mins = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

// ---- classifyFailure ------------------------------------------------------
const kind = (providerName: string, errorMessage?: string) => classifyFailure({ providerName, errorMessage }).kind;
check("resend 503 transient", kind("resend", "Resend returned HTTP 503: unavailable"), "TRANSIENT");
check("resend 500 transient", kind("resend", "Resend returned HTTP 500: x"), "TRANSIENT");
check("resend 429 transient", kind("resend", "Resend returned HTTP 429: slow down"), "TRANSIENT");
check("resend 408 transient", kind("resend", "Resend returned HTTP 408: x"), "TRANSIENT");
check("resend 401 config", kind("resend", "Resend returned HTTP 401: bad key"), "CONFIG");
check("resend 403 config", kind("resend", "Resend returned HTTP 403: x"), "CONFIG");
check("resend 422 unknown (bad address etc.)", kind("resend", "Resend returned HTTP 422: invalid to"), "UNKNOWN");
check("resend 400 unknown", kind("resend", "Resend returned HTTP 400: x"), "UNKNOWN");
check("AT HTTP 503 transient", kind("africastalking", "Africa's Talking returned HTTP 503: x"), "TRANSIENT");
check("fetch failed transient", kind("resend", "fetch failed"), "TRANSIENT");
check("ECONNRESET transient", kind("africastalking", "read ECONNRESET"), "TRANSIENT");
check("ETIMEDOUT transient", kind("resend", "connect ETIMEDOUT 1.2.3.4:443"), "TRANSIENT");
check("socket hang up transient", kind("resend", "socket hang up"), "TRANSIENT");
check("timeout transient", kind("resend", "The operation timed out"), "TRANSIENT");
check("AT 500 transient", kind("africastalking", "+265999123456: InternalServerError (code 500) - try again later"), "TRANSIENT");
check("AT 501 transient", kind("africastalking", "x: GatewayError (code 501) - y"), "TRANSIENT");
check("AT 502 transient", kind("africastalking", "x: RejectedByGateway (code 502) - y"), "TRANSIENT");
check("AT 405 config", kind("africastalking", "x: InsufficientBalance (code 405) - top it up"), "CONFIG");
check("AT 402 config", kind("africastalking", "x: InvalidSenderId (code 402) - y"), "CONFIG");
check("AT 403 recipient", kind("africastalking", "x: InvalidPhoneNumber (code 403) - y"), "RECIPIENT");
check("AT 404 recipient", kind("africastalking", "x: UnsupportedNumberType (code 404) - y"), "RECIPIENT");
check("AT 406 recipient", kind("africastalking", "x: UserInBlacklist (code 406) - y"), "RECIPIENT");
check("AT 407 recipient", kind("africastalking", "x: CouldNotRoute (code 407) - y"), "RECIPIENT");
check("AT 409 recipient", kind("africastalking", "x: DoNotDisturbRejection (code 409) - y"), "RECIPIENT");
check("AT 401 risk hold unknown", kind("africastalking", "x: RiskHold (code 401) - y"), "UNKNOWN");
check("AT unknown code unknown", kind("africastalking", "x: Weird (code 777)"), "UNKNOWN");
check("phone-check recipient", kind("phone-check", "That number has too many digits."), "RECIPIENT");
check("no message unknown", kind("resend", undefined), "UNKNOWN");
check("empty message unknown", kind("resend", ""), "UNKNOWN");
check("null message unknown", classifyFailure({ providerName: "resend", errorMessage: null }).kind, "UNKNOWN");
// HTTP code in the body of the message must not be mistaken: first match wins and is the status.
check("HTTP wins over words in body", kind("resend", "Resend returned HTTP 422: upstream network error"), "UNKNOWN");
// unreadable-reply wording is only ever attached to SENT rows, but if it ever reached us it must not retry.
check("unconfirmed wording unknown", kind("africastalking", "Africa's Talking accepted the request but its reply could not be read (not JSON), so delivery is unconfirmed."), "UNKNOWN");

// ---- retry policies -------------------------------------------------------
check("watched templates have no policy", [
  retryPolicyFor("customer_debt_reminder"),
  retryPolicyFor("supplier_payment_notice"),
  retryPolicyFor("employee_pay_notice"),
  retryPolicyFor("nonsense"),
], [null, null, null, null]);
for (const [k, p] of Object.entries(RETRY_POLICIES)) {
  check(`policy ${k}: delays cover every retry`, p.delaysMinutes.length, p.maxAttempts - 1);
  check(`policy ${k}: delays positive and increasing`, p.delaysMinutes.every((d, i) => d > 0 && (i === 0 || d > p.delaysMinutes[i - 1])), true);
}
// A reset link lives 30 minutes: every retry (and the age cap) must fit inside it.
const pr = RETRY_POLICIES.password_reset;
check("password reset cap under token life", pr.maxAgeMinutes < 30, true);

// ---- planRetry ------------------------------------------------------------
const transient = { providerName: "resend", errorMessage: "Resend returned HTTP 503: x" };
let plan = planRetry({ templateKey: "team_invitation", ...transient, attempt: 1, firstAttemptAt: T0, now: T0 });
check("invitation attempt 1 schedules +10m", plan, { schedule: true, at: mins(T0, 10) });
plan = planRetry({ templateKey: "team_invitation", ...transient, attempt: 2, firstAttemptAt: T0, now: mins(T0, 10) });
check("invitation attempt 2 schedules +60m", plan, { schedule: true, at: mins(T0, 70) });
plan = planRetry({ templateKey: "team_invitation", ...transient, attempt: 3, firstAttemptAt: T0, now: mins(T0, 70) });
check("invitation attempt 3 schedules +240m", plan, { schedule: true, at: mins(T0, 310) });
plan = planRetry({ templateKey: "team_invitation", ...transient, attempt: 4, firstAttemptAt: T0, now: mins(T0, 310) });
check("invitation attempt 4 gives up", plan.schedule, false);
has("gave-up note", (plan as { note: string | null }).note, "Gave up after 4 attempts");
plan = planRetry({ templateKey: "customer_debt_reminder", ...transient, attempt: 1, firstAttemptAt: T0, now: T0 });
check("watched template: no schedule, no note", plan, { schedule: false, note: null });
plan = planRetry({ templateKey: "team_invitation", providerName: "africastalking", errorMessage: "x: InvalidPhoneNumber (code 403) - y", attempt: 1, firstAttemptAt: T0, now: T0 });
has("recipient failure note", (plan as { note: string }).note, "Retrying the same address would fail again");
plan = planRetry({ templateKey: "team_invitation", providerName: "resend", errorMessage: "Resend returned HTTP 401: x", attempt: 1, firstAttemptAt: T0, now: T0 });
has("config failure note says fix then Retry", (plan as { note: string }).note, "Fix the cause, then use Retry");
plan = planRetry({ templateKey: "team_invitation", providerName: "resend", errorMessage: "weird", attempt: 1, firstAttemptAt: T0, now: T0 });
check("unknown failure not scheduled", plan.schedule, false);
// age: reset capped at 25 min, retry at +2m ok, then +10m after a first attempt 20 min ago is too late
plan = planRetry({ templateKey: "password_reset", ...transient, attempt: 1, firstAttemptAt: T0, now: T0 });
check("reset first retry +2m", plan, { schedule: true, at: mins(T0, 2) });
plan = planRetry({ templateKey: "password_reset", ...transient, attempt: 2, firstAttemptAt: T0, now: mins(T0, 20) });
check("reset second retry would land after the age cap", plan.schedule, false);
has("too-old note", (plan as { note: string }).note, "too old");
plan = planRetry({ templateKey: "password_reset", ...transient, attempt: 2, firstAttemptAt: T0, now: mins(T0, 2) });
check("reset second retry inside the cap", plan, { schedule: true, at: mins(T0, 12) });
check("isTooOld false inside", isTooOld("password_reset", T0, mins(T0, 25)), false);
check("isTooOld true outside", isTooOld("password_reset", T0, mins(T0, 26)), true);
check("isTooOld false for no policy", isTooOld("customer_debt_reminder", T0, mins(T0, 99999)), false);

// ---- checkManualRetry -----------------------------------------------------
const base = { status: "FAILED", businessId: "b1", providerName: "resend", errorMessage: "Resend returned HTTP 503: x", retriedAt: null };
check("manual ok", checkManualRetry(base), { ok: true });
check("manual config ok", checkManualRetry({ ...base, errorMessage: "Resend returned HTTP 401: x" }), { ok: true });
check("manual unknown ok (a person decides)", checkManualRetry({ ...base, errorMessage: "weird" }), { ok: true });
check("manual SENT refused", checkManualRetry({ ...base, status: "SENT" }).ok, false);
check("manual LOGGED refused", checkManualRetry({ ...base, status: "LOGGED" }).ok, false);
check("manual no business refused", checkManualRetry({ ...base, businessId: null }).ok, false);
check("manual already retried refused", checkManualRetry({ ...base, retriedAt: T0 }).ok, false);
has("manual recipient refused names fix", (checkManualRetry({ ...base, providerName: "phone-check", errorMessage: "bad" }) as { message: string }).message, "Fix the number or address");
check("manual AT 403 refused", checkManualRetry({ ...base, providerName: "africastalking", errorMessage: "x (code 403)" }).ok, false);

// ---- describeRetryState ---------------------------------------------------
check("state: SENT none", describeRetryState({ status: "SENT", nextRetryAt: null, retriedAt: null, retryNote: null }), null);
check("state: plain failed none", describeRetryState({ status: "FAILED", nextRetryAt: null, retriedAt: null, retryNote: null }), null);
check("state: queued", describeRetryState({ status: "FAILED", nextRetryAt: T0, retriedAt: null, retryNote: null }), { kind: "QUEUED", at: T0 });
check("state: retried", describeRetryState({ status: "FAILED", nextRetryAt: null, retriedAt: T0, retryNote: null }), { kind: "RETRIED", text: "Retried. See the newer attempt." });
check("state: dropped note", describeRetryState({ status: "FAILED", nextRetryAt: null, retriedAt: T0, retryNote: "Dropped: x" }), { kind: "NOTE", text: "Dropped: x" });
check("state: gave-up note", describeRetryState({ status: "FAILED", nextRetryAt: null, retriedAt: null, retryNote: "Gave up" }), { kind: "NOTE", text: "Gave up" });

// ---- processRetryBatch against an in-memory queue --------------------------
type Mem = RetryRow & { retriedAt: Date | null; note: string | null; status: "FAILED" };
function makeRow(id: string, over: Partial<RetryRow> = {}): RetryRow {
  return {
    id, businessId: "b1", userId: null, channel: "EMAIL", templateKey: "team_invitation",
    recipientAddress: "a@b.mw", subject: "S", body: "B", attempt: 1,
    firstAttemptAt: T0, nextRetryAt: mins(T0, 10), relatedEntityType: "BusinessInvitation", relatedEntityId: "inv1", ...over,
  };
}
function world(rows: RetryRow[], opts: { relevant?: (r: RetryRow) => { ok: true } | { ok: false; note: string }; resend?: (r: RetryRow) => "SENT" | "FAILED" | "LOGGED" | Error } = {}) {
  const mem = new Map<string, Mem>(rows.map((r) => [r.id, { ...r, retriedAt: null, note: null, status: "FAILED" as const }]));
  const sent: string[] = [];
  const claimLog: string[] = [];
  const deps: RetryDeps = {
    async findDue(now, limit) {
      return [...mem.values()].filter((m) => !m.retriedAt && m.nextRetryAt && m.nextRetryAt <= now).sort((a, b) => +a.nextRetryAt - +b.nextRetryAt).slice(0, limit).map(({ retriedAt, note, status, ...r }) => r);
    },
    async claim(row) {
      const m = mem.get(row.id)!;
      claimLog.push(row.id);
      // same condition as the Prisma updateMany: still queued, same nextRetryAt
      if (m.retriedAt || +m.nextRetryAt !== +row.nextRetryAt) return false;
      m.retriedAt = new Date();
      return true;
    },
    async isStillRelevant(row) { return opts.relevant ? opts.relevant(row) : { ok: true }; },
    async annotate(row, note) { mem.get(row.id)!.note = note; },
    async resend(row) {
      const r = opts.resend ? opts.resend(row) : "SENT";
      if (r instanceof Error) throw r;
      sent.push(row.id);
      return { status: r };
    },
  };
  return { mem, sent, claimLog, deps };
}

async function main() {
let w = world([makeRow("r1"), makeRow("r2", { nextRetryAt: mins(T0, 30) })]);
let res = await processRetryBatch(w.deps, mins(T0, 15), 100);
check("batch: only the due row is picked", [res.considered, res.sent], [1, 1]);
check("batch: sent r1 only", w.sent, ["r1"]);
check("batch: r1 taken over", w.mem.get("r1")!.retriedAt !== null, true);
check("batch: r2 untouched", w.mem.get("r2")!.retriedAt, null);

// running again right away sends nothing (idempotent)
res = await processRetryBatch(w.deps, mins(T0, 15), 100);
check("batch: second run finds nothing new", [res.considered, res.sent], [0, 0]);

// two overlapping runs: both read the row before either claims
w = world([makeRow("r1")]);
const rowsSeen = await w.deps.findDue(mins(T0, 15), 100);
const stale: RetryDeps = { ...w.deps, findDue: async () => rowsSeen };
const [a, b] = await Promise.all([processRetryBatch(stale, mins(T0, 15), 100), processRetryBatch(stale, mins(T0, 15), 100)]);
check("overlap: exactly one send", w.sent, ["r1"]);
check("overlap: one sent, one skipped", [a.sent + b.sent, a.skipped + b.skipped], [1, 1]);

// a person takes the row first
w = world([makeRow("r1")]);
const seen2 = await w.deps.findDue(mins(T0, 15), 100);
w.mem.get("r1")!.retriedAt = new Date(); // person clicked Retry
res = await processRetryBatch({ ...w.deps, findDue: async () => seen2 }, mins(T0, 15), 100);
check("person first: cron skips, sends nothing", [res.skipped, res.sent, w.sent.length], [1, 0, 0]);

// too old when it finally runs (cron was down): dropped, not sent
w = world([makeRow("r1", { templateKey: "password_reset", firstAttemptAt: T0, nextRetryAt: mins(T0, 2) })]);
res = await processRetryBatch(w.deps, mins(T0, 120), 100);
check("too old: dropped not sent", [res.dropped, res.sent], [1, 0]);
has("too old: note recorded", w.mem.get("r1")!.note, "too old");

// no longer relevant
w = world([makeRow("r1")], { relevant: () => ({ ok: false, note: "the invitation was accepted, withdrawn or has expired." }) });
res = await processRetryBatch(w.deps, mins(T0, 15), 100);
check("irrelevant: dropped not sent", [res.dropped, res.sent, w.sent.length], [1, 0, 0]);
has("irrelevant: note recorded", w.mem.get("r1")!.note, "Dropped: the invitation was accepted");

// outcomes
w = world([makeRow("r1")], { resend: () => "FAILED" });
res = await processRetryBatch(w.deps, mins(T0, 15), 100);
check("failed again counted", [res.failedAgain, res.sent], [1, 0]);
w = world([makeRow("r1")], { resend: () => "LOGGED" });
res = await processRetryBatch(w.deps, mins(T0, 15), 100);
check("logged counted", [res.logged, res.sent], [1, 0]);

// one throwing row must not stop the others, and stays claimed (never auto re-sent)
w = world([makeRow("bad", { nextRetryAt: mins(T0, 5) }), makeRow("good", { nextRetryAt: mins(T0, 6) })], {
  resend: (r) => (r.id === "bad" ? new Error("db went away") : "SENT"),
});
res = await processRetryBatch(w.deps, mins(T0, 15), 100);
check("error isolated", [res.errors, res.sent], [1, 1]);
check("errored row stays claimed", w.mem.get("bad")!.retriedAt !== null, true);
has("errored row annotated", w.mem.get("bad")!.note, "Retry stopped by an error");
res = await processRetryBatch(w.deps, mins(T0, 30), 100);
check("errored row not auto-resent next run", [res.considered, w.sent], [0, ["good"]]);

// a throwing claim is counted as an error and does not annotate (nothing was claimed)
w = world([makeRow("r1")]);
res = await processRetryBatch({ ...w.deps, claim: async () => { throw new Error("boom"); } }, mins(T0, 15), 100);
check("claim throws: error counted, nothing sent", [res.errors, w.sent.length, w.mem.get("r1")!.note], [1, 0, null]);

// limit and ordering (oldest due first)
w = world([makeRow("c", { nextRetryAt: mins(T0, 3) }), makeRow("a", { nextRetryAt: mins(T0, 1) }), makeRow("b", { nextRetryAt: mins(T0, 2) })]);
res = await processRetryBatch(w.deps, mins(T0, 15), 2);
check("limit honoured, oldest first", w.sent, ["a", "b"]);

// SMS rows go through the same path
w = world([makeRow("s1", { channel: "SMS", templateKey: "subscription_renewal_reminder", relatedEntityType: "Subscription" })]);
res = await processRetryBatch(w.deps, mins(T0, 20), 100);
check("sms row retried", res.sent, 1);


console.log(failed === 0 ? `OK - ${total} checks passed` : `${failed} of ${total} checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
}
main();
