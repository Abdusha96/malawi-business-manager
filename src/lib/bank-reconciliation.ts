import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { getAccountBalance, reverseCashTransactionsForReference, postCashTransactionForBankReconciliationAdjustment } from "./cashbook";
import { postJournalEntryForBankReconciliationAdjustment } from "./accounting-integrations";
import { reverseJournalEntriesForReference } from "./accounting";
import { logAudit } from "./audit";
import { countReopens, getReopenHistory, reopenCapMessage } from "./reopen-audit";
import { OpenBankReconciliationInput, BankStatementLineInput, SetPeriodStartInput } from "./validation";
import {
  parseStatementCsv,
  parseStatementOfx,
  flagDuplicates,
  flagOutOfPeriod,
  classifyLineDate,
  validatePeriodStart,
  suggestPeriodStart,
  OUT_OF_PERIOD_LOOKBACK_DAYS,
  DateOrder,
  FlaggedRow,
  PeriodFlag,
  StatementColumns,
  StatementRowError,
} from "./bank-statement-csv";
import { findOverlappingStatements, flagRepeatsOfOtherStatements, lineDateSpan, StatementOverlap } from "./statement-overlap";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export class BankReconciliationError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "BankReconciliationError";
    this.status = status;
  }
}

/**
 * Opens a new reconciliation for one CashAccount against one statement.
 * Snapshots the account's live book balance into bookBalanceAtStart – the
 * one deliberate exception in this app to "computed, never stored" (see
 * the schema comment on BankReconciliation for why: it's an audit record
 * of the moment reconciliation started, not a figure that should drift as
 * later, unrelated transactions get posted).
 *
 * Only one IN_PROGRESS reconciliation per account at a time – starting a
 * second one before finishing the first would just create two competing,
 * overlapping views of the same unmatched book transactions.
 */
export async function openBankReconciliation(params: {
  businessId: string;
  createdById: string;
  data: OpenBankReconciliationInput;
}) {
  const { businessId, createdById, data } = params;
  // Module 69 – optional first day of the statement. Refused, never clamped, when
  // it is after the statement date. Compared as calendar days (the ISO string's
  // date part), the same way every other date in this file is.
  const periodStartYmd = data.periodStart ? data.periodStart.slice(0, 10) : null;
  if (periodStartYmd) {
    const problem = validatePeriodStart(periodStartYmd, data.statementDate.slice(0, 10));
    if (problem) throw new BankReconciliationError(problem);
  }

  return prisma.$transaction(async (tx) => {
    // Serialize opens (and reopens) for this account. Without a database
    // partial unique index, two requests could both see no open statement.
    const accountLock = await tx.cashAccount.updateMany({
      where: { id: data.accountId, businessId },
      data: { updatedAt: new Date() },
    });
    if (accountLock.count === 0) throw new BankReconciliationError("Cash account not found.");
    const account = await tx.cashAccount.findUniqueOrThrow({ where: { id: data.accountId } });
    const existing = await tx.bankReconciliation.findFirst({
      where: { businessId, accountId: data.accountId, status: "IN_PROGRESS" },
    });
    if (existing) {
      throw new BankReconciliationError(
        `${account.name} already has a reconciliation in progress. Finish or delete it before starting another.`
      );
    }

    const cash = await tx.cashTransaction.aggregate({ where: { accountId: data.accountId }, _sum: { amount: true } });
    const bookBalanceAtStart = round2(Number(account.openingBalance) + Number(cash._sum.amount ?? 0));
    const reconciliation = await tx.bankReconciliation.create({
      data: {
        businessId,
        accountId: data.accountId,
        statementDate: new Date(data.statementDate),
        periodStart: periodStartYmd ? new Date(`${periodStartYmd}T00:00:00.000Z`) : null,
        statementEndingBalance: data.statementEndingBalance,
        bookBalanceAtStart,
        createdById,
      },
    });

    await logAudit({
      tx,
      businessId,
      userId: createdById,
      action: "bankrecon.open",
      entityType: "BankReconciliation",
      entityId: reconciliation.id,
      metadata: { accountId: data.accountId, statementDate: data.statementDate, periodStart: periodStartYmd, statementEndingBalance: data.statementEndingBalance },
    });
    return reconciliation;
  });
}

async function getOpenReconciliationOrThrow(businessId: string, reconciliationId: string) {
  const reconciliation = await prisma.bankReconciliation.findFirst({
    where: { id: reconciliationId, businessId },
    include: { account: true },
  });
  if (!reconciliation) throw new BankReconciliationError("Reconciliation not found.");
  if (reconciliation.status !== "IN_PROGRESS") {
    throw new BankReconciliationError("This reconciliation is already completed and can no longer be changed.");
  }
  return reconciliation;
}

/**
 * Serializes a line mutation with completion/reopen. Call inside the same
 * transaction as the line write; the conditional update acquires the parent
 * row lock and rechecks that the statement is still open after any waiter.
 */
async function lockOpenReconciliation(tx: Prisma.TransactionClient, businessId: string, reconciliationId: string) {
  const locked = await tx.bankReconciliation.updateMany({
    where: { id: reconciliationId, businessId, status: "IN_PROGRESS" },
    data: { updatedAt: new Date() },
  });
  if (locked.count === 0) {
    throw new BankReconciliationError("This reconciliation is already completed and can no longer be changed.");
  }
}

/**
 * Module 70. The lines that sit on OTHER reconciliations of the same account,
 * bounded to a date span so the query stays small however long the account's
 * history is. Same business + account only; never this reconciliation's own lines.
 */
async function getOtherStatementLines(params: {
  businessId: string;
  accountId: string;
  reconciliationId: string;
  span: { min: string; max: string } | null;
}) {
  if (!params.span) return [];
  const rows = await prisma.bankStatementLine.findMany({
    where: {
      businessId: params.businessId,
      accountId: params.accountId,
      reconciliationId: { not: params.reconciliationId },
      lineDate: { gte: new Date(`${params.span.min}T00:00:00.000Z`), lte: new Date(`${params.span.max}T00:00:00.000Z`) },
    },
    select: { lineDate: true, description: true, amount: true },
  });
  return rows.map((e) => ({ lineDate: e.lineDate.toISOString().slice(0, 10), description: e.description, amount: Number(e.amount) }));
}

