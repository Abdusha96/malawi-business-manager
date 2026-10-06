/**
 * Module 52: standalone checks for the pure cursor-pagination helper. No
 * database, no framework:
 *   npx tsx scripts/verify-reopen-history-pagination.ts   (npm run verify:reopen-history-pagination)
 * Exits non-zero if any check fails.
 *
 * Covers src/lib/pagination.ts::paginateRows directly – the orchestration in
 * src/lib/reopen-audit.ts::getReopenHistory pulls in Prisma at module scope
 * and can't be exercised here, the same reason scripts/verify-vat-refunds.ts
 * only tests resolveVatDirection directly.
 */
import { paginateRows } from "../src/lib/pagination";

let failed = 0,
  total = 0;
function check(name: string, actual: unknown, expected: unknown) {
  total++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`);

// ---- no rows at all ----
check("empty input, any limit", paginateRows([], 20), { page: [], hasMore: false });

// ---- fewer rows than the limit ----
check("5 rows, limit 20 -> all returned, no more", paginateRows(ids(5), 20), { page: ids(5), hasMore: false });

// ---- exactly the limit, no extra row fetched ----
// This is the case the fetch-limit+1 trick exists to disambiguate from the
// next one – a caller that fetched exactly `limit` rows (e.g. the true last
// page happens to be a round number) must not be told there's more.
check("exactly 20 rows for limit 20 -> all returned, no more", paginateRows(ids(20), 20), { page: ids(20), hasMore: false });

// ---- one more than the limit (the real "hasMore" signal) ----
check("21 rows for limit 20 -> first 20 returned, has more", paginateRows(ids(21), 20), { page: ids(20), hasMore: true });

// ---- well past the limit ----
check("41 rows for limit 20 -> first 20 returned, has more", paginateRows(ids(41), 20), { page: ids(20), hasMore: true });

// ---- limit of 1 (smallest real page size) ----
check("2 rows for limit 1 -> first row only, has more", paginateRows(ids(2), 1), { page: ["r0"], hasMore: true });
check("1 row for limit 1 -> that row, no more", paginateRows(ids(1), 1), { page: ["r0"], hasMore: false });

// ---- degenerate limit ----
check("limit 0, rows present -> nothing returned, has more", paginateRows(ids(3), 0), { page: [], hasMore: true });
check("limit 0, no rows -> nothing returned, no more", paginateRows([], 0), { page: [], hasMore: false });
check("negative limit treated like zero", paginateRows(ids(3), -5), { page: [], hasMore: true });

// ---- ordering is preserved, not re-sorted ----
check("order preserved on the returned page", paginateRows(["z", "a", "m"], 2), { page: ["z", "a"], hasMore: true });

console.log(`\n${total - failed}/${total} checks passed.`);
if (failed > 0) process.exit(1);
