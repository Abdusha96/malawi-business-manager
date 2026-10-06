/**
 * Module 42: standalone checks for Period Close. No database, no framework:
 *   npx tsx scripts/verify-period-close.ts   (npm run verify:period)
 * Exits non-zero if any check fails.
 *
 * Covers the pure rules (src/lib/period-lock.ts), the general ledger choke point and the record
 * guard against a fake transaction, permissions and the request schema. It does NOT exercise
 * Postgres: the Business row lock that serialises a close against a posting is described in the
 * README, with a manual two-request test.
 */
import {
  isRealYmd, dayAfter, previousDay, monthEndYmd, isDayClosed, isInstantClosed, closedPeriodMessage,
  checkRecordDate, planClosedThroughChange, closePresets, EARLIEST_CLOSE_DATE,
} from "../src/lib/period-lock";
import { postJournalEntry, PeriodClosedError, AccountingError } from "../src/lib/accounting";
import { assertRecordDateOpen } from "../src/lib/period-close";
import { periodCloseSchema } from "../src/lib/validation";
import { DEFAULT_ROLE_PERMISSIONS } from "../src/lib/permissions";

let failed = 0, total = 0;
function check(name: string, actual: unknown, expected: unknown) {
  total++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}
async function rejects(name: string, fn: () => Promise<unknown>, cls: new (...a: any[]) => Error) {
  total++;
  try { await fn(); failed++; console.error(`FAIL ${name}: did not throw`); }
  catch (e) { if (!(e instanceof cls)) { failed++; console.error(`FAIL ${name}: threw ${(e as Error).name}`); } }
}

// ---- 1. Calendar helpers
check("real date", isRealYmd("2026-03-31"), true);
check("Feb 31 is not real", isRealYmd("2026-02-31"), false);
check("leap day real in 2028", isRealYmd("2028-02-29"), true);
check("leap day not real in 2027", isRealYmd("2027-02-29"), false);
check("wrong shape", [isRealYmd("2026-3-1"), isRealYmd(""), isRealYmd(null), isRealYmd(20260331)], [false, false, false, false]);
check("dayAfter month end", dayAfter("2026-03-31"), "2026-04-01");
check("dayAfter year end", dayAfter("2026-12-31"), "2027-01-01");
check("dayAfter leap", dayAfter("2028-02-28"), "2028-02-29");
check("previousDay", [previousDay("2026-03-01"), previousDay("2027-01-01")], ["2026-02-28", "2026-12-31"]);
check("monthEndYmd", [monthEndYmd("2026-02"), monthEndYmd("2028-02"), monthEndYmd("2026-12")], ["2026-02-28", "2028-02-29", "2026-12-31"]);

// ---- 2. Closed-day test
check("null closes nothing", [isDayClosed(null, "2000-01-01"), isDayClosed(undefined, "2026-01-01")], [false, false]);
check("boundary day is closed", isDayClosed("2026-03-31", "2026-03-31"), true);
check("day after is open", isDayClosed("2026-03-31", "2026-04-01"), false);
check("earlier day is closed", isDayClosed("2026-03-31", "2025-12-31"), true);

// 22:30 UTC on 31 Mar is already 1 April in Blantyre (UTC+2): the calendar day decides, not the instant.
const lateMar31Utc = new Date("2026-03-31T22:30:00Z");
check("Blantyre sees 1 April, so open", isInstantClosed("2026-03-31", lateMar31Utc, "Africa/Blantyre"), false);
check("UTC sees 31 March, so closed", isInstantClosed("2026-03-31", lateMar31Utc, "UTC"), true);
check("UTC midnight pick is the same day in Blantyre", isInstantClosed("2026-03-31", new Date("2026-03-31T00:00:00Z"), "Africa/Blantyre"), true);

