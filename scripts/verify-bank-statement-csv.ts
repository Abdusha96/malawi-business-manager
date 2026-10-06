/**
 * Module 62: standalone checks for the pure bank-statement CSV parser. No
 * database, no framework:
 *   npx tsx scripts/verify-bank-statement-csv.ts   (npm run verify:bank-statement-csv)
 * Exits non-zero if any check fails.
 *
 * Covers src/lib/bank-statement-csv.ts directly – the orchestration in
 * src/lib/bank-reconciliation.ts::importBankStatementCsv pulls in Prisma at
 * module scope and can't be exercised here, the same reason
 * scripts/verify-vat-refunds.ts only tests resolveVatDirection directly.
 */
import {
  parseCsvRecords,
  detectDelimiter,
  parseStatementDate,
  parseStatementAmount,
  parseStatementCsv,
  parseDirectionIndicator,
  flagDuplicates,
  statementLineKey,
  daysBetweenYmd,
  classifyLineDate,
  flagOutOfPeriod,
  OUT_OF_PERIOD_LOOKBACK_DAYS,
  MAX_IMPORT_ROWS,
} from "../src/lib/bank-statement-csv";

let failed = 0,
  total = 0;
function check(name: string, actual: unknown, expected: unknown) {
  total++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------- raw CSV
check("simple records", parseCsvRecords("a,b\n1,2\n", ","), [["a", "b"], ["1", "2"]]);
check("CRLF line endings", parseCsvRecords("a,b\r\n1,2\r\n", ","), [["a", "b"], ["1", "2"]]);
check("quoted field with comma", parseCsvRecords('a,"b,c"\n', ","), [["a", "b,c"]]);
check("escaped quote", parseCsvRecords('a,"say ""hi"""\n', ","), [["a", 'say "hi"']]);
check("newline inside quotes stays in one field", parseCsvRecords('a,"line1\nline2"\nx,y', ","), [["a", "line1\nline2"], ["x", "y"]]);
check("no trailing newline", parseCsvRecords("a,b\n1,2", ","), [["a", "b"], ["1", "2"]]);
check("BOM stripped", parseCsvRecords("\ufeffa,b\n", ","), [["a", "b"]]);
check("blank line kept as a record (row numbers stay honest)", parseCsvRecords("a\n\nb\n", ","), [["a"], [""], ["b"]]);
check("empty trailing field", parseCsvRecords("a,b,\n", ","), [["a", "b", ""]]);

check("delimiter: comma", detectDelimiter("Date,Description,Amount\n"), ",");
check("delimiter: semicolon", detectDelimiter("Date;Description;Amount\n"), ";");
check("delimiter: tab", detectDelimiter("Date\tDescription\tAmount\n"), "\t");
check("delimiter ignores commas inside quotes", detectDelimiter('Date;"Desc, with comma";Amount\n'), ";");

// ---------------------------------------------------------------- dates
check("ISO", parseStatementDate("2026-09-01"), "2026-09-01");
check("ISO with time", parseStatementDate("2026-09-01T10:32:00Z"), "2026-09-01");
check("DMY slash", parseStatementDate("01/09/2026"), "2026-09-01");
check("DMY day 13+ is unambiguous", parseStatementDate("25/12/2026"), "2026-12-25");
check("MDY when asked", parseStatementDate("09/01/2026", "MDY"), "2026-09-01");
check("MDY invalid month rejected", parseStatementDate("25/12/2026", "MDY"), null);
check("dash separators", parseStatementDate("1-9-2026"), "2026-09-01");
check("dot separators", parseStatementDate("01.09.2026"), "2026-09-01");
check("two-digit year", parseStatementDate("01/09/26"), "2026-09-01");
check("month name", parseStatementDate("01 Sep 2026"), "2026-09-01");
check("month name with dashes, 2-digit year", parseStatementDate("1-Sep-26"), "2026-09-01");
check("long month name", parseStatementDate("1 September 2026"), "2026-09-01");
check("US month-name form", parseStatementDate("Sep 1, 2026"), "2026-09-01");
check("trailing time ignored", parseStatementDate("01/09/2026 10:32"), "2026-09-01");
check("leap day valid", parseStatementDate("29/02/2028"), "2028-02-29");
check("non-leap 29 Feb rejected", parseStatementDate("29/02/2026"), null);
check("31 Apr rejected", parseStatementDate("31/04/2026"), null);
check("garbage rejected", parseStatementDate("yesterday"), null);
check("empty rejected", parseStatementDate("  "), null);

// ---------------------------------------------------------------- amounts
const amt = (s: string) => {
  const r = parseStatementAmount(s);
  return r.ok ? r.value : `ERR:${r.error}`;
};
check("plain", amt("1500"), 1500);
check("decimals", amt("1500.50"), 1500.5);
check("thousands", amt("1,234.50"), 1234.5);
check("negative", amt("-1,234.50"), -1234.5);
check("parentheses negative", amt("(1,234.50)"), -1234.5);
check("trailing minus", amt("1234.50-"), -1234.5);
check("unicode minus", amt("\u22121,000.00"), -1000);
check("MWK prefix", amt("MWK 1,234.50"), 1234.5);
check("K prefix (Kwacha)", amt("K1,500"), 1500);
check("DR suffix is negative", amt("1,234.50 DR"), -1234.5);
check("CR suffix is positive", amt("1,234.50 CR"), 1234.5);
check("decimal comma", amt("1234,50"), 1234.5);
check("European both separators", amt("1.234,50"), 1234.5);
check("space thousands", amt("1 234.50"), 1234.5);
check("thousands-only comma", amt("1,234"), 1234);
check("empty is null (normal in Debit/Credit layout)", amt(""), null);
check("lone dash is null", amt("-"), null);
check("zero parses to 0", amt("0.00"), 0);
check("3 decimal places rejected", String(amt("1.234567")).startsWith("ERR:"), true);
check("letters rejected", String(amt("abc")).startsWith("ERR:"), true);
check("ambiguous comma grouping rejected", String(amt("1,2345")).startsWith("ERR:"), true);
check("float noise absorbed", amt("0.10"), 0.1);

// ---------------------------------------------------------------- whole files
const parse = (t: string, o?: { dateOrder?: "DMY" | "MDY" }) => parseStatementCsv(t, o);

// signed amount column
{
  const r = parse("Date,Description,Amount,Balance\n01/09/2026,Salary,\"250,000.00\",300000\n02/09/2026,Airtime,-500,299500\n");
  check("signed: ok", r.ok, true);
  if (r.ok) {
    check("signed: rows", r.rows.map((x) => [x.rowNumber, x.lineDate, x.description, x.amount]), [
      [2, "2026-09-01", "Salary", 250000],
      [3, "2026-09-02", "Airtime", -500],
    ]);
    check("signed: no errors", r.errors, []);
    check("signed: columns", r.columns, { date: "Date", description: "Description", amount: "Amount", debit: null, credit: null, indicator: null });
  }
}

// debit / credit columns, statement convention (debit = out)
{
  const r = parse("Date,Narration,Debit,Credit,Balance\n01/09/2026,Monthly fee,1500.00,,98500\n03/09/2026,Deposit,,20000,118500\n");
  check("dr/cr: ok", r.ok, true);
  if (r.ok) {
    check("dr/cr: debit negative, credit positive", r.rows.map((x) => x.amount), [-1500, 20000]);
    check("dr/cr: columns", r.columns, { date: "Date", description: "Narration", amount: null, debit: "Debit", credit: "Credit", indicator: null });
  }
}

// debit already printed negative -> same result
{
  const r = parse("Date,Details,Withdrawals,Deposits\n01/09/2026,Fee,-1500.00,\n");
  check("dr/cr: pre-negated debit still negative", r.ok && r.rows[0].amount, -1500);
}

// both filled / both empty
{
  const r = parse("Date,Description,Debit,Credit\n01/09/2026,Odd,10,20\n02/09/2026,Nothing,,\n03/09/2026,Fine,,5\n");
  check("dr/cr: both-filled and both-empty are errors", r.ok && r.errors.map((e) => [e.rowNumber, e.message]), [
    [2, "Both Debit and Credit are filled in"],
    [3, "Debit and Credit are both empty or zero"],
  ]);
  check("dr/cr: good row still parsed", r.ok && r.rows.length, 1);
}

// preamble above the header + blank rows + semicolons
{
  const r = parse("Account: 1234567\nStatement period: Sep 2026\n\nTransaction Date;Particulars;Amount\n01/09/2026;Fee;-1.500,00\n\n02/09/2026;Interest;12,34\n", {});
  check("preamble: ok", r.ok, true);
  if (r.ok) {
    check("preamble: header row number", r.headerRow, 4);
    check("preamble: delimiter", r.delimiter, ";");
    check("preamble: rows", r.rows.map((x) => [x.rowNumber, x.amount]), [[5, -1500], [7, 12.34]]);
    check("preamble: blank row counted", r.blankRowsSkipped, 1);
  }
}

// bad rows are reported with row numbers, good rows survive
{
  const r = parse("Date,Description,Amount\n01/09/2026,Ok,100\nnot a date,Bad date,50\n03/09/2026,,50\n04/09/2026,Zero,0\n05/09/2026,Bad amount,abc\n");
  check("errors: ok overall", r.ok, true);
  if (r.ok) {
    check("errors: one good row", r.rows.length, 1);
    check("errors: row numbers + reasons", r.errors.map((e) => [e.rowNumber, e.message]), [
      [3, 'Couldn\'t read the date "not a date"'],
      [4, "Description is empty"],
      [5, "Amount is empty or zero"],
      [6, '"abc" is not a valid amount'],
    ]);
  }
}

// MDY option flows through
{
  const r = parse("Date,Description,Amount\n09/01/2026,X,1\n", { dateOrder: "MDY" });
  check("MDY option applied to a file", r.ok && r.rows[0].lineDate, "2026-09-01");
}

// header alias priority + fatal cases
{
  const r = parse("Value Date,Date,Description,Amount\n05/09/2026,01/09/2026,X,1\n");
  check("alias priority: Date beats Value Date", r.ok && r.rows[0].lineDate, "2026-09-01");
}
check("empty file", parse("  \n ").ok, false);
check("no header found", parse("foo,bar\n1,2\n").ok, false);
check("header without description column", parse("Date,Amount\n01/09/2026,5\n").ok, false);
check("header only, no data", parse("Date,Description,Amount\n").ok, false);
{
  const big = "Date,Description,Amount\n" + Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `01/09/2026,Row ${i},1`).join("\n");
  const r = parse(big);
  check("row cap enforced", r.ok, false);
  const atCap = "Date,Description,Amount\n" + Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => `01/09/2026,Row ${i},1`).join("\n");
  const r2 = parse(atCap);
  check("exactly at the cap is fine", r2.ok && r2.rows.length, MAX_IMPORT_ROWS);
}
{
  const r = parse('Date,Description,Amount\n01/09/2026,"Transfer, ref ""A1""",-5\n');
  check("quoted description with comma and quotes", r.ok && r.rows[0].description, 'Transfer, ref "A1"');
}
{
  const r = parse("Date,Description,Amount\n01/09/2026,  Spaced    out   text  ,5\n");
  check("description whitespace collapsed", r.ok && r.rows[0].description, "Spaced out text");
}
{
  const r = parse("\ufeffDate,Description,Amount\n01/09/2026,BOM file,5\n");
  check("BOM'd file parses", r.ok && r.rows.length, 1);
}

