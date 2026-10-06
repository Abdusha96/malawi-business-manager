/**
 * Module 76 – reading Africa's Talking DELIVERY REPORTS.
 *
 * Module 71 stopped calling a rejected text "sent". What it could not fix is the gap after that:
 * `SENT` means the gateway accepted the request and queued it. Whether the text reached the handset is
 * reported later, by a separate HTTP callback the gateway makes to a URL we give it (a "delivery
 * report"). A text to a phone that is switched off, a number on a do-not-disturb list or a network that
 * dropped it all look like a green SENT until that report is read. This file is the pure half of reading it.
 *
 * PURE and import-free on purpose (same split as sms-delivery.ts and notification-retry.ts): the webhook
 * route, the Notifications page ("use client" children included) and the plain-Node verify script all load it.
 *
 * Shape of the callback, from Africa's Talking's published documentation (form-encoded POST):
 *   id=ATXid_...&status=Success|Sent|Submitted|Buffered|Rejected|Failed
 *   &phoneNumber=%2B265...&networkCode=...&failureReason=...&retryCount=0
 * It is NOT signed. The callback is therefore protected by a secret in the URL (see the route), and a
 * report can only ever change the one log row whose stored message id it names, and only if the number on
 * the report matches the number we dialled.
 *
 * The rules that keep it honest:
 *   - Fail closed on the unknown: an unrecognised status word changes nothing (it is never read as success).
 *   - A report can only move a row FORWARD: nothing -> in progress -> delivered|undelivered. Reports arrive
 *     out of order and more than once; a late "Sent" never undoes "Success".
 *   - The first final answer wins. A later, contradicting final answer is refused and counted as a conflict
 *     rather than silently overwriting what the person may already have acted on.
 */

export type DeliveryState = "IN_PROGRESS" | "DELIVERED" | "UNDELIVERED";

export type DeliveryReport = {
  messageId: string;
  state: DeliveryState;
  /** The status word exactly as the gateway wrote it. */
  statusText: string;
  /** Only kept when the state is UNDELIVERED; null when the gateway gave none. */
  failureReason: string | null;
  phoneNumber: string | null;
  networkCode: string | null;
  retryCount: number | null;
};

export type ParseReportResult = { ok: true; report: DeliveryReport } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Reading one callback
// ---------------------------------------------------------------------------

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Status words documented by Africa's Talking, as they map to our three states. */
const STATUS_TO_STATE: Record<string, DeliveryState> = {
  success: "DELIVERED",
  sent: "IN_PROGRESS",
  submitted: "IN_PROGRESS",
  buffered: "IN_PROGRESS",
  queued: "IN_PROGRESS",
  failed: "UNDELIVERED",
  rejected: "UNDELIVERED",
};

export function stateFromStatusWord(word: string): DeliveryState | null {
  return STATUS_TO_STATE[norm(word)] ?? null;
}

const MAX_REASON_CHARS = 100;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_.-]{3,100}$/;

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  // Control characters out, whitespace collapsed: this text ends up on a page.
  const t = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (t === "") return null;
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * Read the form fields of one callback. Keys are matched case-insensitively (the gateway writes
 * `phoneNumber`, a proxy might not keep that). Missing id, unusable id or an unrecognised status
 * word is refused, never guessed.
 */
