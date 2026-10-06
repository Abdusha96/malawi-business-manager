import { prisma } from "./prisma";
import { Prisma } from "@prisma/client";
import { SYSTEM_ACCOUNTS, normalBalanceForType } from "./chart-of-accounts";
import { checkRecordDate } from "./period-lock";
import { resolveTimeZone } from "./timezone";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export class AccountingError extends Error {}

/**
 * Module 42: a record dated in a closed period. Extends AccountingError so every route that
 * already turns an AccountingError into a 400 (manual journals, tax payments, FX adjustments)
 * handles it with no change. Routes that did not catch AccountingError before add it.
 */
export class PeriodClosedError extends AccountingError {}

/**
 * Seeds the standard chart of accounts for a new business. Called once, at
 * registration (mirrors the Cashbook's default-account and Payroll's
 * default-tax-config seeding from Modules 9 and 10).
 */
export async function seedChartOfAccounts(tx: Prisma.TransactionClient, businessId: string) {
  await tx.account.createMany({
    data: SYSTEM_ACCOUNTS.map((def) => ({
      businessId,
      code: def.code,
      name: def.name,
      type: def.type,
      normalBalance: normalBalanceForType(def.type),
      systemKey: def.key,
      isSystemAccount: true,
    })),
  });
}

/**
 * Looks up a system account by its stable key (never by code or name,
 * which are user-editable). Throws loudly rather than silently skipping a
 * posting if a business's chart of accounts is somehow missing an account
 * the posting engine depends on.
 */
export async function getSystemAccountId(
  tx: Prisma.TransactionClient,
  businessId: string,
  systemKey: string
): Promise<string> {
  const account = await tx.account.findUnique({
    where: { businessId_systemKey: { businessId, systemKey } },
  });
  if (!account) {
    throw new AccountingError(
      `Missing system account "${systemKey}" for this business. Chart of accounts may not have been seeded – contact support.`
    );
  }
  return account.id;
}

/**
 * Same lookup as getSystemAccountId, but creates the account on the fly if
 * it's missing rather than throwing. Needed because SYSTEM_ACCOUNTS grows
 * over time (Module 16 added two new keys for refund credit notes) and
 * seedChartOfAccounts() only ever runs once, at registration – a business
 * that registered before this module existed has a chart of accounts
 * that's missing these keys entirely. Mirrors the backfill pattern Module
 * 14 used for planHasFeature() on already-existing data. Only use this for
 * accounts a business could plausibly not have yet; established accounts
 * (Cash, AR, Inventory, ...) should keep using getSystemAccountId so a
 * genuinely broken chart of accounts still fails loudly.
 */
export async function getOrCreateSystemAccountId(
  tx: Prisma.TransactionClient,
  businessId: string,
  systemKey: string
): Promise<string> {
  const existing = await tx.account.findUnique({
    where: { businessId_systemKey: { businessId, systemKey } },
  });
  if (existing) return existing.id;

  const def = SYSTEM_ACCOUNTS.find((a) => a.key === systemKey);
  if (!def) {
    throw new AccountingError(`"${systemKey}" is not a known system account key.`);
  }

  // Module 33: Account has @@unique([businessId, code]), and a business
  // that registered before this system account existed may already have
  // hand-created an account using the code SYSTEM_ACCOUNTS now reserves for
  // it (codes are user-editable and nothing stops a user picking one).
  // Rather than fail the very first posting with a unique-constraint error,
  // step to the next free numeric code – the code carries no logic (see the
  // header of chart-of-accounts.ts), only systemKey does.
  let code = def.code;
  for (let attempts = 0; attempts < 50; attempts++) {
    const taken = await tx.account.findUnique({ where: { businessId_code: { businessId, code } } });
    if (!taken) break;
    code = String(Number(def.code) + attempts + 1);
  }

  const created = await tx.account.create({
    data: {
      businessId,
      code,
      name: def.name,
      type: def.type,
      normalBalance: normalBalanceForType(def.type),
      systemKey: def.key,
      isSystemAccount: true,
    },
  });
  return created.id;
}

export interface JournalLineInput {
  accountId: string;
  debit?: number;
  credit?: number;
  description?: string;
}

/**
 * THE single place a JournalEntry is created. Enforces the one rule that
 * makes double-entry bookkeeping meaningful: total debits must equal total
 * credits. Every integration point (Sales, Purchases, Expenses, Payroll,
 * Transfers, Payments) calls this rather than writing to JournalEntry
 * directly.
 */