// ---------------------------------------------------------------- duplicates
const row = (n: number, d: string, desc: string, a: number) => ({ rowNumber: n, lineDate: d, description: desc, amount: a });
check("key ignores case and spacing", statementLineKey({ lineDate: "2026-09-01", description: "Bank  FEE", amount: -5 }), statementLineKey({ lineDate: "2026-09-01", description: "bank fee", amount: -5 }));
check(
  "no existing lines -> nothing flagged",
  flagDuplicates([row(2, "2026-09-01", "Fee", -5)], []).map((r) => r.possibleDuplicate),
  [false]
);
check(
  "re-importing the same file flags every row",
  flagDuplicates(
    [row(2, "2026-09-01", "Fee", -5), row(3, "2026-09-02", "Salary", 100)],
    [{ lineDate: "2026-09-01", description: "Fee", amount: -5 }, { lineDate: "2026-09-02", description: "salary", amount: 100 }]
  ).map((r) => r.possibleDuplicate),
  [true, true]
);
check(
  "COUNT-AWARE: 1 existing, 2 identical in file -> first flagged, second imports",
  flagDuplicates(
    [row(2, "2026-09-01", "Airtime", -500), row(3, "2026-09-01", "Airtime", -500)],
    [{ lineDate: "2026-09-01", description: "Airtime", amount: -500 }]
  ).map((r) => r.possibleDuplicate),
  [true, false]
);
check(
  "2 existing, 2 in file -> both flagged",
  flagDuplicates(
    [row(2, "2026-09-01", "Airtime", -500), row(3, "2026-09-01", "Airtime", -500)],
    [{ lineDate: "2026-09-01", description: "Airtime", amount: -500 }, { lineDate: "2026-09-01", description: "Airtime", amount: -500 }]
  ).map((r) => r.possibleDuplicate),
  [true, true]
);
check(
  "different amount is not a duplicate",
  flagDuplicates([row(2, "2026-09-01", "Fee", -5)], [{ lineDate: "2026-09-01", description: "Fee", amount: -6 }]).map((r) => r.possibleDuplicate),
  [false]
);
check(
  "different date is not a duplicate",
  flagDuplicates([row(2, "2026-09-02", "Fee", -5)], [{ lineDate: "2026-09-01", description: "Fee", amount: -5 }]).map((r) => r.possibleDuplicate),
  [false]
);

