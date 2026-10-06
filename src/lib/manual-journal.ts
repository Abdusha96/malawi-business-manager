import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { postJournalEntry, reverseJournalEntriesForReference, getOrCreateSystemAccountId } from "./accounting";
import { logAudit } from "./audit";
import { getBusinessTimeZone } from "./business-timezone";
import { parseDateInput, todayYmd } from "./date-range";
import {
  checkManualJournal,
  controlledAccountReason,
  tambalaToAmount,
  TEMPLATE_ACCOUNT_KEYS,
} from "./manual-journal-rules";
import type { ManualJournalInput } from "./validation";

/**
 * Manual Journal Entries – Module 41.
 *
 * WHY THIS EXISTS. Modules 18, 19, 20 and 33 each end a limitation with "an
 * Accountant books this by manual journal entry" (clear the VAT liability, book the
 * company income tax charge, ...). No screen or route ever existed to do that, and
 * for income tax not even the accounts did. This module is that missing front door
 * to the ledger, plus the two accounts Modules 20/33 assumed.
 *
 * DESIGN CHOICES, stated plainly:
 *
 * 1. ONE POSTING PATH. The lines are posted by postJournalEntry() – the same
 *    balance check, the same numbering (JE-...), the same tables as every other
 *    module – tagged referenceType "ManualJournal" / referenceId = the
 *    ManualJournal row. The ManualJournal row (MJ-...) adds what a bare
 *    JournalEntry lacks: a status, a void trail, a narration and a supporting
 *    document reference. It stores no lines of its own, so it can never disagree
 *    with the ledger.
 *
 * 2. NO EDIT. Void and re-enter. An edit would have to reverse and re-post anyway,
 *    and the void row is the audit trail (same rule as Tax Payments, Module 39).
 *    A void posts an equal-and-opposite entry dated TODAY (reverseJournalEntriesFor
 *    Reference); nothing is deleted. The original stays in the period it was posted
 *    to, and the reversal lands in the period the void happened – the same as every
 *    other void in this app.
 *
 * 3. SUB-LEDGER ACCOUNTS ARE OFF LIMITS (see CONTROLLED_ACCOUNTS in
 *    manual-journal-rules.ts). A manual line on Cash, Bank, mobile money, Accounts
 *    Receivable/Payable, Inventory, customer/supplier credits, Fixed Assets or
 *    Accumulated Depreciation would move the GL and leave the sub-ledger alone, with
 *    nothing to reconcile them. The user is told which page to use instead. Custom
 *    accounts and every other system account (equity, revenue, expenses, VAT, PAYE,
 *    withholding, income tax) are allowed.
 *
 * 4. THE DATE IS A CALENDAR DAY IN THE BUSINESS TIME ZONE (Module 34/35). A bare
 *    "YYYY-MM-DD" is stored as the START of that day in the business zone, so the
 *    entry lands on the chosen day in every report whatever zone the server runs in.
 *    The future is refused by comparing calendar dates, not instants, so there is
 *    no timezone slack to reason about. Back-dating is allowed: there is no period
 *    close in this app yet (KNOWN LIMITATION – see README), so a back-dated entry
 *    changes a report that may already have been filed. It is audit-logged.
 *
 * 5. BUSINESS-WIDE. The GL has no branch dimension, so a branch-locked member can
 *    view but not post (the route enforces it). Posting to the whole business's books
 *    is an owner/accountant act, not a branch one.
 *
 * 6. RE-CHECKED INSIDE THE TRANSACTION. Accounts are loaded and validated inside the
 *    same transaction that numbers and posts the entry, so an account deactivated a
 *    moment earlier can't slip through between the check and the write.
 */

export class ManualJournalError extends Error {
  readonly problems: string[];
  constructor(message: string, problems: string[] = []) {
    super(message);
    this.name = "ManualJournalError";
    this.problems = problems;
  }
}

const EARLIEST_DATE = "2000-01-01";

/**
 * Makes sure the accounts the templates use exist. SYSTEM_ACCOUNTS grew in this
 * module and seedChartOfAccounts() only runs at registration, so an existing
 * business is missing INCOME_TAX_EXPENSE / INCOME_TAX_PAYABLE until something asks
 * for them – the lazy-backfill rule (getOrCreateSystemAccountId). Each account is
 * created in its own transaction: a unique-constraint race with another request
 * aborts a Postgres transaction, so it has to be caught around one, not inside it.
 */
