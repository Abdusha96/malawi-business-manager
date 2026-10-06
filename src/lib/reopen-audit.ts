import { prisma } from "./prisma";
import { paginateRows } from "./pagination";

/**
 * Module 50 – Reopen History & Cap. Module 51 – Configurable Reopen Cap.
 *
 * WHY THIS EXISTS. Bank Reconciliation (Module 48) and Stock Take (Module 49)
 * both shipped a completed-record reopen, and both documented the exact same
 * pair of gaps at the time: no cap on how many times a record can be
 * reopened, and no in-app view of that history – AuditLog had every event
 * (`bankrecon.reopen`/`stocktake.reopen`) but nothing ever rendered it. This
 * file closes both gaps once, for both resources, instead of writing the fix
 * twice – the two models already mirror each other field-for-field, right
 * down to the action-name convention (`<resource>.complete` / `.reopen`).
 *
 * COUNT IS COMPUTED, NEVER STORED. This app already treats balances and
 * accumulated depreciation as derived-live-from-the-ledger rather than
 * cached columns (see architecture notes). A reopen count is the same kind
 * of fact: AuditLog is already the one place every reopen is durably
 * recorded, so counting against it directly can't drift the way a second,
 * stored counter could. No new column, no migration, on either model.
 *
 * WHY A CAP AT ALL. Reopening exists for genuine corrections, not as a
 * second edit mode for a record that should have stayed in progress longer.
 * A business that has reopened the same reconciliation or stock take
 * Business.maxReopens times almost certainly has a deeper problem a manual
 * journal (Module 41) is the honest tool for, not another reopen.
 *
 * THE CAP ITSELF (Module 51). Originally a hard-coded MAX_REOPENS = 5
 * (Module 50). An Owner in this position has no way to fix the count that
 * already happened – reopening exists precisely because a completed record
 * turned out to need more work – so a business-wide code constant was the
 * wrong shape for something an Owner might legitimately need to raise. It's
 * now `Business.maxReopens`, editable from /settings/general the same way
 * Module 35 made the time zone editable. `reopenCapMessage()` below takes
 * the resolved value as a parameter rather than reading a constant, so a
 * caller can't accidentally check against the old shared default.
 *
 * PAGINATION (Module 52). Module 50 hard-capped the history read at 20 rows
 * with no way to see anything older, and Module 51 raising the reopen cap to
 * as high as 20 made that a real ceiling rather than a generous one – a
 * business on a high cap could reopen a record more times than the panel
 * could ever show. `getReopenHistory()` now returns a page plus a cursor
 * instead of a flat array; the detail pages embed the first page for free
 * (same query shape as before, just wrapped), and a new per-resource
 * `reopen-history` route lets the UI fetch further pages on demand.
 *
 * LINE REFERENCE (Module 54). A reopen's reason was always free text, with
 * no way to say WHICH line of the reconciliation/stock take it was about.
 * `reopenBankReconciliation()`/`reopenStockTake()` now accept an optional
 * `lineId` and, when given, resolve a short human label for it (the
 * statement line's description+date, or the stock take line's product
 * name) at the moment of reopening – snapshotted into this same AuditLog
 * metadata blob as `lineLabel`, not re-joined live, so a history entry
 * still reads correctly even if that line is later deleted (statement
 * lines can be – see deleteBankStatementLine) or its product renamed.
 */

export type ReopenableEntityType = "BankReconciliation" | "StockTake";

export interface ReopenHistoryRow {
  id: string;
  action: string;
  at: Date;
  by: string | null;
  reason: string | null;
  // Module 54: a short label for the specific line this reopen was about,
  // snapshotted at reopen time – null for a reopen that wasn't tied to one
  // line, and for every "complete" row (only reopens ever carry one).
  lineLabel: string | null;
}

function completeAction(entityType: ReopenableEntityType): string {
  return entityType === "BankReconciliation" ? "bankrecon.complete" : "stocktake.complete";
}

function reopenAction(entityType: ReopenableEntityType): string {
  return entityType === "BankReconciliation" ? "bankrecon.reopen" : "stocktake.reopen";
}

/**
 * How many times this record has already been reopened. Called before a new
 * reopen is allowed – pass the result to `reopenCapMessage()` once it has
 * reached the business's `maxReopens`.
 */
export async function countReopens(businessId: string, entityType: ReopenableEntityType, entityId: string): Promise<number> {
  return prisma.auditLog.count({
    where: { businessId, entityType, entityId, action: reopenAction(entityType) },
  });
}

export const REOPEN_HISTORY_PAGE_SIZE = 20;

export interface ReopenHistoryPage {
  rows: ReopenHistoryRow[];
  nextCursor: string | null;
}

/**
 * One page of the complete/reopen timeline for one record, newest first.
 * Includes both actions (not just reopens) so the in-app view reads as a
 * real timeline – "Completed ... Reopened ... Completed again" – rather
 * than a bare list of reopen events with no context for what came between
 * them.
 *
 * Cursor-paginated (Module 52) on `id` rather than `createdAt`: two audit
 * rows written in the same request (e.g. a reopen and its own audit entry)
 * can share a timestamp down to the millisecond, so `createdAt` alone isn't
 * a safe boundary between pages – a row could be skipped or repeated. `id`
 * is a cuid, so it's both unique and, since cuids are lexically time-sortable
 * at the same insertion moment as `createdAt`, stable as a secondary sort key.
 * `cursor` is the `id` of the last row the caller already has; pass none for
 * the first page.
 */
export async function getReopenHistory(
  businessId: string,
  entityType: ReopenableEntityType,
  entityId: string,
  options?: { cursor?: string; limit?: number }
): Promise<ReopenHistoryPage> {
  const limit = options?.limit ?? REOPEN_HISTORY_PAGE_SIZE;
  const rows = await prisma.auditLog.findMany({
    where: { businessId, entityType, entityId, action: { in: [completeAction(entityType), reopenAction(entityType)] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(options?.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    include: { user: { select: { name: true } } },
  });

  const { page, hasMore } = paginateRows(rows, limit);

  return {
    rows: page.map((r) => {
      const meta = (r.metadata ?? {}) as { reason?: string | null; lineLabel?: string | null };
      return {
        id: r.id,
        action: r.action,
        at: r.createdAt,
        by: r.user?.name ?? null,
        reason: meta.reason ?? null,
        lineLabel: meta.lineLabel ?? null,
      };
    }),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

export function reopenCapMessage(entityLabel: string, maxReopens: number): string {
  return (
    `This ${entityLabel} has already been reopened ${maxReopens} times, the maximum allowed. ` +
    `If it needs correcting again, record the difference as a manual journal entry instead.`
  );
}