// ------------------------------------------------- Module 63: Dr/Cr indicator
check("indicator: DR", parseDirectionIndicator("DR"), "OUT");
check("indicator: dr. lowercase with dot", parseDirectionIndicator(" dr. "), "OUT");
check("indicator: Debit", parseDirectionIndicator("Debit"), "OUT");
check("indicator: D", parseDirectionIndicator("D"), "OUT");
check("indicator: Withdrawal", parseDirectionIndicator("Withdrawal"), "OUT");
check("indicator: CR", parseDirectionIndicator("CR"), "IN");
check("indicator: Credit", parseDirectionIndicator("credit"), "IN");
check("indicator: C", parseDirectionIndicator("C"), "IN");
check("indicator: Deposit", parseDirectionIndicator("Deposit"), "IN");
check("indicator: blank", parseDirectionIndicator("  "), "EMPTY");
check("indicator: unknown word", parseDirectionIndicator("Card"), "UNKNOWN");
check("indicator: Transfer is unknown, not guessed", parseDirectionIndicator("Transfer"), "UNKNOWN");

// unsigned amount + "Dr/Cr" column (strict header name)
{
  const r = parse("Date,Description,Amount,Dr/Cr,Balance\n01/09/2026,Salary,\"250,000.00\",CR,300000\n02/09/2026,Airtime,500.00,DR,299500\n");
  check("ind strict: ok", r.ok, true);
  if (r.ok) {
    check("ind strict: amounts", r.rows.map((x) => x.amount), [250000, -500]);
    check("ind strict: no errors/warnings", [r.errors, r.warnings], [[], []]);
    check("ind strict: columns", r.columns, { date: "Date", description: "Description", amount: "Amount", debit: null, credit: null, indicator: "Dr/Cr" });
  }
}

