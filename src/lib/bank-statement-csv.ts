/**
 * Module 62 – Bank Statement CSV Import (pure parsing layer).
 *
 * Closes the KNOWN LIMITATION Module 22 documented from day one: statement
 * lines could only be typed in by hand, one at a time. Malawian banks and
 * mobile-money providers let account holders download a CSV, so a real
 * month's statement (often 50–300 lines) no longer has to be re-keyed.
 *
 * This file is deliberately IMPORT-FREE (no Prisma, no zod, no React) so it is
 * safe from the server-side `bank-reconciliation.ts`, safe from a "use client"
 * component if a preview is ever moved into the browser, and directly testable
 * by `scripts/verify-bank-statement-csv.ts` with no database – the same split
 * `vat-payment-direction.ts`, `stale-transfer.ts` and `pagination.ts` use.
 *
 * Scope, on purpose: the file must have a header row, and a date column plus
 * EITHER one signed amount column OR separate debit/credit columns. Everything
 * the parser cannot make sense of is reported per row with its row number –
 * never silently dropped, never guessed at.
 *
 * Module 63 adds a third layout: an UNSIGNED amount column plus a separate
 * Dr/Cr indicator column (headers like "Dr/Cr", "Debit/Credit", "Type"). See
 * `parseDirectionIndicator()` and the "indicator" notes on `matchHeader()`.
 */

export const MAX_IMPORT_ROWS = 1000;
export const MAX_CSV_CHARS = 500_000;

export type DateOrder = "DMY" | "MDY";

export interface ParsedStatementRow {
  /** 1-based record number in the file (the header counts, blank rows count) – matches what a spreadsheet shows. */
  rowNumber: number;
  /** Calendar day, "YYYY-MM-DD". The server stores it as UTC midnight, the same as a date-input value. */
  lineDate: string;
  description: string;
  /** Signed like CashTransaction.amount: positive = money in, negative = money out. Never 0. */
  amount: number;
}

export interface StatementRowError {
  rowNumber: number;
  message: string;
}

export interface StatementColumns {
  date: string;
  description: string;
  /** Present when the file has one signed amount column. */
  amount: string | null;
  /** Present (with `credit`) when the file has separate money-out / money-in columns. */
  debit: string | null;
  credit: string | null;
  /**
   * Module 63. Present when an unsigned/signed Amount column is accompanied by a
   * Dr/Cr direction column ("Dr/Cr", "Type", ...) that the parser is using to
   * decide money in vs out. Null in every other layout.
   */
  indicator: string | null;
}

