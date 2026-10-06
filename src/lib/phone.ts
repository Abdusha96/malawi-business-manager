/**
 * Module 72 – turning a phone number as someone typed it into one an SMS
 * gateway will accept.
 *
 * Why this exists: customers and suppliers keep their phone as free text
 * ("0999 123 456", "099-123-4567", "265999123456", "+265 (0) 999 123 456").
 * Until now `sendSms()` handed that text to Africa's Talking untouched, and
 * anything but strict international format (+265999123456) came back as
 * InvalidPhoneNumber. Since Module 71 that refusal is visible, which made the
 * gap obvious: the most common way a Malawian writes a number (leading 0) was
 * the one most likely to fail.
 *
 * PURE and import-free on purpose (same split as sms-delivery.ts and
 * bank-statement-csv.ts): `notifications.ts` imports Prisma at module scope, so
 * anything a plain-Node verify script or a "use client" form must run lives in
 * its own file.
 *
 * Rules, in the order they are applied:
 *   1. Blank = no number.
 *   2. More than one number in the field ("0999... / 0888...", "a, b", "a or
 *      b") is REFUSED, never guessed: sendSms() dials exactly one number, and
 *      picking the first could text the wrong phone. The message says to keep
 *      one number in the field.
 *   3. Only digits, spaces, dashes, dots, brackets and a single leading "+"
 *      are allowed. Anything else (letters, "ext 5") is refused rather than
 *      silently dropped, because dropping characters changes which number it is.
 *   4. Malawi (country code 265, nine digits after it) is understood in every
 *      form people actually write: 0999123456, 999123456, 265999123456,
 *      +265999123456, 00265999123456, and the "+265 (0)999..." form with the
 *      trunk zero left in.
 *   5. A "+" or "00" number with a DIFFERENT country code passes through as
 *      international (E.164: 8 to 15 digits, no leading zero). This build does
 *      not know other countries' rules, so it only checks length.
 *   6. A number with no "+"/"00" and no leading 0 that is not 9 or 12 digits is
 *      refused - it is not guessed into a country.
 *
 * Line type (added after the first cut of this module). Malawi's numbering
 * plan (MACRA, 2009) is read from the prefix after +265:
 *   - starts with 1            -> LANDLINE (Malawi Telecom geographic, 7 digits:
 *                                 1 XXX XXX; the migrated 1 11X XXX XXX form is 9)
 *   - starts with 21           -> LANDLINE (Access Communications geographic, 9)
 *   - starts with 8 or 9, or 77-> MOBILE (TNM 88/89, Airtel 99/98, 77 non-geographic), 9 digits
 *   - anything else            -> UNKNOWN (31 is TNM's SIM-less VoIP range, 22 is
 *                                 Access non-geographic): never refused on a guess
 * Only LANDLINE is ever refused for SMS, and only because a text to a fixed line
 * cannot be delivered; UNKNOWN goes to the gateway, which has the final word.
 * The operator name is a prefix guess for display only (numbers can be ported)
 * and is never used to block anything.
 *
 * NOT done: no per-country rules beyond Malawi.
 */

export const MALAWI_COUNTRY_CODE = "265";
export const MALAWI_NATIONAL_LENGTH = 9;
export const MALAWI_LANDLINE_SHORT_LENGTH = 7;

/** providerName written to NotificationLog when a number is refused before any provider was called. */
export const PHONE_CHECK_PROVIDER = "phone-check";

export type LineType = "MOBILE" | "LANDLINE" | "UNKNOWN";

export type PhoneOk = {
  ok: true;
  /** "+" followed by digits, ready for the gateway. */
  e164: string;
  /** true when e164 differs from what was typed (so the UI can say what will be dialled). */
  changed: boolean;
  /** true when the country code was ASSUMED to be Malawi (typed with no +/00/265). */
  assumedMalawi: boolean;
  /** true for a valid number outside Malawi (length-checked only). */
  foreign: boolean;
  /** Malawian numbers only; foreign numbers are always UNKNOWN. */
  lineType: LineType;
  /** Prefix guess for display only ("TNM", "Airtel"); null when not known. */
  operator: string | null;
};

export type PhoneBad = {
  ok: false;
  /** One sentence in plain words, safe to show to whoever typed the number. */
  reason: string;
};

export type PhoneResult = PhoneOk | PhoneBad;

const MULTI_SEPARATOR = /[\/,;&\n\r]|\s+(?:or|and)\s+/i;
const ALLOWED_CHARS = /^\+?[0-9 \u00a0\-.()]+$/;

function bad(reason: string): PhoneBad {
  return { ok: false, reason };
}