/** Module 70. Statement periods of the other reconciliations of this account, for the overlap check. */
async function getOtherStatementPeriods(businessId: string, accountId: string, reconciliationId: string) {
  const rows = await prisma.bankReconciliation.findMany({
    where: { businessId, accountId, id: { not: reconciliationId } },
    select: { id: true, statementDate: true, periodStart: true },
  });
  return rows.map((r) => ({
    id: r.id,
    statementDate: r.statementDate.toISOString().slice(0, 10),
    periodStart: r.periodStart ? r.periodStart.toISOString().slice(0, 10) : null,
  }));
}

/**
 * Adds one statement line, typed in by hand from the real bank/mobile-
 * money statement (Module 62 added importBankStatementCsv below for a whole
 * downloaded statement; OFX is still unsupported). Starts life UNMATCHED; every line must
 * end up MATCHED, POSTED, or IGNORED before the reconciliation can be
 * completed (see completeBankReconciliation).
 */
export async function addBankStatementLine(params: {
  businessId: string;
  reconciliationId: string;
  createdById: string;
  data: BankStatementLineInput;
}) {
  const { businessId, reconciliationId, createdById, data } = params;
  const reconciliation = await getOpenReconciliationOrThrow(businessId, reconciliationId);

  const line = await prisma.$transaction(async (tx) => {
    await lockOpenReconciliation(tx, businessId, reconciliationId);
    return tx.bankStatementLine.create({
      data: {
        businessId,
        reconciliationId,
        accountId: reconciliation.accountId,
        lineDate: new Date(data.lineDate),
        description: data.description,
        amount: data.amount,
        createdById,
      },
    });
  });
  // Module 64. Typed lines are still ACCEPTED whatever their date (unchanged),
  // but the caller now hears when one falls outside the statement's period.
  const periodFlag = classifyLineDate(
    line.lineDate.toISOString().slice(0, 10),
    reconciliation.statementDate.toISOString().slice(0, 10),
    OUT_OF_PERIOD_LOOKBACK_DAYS,
    reconciliation.periodStart ? reconciliation.periodStart.toISOString().slice(0, 10) : null // Module 69: exact when known
  );
  // Module 70. Also say when the same date + description + amount is already on
  // another statement of this account (still ACCEPTED – a warning only).
  const lineYmd = line.lineDate.toISOString().slice(0, 10);
  const others = await getOtherStatementLines({ businessId, accountId: reconciliation.accountId, reconciliationId, span: { min: lineYmd, max: lineYmd } });
  const repeatsOtherStatement = flagRepeatsOfOtherStatements([{ lineDate: lineYmd, description: line.description, amount: Number(line.amount) }], others)[0].repeatsOtherStatement;
  return { line, periodFlag, repeatsOtherStatement };
}

const IMPORT_PREVIEW_ROWS = 15;
const IMPORT_ERROR_LIST_LIMIT = 25;

export interface ImportBankStatementResult {
  dryRun: boolean;
  delimiter: string;
  columns: StatementColumns;
  warnings: string[]; // Module 63 – non-fatal notes about how the file was read
  totalRows: number; // data rows found (blank rows excluded)
  readableRows: number;
  duplicateRows: number; // readable rows already present in this reconciliation
  // Module 70 – rows (not already duplicates here) whose date + description + amount is on ANOTHER statement of this account.
  repeatedElsewhereRows: number;
  repeatedElsewhereOnlyRows: number; // repeated-elsewhere rows that are NOT also out of period – what skipOtherStatementRepeats removes beyond the period skip
  skippedRepeatedElsewhere: number;
  statementOverlaps: StatementOverlap[]; // other statements sharing days with this one (needs both start dates)
  // Module 64 – statement-period check. statementDate is the reconciliation's own end date.
  statementDate: string; // "YYYY-MM-DD"
  periodStart: string | null; // Module 69 – the recorded first day, or null when unknown (then longBeforeRows is the heuristic)
  afterStatementRows: number; // readable rows dated after statementDate (definite)
  beforeStartRows: number; // Module 69 – readable rows dated before periodStart (definite; always 0 when periodStart is null)
  longBeforeRows: number; // readable rows dated more than OUT_OF_PERIOD_LOOKBACK_DAYS before it (heuristic; always 0 when periodStart is set)
  outOfPeriodOnlyRows: number; // flagged rows that are NOT also duplicates – what skipOutOfPeriod would actually remove
  invalidRowCount: number;
  invalidRows: StatementRowError[]; // first IMPORT_ERROR_LIST_LIMIT only – see invalidRowCount for the real total
  willImport: number; // what a real run would create with the same options
  imported: number; // 0 on a dry run
  skippedDuplicates: number;
  skippedInvalid: number;
  skippedOutOfPeriod: number; // Module 64 – only non-duplicate flagged rows, so nothing is counted twice
  preview: (FlaggedRow & { periodFlag: PeriodFlag | null; repeatsOtherStatement: boolean })[]; // first IMPORT_PREVIEW_ROWS readable rows
}

/**
 * Module 62 – imports a downloaded bank/mobile-money statement CSV as
 * statement lines. Parsing is the pure `parseStatementCsv` (see that file
 * for what formats it understands); this function only adds the parts that
 * need the database: the IN_PROGRESS guard, duplicate detection against the
 * lines already in THIS reconciliation, and the write.
 *
 * Nothing is dropped silently. Unreadable rows block a real import unless the
 * caller passes skipInvalid; rows that already exist are skipped only while
 * skipDuplicates is on; the result reports every count either way, and the
 * write is one transaction (all lines or none) with a single audit row.
 * Imported lines start UNMATCHED like typed ones – importing never matches,
 * posts, or otherwise touches the books.
 */