export async function postJournalEntry(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  description: string;
  lines: JournalLineInput[];
  referenceType?: string;
  referenceId?: string;
  createdById: string;
  entryDate?: Date;
}) {
  const { tx, businessId, lines } = params;

  if (lines.length < 2) {
    throw new AccountingError("A journal entry needs at least two lines (one debit, one credit).");
  }

  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of lines) {
    const debit = round2(line.debit ?? 0);
    const credit = round2(line.credit ?? 0);
    if (debit > 0 && credit > 0) {
      throw new AccountingError("A journal line cannot have both a debit and a credit.");
    }
    if (debit === 0 && credit === 0) {
      throw new AccountingError("A journal line must have a non-zero debit or credit.");
    }
    totalDebit = round2(totalDebit + debit);
    totalCredit = round2(totalCredit + credit);
  }

  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new AccountingError(
      `Journal entry does not balance: debits ${totalDebit} != credits ${totalCredit}. This is a bug in the calling code, not a user error.`
    );
  }

  const business = await tx.business.update({
    where: { id: businessId },
    data: { nextJournalEntryNumber: { increment: 1 } },
  });

  // Module 42 (Period Close): refuse an entry whose explicit date is in a closed period. This
  // is THE choke point, so manual journals, depreciation runs, tax payments and FX adjustments
  // are all covered by this one check. Only an explicit entryDate is checked: an undated entry
  // is dated "now", which the lock can never cover (see period-lock.ts). The update above just
  // took the Business row lock, so `business` is the row as of that lock. A close that committed
  // first is seen here, and a close that comes later waits for this transaction. Throwing rolls
  // back the number increment with the rest of the transaction.
  if (params.entryDate) {
    const refusal = checkRecordDate({
      closedThrough: business.booksClosedThrough,
      instant: params.entryDate,
      tz: resolveTimeZone(business.timezone),
      what: "this journal entry",
      mode: "date",
    });
    if (refusal) throw new PeriodClosedError(refusal);
  }

  // Lock every referenced account in a stable order before writing lines.
  // Account deactivation takes the same row lock before checking history, so
  // it cannot slip between the "never posted" check and this journal write.
  // This comes after the Business lock above because callers that check the
  // period earlier already use the same Business -> Account lock order.
  const accountIds = Array.from(new Set(lines.map((line) => line.accountId))).sort();
  for (const accountId of accountIds) {
    const accountClaim = await tx.account.updateMany({
      where: { id: accountId, businessId, isActive: true },
      data: { isActive: true },
    });
    if (accountClaim.count === 0) {
      throw new AccountingError("A journal line refers to an account that is missing, inactive, or belongs to another business.");
    }
  }

  const entryNumber = `${business.journalEntryPrefix}-${String(business.nextJournalEntryNumber - 1).padStart(6, "0")}`;

  return tx.journalEntry.create({
    data: {
      businessId,
      entryNumber,
      entryDate: params.entryDate ?? new Date(),
      description: params.description,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      createdById: params.createdById,
      lines: {
        create: lines.map((l) => ({
          accountId: l.accountId,
          debit: round2(l.debit ?? 0),
          credit: round2(l.credit ?? 0),
          description: l.description,
        })),
      },
    },
    include: { lines: true },
  });
}

/**
 * An account's balance, expressed in its normal-balance direction (so an
 * ASSET account with more debits than credits shows a positive number, and
 * so does a LIABILITY account with more credits than debits – both read as
 * "the amount this account holds," not raw debit-minus-credit which would
 * make liabilities show negative).
 */
export async function getAccountBalance(businessId: string, accountId: string, asOf?: Date): Promise<number> {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });

  const agg = await prisma.journalLine.aggregate({
    where: {
      accountId,
      journalEntry: { businessId, ...(asOf ? { entryDate: { lte: asOf } } : {}) },
    },
    _sum: { debit: true, credit: true },
  });

  const totalDebit = Number(agg._sum.debit ?? 0);
  const totalCredit = Number(agg._sum.credit ?? 0);

  return account.normalBalance === "DEBIT" ? round2(totalDebit - totalCredit) : round2(totalCredit - totalDebit);
}

export async function getAllAccountBalances(businessId: string, asOf?: Date) {
  const accounts = await prisma.account.findMany({ where: { businessId, isActive: true }, orderBy: { code: "asc" } });

  return Promise.all(
    accounts.map(async (a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      normalBalance: a.normalBalance,
      balance: await getAccountBalance(businessId, a.id, asOf),
    }))
  );
}

/**
 * Reverses every JournalLine posted under a given reference (referenceType
 * + referenceId) with an equal-and-opposite entry – mirrors
 * src/lib/cashbook.ts::reverseCashTransactionsForReference exactly, for the
 * same reason: never delete a JournalEntry (that erases the audit trail),
 * post the correction instead.
 */
export async function reverseJournalEntriesForReference(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  referenceType: string;
  referenceId: string;
  createdById: string;
  reason: string;
}) {
  const { tx, businessId, referenceType, referenceId, createdById, reason } = params;

  const entries = await tx.journalEntry.findMany({
    where: { businessId, referenceType, referenceId },
    include: { lines: true },
  });

  const reversals = [];
  for (const entry of entries) {
    // Skip anything already a reversal of this entry, so reversing twice
    // doesn't cascade – reversals are tagged with referenceType "<Type>Reversal".
    const reversal = await postJournalEntry({
      tx,
      businessId,
      description: reason,
      lines: entry.lines.map((l) => ({
        accountId: l.accountId,
        debit: Number(l.credit), // swap: what was credited is now debited, and vice versa
        credit: Number(l.debit),
      })),
      referenceType: `${referenceType}Reversal`,
      referenceId,
      createdById,
    });
    reversals.push(reversal);
  }

  return reversals;
}
