/**
 * Module 71: standalone checks for reading Africa's Talking's per-recipient
 * delivery status. No database, no network, no framework:
 *   npx tsx scripts/verify-sms-delivery.ts   (npm run verify:sms-delivery)
 * Exits non-zero if any check fails.
 *
 * Covers src/lib/sms-delivery.ts directly - notifications.ts imports Prisma at
 * module scope and can't be loaded here, the same reason the other pure
 * verify scripts target their own import-free files.
 */
import {
  parseAfricasTalkingResponse,
  isAcceptedStatusCode,
  describeRecipientFailure,
  ACCEPTED_STATUS_CODES,
  SmsRecipientOutcome,
} from "../src/lib/sms-delivery";

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
function has(name: string, haystack: string | undefined, needle: string) {
  total++;
  if (!haystack || !haystack.includes(needle)) {
    failed++;
    console.error(`FAIL ${name}\n  expected to contain ${JSON.stringify(needle)}\n  actual   ${JSON.stringify(haystack)}`);
  }
}

function body(recipients: unknown[] | undefined, message = "Sent to 1/1 Total Cost: MWK 20.0000"): string {
  const data: Record<string, unknown> = { Message: message };
  if (recipients !== undefined) data.Recipients = recipients;
  return JSON.stringify({ SMSMessageData: data });
}
const rec = (statusCode: unknown, status: unknown, extra: Record<string, unknown> = {}) => ({
  statusCode,
  number: "+265999123456",
  cost: "MWK 20.0000",
  status,
  messageId: "ATXid_abc",
  ...extra,
});

// ---- accepted codes ----
check("accepted codes are exactly 100/101/102", [...ACCEPTED_STATUS_CODES], [100, 101, 102]);
for (const c of [100, 101, 102]) check(`code ${c} accepted`, isAcceptedStatusCode(c), true);
for (const c of [0, 99, 103, 401, 403, 405, 500, 502]) check(`code ${c} not accepted`, isAcceptedStatusCode(c), false);
check("null code not accepted", isAcceptedStatusCode(null), false);

// ---- the normal success ----
{
  const v = parseAfricasTalkingResponse(body([rec(101, "Success")]));
  check("101 Success -> SENT", v.status, "SENT");
  check("101 Success -> confirmed", v.confirmed, true);
  check("101 Success -> no error message", v.errorMessage, undefined);
  check("101 Success -> one recipient, ok", v.recipients.map((r) => r.ok), [true]);
  check("101 Success -> messageId kept", v.recipients[0].messageId, "ATXid_abc");
  check("101 Success -> cost kept", v.recipients[0].cost, "MWK 20.0000");
}
check("100 Processed -> SENT", parseAfricasTalkingResponse(body([rec(100, "Processed")])).status, "SENT");
check("102 Queued -> SENT", parseAfricasTalkingResponse(body([rec(102, "Queued")])).status, "SENT");
check("statusCode as a numeric string still read", parseAfricasTalkingResponse(body([rec("101", "Success")])).status, "SENT");
check("statusCode with spaces still read", parseAfricasTalkingResponse(body([rec(" 101 ", "Success")])).status, "SENT");

// ---- refusals that arrive as HTTP 200 ----
const refusals: [number, string, string][] = [
  [401, "RiskHold", "held the message"],
  [402, "InvalidSenderId", "sender ID"],
  [403, "InvalidPhoneNumber", "+265"],
  [404, "UnsupportedNumberType", "landline"],
  [405, "InsufficientBalance", "top it up"],
  [406, "UserInBlacklist", "opted out"],
  [407, "CouldNotRoute", "route"],
  [409, "DoNotDisturbRejection", "do-not-disturb"],
  [500, "InternalServerError", "try again later"],
  [501, "GatewayError", "try again later"],
  [502, "RejectedByGateway", "rejected"],
];
for (const [code, word, hint] of refusals) {
  const v = parseAfricasTalkingResponse(body([rec(code, word)], "Sent to 0/1"));
  check(`${code} -> FAILED`, v.status, "FAILED");
  check(`${code} -> confirmed`, v.confirmed, true);
  has(`${code} names the word`, v.errorMessage, word);
  has(`${code} names the code`, v.errorMessage, `code ${code}`);
  has(`${code} gives a hint`, v.errorMessage, hint);
  has(`${code} names the number`, v.errorMessage, "+265999123456");
}

// ---- the code beats the word ----
{
  const v = parseAfricasTalkingResponse(body([rec(403, "Success")]));
  check("code 403 with status word Success -> FAILED (code wins)", v.status, "FAILED");
  const w = parseAfricasTalkingResponse(body([rec(101, "InvalidPhoneNumber")]));
  check("code 101 with a failure word -> SENT (code wins)", w.status, "SENT");
}

