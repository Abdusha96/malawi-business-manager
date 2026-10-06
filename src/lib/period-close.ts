import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { logAudit } from "./audit";
import { PeriodClosedError } from "./accounting";
import { resolveTimeZone, ymdIn } from "./timezone";
import { todayYmd } from "./date-range";
import { checkRecordDate, planClosedThroughChange, closePresets, monthEndYmd, isRealYmd, previousDay } from "./period-lock";

/**
 * Period Close, Module 42. The database half; the rules are pure and live in
 * src/lib/period-lock.ts.
 *
 * WHY THIS EXISTS. Module 41's first known limitation: nothing stopped a back-dated entry
 * landing in a month whose VAT return or tax payment was already filed. The books had no
 * notion of "finished". This adds one number to the business, the last closed day, and
 * makes every place a record can be dated into the past respect it.
 *
 * DESIGN CHOICES, stated plainly:
 *
 * 1. ONE DATE, NOT A TABLE OF PERIODS. `Business.booksClosedThrough` is a single calendar day.
 *    Everything on or before it is closed. There is no per-month status to keep in step with a
 *    calendar, no gap that lets March stay open while April is closed, and no second source of
 *    truth. Closing more advances the date. Reopening moves it back or clears it.
 *
 * 2. THE GENERAL LEDGER CHOKE POINT DOES MOST OF THE WORK. postJournalEntry() refuses an entry
 *    with an explicit date on a closed day. Manual journals, depreciation runs, tax payments
 *    and foreign exchange adjustments all pass an explicit date, so all four are covered by
 *    one check that no future caller can forget.
 *
 * 3. RECORDS THAT REPORTS READ DIRECTLY ARE GUARDED AT THE RECORD (assertRecordDateOpen).
 *    A sale, a purchase and an expense are read by the VAT return and the reports from their
 *    own rows, not from the ledger. Voiding a March sale in April posts its reversal on an
 *    April date, which the ledger is happy with, yet the March VAT return would change. So a
 *    sale or purchase dated in a closed period can't be voided, and an expense or fixed asset
 *    dated there can't be created, edited, deleted or disposed. Records that live only in the
 *    ledger (a manual journal, an FX adjustment, a tax payment) CAN still be voided: the
 *    reversal is dated today, so closed days are never touched.
 *
 * 4. THE BUSINESS ROW LOCK MAKES CLOSE AND POST SERIALISE. lockBookState() updates the
 *    Business row, which takes Postgres's row lock and returns the row as of that lock. A
 *    posting and a close in the same instant therefore run one after the other. Whichever
 *    commits first is what the other sees, so a close can't be slipped past by a posting
 *    that read the lock date a moment earlier.
 *
 * 5. CLOSING IS AN ACCOUNTING ACT, REOPENING IS AN OWNER ACT. `accounting.manage` (Owner and
 *    Accountant, already granted) closes. Reopening also needs `business.settings.manage`
 *    (Owner). No new permission, so no re-seed. A reopen must carry a reason. Every change is
 *    audit-logged with the old and new date, so the history can't be rewritten quietly.
 *
 * 6. ONLY FINISHED DAYS CAN BE CLOSED. The latest day you can close through is yesterday in the
 *    business zone. Today's books are still being written.
 */

export class PeriodCloseError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PeriodCloseError";
    this.status = status;
  }
}

export const PERIOD_CLOSE_ENTITY = "PeriodClose";
export const PERIOD_CLOSE_ACTIONS = ["period.closed", "period.reopened"] as const;

export interface BookState {
  closedThrough: string | null;
  tz: string;
}

/**
 * Reads the closed-through day AND takes the Business row lock in the same statement. Call it
 * first inside any transaction that acts on a dated record, so a close can't commit between
 * the check and the write. The no-op `updatedAt` write is what takes the lock; nothing else on
 * the row changes.
 */
export async function lockBookState(tx: Prisma.TransactionClient, businessId: string): Promise<BookState> {
  const business = await tx.business.update({
    where: { id: businessId },
    data: { updatedAt: new Date() },
    select: { booksClosedThrough: true, timezone: true },
  });
  return { closedThrough: business.booksClosedThrough ?? null, tz: resolveTimeZone(business.timezone) };
}

/**
 * Throws PeriodClosedError when `instant` is on a closed day. A missing date is not checked
 * (an undated record is dated "now", which is never closed). `mode` "date" is for a date the
 * user picked, "change" for a record that already exists in the period and is being edited,
 * voided or deleted.
 */