/** Reads the line type and operator from the digits after +265. Pure prefix lookup. */
export function classifyMalawiNumber(nsn: string): { lineType: LineType; operator: string | null } {
  if (nsn.startsWith("1")) return { lineType: "LANDLINE", operator: null };
  if (nsn.startsWith("21")) return { lineType: "LANDLINE", operator: null };
  if (nsn.length === MALAWI_NATIONAL_LENGTH) {
    if (nsn.startsWith("88") || nsn.startsWith("89")) return { lineType: "MOBILE", operator: "TNM" };
    if (nsn.startsWith("99") || nsn.startsWith("98")) return { lineType: "MOBILE", operator: "Airtel" };
    if (nsn.startsWith("77")) return { lineType: "MOBILE", operator: null };
    if (nsn.startsWith("8") || nsn.startsWith("9")) return { lineType: "MOBILE", operator: null };
  }
  return { lineType: "UNKNOWN", operator: null };
}

/** A Malawian national number is 9 digits, or 7 when it is a Malawi Telecom landline (1 XXX XXX). */
function validMalawiNsnLength(nsn: string): boolean {
  if (nsn.length === MALAWI_NATIONAL_LENGTH) return true;
  return nsn.length === MALAWI_LANDLINE_SHORT_LENGTH && nsn.startsWith("1");
}

function malawi(nsn: string, typed: string, assumed: boolean): PhoneResult {
  const e164 = `+${MALAWI_COUNTRY_CODE}${nsn}`;
  const { lineType, operator } = classifyMalawiNumber(nsn);
  return { ok: true, e164, changed: e164 !== typed, assumedMalawi: assumed, foreign: false, lineType, operator };
}

/**
 * Reads one phone number as typed. Never throws. See the header for the rules.
 */
export function normalizePhoneNumber(input: string | null | undefined): PhoneResult {
  const typed = (input ?? "").trim();
  if (typed === "") return bad("There is no phone number.");

  // 2. one number only.
  const parts = typed.split(MULTI_SEPARATOR).filter((p) => /[0-9]/.test(p));
  if (parts.length > 1) {
    return bad(
      "The phone field holds more than one number. Keep one number in it so the text goes to the right phone."
    );
  }

  // 3. only phone-number characters, "+" only at the very start.
  if (!ALLOWED_CHARS.test(typed)) {
    return bad("The phone number has characters that are not part of a number (letters or symbols).");
  }
  if (typed.indexOf("+") > 0) {
    return bad("The \"+\" of a phone number can only be at the very start.");
  }

  const digits = typed.replace(/[^0-9]/g, "");
  if (digits === "") return bad("There is no phone number.");

  const hasPlus = typed.startsWith("+");
  const hasDoubleZero = !hasPlus && digits.startsWith("00");

  // 4/5. explicit international ("+..." or "00...").
  if (hasPlus || hasDoubleZero) {
    const intl = hasPlus ? digits : digits.slice(2);
    if (intl.startsWith(MALAWI_COUNTRY_CODE)) {
      return malawiFromAfterCode(intl.slice(MALAWI_COUNTRY_CODE.length), typed, false);
    }
    if (intl.length < 8 || intl.length > 15 || intl.startsWith("0")) {
      return bad(
        `"${typed}" is not a valid international number (it needs a country code and 8 to 15 digits in all).`
      );
    }
    return {
      ok: true,
      e164: `+${intl}`,
      changed: `+${intl}` !== typed,
      assumedMalawi: false,
      foreign: true,
      lineType: "UNKNOWN",
      operator: null,
    };
  }

  // Country code written without a "+" ("265999123456"). 12 digits, or 13 with
  // the trunk zero left in. A 9-digit number that happens to start 265 is
  // handled below as a bare national number, never here.
  // The same for a 7-digit landline: 265 + 1XXXXXX is 10 digits, or 11 with the trunk zero.
  const afterCc = digits.slice(MALAWI_COUNTRY_CODE.length);
  const landlineWithCc =
    (digits.length === 10 && afterCc.startsWith("1")) || (digits.length === 11 && afterCc.startsWith("01"));
  if (
    digits.startsWith(MALAWI_COUNTRY_CODE) &&
    (digits.length === 12 || digits.length === 13 || landlineWithCc)
  ) {
    return malawiFromAfterCode(digits.slice(MALAWI_COUNTRY_CODE.length), typed, false);
  }

  // Local form with the trunk zero ("0999123456").
  if (digits.startsWith("0")) {
    const nsn = digits.slice(1);
    if (!validMalawiNsnLength(nsn)) {
      return bad(
        `A Malawian mobile number has 10 digits with the leading 0 (for example 0999123456) and a landline has 8 (for example 01771234); this one has ${digits.length}.`
      );
    }
    return malawi(nsn, typed, false);
  }

  // Bare national number, no zero ("999123456"): people drop the 0 when copying.
  if (digits.length === MALAWI_NATIONAL_LENGTH) {
    return malawi(digits, typed, true);
  }

  return bad(
    `This number has ${digits.length} digits and no country code, so it cannot be read as a Malawian number. ` +
      "Write it as 0999123456 or with the country code (+265999123456)."
  );
}

