/**
 * Module 52 – Paginate Reopen History.
 *
 * The "fetch limit+1, slice, and flag hasMore" trick used by
 * `reopen-audit.ts::getReopenHistory()` is pure once the rows are already in
 * hand – it has nothing to do with Prisma or AuditLog specifically. Pulling
 * it out here means the one place that could have an off-by-one bug (has
 * there ever been a case where `rows.length === limit` exactly, with no
 * further page, that gets mistaken for "more exist"?) is testable directly,
 * without a database, the same way `vat-carry-forward.ts` and
 * `debit-note-calc.ts` keep their pure math import-free and separately
 * verifiable.
 */
export interface Page<T> {
  page: T[];
  hasMore: boolean;
}

/**
 * `rows` must already be the result of fetching `limit + 1` rows in the
 * caller's sort order. Returns the first `limit` of them plus whether a
 * `(limit + 1)`th row existed (i.e. there's a next page).
 */
export function paginateRows<T>(rows: T[], limit: number): Page<T> {
  if (limit <= 0) return { page: [], hasMore: rows.length > 0 };
  const hasMore = rows.length > limit;
  return { page: hasMore ? rows.slice(0, limit) : rows, hasMore };
}