/** Parses OFX 1.x SGML and OFX 2.x XML bank statement transactions. */
export function parseStatementOfx(text: string): ParseStatementResult {
  if (!text || !text.trim()) return { ok: false, error: "The file is empty." };
  if (text.length > MAX_CSV_CHARS) return { ok: false, error: `The file is too large (over ${MAX_CSV_CHARS.toLocaleString("en-US")} characters). Split the statement into smaller files.` };
  if (!/<OFX(?:\s|>)/i.test(text) || !/<STMTTRN(?:\s|>)/i.test(text)) {
    return { ok: false, error: "This doesn't look like an OFX bank statement. The file must contain an OFX header and statement transactions." };
  }
  const rows: ParsedStatementRow[] = [];
  const errors: StatementRowError[] = [];
  const decode = (s: string) => s
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (entity, n: string) => { const cp = Number(n); return cp <= 0x10ffff ? String.fromCodePoint(cp) : entity; })
    .replace(/&#x([\da-f]+);/gi, (entity, n: string) => { const cp = Number.parseInt(n, 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : entity; });
  const transactions = [...text.matchAll(/<STMTTRN(?:\s[^>]*)?>([\s\S]*?)(?=<STMTTRN(?:\s|>)|<\/BANKTRANLIST\s*>|$)/gi)];
  if (!transactions.length) return { ok: false, error: "No bank transactions were found in this OFX file." };
  if (transactions.length > MAX_IMPORT_ROWS) return { ok: false, error: `Too many rows – the limit is ${MAX_IMPORT_ROWS} per import. Split the statement into smaller files.` };
  const field = (block: string, name: string) => {
    const re = new RegExp(`<${name}\\s*>([\\s\\S]*?)(?=<|$)`, "i");
    return decode(re.exec(block)?.[1]?.trim() ?? "");
  };
  transactions.forEach((match, i) => {
    const block = match[1];
    const rowNumber = i + 1;
    const posted = field(block, "DTPOSTED");
    const dateText = /^(\d{4})(\d{2})(\d{2})/.exec(posted);
    const lineDate = dateText ? parseStatementDate(`${dateText[1]}-${dateText[2]}-${dateText[3]}`) : null;
    if (!lineDate) { errors.push({ rowNumber, message: `Couldn't read the OFX posted date "${posted}"` }); return; }
    const rawAmount = field(block, "TRNAMT");
    const parsedAmount = parseStatementAmount(rawAmount);
    if (!parsedAmount.ok || parsedAmount.value === null || parsedAmount.value === 0) { errors.push({ rowNumber, message: parsedAmount.ok ? "Amount is empty or zero" : parsedAmount.error }); return; }
    const description = [field(block, "NAME"), field(block, "MEMO")].filter(Boolean).join(" – ").replace(/\s+/g, " ").trim() || field(block, "TRNTYPE") || field(block, "FITID");
    if (!description) { errors.push({ rowNumber, message: "Description is empty" }); return; }
    rows.push({ rowNumber, lineDate, description, amount: parsedAmount.value });
  });
  if (!rows.length && !errors.length) return { ok: false, error: "The file has a header but no data rows." };
  return { ok: true, delimiter: ",", headerRow: 1, columns: { date: "DTPOSTED", description: "NAME / MEMO", amount: "TRNAMT", debit: null, credit: null, indicator: null }, rows, errors, blankRowsSkipped: 0, warnings: [] };
}

export type ParseStatementResult =
  | { ok: false; error: string }
  | {
      ok: true;
      delimiter: "," | ";" | "\t";
      /** Record number of the header row (rows above it – account name, period – are ignored). */
      headerRow: number;
      columns: StatementColumns;
      rows: ParsedStatementRow[];
      errors: StatementRowError[];
      blankRowsSkipped: number;
      /** Module 63. Non-fatal notes about how the file was read (e.g. a "Type" column that was ignored). */
      warnings: string[];
    };

// ---------------------------------------------------------------------------
// Low-level CSV
// ---------------------------------------------------------------------------

const DELIMITERS = [",", ";", "\t"] as const;

/** Counts a candidate delimiter outside double quotes across the first few non-empty lines. */
function scoreDelimiter(text: string, delimiter: string): number {
  let inQuotes = false;
  let count = 0;
  let linesSeen = 0;
  for (let i = 0; i < text.length && linesSeen < 5; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && ch === "\n") {
      linesSeen++;
    } else if (!inQuotes && ch === delimiter) {
      count++;
    }
  }
  return count;
}

export function detectDelimiter(text: string): "," | ";" | "\t" {
  let best: "," | ";" | "\t" = ",";
  let bestScore = 0;
  for (const d of DELIMITERS) {
    const s = scoreDelimiter(text, d);
    if (s > bestScore) {
      best = d;
      bestScore = s;
    }
  }
  return best;
}

/**
 * RFC 4180-ish: quoted fields, "" as an escaped quote, delimiters and newlines
 * inside quotes, CRLF or LF. A leading BOM (Excel's "CSV UTF-8") is stripped.
 * Returns every record, including blank ones, so row numbers stay honest.
 */