export async function ensureManualJournalAccounts(businessId: string): Promise<void> {
  for (const key of TEMPLATE_ACCOUNT_KEYS) {
    try {
      await prisma.$transaction((tx) => getOrCreateSystemAccountId(tx, businessId, key));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue; // someone else just created it
      throw err;
    }
  }
}

export interface PostableAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  normalBalance: string;
  systemKey: string | null;
  isSystemAccount: boolean;
}

export interface BlockedAccount {
  id: string;
  code: string;
  name: string;
  reason: string;
}

/** Active accounts split into what a manual line may use and what it may not (with the reason and where to go instead). */
export async function listAccountsForManualJournal(businessId: string): Promise<{ accounts: PostableAccount[]; blocked: BlockedAccount[] }> {
  await ensureManualJournalAccounts(businessId);
  const rows = await prisma.account.findMany({ where: { businessId, isActive: true }, orderBy: { code: "asc" } });
  const accounts: PostableAccount[] = [];
  const blocked: BlockedAccount[] = [];
  for (const a of rows) {
    const reason = controlledAccountReason(a.systemKey);
    if (reason) blocked.push({ id: a.id, code: a.code, name: a.name, reason });
    else
      accounts.push({
        id: a.id,
        code: a.code,
        name: a.name,
        type: a.type,
        normalBalance: a.normalBalance,
        systemKey: a.systemKey,
        isSystemAccount: a.isSystemAccount,
      });
  }
  return { accounts, blocked };
}

export async function createManualJournal(params: { businessId: string; userId: string; input: ManualJournalInput }) {
  const { businessId, userId, input } = params;

  const tz = await getBusinessTimeZone(businessId);
  const today = todayYmd(tz);
  const day = input.entryDate && input.entryDate.trim() !== "" ? input.entryDate : today;
  const entryDate = parseDateInput(day, "start", tz);
  if (!entryDate) throw new ManualJournalError("That is not a real calendar date.");
  if (day > today) throw new ManualJournalError("The entry date can't be in the future. Post it on the day it takes effect.");
  if (day < EARLIEST_DATE) throw new ManualJournalError(`The entry date can't be before ${EARLIEST_DATE}.`);

  // Balance and account rules are cheap and need no lock – fail before opening a transaction when the
  // shape is wrong; the same check runs again inside the transaction against freshly-read accounts.
  return prisma.$transaction(async (tx) => {
    const ids = Array.from(new Set(input.lines.map((l) => l.accountId)));
    const accounts = await tx.account.findMany({
      where: { businessId, id: { in: ids } },
      select: { id: true, code: true, name: true, isActive: true, systemKey: true },
    });
    const checked = checkManualJournal(input.lines, accounts);
    if (!checked.ok) throw new ManualJournalError(checked.errors[0], checked.errors);

    const updated = await tx.business.update({
      where: { id: businessId },
      data: { nextManualJournalNumber: { increment: 1 } },
    });
    const journalNumber = `${updated.manualJournalPrefix}-${String(updated.nextManualJournalNumber - 1).padStart(6, "0")}`;
    const totalAmount = tambalaToAmount(checked.totalDebit);

    const journal = await tx.manualJournal.create({
      data: {
        businessId,
        journalNumber,
        entryDate,
        description: input.description,
        documentRef: input.documentRef || undefined,
        notes: input.notes || undefined,
        totalAmount,
        status: "RECORDED",
        createdById: userId,
      },
    });

    const entry = await postJournalEntry({
      tx,
      businessId,
      description: `${journalNumber} – ${input.description}`,
      lines: checked.lines.map((l) => ({
        accountId: l.accountId,
        debit: tambalaToAmount(l.debit),
        credit: tambalaToAmount(l.credit),
        description: l.memo ?? undefined,
      })),
      referenceType: "ManualJournal",
      referenceId: journal.id,
      createdById: userId,
      entryDate,
    });

    await logAudit({
      tx,
      businessId,
      userId,
      action: "manual_journal.create",
      entityType: "ManualJournal",
      entityId: journal.id,
      metadata: {
        journalNumber,
        journalEntryNumber: entry.entryNumber,
        entryDate: day,
        backDated: day < today,
        totalAmount,
        lineCount: checked.lines.length,
        documentRef: input.documentRef || null,
      },
    });

    return journal;
  });
}