export async function importBankStatementCsv(params: {
  businessId: string;
  reconciliationId: string;
  createdById: string;
  csv: string;
  format?: "CSV" | "OFX";
  dateOrder: DateOrder;
  dryRun: boolean;
  skipDuplicates: boolean;
  skipInvalid: boolean;
  skipOutOfPeriod: boolean; // Module 64 – default false: out-of-period rows only warn
  skipOtherStatementRepeats: boolean; // Module 70 – default false: rows already on another statement only warn
}): Promise<ImportBankStatementResult> {
  const { businessId, reconciliationId, createdById, csv, format = "CSV", dateOrder, dryRun, skipDuplicates, skipInvalid, skipOutOfPeriod, skipOtherStatementRepeats } = params;
  const reconciliation = await getOpenReconciliationOrThrow(businessId, reconciliationId);

  const parsed = format === "OFX" ? parseStatementOfx(csv) : parseStatementCsv(csv, { dateOrder });
  if (!parsed.ok) throw new BankReconciliationError(parsed.error);

  const existing = await prisma.bankStatementLine.findMany({
    where: { reconciliationId },
    select: { lineDate: true, description: true, amount: true },
  });
  const flagged = flagDuplicates(
    parsed.rows,
    existing.map((e) => ({ lineDate: e.lineDate.toISOString().slice(0, 10), description: e.description, amount: Number(e.amount) }))
  );

  // Module 64. The reconciliation only records its END date, so "after" is
  // definite and "long before" is a heuristic (see OUT_OF_PERIOD_LOOKBACK_DAYS).
  // Module 69: when the reconciliation records its start date the "before" side is
  // exact (BEFORE_START) and the guess is not used at all.
  const statementDate = reconciliation.statementDate.toISOString().slice(0, 10);
  const periodStart = reconciliation.periodStart ? reconciliation.periodStart.toISOString().slice(0, 10) : null;
  const withPeriod = flagOutOfPeriod(flagged, statementDate, OUT_OF_PERIOD_LOOKBACK_DAYS, periodStart);

  // Module 70. Rows already on another statement of this account. A row that is
  // already a duplicate INSIDE this reconciliation is passed over so it is never
  // counted twice (precedence: duplicate, then repeated elsewhere, then out of period).
  const [otherLines, otherPeriods] = await Promise.all([
    getOtherStatementLines({ businessId, accountId: reconciliation.accountId, reconciliationId, span: lineDateSpan(parsed.rows) }),
    getOtherStatementPeriods(businessId, reconciliation.accountId, reconciliationId),
  ]);
  const checked = flagRepeatsOfOtherStatements(withPeriod, otherLines, (r) => r.possibleDuplicate);
  const statementOverlaps = findOverlappingStatements({ periodStart, statementDate }, otherPeriods).overlaps;

  const duplicateRows = checked.filter((r) => r.possibleDuplicate).length;
  const afterStatementRows = checked.filter((r) => r.periodFlag === "AFTER_STATEMENT").length;
  const beforeStartRows = checked.filter((r) => r.periodFlag === "BEFORE_START").length;
  const longBeforeRows = checked.filter((r) => r.periodFlag === "LONG_BEFORE").length;
  // A row that is both a duplicate and out of period is counted as a duplicate
  // only when it's skipped as one, so the skip counts never overlap.
  const repeatedElsewhereRows = checked.filter((r) => r.repeatsOtherStatement).length;
  const outOfPeriodOnlyRows = checked.filter((r) => r.periodFlag !== null && !r.possibleDuplicate && !r.repeatsOtherStatement).length;
  const repeatedElsewhereOnlyRows = checked.filter((r) => r.repeatsOtherStatement && r.periodFlag === null).length;
  const toImport = checked.filter((r) => {
    if (skipDuplicates && r.possibleDuplicate) return false;
    if (skipOtherStatementRepeats && r.repeatsOtherStatement) return false;
    if (skipOutOfPeriod && r.periodFlag !== null) return false;
    return true;
  });
  const invalidRowCount = parsed.errors.length;
  const skippedDuplicates = skipDuplicates ? duplicateRows : 0;
  const skippedRepeatedElsewhere = skipOtherStatementRepeats ? repeatedElsewhereRows : 0;
  const skippedOutOfPeriod = skipOutOfPeriod
    ? checked.filter((r) => r.periodFlag !== null && !(skipDuplicates && r.possibleDuplicate) && !(skipOtherStatementRepeats && r.repeatsOtherStatement)).length
    : 0;
  const skippedInvalid = invalidRowCount;

  const result: ImportBankStatementResult = {
    dryRun,
    delimiter: parsed.delimiter === "\t" ? "tab" : parsed.delimiter,
    columns: parsed.columns,
    warnings: parsed.warnings,
    totalRows: parsed.rows.length + invalidRowCount,
    readableRows: parsed.rows.length,
    duplicateRows,
    repeatedElsewhereRows,
    repeatedElsewhereOnlyRows,
    skippedRepeatedElsewhere,
    statementOverlaps,
    statementDate,
    periodStart,
    afterStatementRows,
    beforeStartRows,
    longBeforeRows,
    outOfPeriodOnlyRows,
    invalidRowCount,
    invalidRows: parsed.errors.slice(0, IMPORT_ERROR_LIST_LIMIT),
    willImport: invalidRowCount > 0 && !skipInvalid ? 0 : toImport.length,
    imported: 0,
    skippedDuplicates,
    skippedInvalid,
    skippedOutOfPeriod,
    preview: checked.slice(0, IMPORT_PREVIEW_ROWS),
  };
  if (dryRun) return result;

  if (invalidRowCount > 0 && !skipInvalid) {
    throw new BankReconciliationError(
      `${invalidRowCount} row${invalidRowCount === 1 ? "" : "s"} couldn't be read (first: row ${parsed.errors[0].rowNumber} – ${parsed.errors[0].message}). Fix the file, or choose to skip the unreadable rows and import the rest.`
    );
  }
  if (toImport.length === 0) {
    throw new BankReconciliationError(
      (duplicateRows > 0 && skipDuplicates) || (skipOutOfPeriod && outOfPeriodOnlyRows > 0) || (skipOtherStatementRepeats && repeatedElsewhereRows > 0)
        ? "Every readable row is already in this reconciliation, already on another statement, or outside its statement period – nothing to import."
        : "There are no readable rows to import."
    );
  }

  await prisma.$transaction(async (tx) => {
    await lockOpenReconciliation(tx, businessId, reconciliationId);

    await tx.bankStatementLine.createMany({
      data: toImport.map((r) => ({
        businessId,
        reconciliationId,
        accountId: reconciliation.accountId,
        lineDate: new Date(`${r.lineDate}T00:00:00.000Z`),
        description: r.description,
        amount: r.amount,
        createdById,
      })),
    });

    await logAudit({
      tx,
      businessId,
      userId: createdById,
      action: "bankrecon.import_lines",
      entityType: "BankReconciliation",
      entityId: reconciliationId,
      metadata: {
        imported: toImport.length,
        skippedDuplicates,
        skippedInvalid,
        skippedOutOfPeriod,
        repeatedElsewhereRows,
        skippedRepeatedElsewhere,
        overlappingStatementIds: statementOverlaps.map((o) => o.id),
        afterStatementRows,
        beforeStartRows,
        longBeforeRows,
        statementDate,
        periodStart,
        readableRows: parsed.rows.length,
        totalRows: result.totalRows,
        dateOrder,
        indicatorColumn: parsed.columns.indicator,
      },
    });
  });

  return { ...result, imported: toImport.length, willImport: toImport.length };
}