export function parseCsvRecords(input: string, delimiter: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      i++;
    } else if (ch === delimiter) {
      endField();
      i++;
    } else if (ch === "\r") {
      // swallow the \r of CRLF; a lone \r also ends the record
      endRecord();
      i += text[i + 1] === "\n" ? 2 : 1;
    } else if (ch === "\n") {
      endRecord();
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  // final record without a trailing newline
  if (field !== "" || record.length > 0) endRecord();
  return records;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

function fullYear(yy: string): number {
  if (yy.length === 4) return Number(yy);
  const n = Number(yy);
  return n < 70 ? 2000 + n : 1900 + n;
}

function ymd(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Returns "YYYY-MM-DD" or null. ISO dates are unambiguous; numeric
 * "01/09/2026" is read day-first by default (the Malawian convention) unless
 * the caller says MDY. Month-name forms ("01 Sep 2026", "1-Sep-26",
 * "Sep 1, 2026") are unambiguous either way. A trailing time is ignored.
 */
export function parseStatementDate(raw: string, order: DateOrder = "DMY"): string | null {
  let s = raw.trim();
  if (!s) return null;

  // ISO first – "2026-09-01", "2026-09-01T10:32:00Z", "2026-09-01 10:32"
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return isRealDate(y, mo, d) ? ymd(y, mo, d) : null;
  }
  // "2026/09/01"
  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s.*)?$/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return isRealDate(y, mo, d) ? ymd(y, mo, d) : null;
  }

  // drop a trailing time-of-day so "01/09/2026 10:32" reads as a date
  s = s.replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\s*[ap]m)?$/i, "");

  // numeric with / - . separators
  m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = fullYear(m[3]);
    const [day, month] = order === "DMY" ? [a, b] : [b, a];
    return isRealDate(y, month, day) ? ymd(y, month, day) : null;
  }

  // "01 Sep 2026", "1-Sep-26", "1 September 2026"
  m = /^(\d{1,2})[\s\-\/.]+([A-Za-z]{3,9})[\s\-\/.,]+(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    const y = fullYear(m[3]);
    const d = Number(m[1]);
    return month && isRealDate(y, month, d) ? ymd(y, month, d) : null;
  }

  // "Sep 1, 2026"
  m = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    const y = fullYear(m[3]);
    const d = Number(m[2]);
    return month && isRealDate(y, month, d) ? ymd(y, month, d) : null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

export type AmountParse = { ok: true; value: number | null } | { ok: false; error: string };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Parses one amount cell into a SIGNED number. `value: null` means the cell was
 * empty (which is normal in a debit/credit layout). Understands:
 *   "1,234.50"  "-1,234.50"  "(1,234.50)"  "1234.50-"  "MWK 1,234.50"  "K1,500"
 *   "1 234,50" / "1.234,50" (decimal comma)  "1,234.50 DR" (negative)  "1,234.50 CR" (positive)
 * More than 2 decimal places is an error (a bank never prints a fraction of a
 * tambala – if one appears the column is probably not an amount).
 */