// ---- 3. Messages
const dateMsg = closedPeriodMessage({ what: "this expense", day: "2026-03-15", closedThrough: "2026-03-31", mode: "date" });
check("date message names the first open day", dateMsg.includes("2026-04-01") && dateMsg.startsWith("This expense is dated 2026-03-15"), true);
const changeMsg = closedPeriodMessage({ what: "sale SALE-000001", day: "2026-03-15", closedThrough: "2026-03-31", mode: "change" });
check("change message capitalises and points to the Owner", changeMsg.startsWith("Sale SALE-000001") && changeMsg.includes("Owner"), true);
check("post message", closedPeriodMessage({ what: "the depreciation for 2026-03", day: "2026-03-31", closedThrough: "2026-03-31", mode: "post" }).includes("Nothing can be posted"), true);
check("checkRecordDate open returns null", checkRecordDate({ closedThrough: "2026-03-31", instant: new Date("2026-04-02T10:00:00Z"), tz: "Africa/Blantyre", what: "x", mode: "date" }), null);
check("checkRecordDate missing date returns null", checkRecordDate({ closedThrough: "2026-03-31", instant: null, tz: "UTC", what: "x", mode: "date" }), null);
check("checkRecordDate no lock returns null", checkRecordDate({ closedThrough: null, instant: new Date("2001-01-01"), tz: "UTC", what: "x", mode: "date" }), null);
check("checkRecordDate closed returns text", typeof checkRecordDate({ closedThrough: "2026-03-31", instant: new Date("2026-03-10T10:00:00Z"), tz: "UTC", what: "x", mode: "date" }), "string");

// ---- 4. Planning a change
const T = "2026-09-21";
check("first close", planClosedThroughChange({ current: null, requested: "2026-08-31", today: T }), { ok: true, action: "close", from: null, to: "2026-08-31" });
check("advance", planClosedThroughChange({ current: "2026-07-31", requested: "2026-08-31", today: T }), { ok: true, action: "close", from: "2026-07-31", to: "2026-08-31" });
check("move back is a reopen", planClosedThroughChange({ current: "2026-08-31", requested: "2026-06-30", today: T }), { ok: true, action: "reopen", from: "2026-08-31", to: "2026-06-30" });
check("null reopens all", planClosedThroughChange({ current: "2026-08-31", requested: null, today: T }), { ok: true, action: "reopen", from: "2026-08-31", to: null });
check("null when already open refused", planClosedThroughChange({ current: null, requested: null, today: T }).ok, false);
check("same day refused", planClosedThroughChange({ current: "2026-08-31", requested: "2026-08-31", today: T }).ok, false);
check("today refused", planClosedThroughChange({ current: null, requested: T, today: T }).ok, false);
check("future refused", planClosedThroughChange({ current: null, requested: "2027-01-01", today: T }).ok, false);
check("yesterday allowed", planClosedThroughChange({ current: null, requested: "2026-09-20", today: T }).ok, true);
check("unreal date refused", planClosedThroughChange({ current: null, requested: "2026-02-31", today: T }).ok, false);
check("before earliest refused", planClosedThroughChange({ current: null, requested: "1999-12-31", today: T }).ok, false);
check("refusal names latest closable day", (planClosedThroughChange({ current: null, requested: T, today: T }) as any).error.includes("2026-09-20"), true);
check("earliest constant", EARLIEST_CLOSE_DATE, "2000-01-01");

// ---- 5. Presets
const now = new Date("2026-09-21T09:00:00Z");
const p = closePresets({ financialYearStartMonth: 1, tz: "Africa/Blantyre", now });
check("January year presets", p.map((x) => [x.key, x.date]), [["last-month", "2026-08-31"], ["last-quarter", "2026-06-30"], ["last-year", "2025-12-31"]]);
const p2 = closePresets({ financialYearStartMonth: 7, tz: "Africa/Blantyre", now });
check("July year presets", p2.map((x) => [x.key, x.date]), [["last-month", "2026-08-31"], ["last-quarter", "2026-09-30" > "2026-09-20" ? "2026-06-30" : ""], ["last-year", "2026-06-30"]]);
check("every preset is closable", [...p, ...p2].every((x) => planClosedThroughChange({ current: null, requested: x.date, today: "2026-09-21" }).ok), true);
const early = closePresets({ financialYearStartMonth: 1, tz: "Africa/Blantyre", now: new Date("2026-01-03T09:00:00Z") });
check("early January: last month is December, last year is 2025", [early[0].date, early[early.length - 1].date], ["2025-12-31", "2025-12-31"]);