function malawiFromAfterCode(afterCode: string, typed: string, assumed: boolean): PhoneResult {
  // "+265 (0) 999 123 456" leaves the trunk zero in: 265 + 0 + the national number.
  let nsn = afterCode;
  if (nsn.startsWith("0") && validMalawiNsnLength(nsn.slice(1))) nsn = nsn.slice(1);
  if (!validMalawiNsnLength(nsn) || nsn.startsWith("0")) {
    return bad(
      `A Malawian number has ${MALAWI_NATIONAL_LENGTH} digits after +${MALAWI_COUNTRY_CODE} (7 for a landline starting 1); this one has ${afterCode.length}.`
    );
  }
  return malawi(nsn, typed, assumed);
}

/**
 * Can a text message be sent to this number at all? A readable number on a
 * fixed line cannot receive SMS, so it is refused up front with a plain reason
 * instead of being sent to the gateway to fail. Everything else (mobile, or a
 * prefix this file does not know) is allowed through.
 */
export function checkSmsDeliverable(input: string | null | undefined): PhoneResult {
  const r = normalizePhoneNumber(input);
  if (!r.ok) return r;
  if (r.lineType === "LANDLINE") {
    return bad(`${r.e164} is a landline, which cannot receive text messages. Use a mobile number.`);
  }
  return r;
}

/**
 * What to tell a person typing or viewing a phone field. Used by the customer,
 * supplier and employee forms and the record pages so the wording lives in one
 * place.
 *   - empty input           -> null (say nothing)
 *   - a usable mobile       -> a plain note saying what will be dialled (and the operator, when known)
 *   - a landline            -> a warning: it is a valid number but cannot be texted
 *   - an unusable number    -> a warning that says why
 */
export function describePhoneForSms(
  input: string | null | undefined
): { level: "ok" | "warn"; text: string } | null {
  if ((input ?? "").trim() === "") return null;
  const r = normalizePhoneNumber(input);
  if (!r.ok) return { level: "warn", text: `Cannot be texted: ${r.reason}` };
  if (r.lineType === "LANDLINE") {
    return { level: "warn", text: `Cannot be texted: ${r.e164} is a landline, which cannot receive text messages.` };
  }
  const via = r.operator ? ` (${r.operator})` : "";
  if (!r.changed) return { level: "ok", text: `Texts will go to ${r.e164}${via}.` };
  return {
    level: "ok",
    text: r.assumedMalawi
      ? `Texts will go to ${r.e164}${via} (read as a Malawian number).`
      : `Texts will go to ${r.e164}${via}.`,
  };
}

// ---------------------------------------------------------------------------
// Saving: what gets stored
// ---------------------------------------------------------------------------

export type PhoneSave = { ok: true; value: string | null } | { ok: false; reason: string };

/**
 * Decides what to STORE when a phone field is saved from a form or API call.
 *   - blank                         -> null (no number)
 *   - readable (mobile, landline, foreign) -> the canonical "+..." form
 *   - unreadable                    -> refused with the reason
 *   - unchanged from what is already stored (`existing`) -> kept as is, even if
 *     it is an old free-text value, so editing another field of a legacy record
 *     is never blocked by a phone number nobody touched.
 * A landline is STORED (it is a valid number for a person to phone); it is only
 * refused at the moment a text is sent.
 */
export function preparePhoneForSave(input: string | null | undefined, existing?: string | null): PhoneSave {
  const typed = (input ?? "").trim();
  if (typed === "") return { ok: true, value: null };
  if (existing != null && typed === existing.trim()) return { ok: true, value: existing };
  const r = normalizePhoneNumber(typed);
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, value: r.e164 };
}

export type PhoneRewrite =
  | { action: "keep"; reason: "empty" | "already_canonical" }
  | { action: "rewrite"; to: string }
  | { action: "unreadable"; reason: string };

/**
 * One stored value -> what the backfill script should do with it. Pure, so the
 * decision is verified without a database. Unreadable values are REPORTED, never
 * changed or blanked: a person has to look at them.
 */
export function planPhoneRewrite(stored: string | null | undefined): PhoneRewrite {
  const s = (stored ?? "").trim();
  if (s === "") return { action: "keep", reason: "empty" };
  const r = normalizePhoneNumber(s);
  if (!r.ok) return { action: "unreadable", reason: r.reason };
  if (r.e164 === stored) return { action: "keep", reason: "already_canonical" };
  return { action: "rewrite", to: r.e164 };
}