export function parseStatementAmount(raw: string): AmountParse {
  let s = raw.trim();
  // empty, or a lone dash – several bank exports print "-" for "nothing in this column"
  if (!s || /^[-\u2212\u2013\u2014\s]+$/.test(s)) return { ok: true, value: null };

  let negative = false;
  let positiveExplicit = false;

  // DR / CR markers, as prefix or suffix
  const dr = /^(dr\.?\s*)|(\s*dr\.?)$/i;
  const cr = /^(cr\.?\s*)|(\s*cr\.?)$/i;
  if (dr.test(s)) {
    negative = true;
    s = s.replace(dr, "").trim();
  } else if (cr.test(s)) {
    positiveExplicit = true;
    s = s.replace(cr, "").trim();
  }

  // parentheses = negative
  if (/^\(.*\)$/.test(s)) {
    negative = !negative;
    s = s.slice(1, -1).trim();
  }
  // leading sign (ASCII hyphen or the Unicode minus some exports use)
  if (/^[-\u2212]/.test(s)) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trim();
  }
  // trailing minus ("1234.50-")
  if (/[-\u2212]$/.test(s)) {
    negative = !negative;
    s = s.slice(0, -1).trim();
  }

  // currency tokens – "MWK", "MK", "K" (Kwacha), plus a few others
  s = s.replace(/^(mwk|mk|k|usd|zar|gbp|eur|\$|£|€)\s*/i, "").replace(/\s*(mwk|mk|usd|zar|gbp|eur)$/i, "").trim();

  // thousand separators that are spaces / apostrophes
  s = s.replace(/[\s'\u00a0\u202f]/g, "");

  if (!/^[0-9.,]+$/.test(s) || !/\d/.test(s)) {
    return { ok: false, error: `"${raw.trim()}" is not a valid amount` };
  }

  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;
  let normalised: string;

  if (dots > 0 && commas > 0) {
    // the LAST separator is the decimal one, the other is thousands
    const decimalIsDot = s.lastIndexOf(".") > s.lastIndexOf(",");
    normalised = decimalIsDot ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(",", ".");
  } else if (commas > 0) {
    if (commas === 1 && /,\d{1,2}$/.test(s)) {
      normalised = s.replace(",", "."); // decimal comma
    } else if (/^\d{1,3}(,\d{3})+$/.test(s)) {
      normalised = s.replace(/,/g, ""); // thousands
    } else {
      return { ok: false, error: `"${raw.trim()}" is not a valid amount` };
    }
  } else if (dots > 1) {
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) normalised = s.replace(/\./g, "");
    else return { ok: false, error: `"${raw.trim()}" is not a valid amount` };
  } else {
    normalised = s;
  }

  if (!/^(\d+(\.\d+)?|\.\d+)$/.test(normalised)) {
    return { ok: false, error: `"${raw.trim()}" is not a valid amount` };
  }
  const decimals = normalised.includes(".") ? normalised.split(".")[1].length : 0;
  if (decimals > 2) {
    return { ok: false, error: `"${raw.trim()}" has more than 2 decimal places` };
  }

  const magnitude = round2(Number(normalised));
  // an explicit CR wins over a stray sign; DR already set `negative`
  const signed = positiveExplicit ? magnitude : negative ? -magnitude : magnitude;
  return { ok: true, value: signed === 0 ? 0 : signed };
}

// ---------------------------------------------------------------------------
// Header detection
// ---------------------------------------------------------------------------

function normaliseHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const DATE_ALIASES = ["date", "transaction date", "txn date", "trans date", "posting date", "posted date", "value date", "booking date", "tran date"];
const DESCRIPTION_ALIASES = [
  "description", "narration", "narrative", "details", "transaction details", "particulars", "transaction description", "remarks", "memo", "reference", "transaction",
];
const AMOUNT_ALIASES = ["amount", "transaction amount", "txn amount", "amount mwk", "net amount", "value"];
const DEBIT_ALIASES = ["debit", "debits", "withdrawal", "withdrawals", "money out", "paid out", "dr", "debit amount", "amount out", "payments"];
const CREDIT_ALIASES = ["credit", "credits", "deposit", "deposits", "money in", "paid in", "cr", "credit amount", "amount in", "receipts"];

// Module 63 – direction (Dr/Cr) indicator column, used with an Amount column.
// STRICT names can only mean money direction, so the column is trusted on its
// header alone. GENERIC names ("Type") are common on statements for something
// else entirely (Card / ATM / Transfer), so a generic column is only used when
// EVERY filled cell in it is a recognisable Dr/Cr value – otherwise it is
// ignored with a warning rather than guessed at.
const STRICT_INDICATOR_ALIASES = [
  "dr cr", "cr dr", "debit credit", "credit debit", "dr cr indicator", "cr dr indicator",
  "debit credit indicator", "credit debit indicator", "drcr", "crdr", "dc", "d c", "dc indicator", "d c indicator", "indicator",
];
const GENERIC_INDICATOR_ALIASES = ["type", "transaction type", "txn type", "trans type", "tran type", "entry type"];

export type DirectionParse = "OUT" | "IN" | "EMPTY" | "UNKNOWN";

/**
 * Reads one Dr/Cr indicator cell. Statement convention (same as Module 62's
 * Debit/Credit columns): DR / Debit / Withdrawal = money OUT of the account,
 * CR / Credit / Deposit = money IN. Anything else is UNKNOWN – never guessed.
 */
export function parseDirectionIndicator(raw: string): DirectionParse {
  const v = raw.trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");
  if (!v) return "EMPTY";
  if (["dr", "d", "db", "debit", "withdrawal", "withdraw"].includes(v)) return "OUT";
  if (["cr", "c", "credit", "deposit"].includes(v)) return "IN";
  return "UNKNOWN";
}