async function asyncChecks() {
// ---- 6. General ledger choke point (fake transaction)
function fakeTx(over: Record<string, unknown> = {}) {
  const created: any[] = [];
  const tx: any = {
    business: {
      update: async () => ({ journalEntryPrefix: "JE", nextJournalEntryNumber: 2, booksClosedThrough: "2026-03-31", timezone: "Africa/Blantyre", ...over }),
    },
    journalEntry: { create: async (a: any) => { created.push(a); return { ...a.data, entryNumber: "JE-000001", lines: [] }; } },
  };
  return { tx, created };
}
const lines = [{ accountId: "a", debit: 10 }, { accountId: "b", credit: 10 }];
const base = { businessId: "b1", description: "t", lines, createdById: "u" };

{
  const { tx, created } = fakeTx();
  await postJournalEntry({ ...base, tx, entryDate: new Date("2026-04-02T08:00:00Z") });
  check("entry after the lock posts", created.length, 1);
}
{
  const { tx, created } = fakeTx();
  await rejects("entry on a closed day refused", () => postJournalEntry({ ...base, tx, entryDate: new Date("2026-03-15T08:00:00Z") }), PeriodClosedError);
  check("nothing written when refused", created.length, 0);
}
{
  const { tx } = fakeTx();
  await rejects("PeriodClosedError is an AccountingError", () => postJournalEntry({ ...base, tx, entryDate: new Date("2026-03-31T08:00:00Z") }), AccountingError);
}
{
  const { tx, created } = fakeTx();
  await postJournalEntry({ ...base, tx });
  check("undated entry (dated now) is never checked", created.length, 1);
}
{
  const { tx, created } = fakeTx({ booksClosedThrough: null });
  await postJournalEntry({ ...base, tx, entryDate: new Date("2001-01-01T00:00:00Z") });
  check("no lock, any date posts", created.length, 1);
}
{
  // A fake that predates the field (undefined) behaves as open, so older verify scripts keep working.
  const { tx, created } = fakeTx({ booksClosedThrough: undefined });
  await postJournalEntry({ ...base, tx, entryDate: new Date("2010-01-01T00:00:00Z") });
  check("undefined lock is open", created.length, 1);
}
{
  const { tx } = fakeTx({ timezone: "Africa/Accra" });
  await rejects("zone decides the day: 22:30 UTC 31 March is closed in Accra (UTC+0)", () => postJournalEntry({ ...base, tx, entryDate: lateMar31Utc }), PeriodClosedError);
}
{
  const { tx, created } = fakeTx();
  await postJournalEntry({ ...base, tx, entryDate: lateMar31Utc });
  check("same instant is 1 April in Blantyre so it posts", created.length, 1);
}

// ---- 7. Record guard (fake transaction)
function guardTx(closedThrough: string | null) {
  return { business: { update: async () => ({ booksClosedThrough: closedThrough, timezone: "Africa/Blantyre" }) } } as any;
}
const guard = (closedThrough: string | null, instant: Date | null, mode: "date" | "change" | "post" = "change") =>
  assertRecordDateOpen({ tx: guardTx(closedThrough), businessId: "b1", instant, what: "this sale", mode });
await rejects("closed record refused", () => guard("2026-03-31", new Date("2026-03-10T10:00:00Z")), PeriodClosedError);
await guard("2026-03-31", new Date("2026-04-10T10:00:00Z")); total++;
await guard(null, new Date("2010-01-01T00:00:00Z")); total++;
await guard("2026-03-31", null); total++;
await rejects("closed boundary day refused", () => guard("2026-03-31", new Date("2026-03-31T20:00:00Z"), "date"), PeriodClosedError);

}

// ---- 8. Permissions and schema
check("Accountant can close", DEFAULT_ROLE_PERMISSIONS.ACCOUNTANT.includes("accounting.manage"), true);
check("Owner can reopen", DEFAULT_ROLE_PERMISSIONS.OWNER.includes("business.settings.manage"), true);
check("Accountant cannot reopen", DEFAULT_ROLE_PERMISSIONS.ACCOUNTANT.includes("business.settings.manage"), false);
check("Manager cannot close", DEFAULT_ROLE_PERMISSIONS.MANAGER.includes("accounting.manage"), false);
check("Cashier cannot close", DEFAULT_ROLE_PERMISSIONS.CASHIER.includes("accounting.manage"), false);
check("schema: date", periodCloseSchema.safeParse({ closedThrough: "2026-03-31" }).success, true);
check("schema: null reopens", periodCloseSchema.safeParse({ closedThrough: null, reason: "x" }).success, true);
check("schema: missing field", periodCloseSchema.safeParse({}).success, false);
check("schema: bad shape", periodCloseSchema.safeParse({ closedThrough: "31/03/2026" }).success, false);
check("schema: long reason", periodCloseSchema.safeParse({ closedThrough: null, reason: "x".repeat(501) }).success, false);

asyncChecks().then(() => {
  console.log(`${total - failed}/${total} checks passed`);
  // Exit explicitly: importing accounting.ts creates a PrismaClient, and this script never queries it.
  process.exit(failed > 0 ? 1 : 0);
});