/**
 * Reverses a recorded manual journal (equal-and-opposite entry, nothing deleted) and
 * keeps the row as VOIDED history. A conditional write claims the row first, so two
 * people voiding the same entry at once can't both post a reversal – the same
 * read-then-write race Module 38 closed on quotations and Module 39 on FX adjustments.
 */
export async function voidManualJournal(params: { businessId: string; journalId: string; userId: string; reason: string }) {
  const { businessId, journalId, userId, reason } = params;

  const existing = await prisma.manualJournal.findFirst({ where: { id: journalId, businessId } });
  if (!existing) throw new ManualJournalError("Journal entry not found.");
  if (existing.status !== "RECORDED") throw new ManualJournalError("This journal entry has already been voided.");

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.manualJournal.updateMany({
      where: { id: journalId, businessId, status: "RECORDED" },
      data: { status: "VOIDED", voidedAt: new Date(), voidedById: userId, voidReason: reason },
    });
    if (claimed.count === 0) throw new ManualJournalError("This journal entry has already been voided.");

    const reversals = await reverseJournalEntriesForReference({
      tx,
      businessId,
      referenceType: "ManualJournal",
      referenceId: existing.id,
      createdById: userId,
      reason: `Manual journal ${existing.journalNumber} voided – ${reason}`,
    });
    // A RECORDED manual journal always has exactly one posted entry. Zero would mean the ledger and the
    // record disagree – fail loudly and roll the claim back rather than mark it voided with nothing reversed.
    if (reversals.length !== 1) {
      throw new ManualJournalError(`Expected one posted entry for ${existing.journalNumber} but found ${reversals.length}; nothing was changed.`);
    }

    await logAudit({
      tx,
      businessId,
      userId,
      action: "manual_journal.void",
      entityType: "ManualJournal",
      entityId: existing.id,
      metadata: { journalNumber: existing.journalNumber, reason, reversalEntryNumber: reversals[0].entryNumber },
    });

    return tx.manualJournal.findUniqueOrThrow({ where: { id: existing.id } });
  });
}

export interface ManualJournalFilters {
  status?: string;
  from?: Date;
  to?: Date;
  q?: string;
}

export async function listManualJournals(businessId: string, filters: ManualJournalFilters = {}) {
  const q = filters.q?.trim();
  return prisma.manualJournal.findMany({
    where: {
      businessId,
      ...(filters.status === "RECORDED" || filters.status === "VOIDED" ? { status: filters.status } : {}),
      ...(filters.from || filters.to
        ? { entryDate: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
        : {}),
      ...(q
        ? {
            OR: [
              { journalNumber: { contains: q, mode: "insensitive" as const } },
              { description: { contains: q, mode: "insensitive" as const } },
              { documentRef: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }],
    take: 500,
  });
}

/** The journal plus the ledger entry it posted and, once voided, the reversal – each with account names on every line. */
export async function getManualJournal(params: { businessId: string; journalId: string }) {
  const journal = await prisma.manualJournal.findFirst({ where: { id: params.journalId, businessId: params.businessId } });
  if (!journal) return null;

  const entries = await prisma.journalEntry.findMany({
    where: {
      businessId: params.businessId,
      referenceId: journal.id,
      referenceType: { in: ["ManualJournal", "ManualJournalReversal"] },
    },
    include: { lines: { include: { account: { select: { code: true, name: true } } }, orderBy: { id: "asc" } } },
    orderBy: { createdAt: "asc" },
  });

  const shape = (e: (typeof entries)[number]) => ({
    entryNumber: e.entryNumber,
    entryDate: e.entryDate,
    description: e.description,
    lines: e.lines.map((l) => ({
      accountCode: l.account.code,
      accountName: l.account.name,
      debit: Number(l.debit),
      credit: Number(l.credit),
      memo: l.description,
    })),
  });

  const entry = entries.find((e) => e.referenceType === "ManualJournal");
  const reversal = entries.find((e) => e.referenceType === "ManualJournalReversal");
  return { journal, entry: entry ? shape(entry) : null, reversal: reversal ? shape(reversal) : null };
}