/**
 * Module 69 – sets, changes or clears (null) the first day the statement covers,
 * while the reconciliation is still IN_PROGRESS. This is how a reconciliation
 * opened before Module 69 (or without a start date) gets the exact check.
 *
 * Informational only: it changes how lines are FLAGGED, never which lines exist or
 * which book transactions are in scope, so nothing is re-matched or rewritten.
 * The result says how many lines already in the reconciliation now fall outside the
 * period, so the person can look at them – it never deletes or ignores any.
 * Audited with the previous and new value.
 */
export async function setBankReconciliationPeriodStart(params: {
  businessId: string;
  reconciliationId: string;
  updatedById: string;
  data: SetPeriodStartInput;
}) {
  const { businessId, reconciliationId, updatedById, data } = params;
  const reconciliation = await getOpenReconciliationOrThrow(businessId, reconciliationId);

  const endYmd = reconciliation.statementDate.toISOString().slice(0, 10);
  const previous = reconciliation.periodStart ? reconciliation.periodStart.toISOString().slice(0, 10) : null;
  const next = data.periodStart ? data.periodStart.slice(0, 10) : null;
  if (next) {
    const problem = validatePeriodStart(next, endYmd);
    if (problem) throw new BankReconciliationError(problem);
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Re-check inside the transaction: it could have been completed since the read above.
    const claimed = await tx.bankReconciliation.updateMany({
      where: { id: reconciliationId, businessId, status: "IN_PROGRESS" },
      data: { periodStart: next ? new Date(`${next}T00:00:00.000Z`) : null },
    });
    if (claimed.count === 0) throw new BankReconciliationError("This reconciliation is already completed and can no longer be changed.");

    const lines = await tx.bankStatementLine.findMany({ where: { reconciliationId }, select: { lineDate: true } });
    const outOfPeriodLines = lines.filter(
      (l) => classifyLineDate(l.lineDate.toISOString().slice(0, 10), endYmd, OUT_OF_PERIOD_LOOKBACK_DAYS, next) !== null
    ).length;

    await logAudit({
      tx,
      businessId,
      userId: updatedById,
      action: "bankrecon.set_period_start",
      entityType: "BankReconciliation",
      entityId: reconciliationId,
      metadata: { previous, periodStart: next, statementDate: endYmd, outOfPeriodLines },
    });
    return { outOfPeriodLines };
  });

  return { periodStart: next, statementDate: endYmd, outOfPeriodLines: updated.outOfPeriodLines };
}

/**
 * Module 69 – the start date a new reconciliation of this account would naturally
 * have: the day after its latest COMPLETED reconciliation that ends before
 * `statementDate`. A suggestion only (see the pure suggestPeriodStart) – the form
 * pre-fills it and the person confirms or changes it. Null when there is no
 * earlier completed statement.
 */
export async function getSuggestedPeriodStart(params: { businessId: string; accountId: string; statementDate: string }) {
  const { businessId, accountId, statementDate } = params;
  const account = await prisma.cashAccount.findFirst({ where: { id: accountId, businessId }, select: { id: true } });
  if (!account) throw new BankReconciliationError("Cash account not found.", 404);

  const end = statementDate.slice(0, 10);
  const previous = await prisma.bankReconciliation.findMany({
    where: { businessId, accountId, status: "COMPLETED", statementDate: { lt: new Date(`${end}T00:00:00.000Z`) } },
    select: { statementDate: true },
    orderBy: { statementDate: "desc" },
    take: 1,
  });
  const suggested = suggestPeriodStart(
    previous.map((p) => p.statementDate.toISOString().slice(0, 10)),
    end
  );
  return {
    suggestedPeriodStart: suggested,
    previousStatementDate: previous[0] ? previous[0].statementDate.toISOString().slice(0, 10) : null,
  };
}

/**
 * Removes a statement line that was typed in wrong – only while it's
 * still UNMATCHED (never had any book effect) and its reconciliation is
 * still IN_PROGRESS. A MATCHED/POSTED/IGNORED line is a decision already
 * made; use unmatchBankStatementLine / unpostBankStatementLine first if it
 * needs to be undone.
 */
export async function deleteBankStatementLine(params: { businessId: string; lineId: string; deletedById: string }) {
  const { businessId, lineId } = params;
  const line = await prisma.bankStatementLine.findFirst({ where: { id: lineId, businessId } });
  if (!line) throw new BankReconciliationError("Statement line not found.");
  await getOpenReconciliationOrThrow(businessId, line.reconciliationId);
  if (line.status !== "UNMATCHED") {
    throw new BankReconciliationError("Only an unmatched line can be deleted – unmatch, unpost, or un-ignore it first.");
  }
  await prisma.$transaction(async (tx) => {
    await lockOpenReconciliation(tx, businessId, line.reconciliationId);
    const deleted = await tx.bankStatementLine.deleteMany({ where: { id: lineId, businessId, status: "UNMATCHED" } });
    if (deleted.count === 0) throw new BankReconciliationError("Only an unmatched line can be deleted – unmatch, unpost, or un-ignore it first.");
  });
}

/**
 * Links a statement line to a book transaction the business already
 * recorded – the common case (a Sale receipt, an Expense payment) already
 * showing up on the bank's side too. The @@unique on
 * BankStatementLine.matchedTransactionId (not application logic alone)
 * is what prevents matching the same book transaction twice.
 */
export async function matchBankStatementLine(params: {
  businessId: string;
  lineId: string;
  transactionId: string;
  matchedById: string;
}) {
  const { businessId, lineId, transactionId, matchedById } = params;

  const line = await prisma.bankStatementLine.findFirst({ where: { id: lineId, businessId } });
  if (!line) throw new BankReconciliationError("Statement line not found.");
  await getOpenReconciliationOrThrow(businessId, line.reconciliationId);
  if (line.status !== "UNMATCHED") {
    throw new BankReconciliationError("This line has already been handled – unmatch it first to re-match.");
  }

  const transaction = await prisma.cashTransaction.findFirst({
    where: { id: transactionId, businessId, accountId: line.accountId },
  });
  if (!transaction) throw new BankReconciliationError("Book transaction not found on this account.");
  const alreadyMatched = await prisma.bankStatementLine.findFirst({ where: { matchedTransactionId: transactionId } });
  if (alreadyMatched) {
    throw new BankReconciliationError("That book transaction is already matched to a different statement line.");
  }

  return prisma.$transaction(async (tx) => {
    await lockOpenReconciliation(tx, businessId, line.reconciliationId);
    const changed = await tx.bankStatementLine.updateMany({
      where: { id: lineId, businessId, status: "UNMATCHED" },
      data: { status: "MATCHED", matchedTransactionId: transactionId },
    });
    if (changed.count === 0) throw new BankReconciliationError("This line has already been handled – unmatch it first to re-match.");
    await logAudit({ tx, businessId, userId: matchedById, action: "bankrecon.match", entityType: "BankStatementLine", entityId: lineId, metadata: { transactionId, amount: Number(line.amount) } });
    return tx.bankStatementLine.findUniqueOrThrow({ where: { id: lineId } });
  });
}