// "Debit/Credit" header, word values
{
  const r = parse("Date,Narration,Amount,Debit/Credit\n01/09/2026,Fee,1500,Debit\n02/09/2026,Deposit,20000,Credit\n");
  check("ind Debit/Credit header: ok", r.ok, true);
  if (r.ok) check("ind Debit/Credit header: amounts", r.rows.map((x) => x.amount), [-1500, 20000]);
}

// generic "Type" column whose every filled cell is DR/CR -> used
{
  const r = parse("Date,Description,Type,Amount\n01/09/2026,Salary,CR,1000\n02/09/2026,Fee,DR,25\n");
  check("ind generic all DR/CR: ok", r.ok, true);
  if (r.ok) {
    check("ind generic all DR/CR: amounts", r.rows.map((x) => x.amount), [1000, -25]);
    check("ind generic all DR/CR: column reported", r.columns.indicator, "Type");
  }
}

// generic "Type" column holding something else -> ignored WITH a warning, signed amounts kept
{
  const r = parse("Date,Description,Type,Amount\n01/09/2026,Shop,Card,-300\n02/09/2026,Salary,Transfer,5000\n");
  check("ind generic other: ok", r.ok, true);
  if (r.ok) {
    check("ind generic other: amounts read as printed", r.rows.map((x) => x.amount), [-300, 5000]);
    check("ind generic other: indicator not used", r.columns.indicator, null);
    check("ind generic other: one warning naming the column and a sample value", r.warnings.length === 1 && r.warnings[0].includes('"Type"') && r.warnings[0].includes('"Card"'), true);
  }
}

