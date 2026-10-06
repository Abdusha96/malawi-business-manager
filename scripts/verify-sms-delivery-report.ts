/**
 * Module 76: standalone checks for Africa's Talking delivery reports. No database, no network:
 *   npx tsx scripts/verify-sms-delivery-report.ts   (npm run verify:sms-delivery-report)
 * Covers src/lib/sms-delivery-report.ts (pure, import-free), including the webhook orchestrator against an
 * in-memory table with the same conditional-write behaviour as the Prisma implementation, plus the
 * Module 76 additions to src/lib/notification-retry.ts (manual retry of an undelivered text).
 */
import {
  parseDeliveryReport,
  stateFromStatusWord,
  classifyDeliveryFailure,
  canRetryAfterUndelivered,
  phonesMatch,
  decideDeliveryUpdate,
  constantTimeEquals,
  processDeliveryReport,
  describeDeliveryState,
  NO_REPORT_AFTER_HOURS,
  ReportDeps,
  ReportRow,
  DeliveryState,
} from "../src/lib/sms-delivery-report";
import { checkManualRetry, describeRetryState } from "../src/lib/notification-retry";

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
const hours = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);

async function main() {
  // ---------------------------------------------------------------- status words
  check("Success -> delivered", stateFromStatusWord("Success"), "DELIVERED");
  check("Sent -> in progress", stateFromStatusWord("Sent"), "IN_PROGRESS");
  check("Submitted -> in progress", stateFromStatusWord("Submitted"), "IN_PROGRESS");
  check("Buffered -> in progress", stateFromStatusWord("Buffered"), "IN_PROGRESS");
  check("Failed -> undelivered", stateFromStatusWord("Failed"), "UNDELIVERED");
  check("Rejected -> undelivered", stateFromStatusWord("Rejected"), "UNDELIVERED");
  check("case and spacing ignored", stateFromStatusWord(" SUCCESS "), "DELIVERED");
  check("unknown word is null (never read as success)", stateFromStatusWord("Delivered"), null);
  check("empty word is null", stateFromStatusWord(""), null);

  // ---------------------------------------------------------------- parsing
  let p = parseDeliveryReport({ id: "ATXid_abc123", status: "Success", phoneNumber: "+265999123456", networkCode: "65001", retryCount: "0" });
  check("parse ok", p.ok, true);
  if (p.ok) {
    check("parse id", p.report.messageId, "ATXid_abc123");
    check("parse state", p.report.state, "DELIVERED");
    check("parse phone", p.report.phoneNumber, "+265999123456");
    check("parse network", p.report.networkCode, "65001");
    check("parse retryCount", p.report.retryCount, 0);
    check("failure reason dropped on success", p.report.failureReason, null);
  }
  p = parseDeliveryReport({ id: "ATXid_abc123", status: "Failed", failureReason: "UserInBlacklist" });
  if (p.ok) {
    check("failed keeps reason", p.report.failureReason, "UserInBlacklist");
    check("failed state", p.report.state, "UNDELIVERED");
    check("absent phone is null", p.report.phoneNumber, null);
  } else check("failed parses", true, false);
  p = parseDeliveryReport({ id: "ATXid_abc123", status: "Sent", failureReason: "Whatever" });
  if (p.ok) check("reason ignored when not undelivered", p.report.failureReason, null);
  p = parseDeliveryReport({ id: "ATXid_abc123", status: "Failed" });
  if (p.ok) check("failed with no reason", p.report.failureReason, null);
  p = parseDeliveryReport({ ID: "ATXid_abc123", STATUS: "Success", PhoneNumber: "+265888000111" });
  check("keys are case-insensitive", p.ok, true);
  p = parseDeliveryReport({ status: "Success" });
  check("missing id refused", p.ok, false);
  p = parseDeliveryReport({ id: "  ", status: "Success" });
  check("blank id refused", p.ok, false);
  p = parseDeliveryReport({ id: "AT id with spaces", status: "Success" });
  check("id with spaces refused", p.ok, false);
  p = parseDeliveryReport({ id: "x", status: "Success" });
  check("too-short id refused", p.ok, false);
  p = parseDeliveryReport({ id: "a'; DROP TABLE--", status: "Success" });
  check("odd id refused", p.ok, false);
  p = parseDeliveryReport({ id: "ATXid_abc123" });
  check("missing status refused", p.ok, false);
  p = parseDeliveryReport({ id: "ATXid_abc123", status: "Teleported" });
  check("unknown status refused", p.ok, false);
  if (!p.ok) has("unknown status named", p.reason, "Teleported");
  p = parseDeliveryReport({ id: "ATXid_abc123", status: "Failed", failureReason: "x\u0000y\n\tz".padEnd(300, "q") });
  if (p.ok) {
    check("reason has no control characters", /[\u0000-\u001f]/.test(p.report.failureReason ?? ""), false);
    check("reason clipped", (p.report.failureReason ?? "").length <= 100, true);
  }
  p = parseDeliveryReport({ id: "ATXid_abc123", status: "Success", retryCount: "lots" });
  if (p.ok) check("bad retryCount is null", p.report.retryCount, null);

  // ---------------------------------------------------------------- failure reasons
  check("blacklist permanent", classifyDeliveryFailure("UserInBlacklist").kind, "PERMANENT_RECIPIENT");
  check("DND permanent", classifyDeliveryFailure("DoNotDisturbRejection").kind, "PERMANENT_RECIPIENT");
  check("invalid number permanent", classifyDeliveryFailure("InvalidPhoneNumber").kind, "PERMANENT_RECIPIENT");
  check("inactive permanent", classifyDeliveryFailure("UserIsInactive").kind, "PERMANENT_RECIPIENT");
  check("absent subscriber temporary", classifyDeliveryFailure("AbsentSubscriber").kind, "TEMPORARY_RECIPIENT");
  check("balance is account", classifyDeliveryFailure("InsufficientBalance").kind, "ACCOUNT");
  check("sender id is account", classifyDeliveryFailure("InvalidSenderId").kind, "ACCOUNT");
  check("delivery failure is network", classifyDeliveryFailure("DeliveryFailure").kind, "NETWORK");
  check("gateway error is network", classifyDeliveryFailure("GatewayError").kind, "NETWORK");
  check("spelling/spacing tolerated", classifyDeliveryFailure("user in blacklist").kind, "PERMANENT_RECIPIENT");
  check("unknown reason is UNKNOWN", classifyDeliveryFailure("SomethingNew").kind, "UNKNOWN");
  has("unknown reason shown as written", classifyDeliveryFailure("SomethingNew").text, "SomethingNew");
  check("no reason is UNKNOWN", classifyDeliveryFailure(null).kind, "UNKNOWN");
  has("no reason says so", classifyDeliveryFailure(undefined).text, "no reason");
  check("permanent recipient not retryable", canRetryAfterUndelivered("UserInBlacklist"), false);
  check("account problem retryable", canRetryAfterUndelivered("InsufficientBalance"), true);
  check("network fault retryable", canRetryAfterUndelivered("NetworkError"), true);
  check("absent subscriber retryable", canRetryAfterUndelivered("AbsentSubscriber"), true);
  check("unknown reason retryable by a person", canRetryAfterUndelivered("SomethingNew"), true);
  check("no reason retryable by a person", canRetryAfterUndelivered(null), true);

  // ---------------------------------------------------------------- phone match
  check("same number matches", phonesMatch("+265999123456", "+265999123456"), true);
  check("country code written differently still matches", phonesMatch("+265999123456", "0999123456"), true);
  check("spaces and punctuation ignored", phonesMatch("+265999123456", "+265 (999) 123-456"), true);
  check("different number does not match", phonesMatch("+265999123456", "+265999123457"), false);
  check("different network same tail does not match", phonesMatch("+265999123456", "+265888123456"), false);
  check("too short never matches", phonesMatch("+265999123456", "123456"), false);
  check("empty never matches", phonesMatch("+265999123456", ""), false);
  check("short foreign numbers need equality", phonesMatch("+4712345678", "+4712345678"), true);
  check("short foreign numbers differ", phonesMatch("+4712345678", "+4712345679"), false);

  // ---------------------------------------------------------------- forward-only decisions
  const rep = (state: DeliveryState, failureReason: string | null = null) => ({ state, failureReason });
  check("null -> in progress applies", decideDeliveryUpdate(null, rep("IN_PROGRESS")).apply, true);
  check("null -> delivered applies", decideDeliveryUpdate(null, rep("DELIVERED")).apply, true);
  check("null -> undelivered applies", decideDeliveryUpdate(null, rep("UNDELIVERED", "NetworkError")).apply, true);
  const ud = decideDeliveryUpdate(null, rep("UNDELIVERED", "NetworkError"));
  if (ud.apply) check("undelivered carries reason", ud.failureReason, "NetworkError");
  const dd = decideDeliveryUpdate(null, rep("DELIVERED", "stray"));
  if (dd.apply) check("delivered drops a stray reason", dd.failureReason, null);
  check("in progress -> delivered applies", decideDeliveryUpdate("IN_PROGRESS", rep("DELIVERED")).apply, true);
  check("in progress -> undelivered applies", decideDeliveryUpdate("IN_PROGRESS", rep("UNDELIVERED")).apply, true);
  const rp = decideDeliveryUpdate("IN_PROGRESS", rep("IN_PROGRESS"));
  check("in progress repeat is not applied", rp.apply === false && rp.why, "repeat");
  const dup = decideDeliveryUpdate("DELIVERED", rep("DELIVERED"));
  check("duplicate final not applied", dup.apply === false && dup.why, "duplicate");
  const dup2 = decideDeliveryUpdate("UNDELIVERED", rep("UNDELIVERED"));
  check("duplicate undelivered not applied", dup2.apply === false && dup2.why, "duplicate");
  const stale = decideDeliveryUpdate("DELIVERED", rep("IN_PROGRESS"));
  check("late Sent never undoes Success", stale.apply === false && stale.why, "stale");
  const stale2 = decideDeliveryUpdate("UNDELIVERED", rep("IN_PROGRESS"));
  check("late Sent never undoes Failed", stale2.apply === false && stale2.why, "stale");
  const c1 = decideDeliveryUpdate("DELIVERED", rep("UNDELIVERED", "X"));
  check("delivered then failed is a conflict, first kept", c1.apply === false && c1.why, "conflict");
  const c2 = decideDeliveryUpdate("UNDELIVERED", rep("DELIVERED"));
  check("failed then delivered is a conflict, first kept", c2.apply === false && c2.why, "conflict");

  // ---------------------------------------------------------------- constant-time compare
  check("equal secrets", constantTimeEquals("s3cret-token", "s3cret-token"), true);
  check("different secrets", constantTimeEquals("s3cret-token", "s3cret-tokeN"), false);
  check("prefix is not equal", constantTimeEquals("s3cret", "s3cret-token"), false);
  check("longer is not equal", constantTimeEquals("s3cret-token", "s3cret"), false);
  check("empty vs empty", constantTimeEquals("", ""), true);
  check("empty vs something", constantTimeEquals("", "x"), false);
  check("NUL padding is not equal", constantTimeEquals("abc", "abc\u0000"), false);

  // ---------------------------------------------------------------- the webhook, against an in-memory table
  type World = {
    rows: Map<string, ReportRow & { reportedAt: Date | null; failureReason: string | null; messageId: string }>;
    deps: ReportDeps;
    writes: number;
    beforeApply?: () => void;
  };
  function world(
    rowDefs: Array<Partial<ReportRow> & { id: string; messageId: string }>,
    secret = "topsecret"
  ): World {
    const rows = new Map<string, ReportRow & { reportedAt: Date | null; failureReason: string | null; messageId: string }>();
    for (const d of rowDefs) {
      rows.set(d.id, {
        id: d.id,
        businessId: d.businessId === undefined ? "biz1" : d.businessId,
        channel: d.channel ?? "SMS",
        providerName: d.providerName ?? "africastalking",
        recipientAddress: d.recipientAddress ?? "+265999123456",
        deliveryState: d.deliveryState ?? null,
        reportedAt: null,
        failureReason: null,
        messageId: d.messageId,
      });
    }
    const w: World = {
      rows,
      writes: 0,
      deps: {
        secret,
        async findByMessageId(messageId) {
          return Array.from(rows.values())
            .filter((r) => r.messageId === messageId)
            .map((r) => ({ id: r.id, businessId: r.businessId, channel: r.channel, providerName: r.providerName, recipientAddress: r.recipientAddress, deliveryState: r.deliveryState }));
        },
        async apply(rowId, expected, next) {
          w.beforeApply?.();
          const r = rows.get(rowId);
          // same conditional write as the Prisma implementation: only if the state is still `expected`
          if (!r || r.deliveryState !== expected) return false;
          r.deliveryState = next.state;
          r.reportedAt = next.reportedAt;
          r.failureReason = next.failureReason;
          w.writes++;
          return true;
        },
        async reload(rowId) {
          const r = rows.get(rowId);
          return r ? r.deliveryState : undefined;
        },
      },
    };
    return w;
  }
  const good = { token: "topsecret", fields: { id: "ATXid_one", status: "Success", phoneNumber: "+265999123456" } };

  let w = world([{ id: "r1", messageId: "ATXid_one" }]);
  let res = await processDeliveryReport(w.deps, good, T0);
  check("delivered report: 200", res.httpStatus, 200);
  check("delivered report: applied", res.body.applied, true);
  check("row is DELIVERED", w.rows.get("r1")?.deliveryState, "DELIVERED");
  check("reportedAt recorded", w.rows.get("r1")?.reportedAt?.toISOString(), T0.toISOString());

  res = await processDeliveryReport(w.deps, good, hours(T0, 1));
  check("same report twice: not applied again", res.body.applied, false);
  check("same report twice: duplicate", res.body.why, "duplicate");
  check("same report twice: still one write", w.writes, 1);
  check("same report twice: reportedAt unchanged", w.rows.get("r1")?.reportedAt?.toISOString(), T0.toISOString());

  res = await processDeliveryReport(w.deps, { token: "topsecret", fields: { id: "ATXid_one", status: "Sent" } }, hours(T0, 2));
  check("late Sent after Success ignored", res.body.why, "stale");
  check("row still DELIVERED", w.rows.get("r1")?.deliveryState, "DELIVERED");

  res = await processDeliveryReport(w.deps, { token: "topsecret", fields: { id: "ATXid_one", status: "Failed", failureReason: "DeliveryFailure" } }, hours(T0, 3));
  check("contradicting Failed refused", res.body.why, "conflict");
  check("row still DELIVERED after conflict", w.rows.get("r1")?.deliveryState, "DELIVERED");

  // in progress then final
  w = world([{ id: "r1", messageId: "ATXid_one" }]);
  res = await processDeliveryReport(w.deps, { token: "topsecret", fields: { id: "ATXid_one", status: "Buffered" } }, T0);
  check("Buffered applied", res.body.state, "IN_PROGRESS");
  res = await processDeliveryReport(w.deps, { token: "topsecret", fields: { id: "ATXid_one", status: "Sent" } }, hours(T0, 0.1));
  check("Sent after Buffered is a repeat", res.body.why, "repeat");
  res = await processDeliveryReport(w.deps, { token: "topsecret", fields: { id: "ATXid_one", status: "Failed", failureReason: "UserInBlacklist", phoneNumber: "0999123456" } }, hours(T0, 0.2));
  check("Failed applied after in-progress", res.body.state, "UNDELIVERED");
  check("failure reason stored", w.rows.get("r1")?.failureReason, "UserInBlacklist");

  // authentication happens first
  w = world([{ id: "r1", messageId: "ATXid_one" }]);
  res = await processDeliveryReport(w.deps, { token: "wrong", fields: good.fields }, T0);
  check("wrong token: 401", res.httpStatus, 401);
  check("wrong token: nothing written", w.writes, 0);
  res = await processDeliveryReport(w.deps, { token: null, fields: good.fields }, T0);
  check("no token: 401", res.httpStatus, 401);
  res = await processDeliveryReport(w.deps, { token: "", fields: good.fields }, T0);
  check("empty token: 401", res.httpStatus, 401);
  w = world([{ id: "r1", messageId: "ATXid_one" }], "");
  res = await processDeliveryReport(w.deps, { token: "", fields: good.fields }, T0);
  check("no secret configured: 503 even with an empty token", res.httpStatus, 503);
  check("no secret configured: nothing written", w.writes, 0);
  res = await processDeliveryReport(w.deps, { token: null, fields: good.fields }, T0);
  check("no secret configured: 503", res.httpStatus, 503);

  // unknown / bad / mismatched
  w = world([{ id: "r1", messageId: "ATXid_one" }]);
  res = await processDeliveryReport(w.deps, { token: "topsecret", fields: { id: "ATXid_other", status: "Success" } }, T0);
  check("unknown id: 404", res.httpStatus, 404);
  res = await processDeliveryReport(w.deps, { token: "topsecret", fields: { status: "Success" } }, T0);
  check("no id: 400", res.httpStatus, 400);
  res = await processDeliveryReport(w.deps, { token: "topsecret", fields: { id: "ATXid_one", status: "Teleported" } }, T0);
  check("unknown status: 400", res.httpStatus, 400);
  check("unknown status: nothing written", w.writes, 0);
  res = await processDeliveryReport(w.deps, { token: "topsecret", fields: { id: "ATXid_one", status: "Success", phoneNumber: "+265888999000" } }, T0);
  check("report for another number: 409", res.httpStatus, 409);
  check("report for another number: row untouched", w.rows.get("r1")?.deliveryState, null);
  res = await processDeliveryReport(w.deps, { token: "topsecret", fields: { id: "ATXid_one", status: "Success" } }, T0);
  check("report without a number is accepted", res.body.applied, true);

  // only an Africa's Talking SMS row can be changed
  w = world([
    { id: "e1", messageId: "ATXid_mail", channel: "EMAIL", providerName: "resend" },
    { id: "s1", messageId: "ATXid_mail2", providerName: "console" },
  ]);
  res = await processDeliveryReport(w.deps, { token: "topsecret", fields: { id: "ATXid_mail", status: "Success" } }, T0);
  check("email row cannot be touched", res.httpStatus, 404);
  res = await processDeliveryReport(w.deps, { token: "topsecret", fields: { id: "ATXid_mail2", status: "Success" } }, T0);
  check("console row cannot be touched", res.httpStatus, 404);

  // two reports racing: the loser re-reads and decides again
  w = world([{ id: "r1", messageId: "ATXid_one" }]);
  let raced = false;
  w.beforeApply = () => {
    if (!raced) {
      raced = true;
      // another request lands "Success" between our read and our write
      const r = w.rows.get("r1")!;
      r.deliveryState = "DELIVERED";
      r.reportedAt = T0;
    }
  };
  res = await processDeliveryReport(w.deps, { token: "topsecret", fields: { id: "ATXid_one", status: "Sent" } }, hours(T0, 1));
  check("race: late Sent loses to Success", res.body.applied, false);
  check("race: reason is stale", res.body.why, "stale");
  check("race: row is DELIVERED", w.rows.get("r1")?.deliveryState, "DELIVERED");

  // race that keeps losing gives up quietly
  w = world([{ id: "r1", messageId: "ATXid_one" }]);
  const alt: DeliveryState[] = ["IN_PROGRESS"];
  w.beforeApply = () => {
    // every attempt finds the state changed under it, but never to something final
    const r = w.rows.get("r1")!;
    r.deliveryState = r.deliveryState === null ? "IN_PROGRESS" : null;
  };
  void alt;
  res = await processDeliveryReport(w.deps, { token: "topsecret", fields: { id: "ATXid_one", status: "Success" } }, T0);
  check("endless race: 200, not applied", res.httpStatus === 200 && res.body.applied === false, true);
  check("endless race: says concurrent", res.body.why, "concurrent");

  // a row deleted mid-flight
  w = world([{ id: "r1", messageId: "ATXid_one" }]);
  w.beforeApply = () => {
    w.rows.delete("r1");
  };
  res = await processDeliveryReport(w.deps, good, T0);
  check("row deleted mid-flight: 404", res.httpStatus, 404);

  // ---------------------------------------------------------------- what the page shows
  const baseRow = {
    channel: "SMS",
    status: "SENT",
    providerName: "africastalking",
    providerMessageId: "ATXid_one",
    deliveryState: null as string | null,
    deliveryReportedAt: null as Date | null,
    deliveryFailureReason: null as string | null,
    createdAt: T0,
  };
  const on = { reportsEnabled: true, now: hours(T0, 1) };
  check("email row: nothing", describeDeliveryState({ ...baseRow, channel: "EMAIL", providerName: "resend" }, on), null);
  check("console SMS: nothing", describeDeliveryState({ ...baseRow, providerName: "console", status: "LOGGED" }, on), null);
  check("failed SMS: nothing (it has its own error line)", describeDeliveryState({ ...baseRow, status: "FAILED" }, on), null);
  let v = describeDeliveryState({ ...baseRow, deliveryState: "DELIVERED", deliveryReportedAt: hours(T0, 0.5) }, on);
  check("delivered tone", v?.tone, "good");
  has("delivered text", v?.text, "Delivered");
  check("delivered time carried", v?.at?.toISOString(), hours(T0, 0.5).toISOString());
  v = describeDeliveryState({ ...baseRow, deliveryState: "IN_PROGRESS" }, on);
  check("in progress tone", v?.tone, "info");
  v = describeDeliveryState({ ...baseRow, deliveryState: "UNDELIVERED", deliveryFailureReason: "AbsentSubscriber" }, on);
  check("undelivered tone", v?.tone, "bad");
  has("undelivered says why", v?.text, "switched off");
  v = describeDeliveryState({ ...baseRow, deliveryState: "UNDELIVERED", deliveryFailureReason: null }, on);
  has("undelivered without reason says so", v?.text, "no reason");
  v = describeDeliveryState({ ...baseRow, deliveryState: "DELIVERED" }, { reportsEnabled: false, now: hours(T0, 1) });
  check("a recorded state still shows if reports were switched off since", v?.tone, "good");
  v = describeDeliveryState(baseRow, on);
  check("no report yet, fresh: waiting", v?.tone, "muted");
  v = describeDeliveryState(baseRow, { reportsEnabled: true, now: hours(T0, NO_REPORT_AFTER_HOURS - 0.01) });
  check("just under the limit: still waiting", v?.tone, "muted");
  v = describeDeliveryState(baseRow, { reportsEnabled: true, now: hours(T0, NO_REPORT_AFTER_HOURS) });
  check("at the limit: warns", v?.tone, "warn");
  has("warning names the callback", v?.text, "callback");
  check("reports off and no report: nothing", describeDeliveryState(baseRow, { reportsEnabled: false, now: hours(T0, 100) }), null);
  check("no message id (unconfirmed send): nothing", describeDeliveryState({ ...baseRow, providerMessageId: null }, { reportsEnabled: true, now: hours(T0, 100) }), null);

  // ---------------------------------------------------------------- manual retry of an undelivered text
  const sent = { status: "SENT", businessId: "biz1", providerName: "africastalking", errorMessage: null as string | null, retriedAt: null as Date | null };
  check("plain SENT still not retryable", checkManualRetry(sent).ok, false);
  check("SENT + in progress not retryable", checkManualRetry({ ...sent, deliveryState: "IN_PROGRESS" }).ok, false);
  check("SENT + delivered not retryable", checkManualRetry({ ...sent, deliveryState: "DELIVERED" }).ok, false);
  check("SENT + undelivered (network) retryable", checkManualRetry({ ...sent, deliveryState: "UNDELIVERED", deliveryFailureReason: "NetworkError" }).ok, true);
  check("SENT + undelivered (account) retryable", checkManualRetry({ ...sent, deliveryState: "UNDELIVERED", deliveryFailureReason: "InsufficientBalance" }).ok, true);
  check("SENT + undelivered (no reason) retryable", checkManualRetry({ ...sent, deliveryState: "UNDELIVERED" }).ok, true);
  const refused = checkManualRetry({ ...sent, deliveryState: "UNDELIVERED", deliveryFailureReason: "UserInBlacklist" });
  check("SENT + undelivered (opted out) refused", refused.ok, false);
  if (!refused.ok) has("refusal says why", refused.message, "opted out");
  check(
    "undelivered but already retried refused",
    checkManualRetry({ ...sent, deliveryState: "UNDELIVERED", deliveryFailureReason: "NetworkError", retriedAt: T0 }).ok,
    false
  );
  check(
    "undelivered with no business refused",
    checkManualRetry({ ...sent, businessId: null, deliveryState: "UNDELIVERED", deliveryFailureReason: "NetworkError" }).ok,
    false
  );
  // Module 75 behaviour is unchanged
  const failedRow = { status: "FAILED", businessId: "biz1", providerName: "africastalking", errorMessage: "Africa's Talking returned HTTP 503: down", retriedAt: null as Date | null };
  check("FAILED transient still retryable", checkManualRetry(failedRow).ok, true);
  check("FAILED refused number still refused", checkManualRetry({ ...failedRow, providerName: "phone-check" }).ok, false);
  check("FAILED already retried still refused", checkManualRetry({ ...failedRow, retriedAt: T0 }).ok, false);
  const wording = checkManualRetry({ ...sent });
  if (!wording.ok) has("message names both cases", wording.message, "undelivered");

  // retry state shown for an undelivered row
  const rs = { nextRetryAt: null as Date | null, retriedAt: null as Date | null, retryNote: null as string | null };
  check("undelivered, not retried: no retry line", describeRetryState({ ...rs, status: "SENT", deliveryState: "UNDELIVERED" }), null);
  check(
    "undelivered, retried: points at the newer attempt",
    describeRetryState({ ...rs, status: "SENT", deliveryState: "UNDELIVERED", retriedAt: T0 })?.kind,
    "RETRIED"
  );
  check("plain SENT: no retry line", describeRetryState({ ...rs, status: "SENT", retriedAt: T0 }), null);
  check("delivered: no retry line", describeRetryState({ ...rs, status: "SENT", deliveryState: "DELIVERED", retriedAt: T0 }), null);

  console.log(failed === 0 ? `OK - ${total} checks passed` : `${failed} of ${total} checks FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