/** Undoes a match, putting the line back to UNMATCHED. Never touches the underlying CashTransaction – it was real and stays exactly as it was. */
export async function unmatchBankStatementLine(params: { businessId: string; lineId: string; unmatchedById: string }) {
  const { businessId, lineId, unmatchedById } = params;
  const line = await prisma.bankStatementLine.findFirst({ where: { id: lineId, businessId } });
  if (!line) throw new BankReconciliationError("Statement line not found.");
  await getOpenReconciliationOrThrow(businessId, line.reconciliationId);
  if (line.status !== "MATCHED") throw new BankReconciliationError("This line isn't matched.");

  return prisma.$transaction(async (tx) => {
    await lockOpenReconciliation(tx, businessId, line.reconciliationId);
    const changed = await tx.bankStatementLine.updateMany({ where: { id: lineId, businessId, status: "MATCHED" }, data: { status: "UNMATCHED", matchedTransactionId: null } });
    if (changed.count === 0) throw new BankReconciliationError("This line isn't matched.");
    await logAudit({ tx, businessId, userId: unmatchedById, action: "bankrecon.unmatch", entityType: "BankStatementLine", entityId: lineId });
    return tx.bankStatementLine.findUniqueOrThrow({ where: { id: lineId } });
  });
}

/**
 * Marks a line as deliberately excluded from reconciliation – e.g. a
 * duplicate the bank printed twice, or a line that turns out to belong to
 * a different account. Always requires a conscious action (never silent),
 * same philosophy as void-don't-delete elsewhere in this app: the line
 * stays visible with its status and reason, not removed from history.
 */
export async function ignoreBankStatementLine(params: {
  businessId: string;
  lineId: string;
  reason?: string | null;
  ignoredById: string;
}) {
  const { businessId, lineId, reason, ignoredById } = params;
  const line = await prisma.bankStatementLine.findFirst({ where: { id: lineId, businessId } });
  if (!line) throw new BankReconciliationError("Statement line not found.");
  await getOpenReconciliationOrThrow(businessId, line.reconciliationId);
  if (line.status !== "UNMATCHED") {
    throw new BankReconciliationError("Only an unmatched line can be ignored – unmatch or unpost it first.");
  }

  return prisma.$transaction(async (tx) => {
    await lockOpenReconciliation(tx, businessId, line.reconciliationId);
    const changed = await tx.bankStatementLine.updateMany({
      where: { id: lineId, businessId, status: "UNMATCHED" },
      data: { status: "IGNORED", description: reason ? `${line.description} – ignored: ${reason}` : line.description },
    });
    if (changed.count === 0) throw new BankReconciliationError("Only an unmatched line can be ignored – unmatch or unpost it first.");
    await logAudit({ tx, businessId, userId: ignoredById, action: "bankrecon.ignore", entityType: "BankStatementLine", entityId: lineId, metadata: { reason: reason ?? undefined } });
    return tx.bankStatementLine.findUniqueOrThrow({ where: { id: lineId } });
  });
}

/** Puts an IGNORED line back to UNMATCHED, in case it was ignored by mistake. */
export async function unignoreBankStatementLine(params: { businessId: string; lineId: string; unignoredById: string }) {
  const { businessId, lineId, unignoredById } = params;
  const line = await prisma.bankStatementLine.findFirst({ where: { id: lineId, businessId } });
  if (!line) throw new BankReconciliationError("Statement line not found.");
  await getOpenReconciliationOrThrow(businessId, line.reconciliationId);
  if (line.status !== "IGNORED") throw new BankReconciliationError("This line isn't ignored.");

  return prisma.$transaction(async (tx) => {
    await lockOpenReconciliation(tx, businessId, line.reconciliationId);
    const changed = await tx.bankStatementLine.updateMany({ where: { id: lineId, businessId, status: "IGNORED" }, data: { status: "UNMATCHED" } });
    if (changed.count === 0) throw new BankReconciliationError("This line isn't ignored.");
    await logAudit({ tx, businessId, userId: unignoredById, action: "bankrecon.unignore", entityType: "BankStatementLine", entityId: lineId });
    return tx.bankStatementLine.findUniqueOrThrow({ where: { id: lineId } });
  });
}

/**
 * The reason this module exists: a statement line the business genuinely
 * never recorded (a bank charge, an interest credit) gets posted for real
 * – to both the Cashbook and the GL, in one transaction – the same
 * "create row, then Cashbook, then GL" sequence every other module in
 * this app follows. See postCashTransactionForBankReconciliationAdjustment
 * and postJournalEntryForBankReconciliationAdjustment.
 */
export async function postBankStatementLineAdjustment(params: {
  businessId: string;
  lineId: string;
  postedById: string;
}) {
  const { businessId, lineId, postedById } = params;

  const line = await prisma.bankStatementLine.findFirst({ where: { id: lineId, businessId }, include: { account: true } });
  if (!line) throw new BankReconciliationError("Statement line not found.");
  await getOpenReconciliationOrThrow(businessId, line.reconciliationId);
  if (line.status !== "UNMATCHED") {
    throw new BankReconciliationError("This line has already been handled.");
  }

  const amount = Number(line.amount);

  await prisma.$transaction(async (tx) => {
    await lockOpenReconciliation(tx, businessId, line.reconciliationId);

    // Claim the statement line before creating either ledger entry. A prior
    // read is not enough: concurrent requests could both observe UNMATCHED
    // and post the same bank movement. The claim rolls back with the ledger
    // writes if either posting fails.
    const claimed = await tx.bankStatementLine.updateMany({
      where: { id: lineId, businessId, reconciliationId: line.reconciliationId, status: "UNMATCHED" },
      data: { status: "POSTED" },
    });
    if (claimed.count === 0) {
      throw new BankReconciliationError("This line has already been handled.");
    }

    await postCashTransactionForBankReconciliationAdjustment({
      tx,
      businessId,
      accountId: line.accountId,
      lineId: line.id,
      amount,
      description: `Bank statement: ${line.description}`,
      createdById: postedById,
    });

    await postJournalEntryForBankReconciliationAdjustment({
      tx,
      businessId,
      lineId: line.id,
      cashAccountType: line.account.type,
      amount,
      description: `Bank statement: ${line.description}`,
      createdById: postedById,
    });

    await logAudit({
      tx,
      businessId,
      userId: postedById,
      action: "bankrecon.post_adjustment",
      entityType: "BankStatementLine",
      entityId: lineId,
      metadata: { amount },
    });
  });

  return prisma.bankStatementLine.findUniqueOrThrow({ where: { id: lineId } });
}