// negative amount already printed with DR -> consistent, magnitude taken
{
  const r = parse("Date,Description,Amount,Dr/Cr\n01/09/2026,Fee,-500,DR\n");
  check("ind consistent negative+DR: ok", r.ok && r.rows.map((x) => x.amount), [-500]);
}

// negative amount + CR -> contradiction is a row error, never resolved by guessing
{
  const r = parse("Date,Description,Amount,Dr/Cr\n01/09/2026,Odd,-500,CR\n02/09/2026,Fine,10,CR\n");
  check("ind contradiction: ok", r.ok, true);
  if (r.ok) {
    check("ind contradiction: bad row reported", r.errors.map((e) => e.rowNumber), [2]);
    check("ind contradiction: message names the conflict", r.errors[0].message.includes("negative") && r.errors[0].message.includes("credit"), true);
    check("ind contradiction: good row still read", r.rows.map((x) => x.amount), [10]);
  }
}

// blank and unrecognised indicator cells -> row errors
{
  const r = parse("Date,Description,Amount,Dr/Cr\n01/09/2026,A,100,\n02/09/2026,B,100,XX\n03/09/2026,C,100,DR\n");
  check("ind bad cells: ok", r.ok, true);
  if (r.ok) {
    check("ind bad cells: rows 2 and 3 reported", r.errors.map((e) => e.rowNumber), [2, 3]);
    check("ind bad cells: empty message", r.errors[0].message.includes("empty"), true);
    check("ind bad cells: unknown message quotes the value", r.errors[1].message.includes('"XX"'), true);
    check("ind bad cells: good row imported", r.rows.map((x) => [x.rowNumber, x.amount]), [[4, -100]]);
  }
}

// indicator column is ignored (and not warned about) in a Debit/Credit-column layout
{
  const r = parse("Date,Narration,Type,Debit,Credit\n01/09/2026,Fee,Card,50,\n02/09/2026,Pay,Transfer,,900\n");
  check("ind ignored in debit/credit layout: amounts", r.ok && r.rows.map((x) => x.amount), [-50, 900]);
  if (r.ok) check("ind ignored in debit/credit layout: no warning", [r.warnings, r.columns.indicator], [[], null]);
}

// signed layout with NO type column is unchanged: no warnings
{
  const r = parse("Date,Description,Amount\n01/09/2026,Salary,250\n");
  check("ind absent: no warnings", r.ok && r.warnings, []);
}

// generic Type column with all-blank cells -> not treated as an indicator
{
  const r = parse("Date,Description,Type,Amount\n01/09/2026,Salary,,250\n02/09/2026,Fee,,-5\n");
  check("ind generic all blank: not used", r.ok && r.columns.indicator, null);
  if (r.ok) check("ind generic all blank: amounts as printed", r.rows.map((x) => x.amount), [250, -5]);
}

// semicolon-separated export with a Dr/Cr column and a decimal comma
{
  const r = parse("Date;Details;Amount;DR/CR\n01/09/2026;Rent;12000,50;DR\n");
  check("ind semicolon+decimal comma", r.ok && r.rows.map((x) => x.amount), [-12000.5]);
}

// Dr/Cr column beside a "DR"-suffixed amount that agrees
{
  const r = parse("Date,Description,Amount,Dr/Cr\n01/09/2026,Fee,500 DR,DR\n");
  check("ind agrees with DR suffix", r.ok && r.rows.map((x) => x.amount), [-500]);
}