// ---- unknown / missing codes fail closed ----
{
  const v = parseAfricasTalkingResponse(body([rec(777, "Whatever")]));
  check("unknown code 777 -> FAILED", v.status, "FAILED");
  has("unknown code names it", v.errorMessage, "code 777");
  const noCode = parseAfricasTalkingResponse(body([{ number: "+265999123456", status: "Success" }]));
  check("no code but word Success -> SENT", noCode.status, "SENT");
  const nothing = parseAfricasTalkingResponse(body([{ number: "+265999123456" }]));
  check("no code and no word -> FAILED", nothing.status, "FAILED");
  has("no code and no word says so", nothing.errorMessage, "no status code");
  const junkCode = parseAfricasTalkingResponse(body([rec("abc", "")]));
  check("non-numeric code, no word -> FAILED", junkCode.status, "FAILED");
  const floatCode = parseAfricasTalkingResponse(body([rec(101.5, "")]));
  check("fractional code is not 101 -> FAILED", floatCode.status, "FAILED");
  const nullRow = parseAfricasTalkingResponse(body([null]));
  check("a null recipient row -> FAILED, no crash", nullRow.status, "FAILED");
}

// ---- empty Recipients list ----
{
  const v = parseAfricasTalkingResponse(body([], "InvalidPhoneNumber"));
  check("empty Recipients -> FAILED", v.status, "FAILED");
  check("empty Recipients -> confirmed refusal", v.confirmed, true);
  has("empty Recipients quotes the gateway message", v.errorMessage, "InvalidPhoneNumber");
  has("empty Recipients points at the number", v.errorMessage, "phone number");
  const noMsg = parseAfricasTalkingResponse(JSON.stringify({ SMSMessageData: { Recipients: [] } }));
  check("empty Recipients without a Message still FAILED", noMsg.status, "FAILED");
  const blankMsg = parseAfricasTalkingResponse(body([], "   "));
  check("blank Message ignored", blankMsg.errorMessage?.includes(": "), false);
}

// ---- several recipients ----
{
  const allOk = parseAfricasTalkingResponse(body([rec(101, "Success"), rec(101, "Success", { number: "+265888000111" })]));
  check("two accepted -> SENT", allOk.status, "SENT");
  const mixed = parseAfricasTalkingResponse(
    body([rec(101, "Success"), rec(403, "InvalidPhoneNumber", { number: "+265888000111" })])
  );
  check("one of two failed -> FAILED", mixed.status, "FAILED");
  has("mixed says 1 of 2", mixed.errorMessage, "1 of 2");
  has("mixed names the failing number", mixed.errorMessage, "+265888000111");
  check("mixed does not name the good number", mixed.errorMessage?.includes("+265999123456"), false);
  const bothBad = parseAfricasTalkingResponse(body([rec(405, "InsufficientBalance"), rec(403, "InvalidPhoneNumber")]));
  has("both failed says 2 of 2", bothBad.errorMessage, "2 of 2");
}

// ---- unreadable bodies: SENT but never confirmed, and say why ----
const unreadableCases: [string, string, string][] = [
  ["empty body", "", "not valid JSON"],
  ["plain text", "OK", "not valid JSON"],
  ["HTML page", "<html>gateway</html>", "not valid JSON"],
  ["JSON null", "null", "unexpected shape"],
  ["JSON string", "\"ok\"", "unexpected shape"],
  ["JSON number", "42", "unexpected shape"],
  ["no SMSMessageData", "{}", "no SMSMessageData"],
  ["SMSMessageData is a string", JSON.stringify({ SMSMessageData: "x" }), "no SMSMessageData"],
  ["no Recipients", body(undefined), "no Recipients list"],
  ["Recipients not a list", JSON.stringify({ SMSMessageData: { Recipients: "x" } }), "no Recipients list"],
];
for (const [label, text, why] of unreadableCases) {
  const v = parseAfricasTalkingResponse(text);
  check(`${label} -> SENT`, v.status, "SENT");
  check(`${label} -> NOT confirmed`, v.confirmed, false);
  has(`${label} explains delivery is unconfirmed`, v.errorMessage, "unconfirmed");
  has(`${label} says why`, v.errorMessage, why);
  check(`${label} -> no recipients`, v.recipients, []);
}

// ---- a confirmed success carries no note ----
check("confirmed success has no errorMessage", parseAfricasTalkingResponse(body([rec(101, "Success")])).errorMessage, undefined);

// ---- long messages are clipped, never dropped ----
{
  const v = parseAfricasTalkingResponse(body([], "x".repeat(2000)));
  check("long gateway message clipped to a sane length", (v.errorMessage ?? "").length <= 303, true);
  check("clipped message ends with an ellipsis", (v.errorMessage ?? "").endsWith("..."), true);
}

// ---- describeRecipientFailure ----
{
  const r: SmsRecipientOutcome = {
    number: null,
    statusCode: null,
    statusText: "",
    ok: false,
    messageId: null,
    cost: null,
  };
  check("describe: nothing known", describeRecipientFailure(r), "unrecognised status (no status code)");
  check(
    "describe: word only",
    describeRecipientFailure({ ...r, statusText: "Odd" }),
    "Odd (no status code)"
  );
  check(
    "describe: code with no word falls back to the documented label",
    describeRecipientFailure({ ...r, statusCode: 405 }),
    "InsufficientBalance (code 405) - the Africa's Talking account balance is too low - top it up"
  );
  check(
    "describe: unknown code, no hint",
    describeRecipientFailure({ ...r, statusCode: 777, statusText: "Odd", number: "+1" }),
    "+1: Odd (code 777)"
  );
}

console.log(`${total - failed}/${total} checks passed`);
if (failed > 0) process.exit(1);