/**
 * Reverses a posted adjustment – equal-and-opposite CashTransaction (see
 * reverseCashTransactionsForReference) and journal entry (see
 * reverseJournalEntriesForReference), both keyed off referenceType
 * "BankReconciliationAdjustment" + referenceId = lineId. Only while the
 * reconciliation is still IN_PROGRESS – once completed, a posted
 * adjustment is part of the accounting history.
 */
export async function unpostBankStatementLineAdjustment(params: {
  businessId: string;
  lineId: string;
  unpostedById: string;
}) {
  const { businessId, lineId, unpostedById } = params;

  const line = await prisma.bankStatementLine.findFirst({ where: { id: lineId, businessId } });
  if (!line) throw new BankReconciliationError("Statement line not found.");
  await getOpenReconciliationOrThrow(businessId, line.reconciliationId);
  if (line.status !== "POSTED") throw new BankReconciliationError("This line hasn't been posted.");

  await prisma.$transaction(async (tx) => {
    await lockOpenReconciliation(tx, businessId, line.reconciliationId);
    const claimed = await tx.bankStatementLine.updateMany({
      where: { id: lineId, businessId, status: "POSTED" },
      data: { status: "UNMATCHED" },
    });
    if (claimed.count === 0) throw new BankReconciliationError("This line has already been unposted.");

    await reverseCashTransactionsForReference({
      tx,
      businessId,
      referenceType: "BankReconciliationAdjustment",
      referenceId: lineId,
      createdById: unpostedById,
      reason: `Reversing posted bank statement line: ${line.description}`,
    });
    await reverseJournalEntriesForReference({
      tx,
      businessId,
      referenceType: "BankReconciliationAdjustment",
      referenceId: lineId,
      createdById: unpostedById,
      reason: `Reversing posted bank statement line: ${line.description}`,
    });
    await logAudit({
      tx,
      businessId,
      userId: unpostedById,
      action: "bankrecon.unpost_adjustment",
      entityType: "BankStatementLine",
      entityId: lineId,
    });
  });

  return prisma.bankStatementLine.findUniqueOrThrow({ where: { id: lineId } });
}

/**
 * Read-only helper: for every still-UNMATCHED line, suggests unmatched
 * book transactions on the same account with the exact same amount within
 * a +/- 3 day window of the statement line's date. A suggestion, not an
 * auto-match – the operator still confirms each one via
 * matchBankStatementLine, since two genuinely different transactions can
 * share an amount (e.g. two MWK 5,000 sales the same week).
 */
export async function suggestBankStatementMatches(businessId: string, reconciliationId: string) {
  const reconciliation = await prisma.bankReconciliation.findFirst({ where: { id: reconciliationId, businessId } });
  if (!reconciliation) throw new BankReconciliationError("Reconciliation not found.");

  const unmatchedLines = await prisma.bankStatementLine.findMany({
    where: { businessId, reconciliationId, status: "UNMATCHED" },
  });

  const candidateTransactions = await prisma.cashTransaction.findMany({
    where: { businessId, accountId: reconciliation.accountId },
  });
  const matchedLines = await prisma.bankStatementLine.findMany({
    where: { businessId, accountId: reconciliation.accountId, matchedTransactionId: { not: null } },
    select: { matchedTransactionId: true },
  });
  const alreadyMatchedIds = new Set(matchedLines.map((l) => l.matchedTransactionId));
  const unmatchedTransactions = candidateTransactions.filter((t) => !alreadyMatchedIds.has(t.id));

  const WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
  const suggestions: { lineId: string; transactionId: string; description: string | null; amount: number; createdAt: Date }[] = [];

  for (const line of unmatchedLines) {
    const lineAmount = round2(Number(line.amount));
    const lineTime = line.lineDate.getTime();
    for (const txn of unmatchedTransactions) {
      if (round2(Number(txn.amount)) !== lineAmount) continue;
      if (Math.abs(txn.createdAt.getTime() - lineTime) > WINDOW_MS) continue;
      suggestions.push({ lineId: line.id, transactionId: txn.id, description: txn.description, amount: Number(txn.amount), createdAt: txn.createdAt });
    }
  }

  return suggestions;
}

/**
 * The reconciliation's working view: every line, plus a running summary
 * comparing the account's live book balance (as of right now – this app
 * has no per-transaction "date" distinct from createdAt, so "as of
 * statementDate" would just mean the same live balance minus anything
 * posted after; simpler and just as honest to show the current balance
 * and let the operator judge) against the statement's ending balance.
 * The difference is informational, not a completion gate on its own – a
 * same-day transaction the bank hasn't processed yet is normal and will
 * clear on next month's statement. What completeBankReconciliation
 * actually requires is that every line has been looked at and handled.
 */
