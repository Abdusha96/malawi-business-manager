/**
 * Module 72: standalone checks for phone-number normalisation.
 *   npx tsx scripts/verify-phone.ts   (npm run verify:phone)
 * No database, no network. Exits non-zero on any failure.
 */
import {
  normalizePhoneNumber,
  describePhoneForSms,
  classifyMalawiNumber,
  checkSmsDeliverable,
  preparePhoneForSave,
  planPhoneRewrite,
} from "../src/lib/phone";
import { runPhoneBackfill, PhoneStore } from "../src/lib/phone-backfill";
import { buildSupplierPaymentMessage, buildEmployeePayMessage } from "../src/lib/party-messages";

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
const e164 = (s: string | null | undefined) => {
  const r = normalizePhoneNumber(s);
  return r.ok ? r.e164 : null;
};

// Malawi, every way people write it
const mw = [
  "0999123456", "0999 123 456", "099-912-3456", "0999.123.456", "(0999) 123456",
  "999123456", "999 123 456", "265999123456", "265 999 123 456",
  "+265999123456", "+265 999 123 456", "+265-999-123-456",
  "00265999123456", "00 265 999 123 456",
  "+265 (0) 999 123 456", "+2650999123456", "2650999123456",
  "  0999123456  ",
];
for (const s of mw) check(`malawi ${JSON.stringify(s)}`, e164(s), "+265999123456");
check("0888 prefix", e164("0888 765 432"), "+265888765432");

// flags
const a = normalizePhoneNumber("+265999123456");
check("canonical unchanged", a.ok && a.changed, false);
const b = normalizePhoneNumber("0999123456");
check("local changed, not assumed", b.ok && [b.changed, b.assumedMalawi, b.foreign], [true, false, false]);
const c = normalizePhoneNumber("999123456");
check("bare 9 digits assumed Malawi", c.ok && [c.changed, c.assumedMalawi], [true, true]);

// foreign passes through, length-checked
check("+27 SA", e164("+27 82 123 4567"), "+27821234567");
check("0027 SA", e164("0027821234567"), "+27821234567");
const f = normalizePhoneNumber("+254712345678");
check("foreign flag", f.ok && f.foreign, true);
check("too short intl", e164("+1234"), null);
check("too long intl", e164("+1234567890123456"), null);
check("intl leading zero", e164("+0123456789"), null);

// refusals
for (const s of ["", "   ", null, undefined, "abc", "0999 12x 456", "0999123456 ext 5", "0999-123-456+7", "+", "0", "12345",
  "099912345", "09991234567", "265999", "26599912345678", "+265 99912345", "+265 0999123456789"]) {
  check(`refuse ${JSON.stringify(s)}`, e164(s as string), null);
}

// several numbers in one field
for (const s of ["0999123456 / 0888765432", "0999123456, 0888765432", "0999123456; 0888765432",
  "0999123456 or 0888765432", "0999123456 and 0888765432", "0999123456 & 0888765432", "0999123456\n0888765432"]) {
  const r = normalizePhoneNumber(s);
  check(`multi ${JSON.stringify(s)}`, !r.ok && r.reason.includes("more than one number"), true);
}

// 9-digit number that starts 265 is a bare national number, not a country code
check("265-prefixed 9 digits", e164("265123456"), "+265265123456");
// 9 digits after +265 with a zero start is refused
check("+265 then 0 + 8", e164("+265 099912345"), null);

// reasons are plain, single sentences
const r1 = normalizePhoneNumber("12345");
check("reason mentions digits", !r1.ok && r1.reason.includes("5 digits"), true);
const r2 = normalizePhoneNumber("099912345");
check("reason mentions 10 digits", !r2.ok && r2.reason.includes("10 digits"), true);

// idempotent
for (const s of mw) {
  const once = e164(s)!;
  check(`idempotent ${s}`, e164(once), once);
}

// describePhoneForSms
check("describe empty", describePhoneForSms(""), null);
check("describe null", describePhoneForSms(null), null);
check("describe canonical", describePhoneForSms("+265999123456"), { level: "ok", text: "Texts will go to +265999123456 (Airtel)." });
check("describe local", describePhoneForSms("0999123456"), { level: "ok", text: "Texts will go to +265999123456 (Airtel)." });
check("describe bare", describePhoneForSms("999123456"), { level: "ok", text: "Texts will go to +265999123456 (Airtel) (read as a Malawian number)." });
const w = describePhoneForSms("nope");
check("describe bad", w && w.level, "warn");
check("describe bad text", w && w.text.startsWith("Cannot be texted: "), true);

