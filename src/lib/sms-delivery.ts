/**
 * Module 71 – reading Africa's Talking's per-recipient delivery status.
 *
 * Until now `deliverSms()` in notifications.ts treated ANY HTTP 200 from
 * Africa's Talking as "SENT". That is wrong: the gateway answers 200/201 when
 * it accepted the REQUEST, and reports each recipient's outcome inside the
 * body (`SMSMessageData.Recipients[].statusCode`). An invalid number, an
 * unsupported number type, an empty account balance or a blocked recipient all
 * come back as HTTP 200, so the Notifications page showed a green "SENT" for a
 * text that never left. This file reads the body and decides.
 *
 * PURE and import-free on purpose (same split as bank-statement-csv.ts and
 * vat-payment-direction.ts): notifications.ts imports Prisma at module scope,
 * so anything a plain-Node verify script needs to exercise lives here instead.
 *
 * Fail-closed rules:
 *   - a recipient counts as accepted ONLY for statusCode 100 (Processed),
 *     101 (Sent) or 102 (Queued); every other code, and any code this file
 *     doesn't know, is a failure that names the code;
 *   - a body with an empty `Recipients` list is a failure (that is how the
 *     gateway reports a number it refused outright), reported with its own
 *     `Message` text;
 *   - if several recipients came back and any failed, the whole send is
 *     FAILED and the message says which (sendSms() only ever dials one number,
 *     so this is defensive, not a designed bulk path);
 *   - a body that can't be read at all is NOT called a failure (the request
 *     was accepted, and calling it FAILED invites a duplicate resend) and NOT
 *     silently called a clean success either: it is SENT with `confirmed:
 *     false` and an explanatory note.
 */

export type SmsRecipientOutcome = {
  number: string | null;
  statusCode: number | null;
  /** The gateway's own status word, e.g. "Success", "InvalidPhoneNumber". */
  statusText: string;
  ok: boolean;
  messageId: string | null;
  cost: string | null;
};

export type SmsDeliveryVerdict = {
  status: "SENT" | "FAILED";
  /**
   * true  = the gateway told us, per recipient, that the message was accepted
   *         (or told us why it was not);
   * false = HTTP was fine but the body was unreadable, so nothing was confirmed.
   */
  confirmed: boolean;
  /** Set for every FAILED, and for a SENT that is not confirmed. */
  errorMessage?: string;
  recipients: SmsRecipientOutcome[];
};

/** Codes documented by Africa's Talking for a recipient row. */
export const ACCEPTED_STATUS_CODES: readonly number[] = [100, 101, 102];

const CODE_LABELS: Record<number, string> = {
  100: "Processed",
  101: "Sent",
  102: "Queued",
  401: "RiskHold",
  402: "InvalidSenderId",
  403: "InvalidPhoneNumber",
  404: "UnsupportedNumberType",
  405: "InsufficientBalance",
  406: "UserInBlacklist",
  407: "CouldNotRoute",
  409: "DoNotDisturbRejection",
  500: "InternalServerError",
  501: "GatewayError",
  502: "RejectedByGateway",
};

/** What to do about a refusal, in plain words for whoever reads the log. */
const CODE_HINTS: Record<number, string> = {
  401: "the gateway held the message for review",
  402: "the sender ID is not registered with Africa's Talking",
  403: "check the phone number, including the +265 country code",
  404: "the number is not one the gateway can text (landline or unsupported type)",
  405: "the Africa's Talking account balance is too low - top it up",
  406: "the recipient has opted out of receiving messages",
  407: "the gateway could not find a route to this network",
  409: "the recipient is on a do-not-disturb list",
  500: "Africa's Talking had an internal error - try again later",
  501: "the network gateway had an error - try again later",
  502: "the network rejected the message",
};

export function isAcceptedStatusCode(code: number | null): boolean {
  return code !== null && ACCEPTED_STATUS_CODES.includes(code);
}

/** One short phrase for a recipient outcome, used in error messages. */
export function describeRecipientFailure(r: SmsRecipientOutcome): string {
  const label = r.statusText || (r.statusCode !== null ? CODE_LABELS[r.statusCode] : "") || "";
  const codePart = r.statusCode !== null ? `code ${r.statusCode}` : "no status code";
  const hint = r.statusCode !== null ? CODE_HINTS[r.statusCode] : undefined;
  const who = r.number ? `${r.number}: ` : "";
  const head = label ? `${label} (${codePart})` : `unrecognised status (${codePart})`;
  return hint ? `${who}${head} - ${hint}` : `${who}${head}`;
}

function asString(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function asCode(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d{1,4}$/.test(v.trim())) return Number(v.trim());
  return null;
}

function readRecipient(raw: unknown): SmsRecipientOutcome {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const statusCode = asCode(o.statusCode);
  const statusText = asString(o.status) ?? "";
  // The status word is only trusted when there is no numeric code to go by.
  // A row with code 403 that also says "Success" is a failure.
  const ok =
    statusCode !== null
      ? isAcceptedStatusCode(statusCode)
      : statusText.toLowerCase() === "success";
  return {
    number: asString(o.number),
    statusCode,
    statusText,
    ok,
    messageId: asString(o.messageId),
    cost: asString(o.cost),
  };
}

const MAX_MESSAGE_CHARS = 300;

function clip(s: string): string {
  return s.length > MAX_MESSAGE_CHARS ? `${s.slice(0, MAX_MESSAGE_CHARS)}...` : s;
}

/**
 * Decide the outcome of an Africa's Talking `/messaging` response that came
 * back with a success HTTP status. `bodyText` is the raw response body.
 */
export function parseAfricasTalkingResponse(bodyText: string): SmsDeliveryVerdict {
  const unreadable = (why: string): SmsDeliveryVerdict => ({
    status: "SENT",
    confirmed: false,
    errorMessage: `Africa's Talking accepted the request but its reply could not be read (${why}), so delivery is unconfirmed.`,
    recipients: [],
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return unreadable("not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") return unreadable("unexpected shape");

  const data = (parsed as Record<string, unknown>).SMSMessageData;
  if (!data || typeof data !== "object") return unreadable("no SMSMessageData");

  const d = data as Record<string, unknown>;
  const message = asString(d.Message);

  if (!Array.isArray(d.Recipients)) {
    // No recipient list at all: nothing to confirm either way.
    return unreadable("no Recipients list");
  }

  const recipients = d.Recipients.map(readRecipient);

  if (recipients.length === 0) {
    // The gateway's way of saying it refused the number outright.
    return {
      status: "FAILED",
      confirmed: true,
      errorMessage: clip(
        `Africa's Talking accepted no recipients${message ? `: ${message}` : ""}. Check the phone number and sender ID.`
      ),
      recipients,
    };
  }

  const failed = recipients.filter((r) => !r.ok);
  if (failed.length === 0) {
    return { status: "SENT", confirmed: true, recipients };
  }

  const detail = failed.map(describeRecipientFailure).join("; ");
  const prefix =
    recipients.length === 1
      ? "Africa's Talking did not deliver the message: "
      : `Africa's Talking rejected ${failed.length} of ${recipients.length} recipients: `;
  return { status: "FAILED", confirmed: true, errorMessage: clip(prefix + detail), recipients };
}