function findColumn(headers: string[], aliases: string[]): number {
  // alias priority order, not column order – "Date" beats "Value Date" when both exist
  for (const alias of aliases) {
    const idx = headers.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

interface HeaderMatch {
  date: number;
  description: number;
  amount: number;
  debit: number;
  credit: number;
  /** Module 63: column whose header can only mean Dr/Cr direction (-1 if none). */
  indicatorStrict: number;
  /** Module 63: a "Type"-style column – only used if its cells all read as Dr/Cr (-1 if none). */
  indicatorGeneric: number;
}

function matchHeader(record: string[]): HeaderMatch | null {
  const headers = record.map(normaliseHeader);
  const date = findColumn(headers, DATE_ALIASES);
  const description = findColumn(headers, DESCRIPTION_ALIASES);
  const amount = findColumn(headers, AMOUNT_ALIASES);
  const debit = findColumn(headers, DEBIT_ALIASES);
  const credit = findColumn(headers, CREDIT_ALIASES);
  const hasAmount = amount !== -1 || (debit !== -1 && credit !== -1);
  if (date === -1 || !hasAmount) return null;
  // prefer the single signed column when both layouts are present (some
  // exports carry "Amount" plus a running "Debit"/"Credit" summary)
  const indicatorStrict = findColumn(headers, STRICT_INDICATOR_ALIASES);
  const indicatorGeneric = findColumn(headers, GENERIC_INDICATOR_ALIASES);
  return { date, description, amount, debit, credit, indicatorStrict, indicatorGeneric };
}

const HEADER_SCAN_LIMIT = 20;

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function parseStatementCsv(text: string, options: { dateOrder?: DateOrder } = {}): ParseStatementResult {
  const dateOrder = options.dateOrder ?? "DMY";

  if (!text || !text.trim()) return { ok: false, error: "The file is empty." };
  if (text.length > MAX_CSV_CHARS) {
    return { ok: false, error: `The file is too large (over ${MAX_CSV_CHARS.toLocaleString("en-US")} characters). Split the statement into smaller files.` };
  }

  const delimiter = detectDelimiter(text);
  const records = parseCsvRecords(text, delimiter);

  // find the header row among the first few non-blank records (banks often
  // print the account name / period above it)
  let headerIndex = -1;
  let match: HeaderMatch | null = null;
  let scanned = 0;
  for (let i = 0; i < records.length && scanned < HEADER_SCAN_LIMIT; i++) {
    if (records[i].every((c) => c.trim() === "")) continue;
    scanned++;
    const m = matchHeader(records[i]);
    if (m) {
      headerIndex = i;
      match = m;
      break;
    }
  }
  if (!match || headerIndex === -1) {
    return {
      ok: false,
      error:
        "Couldn't find a header row. The file needs a header with a Date column and either an Amount column or separate Debit and Credit columns (e.g. \"Date, Description, Debit, Credit, Balance\").",
    };
  }
  if (match.description === -1) {
    return { ok: false, error: "Couldn't find a Description column (accepted names: Description, Narration, Details, Particulars, Reference)." };
  }

  const headerRecord = records[headerIndex];
  const useSigned = match.amount !== -1;
  const warnings: string[] = [];

  // Module 63 – decide whether a Dr/Cr indicator column is in play. Only
  // meaningful next to an Amount column (a Debit/Credit column pair already
  // says the direction by which column is filled).
  let indicatorCol = -1;
  if (useSigned) {
    if (match.indicatorStrict !== -1) {
      indicatorCol = match.indicatorStrict;
    } else if (match.indicatorGeneric !== -1) {
      const filled: string[] = [];
      for (let i = headerIndex + 1; i < records.length; i++) {
        const c = match.indicatorGeneric < records[i].length ? records[i][match.indicatorGeneric] : "";
        if (c.trim() !== "") filled.push(c);
      }
      const other = filled.find((c) => parseDirectionIndicator(c) === "UNKNOWN");
      if (filled.length > 0 && other === undefined) {
        indicatorCol = match.indicatorGeneric;
      } else if (other !== undefined) {
        warnings.push(
          `The \"${headerRecord[match.indicatorGeneric].trim()}\" column was ignored because it holds values other than DR/CR (e.g. \"${other.trim()}\"), so amounts were read as they appear. If that column is meant to say money in or out, rename its header to \"Dr/Cr\" and use DR / CR in it.`
        );
      }
    }
  }

  const columns: StatementColumns = {
    date: headerRecord[match.date].trim(),
    description: headerRecord[match.description].trim(),
    amount: useSigned ? headerRecord[match.amount].trim() : null,
    debit: useSigned ? null : headerRecord[match.debit].trim(),
    credit: useSigned ? null : headerRecord[match.credit].trim(),
    indicator: indicatorCol !== -1 ? headerRecord[indicatorCol].trim() : null,
  };

  const rows: ParsedStatementRow[] = [];
  const errors: StatementRowError[] = [];
  let blankRowsSkipped = 0;
  let dataRecords = 0;

  for (let i = headerIndex + 1; i < records.length; i++) {
    const rec = records[i];
    const rowNumber = i + 1;
    if (rec.every((c) => c.trim() === "")) {
      blankRowsSkipped++;
      continue;
    }
    dataRecords++;
    if (dataRecords > MAX_IMPORT_ROWS) {
      return { ok: false, error: `Too many rows – the limit is ${MAX_IMPORT_ROWS} per import. Split the statement into smaller files.` };
    }

    const cell = (idx: number) => (idx >= 0 && idx < rec.length ? rec[idx] : "");

    const lineDate = parseStatementDate(cell(match.date), dateOrder);
    if (!lineDate) {
      errors.push({ rowNumber, message: `Couldn't read the date "${cell(match.date).trim()}"` });
      continue;
    }

    const description = cell(match.description).replace(/\s+/g, " ").trim();
    if (!description) {
      errors.push({ rowNumber, message: "Description is empty" });
      continue;
    }

    let amount: number;
    if (useSigned) {
      const a = parseStatementAmount(cell(match.amount));
      if (!a.ok) {
        errors.push({ rowNumber, message: a.error });
        continue;
      }
      if (a.value === null || a.value === 0) {
        errors.push({ rowNumber, message: "Amount is empty or zero" });
        continue;
      }
      if (indicatorCol === -1) {
        amount = a.value;
      } else {
        // Module 63 – the indicator column decides direction; the amount
        // supplies the magnitude. Never guessed: a blank or unrecognised
        // indicator, or one that contradicts a signed amount, is a row error.
        const raw = cell(indicatorCol);
        const dir = parseDirectionIndicator(raw);
        if (dir === "EMPTY") {
          errors.push({ rowNumber, message: `${columns.indicator} is empty, so it isn't clear whether this is money in or out` });
          continue;
        }
        if (dir === "UNKNOWN") {
          errors.push({ rowNumber, message: `Couldn't read ${columns.indicator} \"${raw.trim()}\" (expected DR/CR, Debit/Credit)` });
          continue;
        }
        if (a.value < 0 && dir === "IN") {
          errors.push({ rowNumber, message: `Amount is negative but ${columns.indicator} says credit (money in)` });
          continue;
        }
        amount = dir === "OUT" ? -Math.abs(a.value) : Math.abs(a.value);
      }
    } else {
      const d = parseStatementAmount(cell(match.debit));
      const c = parseStatementAmount(cell(match.credit));
      if (!d.ok) {
        errors.push({ rowNumber, message: `Debit: ${d.error}` });
        continue;
      }
      if (!c.ok) {
        errors.push({ rowNumber, message: `Credit: ${c.error}` });
        continue;
      }
      const dv = d.value ?? 0;
      const cv = c.value ?? 0;
      if (dv !== 0 && cv !== 0) {
        errors.push({ rowNumber, message: "Both Debit and Credit are filled in" });
        continue;
      }
      if (dv === 0 && cv === 0) {
        errors.push({ rowNumber, message: "Debit and Credit are both empty or zero" });
        continue;
      }
      // Statement convention: a Debit is money OUT of the account, a Credit is money IN.
      // Some exports print debits already negative – take the magnitude so both read the same.
      amount = dv !== 0 ? -Math.abs(dv) : Math.abs(cv);
    }

    rows.push({ rowNumber, lineDate, description, amount });
  }

  if (rows.length === 0 && errors.length === 0) {
    return { ok: false, error: "The file has a header but no data rows." };
  }

  return { ok: true, delimiter, headerRow: headerIndex + 1, columns, rows, errors, blankRowsSkipped, warnings };
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export function statementLineKey(line: { lineDate: string; description: string; amount: number }): string {
  const desc = line.description.replace(/\s+/g, " ").trim().toLowerCase();
  return `${line.lineDate}|${desc}|${line.amount.toFixed(2)}`;
}

export type FlaggedRow = ParsedStatementRow & { possibleDuplicate: boolean };

/**
 * Flags rows that already exist in the reconciliation. COUNT-AWARE on purpose:
 * two identical lines on one statement (two K500 airtime purchases on the same
 * day) are normal, so a key that already exists N times only flags the first N
 * matching rows in the file – re-importing the same file flags every row, but a
 * file that genuinely has one more identical line than the reconciliation does
 * still imports that extra one.
 */
export function flagDuplicates(rows: ParsedStatementRow[], existing: { lineDate: string; description: string; amount: number }[]): FlaggedRow[] {
  const remaining = new Map<string, number>();
  for (const e of existing) {
    const k = statementLineKey(e);
    remaining.set(k, (remaining.get(k) ?? 0) + 1);
  }
  return rows.map((r) => {
    const k = statementLineKey(r);
    const left = remaining.get(k) ?? 0;
    if (left > 0) {
      remaining.set(k, left - 1);
      return { ...r, possibleDuplicate: true };
    }
    return { ...r, possibleDuplicate: false };
  });
}

// ---------------------------------------------------------------------------
// Module 64 – statement-period check
// ---------------------------------------------------------------------------

/**
 * How far before the statement date a line can sit before it looks like it
 * belongs to an earlier statement. Until Module 69 a reconciliation recorded only
 * its END date (`statementDate`); one opened without a start date still does, so
 * "before the period" can't be known exactly for it. 92 days (about one quarter) leaves room for monthly
 * and quarterly statements plus a few days of slack; anything older is far
 * more likely to be last period's line pasted in by mistake than a real one.
 * It's a heuristic, so it only ever WARNS by default.
 */
export const OUT_OF_PERIOD_LOOKBACK_DAYS = 92;

/**
 * AFTER_STATEMENT – dated after the statement date. Definite: the books side of
 * a reconciliation is cut off at that date, so such a line can never match a
 * book transaction in scope.
 * LONG_BEFORE – dated more than `lookbackDays` before the statement date.
 * Probably an earlier statement's line (heuristic). Only produced when the
 * reconciliation has NO recorded start date.
 * BEFORE_START – (Module 69) dated before the reconciliation's recorded
 * `periodStart`. Definite, like AFTER_STATEMENT, and it replaces the LONG_BEFORE
 * guess whenever a start date is known.
 */
export type PeriodFlag = "AFTER_STATEMENT" | "LONG_BEFORE" | "BEFORE_START";

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whole days from calendar day `a` to calendar day `b` (positive when b is later). Null if either isn't a valid "YYYY-MM-DD". */
export function daysBetweenYmd(a: string, b: string): number | null {
  const ma = YMD_RE.exec(a);
  const mb = YMD_RE.exec(b);
  if (!ma || !mb) return null;
  const ta = Date.UTC(Number(ma[1]), Number(ma[2]) - 1, Number(ma[3]));
  const tb = Date.UTC(Number(mb[1]), Number(mb[2]) - 1, Number(mb[3]));
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((tb - ta) / 86_400_000);
}

/**
 * Classifies one line date against the statement's period. Null = inside the
 * plausible period (or a date that can't be compared).
 *
 * Module 69: with a recorded `periodStart` the start is EXACT – a line dated
 * before it is BEFORE_START and the 92-day guess is not used at all (a quarterly
 * statement with a start date must not be flagged for being "long before", and a
 * line one day before the start must be). Without one, behaviour is exactly
 * Module 64's. A start date that is not a valid day is treated as absent, never
 * as a reason to flag every row.
 */
export function classifyLineDate(
  lineDate: string,
  statementDate: string,
  lookbackDays: number = OUT_OF_PERIOD_LOOKBACK_DAYS,
  periodStart: string | null = null
): PeriodFlag | null {
  const daysBefore = daysBetweenYmd(lineDate, statementDate); // positive = line is before the statement date
  if (daysBefore === null) return null;
  if (daysBefore < 0) return "AFTER_STATEMENT";
  if (periodStart !== null && YMD_RE.test(periodStart)) {
    const daysFromStart = daysBetweenYmd(periodStart, lineDate); // negative = line is before the start
    if (daysFromStart !== null) return daysFromStart < 0 ? "BEFORE_START" : null;
  }
  if (daysBefore > lookbackDays) return "LONG_BEFORE";
  return null;
}

export type PeriodFlagged<T> = T & { periodFlag: PeriodFlag | null };

/** Adds `periodFlag` to each row. Pure – the caller decides what (if anything) to do about a flagged row. */
export function flagOutOfPeriod<T extends { lineDate: string }>(
  rows: T[],
  statementDate: string,
  lookbackDays: number = OUT_OF_PERIOD_LOOKBACK_DAYS,
  periodStart: string | null = null
): PeriodFlagged<T>[] {
  return rows.map((r) => ({ ...r, periodFlag: classifyLineDate(r.lineDate, statementDate, lookbackDays, periodStart) }));
}

// ----------------------------------------------------------------------------
// Module 69 – recorded statement start date
// ----------------------------------------------------------------------------

/** The calendar day after `ymd`, as "YYYY-MM-DD". Null if `ymd` isn't a valid day. Zone-proof (UTC arithmetic on the calendar day). */
export function nextDayYmd(ymd: string): string | null {
  const m = YMD_RE.exec(ymd);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(t)) return null;
  // Reject impossible days such as 2026-02-31, which Date.UTC would roll over silently.
  const back = new Date(t);
  if (back.getUTCFullYear() !== Number(m[1]) || back.getUTCMonth() !== Number(m[2]) - 1 || back.getUTCDate() !== Number(m[3])) return null;
  return new Date(t + 86_400_000).toISOString().slice(0, 10);
}

/**
 * Why a proposed start date can't be used, or null if it can. A start date must be
 * a real calendar day and can't be after the statement date (a one-day statement,
 * start = end, is fine). Never clamped: an impossible pair is refused by name.
 */
export function validatePeriodStart(periodStart: string, statementDate: string): string | null {
  if (!YMD_RE.test(periodStart) || nextDayYmd(periodStart) === null) return "The statement start date isn't a valid date.";
  if (!YMD_RE.test(statementDate) || nextDayYmd(statementDate) === null) return "The statement date isn't a valid date.";
  const span = daysBetweenYmd(periodStart, statementDate);
  if (span === null) return "The statement start date isn't a valid date.";
  if (span < 0) return "The statement start date can't be after the statement date.";
  return null;
}

/**
 * The start date a NEW reconciliation would naturally have: the day after the
 * latest earlier statement that was completed for the same account. Only
 * statements ending BEFORE `statementDate` count (a same-day or later one is not
 * "the previous statement"). Null when there is no earlier statement, or when the
 * day after it would fall after `statementDate`. It's a suggestion the person
 * confirms, never applied silently – statements can have gaps or overlaps.
 */
export function suggestPeriodStart(previousStatementDates: string[], statementDate: string): string | null {
  let latest: string | null = null;
  for (const d of previousStatementDates) {
    const gap = daysBetweenYmd(d, statementDate);
    if (gap === null || gap <= 0) continue; // invalid, same day, or later than this statement
    if (latest === null || d > latest) latest = d; // "YYYY-MM-DD" sorts chronologically
  }
  if (latest === null) return null;
  const next = nextDayYmd(latest);
  if (next === null || validatePeriodStart(next, statementDate) !== null) return null;
  return next;
}