// ---------------------------------------------------------------------------
// Line type and operator
// ---------------------------------------------------------------------------
const lt = (s: string) => {
  const r = normalizePhoneNumber(s);
  return r.ok ? [r.e164, r.lineType, r.operator] : null;
};
check("TNM 88", lt("0881234567"), ["+265881234567", "MOBILE", "TNM"]);
check("TNM 89", lt("0891234567"), ["+265891234567", "MOBILE", "TNM"]);
check("Airtel 99", lt("0991234567"), ["+265991234567", "MOBILE", "Airtel"]);
check("Airtel 98", lt("0981234567"), ["+265981234567", "MOBILE", "Airtel"]);
check("77 mobile no operator", lt("0771234567"), ["+265771234567", "MOBILE", null]);
check("31 VoIP unknown", lt("0311234567"), ["+265311234567", "UNKNOWN", null]);
check("22 unknown", lt("0221234567"), ["+265221234567", "UNKNOWN", null]);
check("Access 21 landline", lt("0211234567"), ["+265211234567", "LANDLINE", null]);
check("MTL landline short 01771234", lt("01771234"), ["+2651771234", "LANDLINE", null]);
check("MTL landline +265 1 771 234", lt("+265 1 771 234"), ["+2651771234", "LANDLINE", null]);
check("MTL landline 265 form", lt("2651771234"), ["+2651771234", "LANDLINE", null]);
check("MTL landline +265 (0) 1 771 234", lt("+265 (0) 1 771 234"), ["+2651771234", "LANDLINE", null]);
check("MTL migrated 9-digit 111", lt("0111234567"), ["+265111234567", "LANDLINE", null]);
check("foreign is UNKNOWN", lt("+27821234567"), ["+27821234567", "UNKNOWN", null]);
check("classify bare", classifyMalawiNumber("991234567"), { lineType: "MOBILE", operator: "Airtel" });
// a 7-digit number that does NOT start with 1 is not a landline shape
check("7 digits not starting 1 refused", lt("02771234"), null);
// a bare 7-digit number is ambiguous and refused
check("bare 7 digits refused", lt("1771234"), null);

// SMS deliverability: landline refused, mobile/unknown allowed
const dl = checkSmsDeliverable("0177 1234");
check("landline not deliverable", !dl.ok && dl.reason.includes("landline"), true);
check("mobile deliverable", checkSmsDeliverable("0999123456").ok, true);
check("unknown prefix deliverable", checkSmsDeliverable("0311234567").ok, true);
check("foreign deliverable", checkSmsDeliverable("+27821234567").ok, true);
check("unreadable not deliverable", checkSmsDeliverable("abc").ok, false);
const dld = describePhoneForSms("01771234");
check("describe landline warns", dld && dld.level, "warn");
check("describe landline text", dld && dld.text.includes("landline"), true);
check("describe mobile operator", describePhoneForSms("0881234567"), { level: "ok", text: "Texts will go to +265881234567 (TNM)." });

// ---------------------------------------------------------------------------
// preparePhoneForSave: what gets stored
// ---------------------------------------------------------------------------
check("save blank -> null", preparePhoneForSave("   "), { ok: true, value: null });
check("save null -> null", preparePhoneForSave(null), { ok: true, value: null });
check("save local -> canonical", preparePhoneForSave("0999 123 456"), { ok: true, value: "+265999123456" });
check("save landline stored", preparePhoneForSave("01 771 234"), { ok: true, value: "+2651771234" });
check("save foreign stored", preparePhoneForSave("+27 82 123 4567"), { ok: true, value: "+27821234567" });
const sb = preparePhoneForSave("0999123456 / 0888765432");
check("save multi refused", !sb.ok && sb.reason.includes("more than one number"), true);
check("save junk refused", preparePhoneForSave("call me").ok, false);
// unchanged legacy value is kept so editing other fields is never blocked
check("save unchanged legacy kept", preparePhoneForSave("0999123456 / 0888765432", "0999123456 / 0888765432"), {
  ok: true,
  value: "0999123456 / 0888765432",
});
check("save changed legacy rewritten", preparePhoneForSave("0999123456", "0999 123 456"), { ok: true, value: "+265999123456" });
check("save clearing stored phone -> null", preparePhoneForSave("", "0999123456"), { ok: true, value: null });

// ---------------------------------------------------------------------------
// planPhoneRewrite: the backfill decision
// ---------------------------------------------------------------------------
check("plan empty", planPhoneRewrite(""), { action: "keep", reason: "empty" });
check("plan null", planPhoneRewrite(null), { action: "keep", reason: "empty" });
check("plan canonical", planPhoneRewrite("+265999123456"), { action: "keep", reason: "already_canonical" });
check("plan rewrite local", planPhoneRewrite("0999123456"), { action: "rewrite", to: "+265999123456" });
check("plan rewrite legacy spaced", planPhoneRewrite("+265999 123 456"), { action: "rewrite", to: "+265999123456" });
check("plan rewrite padded canonical", planPhoneRewrite(" +265999123456 "), { action: "rewrite", to: "+265999123456" });
const pu = planPhoneRewrite("0999123456 / 0888765432");
check("plan unreadable reported", pu.action, "unreadable");
check("plan landline rewritten", planPhoneRewrite("01771234"), { action: "rewrite", to: "+2651771234" });
// running the plan's own output through the plan again changes nothing (safe to re-run)
for (const v of ["0999123456", "+265999 123 456", "265999123456", "01771234", "+27 82 123 4567"]) {
  const first = planPhoneRewrite(v);
  if (first.action === "rewrite") check(`plan re-run ${v}`, planPhoneRewrite(first.to), { action: "keep", reason: "already_canonical" });
}