export async function getBankReconciliation(businessId: string, reconciliationId: string) {
  const reconciliation = await prisma.bankReconciliation.findFirst({
    where: { id: reconciliationId, businessId },
    include: {
      account: { select: { id: true, name: true, type: true } },
      lines: { orderBy: { lineDate: "asc" }, include: { matchedTransaction: true } },
    },
  });
  if (!reconciliation) return null;

  const currentBookBalance = await getAccountBalance(reconciliation.accountId);
  const statementEndingBalance = Number(reconciliation.statementEndingBalance);
  const difference = round2(statementEndingBalance - currentBookBalance);

  const counts = {
    unmatched: reconciliation.lines.filter((l) => l.status === "UNMATCHED").length,
    matched: reconciliation.lines.filter((l) => l.status === "MATCHED").length,
    posted: reconciliation.lines.filter((l) => l.status === "POSTED").length,
    ignored: reconciliation.lines.filter((l) => l.status === "IGNORED").length,
  };

  // Module 50: reopen count and timeline are both read live off AuditLog –
  // see reopen-audit.ts for why this is computed rather than stored.
  // Module 51: the cap itself is now the business's own setting, not a
  // shared constant – fetched alongside so the UI never has to import it.
  // Module 52: history is now the first PAGE, not the whole thing – a
  // `historyNextCursor` tells the UI whether the reopen-history route has
  // more to fetch.
  const [reopenCount, historyPage, business] = await Promise.all([
    countReopens(businessId, "BankReconciliation", reconciliationId),
    getReopenHistory(businessId, "BankReconciliation", reconciliationId),
    prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { maxReopens: true } }),
  ]);

  // Module 69: lines already in the reconciliation that sit outside its period,
  // computed live (never stored) so it stays right when the start date is set or
  // changed. Same classifier the add-line and import checks use.
  const endYmd = reconciliation.statementDate.toISOString().slice(0, 10);
  const startYmd = reconciliation.periodStart ? reconciliation.periodStart.toISOString().slice(0, 10) : null;
  const outOfPeriodLines = reconciliation.lines.filter(
    (l) => classifyLineDate(l.lineDate.toISOString().slice(0, 10), endYmd, OUT_OF_PERIOD_LOOKBACK_DAYS, startYmd) !== null
  ).length;

  // Module 70: other statements of this account sharing days with this one, and
  // lines here that already appear on another statement (count-aware). Both are
  // computed live, never stored, with the same pure functions the client uses.
  const lineRows = reconciliation.lines.map((l) => ({ id: l.id, lineDate: l.lineDate.toISOString().slice(0, 10), description: l.description, amount: Number(l.amount) }));
  const [otherPeriods, otherLines] = await Promise.all([
    getOtherStatementPeriods(businessId, reconciliation.accountId, reconciliationId),
    getOtherStatementLines({ businessId, accountId: reconciliation.accountId, reconciliationId, span: lineDateSpan(lineRows) }),
  ]);
  const overlapResult = findOverlappingStatements({ periodStart: startYmd, statementDate: endYmd }, otherPeriods);
  const repeatedLineIds = flagRepeatsOfOtherStatements(lineRows, otherLines)
    .filter((r) => r.repeatsOtherStatement)
    .map((r) => r.id);

  return {
    ...reconciliation,
    statementEndingBalance,
    bookBalanceAtStart: Number(reconciliation.bookBalanceAtStart),
    outOfPeriodLines,
    statementOverlaps: overlapResult.overlaps,
    overlapNotComparable: overlapResult.notComparable,
    repeatedLineIds,
    lines: reconciliation.lines.map((l) => ({ ...l, amount: Number(l.amount) })),
    currentBookBalance,
    difference,
    counts,
    readyToComplete: counts.unmatched === 0,
    reopenCount,
    maxReopens: business.maxReopens,
    reopensRemaining: Math.max(0, business.maxReopens - reopenCount),
    history: historyPage.rows,
    historyNextCursor: historyPage.nextCursor,
  };
}

export async function listBankReconciliations(businessId: string, accountId?: string) {
  const reconciliations = await prisma.bankReconciliation.findMany({
    where: { businessId, ...(accountId ? { accountId } : {}) },
    include: { account: { select: { id: true, name: true, type: true } } },
    orderBy: { statementDate: "desc" },
  });
  return reconciliations.map((r) => ({
    ...r,
    statementEndingBalance: Number(r.statementEndingBalance),
    bookBalanceAtStart: Number(r.bookBalanceAtStart),
  }));
}

/**
 * Locks the reconciliation in. Requires every line to be MATCHED, POSTED,
 * or IGNORED – i.e. the operator has actually looked at and accounted for
 * everything the bank statement says happened, which is the real point of
 * reconciling (catching a fee or an error, not just producing a balance).
 * A non-zero balance difference at completion time is allowed and shown,
 * not blocked – legitimate timing gaps (a transaction recorded today that
 * the bank hasn't processed) are normal and don't mean something is wrong.
 *
 * A completed reconciliation CAN be reopened – see reopenBankReconciliation
 * below – but only as a deliberate, reasoned Owner act, not by editing
 * this function's own gate.
 */
export async function completeBankReconciliation(params: { businessId: string; reconciliationId: string; completedById: string }) {
  const { businessId, reconciliationId, completedById } = params;

  const reconciliation = await getOpenReconciliationOrThrow(businessId, reconciliationId);
  const result = await prisma.$transaction(async (tx) => {
    // Claim the parent row first. Every line mutation takes this same lock,
    // so completion sees all prior writes and prevents later ones.
    const claimed = await tx.bankReconciliation.updateMany({
      where: { id: reconciliationId, businessId, status: "IN_PROGRESS" },
      data: { status: "COMPLETED", completedAt: new Date(), completedById },
    });
    if (claimed.count === 0) {
      throw new BankReconciliationError("This reconciliation has already been completed.");
    }

    const unmatchedCount = await tx.bankStatementLine.count({
      where: { businessId, reconciliationId, status: "UNMATCHED" },
    });
    if (unmatchedCount > 0) {
      throw new BankReconciliationError(
        `${unmatchedCount} statement line${unmatchedCount === 1 ? "" : "s"} still need${unmatchedCount === 1 ? "s" : ""} to be matched, posted, or ignored before this reconciliation can be completed.`
      );
    }

    const account = await tx.cashAccount.findUniqueOrThrow({ where: { id: reconciliation.accountId } });
    const cash = await tx.cashTransaction.aggregate({ where: { accountId: reconciliation.accountId }, _sum: { amount: true } });
    const currentBookBalance = round2(Number(account.openingBalance) + Number(cash._sum.amount ?? 0));
    const difference = round2(Number(reconciliation.statementEndingBalance) - currentBookBalance);

    await logAudit({
      tx,
      businessId,
      userId: completedById,
      action: "bankrecon.complete",
      entityType: "BankReconciliation",
      entityId: reconciliationId,
      metadata: { difference, statementEndingBalance: Number(reconciliation.statementEndingBalance) },
    });

    const completed = await tx.bankReconciliation.findUniqueOrThrow({ where: { id: reconciliationId } });
    return { reconciliation: completed, difference };
  });

  return result;
}