export function parseDeliveryReport(fields: Record<string, string | undefined | null>): ParseReportResult {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "string") lower[k.toLowerCase()] = v;
  }

  const id = (lower["id"] ?? "").trim();
  if (id === "") return { ok: false, reason: "the report has no message id" };
  if (!MESSAGE_ID_PATTERN.test(id)) return { ok: false, reason: "the message id is not in a recognisable form" };

  const statusText = cleanText(lower["status"], 40);
  if (!statusText) return { ok: false, reason: "the report has no status" };
  const state = stateFromStatusWord(statusText);
  if (!state) return { ok: false, reason: `unrecognised status \"${statusText}\"` };

  let retryCount: number | null = null;
  const rc = (lower["retrycount"] ?? "").trim();
  if (/^\d{1,3}$/.test(rc)) retryCount = Number(rc);

  return {
    ok: true,
    report: {
      messageId: id,
      state,
      statusText,
      failureReason: state === "UNDELIVERED" ? cleanText(lower["failurereason"], MAX_REASON_CHARS) : null,
      phoneNumber: cleanText(lower["phonenumber"], 30),
      networkCode: cleanText(lower["networkcode"], 20),
      retryCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Why it was not delivered
// ---------------------------------------------------------------------------

/**
 *  PERMANENT_RECIPIENT - this number will not receive our texts (invalid, opted out, deactivated, DND).
 *                        Sending the same text again can never help.
 *  TEMPORARY_RECIPIENT - the handset was unreachable right now (switched off, no coverage).
 *  ACCOUNT             - our Africa's Talking account is the problem (balance, sender id). A person fixes it.
 *  NETWORK             - the gateway or the mobile network failed; the same text may well go through later.
 *  UNKNOWN             - a reason this file does not know (shown as the gateway wrote it).
 */
export type DeliveryFailureKind = "PERMANENT_RECIPIENT" | "TEMPORARY_RECIPIENT" | "ACCOUNT" | "NETWORK" | "UNKNOWN";

type ReasonEntry = { kind: DeliveryFailureKind; text: string };

const REASONS: Record<string, ReasonEntry> = {
  invalidphonenumber: { kind: "PERMANENT_RECIPIENT", text: "the phone number is not valid" },
  unsupportednumbertype: { kind: "PERMANENT_RECIPIENT", text: "the number cannot receive texts (landline or unsupported type)" },
  userinblacklist: { kind: "PERMANENT_RECIPIENT", text: "the recipient has opted out of messages" },
  donotdisturbrejection: { kind: "PERMANENT_RECIPIENT", text: "the recipient is on a do-not-disturb list" },
  userindnd: { kind: "PERMANENT_RECIPIENT", text: "the recipient is on a do-not-disturb list" },
  userisinactive: { kind: "PERMANENT_RECIPIENT", text: "the number is no longer active" },
  userdoesnotexist: { kind: "PERMANENT_RECIPIENT", text: "the number does not exist on the network" },
  notnetworksubscriber: { kind: "PERMANENT_RECIPIENT", text: "the number does not belong to a subscriber of that network" },
  usernotsubscribedtoproduct: { kind: "PERMANENT_RECIPIENT", text: "the recipient is not subscribed to receive this kind of message" },
  useraccountsuspended: { kind: "PERMANENT_RECIPIENT", text: "the recipient's line is suspended" },

  absentsubscriber: { kind: "TEMPORARY_RECIPIENT", text: "the phone was switched off or out of coverage" },

  insufficientbalance: { kind: "ACCOUNT", text: "the Africa's Talking account balance is too low - top it up" },
  insufficientcredit: { kind: "ACCOUNT", text: "the Africa's Talking account balance is too low - top it up" },
  invalidsenderid: { kind: "ACCOUNT", text: "the sender ID is not registered with Africa's Talking" },
  senderidblacklisted: { kind: "ACCOUNT", text: "the sender ID was blocked by the network" },
  riskhold: { kind: "ACCOUNT", text: "the gateway held the message for review" },

  deliveryfailure: { kind: "NETWORK", text: "the network could not deliver the message" },
  routefailure: { kind: "NETWORK", text: "the gateway could not find a route to the network" },
  couldnotroute: { kind: "NETWORK", text: "the gateway could not find a route to the network" },
  networkerror: { kind: "NETWORK", text: "the mobile network had an error" },
  internalservererror: { kind: "NETWORK", text: "Africa's Talking had an internal error" },
  gatewayerror: { kind: "NETWORK", text: "the network gateway had an error" },
  rejectedbygateway: { kind: "NETWORK", text: "the network gateway rejected the message" },
  applicationerror: { kind: "NETWORK", text: "Africa's Talking had an application error" },
};

export function classifyDeliveryFailure(reason: string | null | undefined): { kind: DeliveryFailureKind; text: string } {
  const raw = (reason ?? "").trim();
  if (raw === "") return { kind: "UNKNOWN", text: "the gateway gave no reason" };
  const hit = REASONS[norm(raw)];
  if (hit) return hit;
  return { kind: "UNKNOWN", text: `the gateway reported \"${raw.slice(0, MAX_REASON_CHARS)}\"` };
}

/**
 * May a PERSON re-send an SMS the network reported as undelivered? Not when the same number can never
 * receive it. An account problem is allowed (they may have fixed it), as is a network fault or an unknown
 * reason: a person pressing Retry has read the reason and decided.
 */
export function canRetryAfterUndelivered(reason: string | null | undefined): boolean {
  return classifyDeliveryFailure(reason).kind !== "PERMANENT_RECIPIENT";
}

// ---------------------------------------------------------------------------
// Is this report about the number we dialled?
// ---------------------------------------------------------------------------

/**
 * Compare the number on a report with the number we stored (E.164, e.g. +265999123456). Digits only;
 * when both have at least nine digits, the last nine decide (the report may or may not carry the
 * country code the same way). Fewer than seven digits on either side never match.
 */
export function phonesMatch(stored: string, reported: string): boolean {
  const a = stored.replace(/\D/g, "");
  const b = reported.replace(/\D/g, "");
  if (a.length < 7 || b.length < 7) return false;
  if (a.length >= 9 && b.length >= 9) return a.slice(-9) === b.slice(-9);
  return a === b;
}

// ---------------------------------------------------------------------------
// What a report does to a row
// ---------------------------------------------------------------------------

export type DeliveryDecision =
  | { apply: true; state: DeliveryState; failureReason: string | null }
  | { apply: false; why: "repeat" | "duplicate" | "stale" | "conflict"; message: string };

/**
 * Decide, from the row's current delivery state and an incoming report, whether the report is applied.
 * Forward only; the first final answer wins (see the file header).
 */
export function decideDeliveryUpdate(
  current: DeliveryState | null,
  report: Pick<DeliveryReport, "state" | "failureReason">
): DeliveryDecision {
  const incoming = report.state;
  const apply: DeliveryDecision = {
    apply: true,
    state: incoming,
    failureReason: incoming === "UNDELIVERED" ? report.failureReason : null,
  };

  if (current === null) return apply;

  if (current === "IN_PROGRESS") {
    if (incoming === "IN_PROGRESS") {
      return { apply: false, why: "repeat", message: "already recorded as handed to the network" };
    }
    return apply;
  }

  // current is final (DELIVERED or UNDELIVERED)
  if (incoming === current) return { apply: false, why: "duplicate", message: "this outcome was already recorded" };
  if (incoming === "IN_PROGRESS") {
    return { apply: false, why: "stale", message: "an older update arrived after the final outcome" };
  }
  return { apply: false, why: "conflict", message: "a different final outcome was already recorded; the first one is kept" };
}

// ---------------------------------------------------------------------------
// The webhook, with every outside effect injected
// ---------------------------------------------------------------------------

/** Constant-time string compare with no imports (length differences are folded in, not early-exited). */
export function constantTimeEquals(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export type ReportRow = {
  id: string;
  businessId: string | null;
  channel: string;
  providerName: string;
  recipientAddress: string;
  deliveryState: DeliveryState | null;
};

export type ReportDeps = {
  /** The shared secret from the environment. Empty string = the endpoint is switched off. */
  secret: string;
  /** Rows whose providerMessageId equals this id (normally zero or one). */
  findByMessageId(messageId: string): Promise<ReportRow[]>;
  /**
   * Conditional write: set the delivery columns ONLY IF the row's deliveryState is still `expected`
   * (null included). True for exactly one of two racing callers.
   */
  apply(
    rowId: string,
    expected: DeliveryState | null,
    next: { state: DeliveryState; failureReason: string | null; reportedAt: Date }
  ): Promise<boolean>;
  /** Re-read one row's state after a lost race. */
  reload(rowId: string): Promise<DeliveryState | null | undefined>;
};

export type ReportResponse = { httpStatus: number; body: Record<string, unknown> };

const MAX_RACE_RETRIES = 3;

export async function processDeliveryReport(
  deps: ReportDeps,
  input: { token: string | null; fields: Record<string, string | undefined | null> },
  now: Date
): Promise<ReportResponse> {
  if (deps.secret === "") {
    return { httpStatus: 503, body: { error: "disabled", message: "AT_DELIVERY_REPORT_SECRET is not set." } };
  }
  // Authenticate BEFORE looking at the body or touching the database.
  if (input.token === null || !constantTimeEquals(input.token, deps.secret)) {
    return { httpStatus: 401, body: { error: "unauthorized" } };
  }

  const parsed = parseDeliveryReport(input.fields);
  if (!parsed.ok) return { httpStatus: 400, body: { error: "bad_report", message: parsed.reason } };
  const report = parsed.report;

  const rows = (await deps.findByMessageId(report.messageId)).filter(
    (r) => r.channel === "SMS" && r.providerName === "africastalking"
  );
  if (rows.length === 0) {
    // Also what an unknown id from another application on the same gateway account looks like.
    return { httpStatus: 404, body: { error: "not_found", message: "No message with that id." } };
  }

  // If the report names a number, it must be the one we dialled.
  const row = report.phoneNumber === null ? rows[0] : rows.find((r) => phonesMatch(r.recipientAddress, report.phoneNumber as string));
  if (!row) {
    return { httpStatus: 409, body: { error: "number_mismatch", message: "The number on the report is not the number we sent to." } };
  }

  let current: DeliveryState | null = row.deliveryState;
  for (let attempt = 0; attempt < MAX_RACE_RETRIES; attempt++) {
    const decision = decideDeliveryUpdate(current, report);
    if (!decision.apply) {
      return { httpStatus: 200, body: { ok: true, applied: false, why: decision.why } };
    }
    const won = await deps.apply(row.id, current, {
      state: decision.state,
      failureReason: decision.failureReason,
      reportedAt: now,
    });
    if (won) return { httpStatus: 200, body: { ok: true, applied: true, state: decision.state } };
    const fresh = await deps.reload(row.id);
    if (fresh === undefined) {
      return { httpStatus: 404, body: { error: "not_found", message: "No message with that id." } };
    }
    current = fresh;
  }
  return { httpStatus: 200, body: { ok: true, applied: false, why: "concurrent" } };
}

// ---------------------------------------------------------------------------
// What the Notifications page shows
// ---------------------------------------------------------------------------

/** After this many hours without any report, the page says so (the text may still have arrived). */
export const NO_REPORT_AFTER_HOURS = 24;

export type DeliveryView = {
  tone: "good" | "info" | "bad" | "warn" | "muted";
  text: string;
  /** When the report arrived (null for the "waiting" views). */
  at: Date | null;
} | null;

export function describeDeliveryState(
  row: {
    channel: string;
    status: string;
    providerName: string;
    providerMessageId: string | null;
    deliveryState: string | null;
    deliveryReportedAt: Date | null;
    deliveryFailureReason: string | null;
    createdAt: Date;
  },
  opts: { reportsEnabled: boolean; now: Date }
): DeliveryView {
  if (row.channel !== "SMS" || row.providerName !== "africastalking" || row.status !== "SENT") return null;

  if (row.deliveryState === "DELIVERED") {
    return { tone: "good", text: "Delivered to the handset", at: row.deliveryReportedAt };
  }
  if (row.deliveryState === "IN_PROGRESS") {
    return { tone: "info", text: "Handed to the mobile network; not yet confirmed on the handset", at: row.deliveryReportedAt };
  }
  if (row.deliveryState === "UNDELIVERED") {
    const why = classifyDeliveryFailure(row.deliveryFailureReason);
    return { tone: "bad", text: `Not delivered: ${why.text}`, at: row.deliveryReportedAt };
  }

  // No report yet. Without a message id (an "accepted but unconfirmed" send) one can never arrive, and
  // when reports are not switched on there is nothing to wait for: say nothing in both cases.
  if (!row.providerMessageId || !opts.reportsEnabled) return null;
  const ageHours = (opts.now.getTime() - row.createdAt.getTime()) / 3_600_000;
  if (ageHours >= NO_REPORT_AFTER_HOURS) {
    return {
      tone: "warn",
      text: `No delivery report after ${NO_REPORT_AFTER_HOURS} hours. The text may still have arrived; check the callback URL in Africa's Talking.`,
      at: null,
    };
  }
  return { tone: "muted", text: "Waiting for a delivery report", at: null };
}