// ---------------------------------------------------------------------------
// SMS wording for suppliers and employees
// ---------------------------------------------------------------------------
check(
  "supplier message with balance",
  buildSupplierPaymentMessage({
    supplierName: "Shoprite Ltd",
    businessName: "Mzuzu Traders",
    amount: 50000,
    method: "MOBILE_MONEY",
    dateText: "30 Sep 2026",
    reference: "MM123",
    balanceOwed: 20000,
  }),
  "Hello Shoprite Ltd, Mzuzu Traders has paid you MWK 50,000 by mobile money on 30 Sep 2026 (ref MM123). MWK 20,000 is still owed to you."
);
check(
  "supplier message settled, no ref",
  buildSupplierPaymentMessage({
    supplierName: "A",
    businessName: "B",
    amount: 1250.5,
    method: "CASH",
    dateText: "1 Oct 2026",
    reference: "  ",
    balanceOwed: 0,
  }),
  "Hello A, B has paid you MWK 1,250.5 by cash on 1 Oct 2026. Nothing further is owed to you."
);
check(
  "employee message",
  buildEmployeePayMessage({ employeeName: "Grace Banda", businessName: "Mzuzu Traders", payPeriod: "2026-09", netSalary: 180000, method: "BANK_TRANSFER" }),
  "Hello Grace Banda, your pay for 2026-09 from Mzuzu Traders has been paid by bank transfer: net MWK 180,000."
);
check(
  "employee message no method",
  buildEmployeePayMessage({ employeeName: "G", businessName: "B", payPeriod: "2026-09", netSalary: 100 }),
  "Hello G, your pay for 2026-09 from B has been paid: net MWK 100."
);

// ---------------------------------------------------------------------------
// Backfill run against in-memory stores
// ---------------------------------------------------------------------------
function memStore(label: string, data: Record<string, string | null>, unique = false): PhoneStore & { data: Record<string, string | null> } {
  return {
    label,
    unique,
    data,
    load: async () => Object.entries(data).map(([id, phone]) => ({ id, phone })),
    write: async (id, phone) => {
      data[id] = phone;
    },
  };
}

async function backfillChecks() {
  const users = memStore(
    "User",
    {
      u1: "0999123456", //          -> rewrite
      u2: "+265888765432", //       already canonical
      u3: null, //                  empty
      u4: "0888 765 432", //        would collide with u2's number -> skipped
      u5: "0995 000 111", //        -> rewrite
      u6: "+265995000111 ", //      same number as u5 after cleaning -> second claimant skipped (whichever runs second)
      u7: "0999 123 456 / 0881", // unreadable, untouched
    },
    true
  );
  const customers = memStore("Customer", { c1: "0999123456", c2: "0999123456", c3: "abc", c4: "01771234" });

  const dry = await runPhoneBackfill([users, customers], false);
  check("dry run changes nothing (users)", users.data.u1, "0999123456");
  check("dry run changes nothing (customers)", customers.data.c1, "0999123456");
  check("dry run counts rewrites", dry.rewritten, 5); // u1, u5 + c1, c2, c4

  const applied = await runPhoneBackfill([users, customers], true);
  check("apply rewrites user", users.data.u1, "+265999123456");
  check("apply leaves canonical", users.data.u2, "+265888765432");
  check("apply leaves empty", users.data.u3, null);
  check("unique collision skipped", users.data.u4, "0888 765 432");
  check("unreadable untouched", users.data.u7, "0999 123 456 / 0881");
  check("one of u5/u6 claimed the number", [users.data.u5, users.data.u6].filter((v) => v === "+265995000111").length, 1);
  check("the other was skipped", applied.skippedCollisions, 2); // u4, plus whichever of u5/u6 came second
  check("non-unique stores allow duplicates", [customers.data.c1, customers.data.c2], ["+265999123456", "+265999123456"]);
  check("landline customer rewritten", customers.data.c4, "+2651771234");
  check("unreadable reported", applied.unreadable.map((u) => `${u.label}:${u.id}`).sort(), ["Customer:c3", "User:u7"]);

  // second run: nothing left to rewrite (u4 and the collision loser stay skipped)
  const again = await runPhoneBackfill([users, customers], true);
  check("re-run rewrites nothing", again.rewritten, 0);
}

backfillChecks().then(() => {
  console.log(`${total - failed}/${total} checks passed`);
  if (failed) process.exit(1);
});