/**
 * Module 48. Puts a COMPLETED reconciliation back to IN_PROGRESS so a
 * mistake found after the fact – a line matched to the wrong transaction,
 * a bank-fee adjustment posted twice, a line that should have been
 * ignored – can actually be corrected, instead of only being fixed by a
 * separate, disconnected manual journal.
 *
 * Deliberately the SAME shape as Period Close's close/reopen split
 * (Module 42): completing a reconciliation is an ordinary accounting act
 * (`bankrecon.manage`, Owner + Accountant); reopening one that's already
 * completed is bigger – undoing a signed-off statement match – so it also
 * needs `business.settings.manage` (Owner only). The caller (the API
 * route) resolves that permission and passes the result in as `canReopen`,
 * the same division of labour requireApiContext/hasPermission already
 * follow elsewhere; this function only enforces the boolean, it doesn't
 * know how to check permissions itself.
 *
 * A reason is required – never a silent reopen – logged to AuditLog and
 * also snapshotted onto the row itself (see the schema comment on
 * `reopenedAt` for why only the most recent reopen lives there).
 *
 * Guards against the one real hazard: by the time this reconciliation is
 * reopened, the business may already have opened a NEWER one for the same
 * account (e.g. next month's statement) – openBankReconciliation's own
 * "only one IN_PROGRESS per account" rule would otherwise be silently
 * broken. Reopening an older one while a newer one is mid-flight is
 * refused with a pointer to finish or delete that newer one first.
 *
 * Once reopened, every existing per-line function (match/unmatch/post/
 * unpost/ignore/unignore, add/delete line) works completely unchanged –
 * they all gate on status === IN_PROGRESS via getOpenReconciliationOrThrow,
 * which this function's own status update now satisfies again. That
 * includes unpostBankStatementLineAdjustment: a POSTED line's adjustment
 * (real Cashbook + GL entries) can now genuinely be undone after the fact,
 * not just a matched line re-matched. bookBalanceAtStart is left exactly
 * as it was snapshotted at original open time – reopening doesn't restart
 * the reconciliation, it resumes it.
 *
 * Module 54: an optional `lineId` names which statement line the reopen is
 * actually about – closing the KNOWN LIMITATION documented since this
 * function first shipped ("a reopen's reason is still free text, not tied
 * to a specific line"). Verified to belong to THIS reconciliation before
 * anything is written, same "don't trust an id without checking ownership"
 * rule every other line lookup in this file follows. A short label is
 * resolved once, here, and snapshotted into the AuditLog entry (see
 * reopen-audit.ts) so the history reads correctly even after the line
 * itself is later deleted (deleteBankStatementLine allows this while
 * UNMATCHED) – the same reasoning `reason` being free text already needed:
 * a fact worth keeping has to be captured at the moment it's true.
 */
export async function reopenBankReconciliation(params: {
  businessId: string;
  reconciliationId: string;
  reason: string;
  lineId?: string | null;
  reopenedById: string;
  canReopen: boolean;
}) {
  const { businessId, reconciliationId, reopenedById, canReopen } = params;
  const reason = params.reason.trim();

  if (!canReopen) {
    throw new BankReconciliationError("Only the Owner can reopen a completed reconciliation.", 403);
  }
  if (!reason) {
    throw new BankReconciliationError("A reason is required to reopen a completed reconciliation.");
  }

  const reconciliation = await prisma.bankReconciliation.findFirst({ where: { id: reconciliationId, businessId } });
  if (!reconciliation) throw new BankReconciliationError("Reconciliation not found.");
  if (reconciliation.status !== "COMPLETED") {
    throw new BankReconciliationError("Only a completed reconciliation can be reopened.");
  }

  const lineId = params.lineId || null;
  return prisma.$transaction(async (tx) => {
    // Serialize reopen with new reconciliations and other reopens for the
    // same cash account, preserving the one-open-statement invariant.
    const accountLock = await tx.cashAccount.updateMany({
      where: { id: reconciliation.accountId, businessId },
      data: { updatedAt: new Date() },
    });
    if (accountLock.count === 0) throw new BankReconciliationError("Cash account not found.");

    const conflicting = await tx.bankReconciliation.findFirst({
      where: { businessId, accountId: reconciliation.accountId, status: "IN_PROGRESS", id: { not: reconciliationId } },
    });
    if (conflicting) {
      throw new BankReconciliationError(
        "This account already has a different reconciliation in progress. Finish or delete it before reopening an earlier one."
      );
    }

    let lineLabel: string | null = null;
    if (lineId) {
      const line = await tx.bankStatementLine.findFirst({ where: { id: lineId, businessId, reconciliationId } });
      if (!line) throw new BankReconciliationError("That statement line doesn't belong to this reconciliation.");
      lineLabel = `${line.description} (${line.lineDate.toISOString().slice(0, 10)})`;
    }

    const [priorReopens, business] = await Promise.all([
      countReopens(businessId, "BankReconciliation", reconciliationId),
      tx.business.findUniqueOrThrow({ where: { id: businessId }, select: { maxReopens: true } }),
    ]);
    if (priorReopens >= business.maxReopens) {
      throw new BankReconciliationError(reopenCapMessage("reconciliation", business.maxReopens));
    }

    const changed = await tx.bankReconciliation.updateMany({
      where: { id: reconciliationId, businessId, status: "COMPLETED" },
      data: { status: "IN_PROGRESS", reopenedAt: new Date(), reopenedById, reopenReason: reason, reopenLineId: lineId },
    });
    if (changed.count === 0) throw new BankReconciliationError("Only a completed reconciliation can be reopened.");
    const reopened = await tx.bankReconciliation.findUniqueOrThrow({ where: { id: reconciliationId } });

    await logAudit({
      tx,
      businessId,
      userId: reopenedById,
      action: "bankrecon.reopen",
      entityType: "BankReconciliation",
      entityId: reconciliationId,
      metadata: { reason, previousCompletedAt: reconciliation.completedAt, lineId, lineLabel },
    });
    return reopened;
  });
}

/**
 * Deletes an IN_PROGRESS reconciliation outright – only while no line has
 * been POSTED (a posted line has real Cashbook/GL effect; unpost it first,
 * the same "void, don't silently delete" rule the rest of this app
 * follows once something has touched the ledger for real). MATCHED lines
 * are safe to cascade-delete: matching never creates anything, it only
 * links to a CashTransaction that already existed and stays exactly as it
 * was.
 */
export async function deleteBankReconciliation(params: { businessId: string; reconciliationId: string; deletedById: string }) {
  const { businessId, reconciliationId, deletedById } = params;
  const reconciliation = await getOpenReconciliationOrThrow(businessId, reconciliationId);

  await prisma.$transaction(async (tx) => {
    await lockOpenReconciliation(tx, businessId, reconciliationId);
    const postedCount = await tx.bankStatementLine.count({
      where: { businessId, reconciliationId, status: "POSTED" },
    });
    if (postedCount > 0) {
      throw new BankReconciliationError(
        "This reconciliation has posted adjustments – unpost them before deleting the reconciliation."
      );
    }

    await tx.bankReconciliation.delete({ where: { id: reconciliationId } });
    await logAudit({
      tx,
      businessId,
      userId: deletedById,
      action: "bankrecon.delete",
      entityType: "BankReconciliation",
      entityId: reconciliationId,
      metadata: { accountId: reconciliation.accountId },
    });
  });
}