// ---------------------------------------------------------------- Module 64: statement-period check
check("lookback constant", OUT_OF_PERIOD_LOOKBACK_DAYS, 92);
check("days between same day", daysBetweenYmd("2026-09-30", "2026-09-30"), 0);
check("days between later", daysBetweenYmd("2026-09-01", "2026-09-30"), 29);
check("days between earlier", daysBetweenYmd("2026-09-30", "2026-09-01"), -29);
check("days across leap day", daysBetweenYmd("2028-02-28", "2028-03-01"), 2);
check("days across non-leap Feb", daysBetweenYmd("2027-02-28", "2027-03-01"), 1);
check("days across year end", daysBetweenYmd("2026-12-31", "2027-01-01"), 1);
check("days invalid input a", daysBetweenYmd("01/09/2026", "2026-09-30"), null);
check("days invalid input b", daysBetweenYmd("2026-09-01", "garbage"), null);

const SD = "2026-09-30";
check("period: on the statement date is fine", classifyLineDate("2026-09-30", SD), null);
check("period: first day of month is fine", classifyLineDate("2026-09-01", SD), null);
check("period: one day after is flagged", classifyLineDate("2026-10-01", SD), "AFTER_STATEMENT");
check("period: far after is flagged", classifyLineDate("2027-09-30", SD), "AFTER_STATEMENT");
check("period: exactly 92 days before is fine", classifyLineDate("2026-06-30", SD), null);
check("period: 93 days before is flagged", classifyLineDate("2026-06-29", SD), "LONG_BEFORE");
check("period: a year before is flagged", classifyLineDate("2025-09-30", SD), "LONG_BEFORE");
check("period: custom lookback honoured", classifyLineDate("2026-09-01", SD, 10), "LONG_BEFORE");
check("period: custom lookback boundary", classifyLineDate("2026-09-20", SD, 10), null);
check("period: unparseable statement date never flags", classifyLineDate("2026-09-01", "n/a"), null);
check("period: unparseable line date never flags", classifyLineDate("n/a", SD), null);

{
  const rows = [
    { rowNumber: 2, lineDate: "2026-09-15", description: "In period", amount: 10 },
    { rowNumber: 3, lineDate: "2026-10-02", description: "After", amount: 20 },
    { rowNumber: 4, lineDate: "2026-01-05", description: "Old", amount: 30 },
  ];
  const out = flagOutOfPeriod(rows, SD);
  check("flagOutOfPeriod flags", out.map((r) => r.periodFlag), [null, "AFTER_STATEMENT", "LONG_BEFORE"]);
  check("flagOutOfPeriod keeps the row fields", out.map((r) => r.description), ["In period", "After", "Old"]);
  check("flagOutOfPeriod doesn't mutate the input", (rows[0] as Record<string, unknown>).periodFlag, undefined);
  check("flagOutOfPeriod on no rows", flagOutOfPeriod([], SD), []);

  // composes with duplicate flagging without either overriding the other
  const both = flagOutOfPeriod(flagDuplicates(rows, [{ lineDate: "2026-10-02", description: "after", amount: 20 }]), SD);
  check("dup + period compose", both.map((r) => [r.possibleDuplicate, r.periodFlag]), [
    [false, null],
    [true, "AFTER_STATEMENT"],
    [false, "LONG_BEFORE"],
  ]);
}

// end to end through the parser: a statement whose dates are read in the wrong order shows up as out of period
{
  const csv = "Date,Description,Amount\n03/09/2026,Salary,250\n25/09/2026,Rent,-100\n";
  const dmy = parseStatementCsv(csv, { dateOrder: "DMY" });
  const mdy = parseStatementCsv(csv, { dateOrder: "MDY" });
  if (dmy.ok) check("parser DMY dates all in period", flagOutOfPeriod(dmy.rows, SD).map((r) => r.periodFlag), [null, null]);
  else check("parser DMY parsed", true, false);
  // MDY reads 25/09 as month 25 -> unreadable row, never a silent wrong date
  if (mdy.ok) check("parser MDY: 25/09 is an error, not a wrong date", mdy.errors.length, 1);
  else check("parser MDY parsed", true, false);
}

if (failed > 0) {
  console.error(`\n${failed} of ${total} checks FAILED`);
  process.exit(1);
}
console.log(`bank-statement-csv: ${total}/${total} checks passed`);