export async function assertRecordDateOpen(params: {
  tx: Prisma.TransactionClient;
  businessId: string;
  instant: Date | null | undefined;
  what: string;
  mode: "date" | "change" | "post";
}): Promise<void> {
  const { tx, businessId, instant, what, mode } = params;
  if (!instant) return;
  const state = await lockBookState(tx, businessId);
  const refusal = checkRecordDate({ closedThrough: state.closedThrough, instant, tz: state.tz, what, mode });
  if (refusal) throw new PeriodClosedError(refusal);
}

export interface CloseReadiness {
  draftPayrollPeriods: { period: string; runs: number }[];
  openBankReconciliations: number;
}

/**
 * Things that are still unfinished inside the days about to be closed. Informational only:
 * neither is blocked by the lock (payroll is paid, and a reconciliation is completed, on a
 * date of their own), but closing the books with a March payroll still in draft is almost
 * always a mistake worth a second look.
 */
export async function getCloseReadiness(businessId: string, through: string, tz: string): Promise<CloseReadiness> {
  const drafts = await prisma.payroll.groupBy({
    by: ["payPeriod"],
    where: { businessId, status: "DRAFT" },
    _count: { _all: true },
  });
  const draftPayrollPeriods = drafts
    .filter((d) => monthEndYmd(d.payPeriod) <= through)
    .map((d) => ({ period: d.payPeriod, runs: d._count._all }))
    .sort((a, b) => a.period.localeCompare(b.period));

  const recs = await prisma.bankReconciliation.findMany({
    where: { businessId, status: "IN_PROGRESS" },
    select: { statementDate: true },
  });
  const openBankReconciliations = recs.filter((r) => ymdIn(r.statementDate, tz) <= through).length;

  return { draftPayrollPeriods, openBankReconciliations };
}

export interface PeriodCloseHistoryRow {
  id: string;
  action: "period.closed" | "period.reopened";
  from: string | null;
  to: string | null;
  reason: string | null;
  by: string | null;
  at: Date;
}

export async function getPeriodCloseOverview(businessId: string) {
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: businessId },
    select: { booksClosedThrough: true, timezone: true, financialYearStartMonth: true },
  });
  const tz = resolveTimeZone(business.timezone);
  const today = todayYmd(tz);

  const rows = await prisma.auditLog.findMany({
    where: { businessId, entityType: PERIOD_CLOSE_ENTITY, action: { in: [...PERIOD_CLOSE_ACTIONS] } },
    orderBy: { createdAt: "desc" },
    take: 30,
    include: { user: { select: { name: true } } },
  });

  const history: PeriodCloseHistoryRow[] = rows.map((r) => {
    const meta = (r.metadata ?? {}) as { from?: string | null; to?: string | null; reason?: string | null };
    return {
      id: r.id,
      action: r.action as PeriodCloseHistoryRow["action"],
      from: meta.from ?? null,
      to: meta.to ?? null,
      reason: meta.reason ?? null,
      by: r.user?.name ?? null,
      at: r.createdAt,
    };
  });

  return {
    closedThrough: business.booksClosedThrough ?? null,
    timeZone: tz,
    today,
    // The latest day that can be closed is yesterday.
    latestClosable: previousDay(today),
    presets: closePresets({ financialYearStartMonth: business.financialYearStartMonth, tz }),
    history,
  };
}

export async function setBooksClosedThrough(params: {
  businessId: string;
  userId: string;
  requested: string | null;
  reason?: string | null;
  canReopen: boolean;
}) {
  const { businessId, userId, requested, canReopen } = params;
  const reason = params.reason?.trim() ? params.reason.trim() : null;

  if (requested !== null && !isRealYmd(requested)) {
    throw new PeriodCloseError("That is not a real calendar date. Use the form 2026-03-31.");
  }

  return prisma.$transaction(async (tx) => {
    const state = await lockBookState(tx, businessId);
    const plan = planClosedThroughChange({ current: state.closedThrough, requested, today: todayYmd(state.tz) });
    if (!plan.ok) throw new PeriodCloseError(plan.error);

    if (plan.action === "reopen") {
      if (!canReopen) throw new PeriodCloseError("Only the Owner can reopen closed books.", 403);
      if (!reason) throw new PeriodCloseError("Give a reason for reopening the books. It is kept in the history.");
    }

    await tx.business.update({ where: { id: businessId }, data: { booksClosedThrough: plan.to } });

    await logAudit({
      tx,
      businessId,
      userId,
      action: plan.action === "close" ? "period.closed" : "period.reopened",
      entityType: PERIOD_CLOSE_ENTITY,
      entityId: businessId,
      metadata: { from: plan.from, to: plan.to, reason },
    });

    return { action: plan.action, from: plan.from, closedThrough: plan.to };
  });
}
