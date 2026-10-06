/**
 * Module 65: standalone checks for the pure short/damaged-receipt logic. No
 * database, no framework:
 *   npx tsx scripts/verify-stock-transfer-receipt.ts   (npm run verify:stock-transfer-receipt)
 * Exits non-zero if any check fails.
 *
 * Covers src/lib/stock-transfer-receipt.ts directly. receiveStockTransfer()
 * itself pulls in Prisma at module scope and can't be exercised here (same
 * reason verify-notification-transition.ts only tests the pure half).
 */
import {
  resolveReceipt,
  lineShortfall,
  transferHasShortfall,
  DispatchedLine,
  ReceiptResolution,
  MAX_SHORTFALL_REASON_LENGTH,
} from "../src/lib/stock-transfer-receipt";

let failed = 0,
  total = 0;
function check(name: string, actual: unknown, expected: unknown) {
  total++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}
function ok(r: ReceiptResolution) {
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r;
}
function err(r: ReceiptResolution): string {
  return r.ok ? "(no error)" : r.error;
}

const rice: DispatchedLine = { id: "l1", productName: "Rice 50kg", quantity: 10, unitCost: 1500 };
const oil: DispatchedLine = { id: "l2", productName: "Cooking oil", quantity: 4.5, unitCost: 2200.5 };
const lines = [rice, oil];

// ---- full receipt: no body / empty body / lines omitted ----
{
  const a = ok(resolveReceipt(lines, undefined));
  check("no inputs -> not short", a.shortLineCount, 0);
  check("no inputs -> zero shortfall value", a.totalShortfallValue, 0);
  check("no inputs -> every line received in full", a.lines.map((l) => l.quantityReceived), [10, 4.5]);
  check("no inputs -> receivedNothing false", a.receivedNothing, false);
  check("null inputs behave like undefined", ok(resolveReceipt(lines, null)).shortLineCount, 0);
  check("empty inputs behave like undefined", ok(resolveReceipt(lines, [])).shortLineCount, 0);
}

// ---- a short line ----
{
  const a = ok(resolveReceipt(lines, [{ lineId: "l1", quantityReceived: 8, shortfallReason: "  2 bags split open  " }]));
  check("short line counted", a.shortLineCount, 1);
  check("short line shortfall qty", a.lines[0].shortfall, 2);
  check("short line value = 2 x 1500", a.lines[0].shortfallValue, 3000);
  check("reason is trimmed", a.lines[0].shortfallReason, "2 bags split open");
  check("total shortfall value", a.totalShortfallValue, 3000);
  check("omitted line defaults to full", a.lines[1].quantityReceived, 4.5);
  check("omitted line has no reason", a.lines[1].shortfallReason, null);
  check("omitted line is not short", a.lines[1].isShort, false);
}

// ---- multiple short lines, value to 2dp ----
{
  const a = ok(
    resolveReceipt(lines, [
      { lineId: "l1", quantityReceived: 9.5, shortfallReason: "leaked" },
      { lineId: "l2", quantityReceived: 4.123, shortfallReason: "damaged" },
    ])
  );
  check("two short lines", a.shortLineCount, 2);
  check("fractional shortfall qty (0.5)", a.lines[0].shortfall, 0.5);
  check("fractional shortfall value 0.5 x 1500", a.lines[0].shortfallValue, 750);
  check("4.5 - 4.123 = 0.377 exactly, no float drift", a.lines[1].shortfall, 0.377);
  check("0.377 x 2200.5 rounded to 2dp", a.lines[1].shortfallValue, 829.59);
  check("total = sum of rounded line values", a.totalShortfallValue, 1579.59);
}

// ---- nothing arrived ----
{
  const a = ok(
    resolveReceipt(lines, [
      { lineId: "l1", quantityReceived: 0, shortfallReason: "truck burnt" },
      { lineId: "l2", quantityReceived: 0, shortfallReason: "truck burnt" },
    ])
  );
  check("all-zero receipt flagged", a.receivedNothing, true);
  check("all-zero shortfall = full dispatched value", a.totalShortfallValue, round(10 * 1500 + 4.5 * 2200.5));
  const b = ok(resolveReceipt(lines, [{ lineId: "l1", quantityReceived: 0, shortfallReason: "lost" }]));
  check("one line at zero, other in full is NOT receivedNothing", b.receivedNothing, false);
  check("zero received is a valid quantity", b.lines[0].quantityReceived, 0);
}
function round(n: number) {
  return Math.round(n * 100) / 100;
}

// ---- reason handling ----
{
  check(
    "short line with no reason refused",
    err(resolveReceipt(lines, [{ lineId: "l1", quantityReceived: 5 }])),
    "Rice 50kg: a reason is required when less than the dispatched quantity arrived."
  );
  check(
    "short line with whitespace-only reason refused",
    err(resolveReceipt(lines, [{ lineId: "l1", quantityReceived: 5, shortfallReason: "   " }])).startsWith("Rice 50kg: a reason"),
    true
  );
  check(
    "null reason on a short line refused",
    err(resolveReceipt(lines, [{ lineId: "l1", quantityReceived: 5, shortfallReason: null }])).startsWith("Rice 50kg: a reason"),
    true
  );
  const long = "x".repeat(MAX_SHORTFALL_REASON_LENGTH + 1);
  check(
    "over-long reason refused",
    err(resolveReceipt(lines, [{ lineId: "l1", quantityReceived: 5, shortfallReason: long }])).includes("limited to 200"),
    true
  );
  const atLimit = "x".repeat(MAX_SHORTFALL_REASON_LENGTH);
  check("reason at the limit accepted", resolveReceipt(lines, [{ lineId: "l1", quantityReceived: 5, shortfallReason: atLimit }]).ok, true);
  const full = ok(resolveReceipt(lines, [{ lineId: "l1", quantityReceived: 10, shortfallReason: "leftover text" }]));
  check("reason on a full line is discarded", full.lines[0].shortfallReason, null);
  check("full line given explicitly is not short", full.shortLineCount, 0);
}

// ---- refusals ----
{
  check(
    "more than dispatched refused",
    err(resolveReceipt(lines, [{ lineId: "l1", quantityReceived: 10.001, shortfallReason: "x" }])).startsWith(
      "Rice 50kg: can't receive more than was dispatched (10)."
    ),
    true
  );
  check(
    "negative refused",
    err(resolveReceipt(lines, [{ lineId: "l1", quantityReceived: -1, shortfallReason: "x" }])),
    "Rice 50kg: quantity received can't be negative."
  );
  check(
    "4 decimals refused, not rounded",
    err(resolveReceipt(lines, [{ lineId: "l1", quantityReceived: 9.9999, shortfallReason: "x" }])).includes("at most 3 decimal"),
    true
  );
  check(
    "NaN refused",
    err(resolveReceipt(lines, [{ lineId: "l1", quantityReceived: NaN, shortfallReason: "x" }])).includes("at most 3 decimal"),
    true
  );
  check(
    "Infinity refused",
    err(resolveReceipt(lines, [{ lineId: "l1", quantityReceived: Infinity, shortfallReason: "x" }])).includes("at most 3 decimal"),
    true
  );
  check(
    "unknown line id refused",
    err(resolveReceipt(lines, [{ lineId: "nope", quantityReceived: 1, shortfallReason: "x" }])),
    "A line in the receipt doesn't belong to this transfer."
  );
  check(
    "duplicate line id refused",
    err(
      resolveReceipt(lines, [
        { lineId: "l1", quantityReceived: 5, shortfallReason: "x" },
        { lineId: "l1", quantityReceived: 6, shortfallReason: "x" },
      ])
    ),
    "Rice 50kg appears more than once in the receipt."
  );
  check("one bad line fails the whole receipt (nothing partly resolved)", resolveReceipt(lines, [
    { lineId: "l1", quantityReceived: 5, shortfallReason: "ok" },
    { lineId: "l2", quantityReceived: 99, shortfallReason: "ok" },
  ]).ok, false);
}

// ---- float-safety on the boundary ----
{
  const tenths: DispatchedLine = { id: "t", productName: "Tenths", quantity: 0.3, unitCost: 100 };
  const a = ok(resolveReceipt([tenths], [{ lineId: "t", quantityReceived: 0.1 + 0.2 }]));
  check("0.1 + 0.2 received against 0.3 dispatched is a FULL receipt, not a phantom 5e-17 shortfall", a.lines[0].isShort, false);
  check("...and needs no reason", a.shortLineCount, 0);
  const b = ok(resolveReceipt([tenths], [{ lineId: "t", quantityReceived: 0.299, shortfallReason: "spill" }]));
  check("0.001 short is a real shortfall", b.lines[0].shortfall, 0.001);
  check("...worth 0.001 x 100 = 0.10", b.lines[0].shortfallValue, 0.1);
}

// ---- zero-cost product: short, but nothing to write off ----
{
  const free: DispatchedLine = { id: "f", productName: "Free sample", quantity: 5, unitCost: 0 };
  const a = ok(resolveReceipt([free], [{ lineId: "f", quantityReceived: 3, shortfallReason: "lost" }]));
  check("zero-cost line is still recorded as short", a.lines[0].isShort, true);
  check("zero-cost shortfall has no value to write off", a.totalShortfallValue, 0);
}

// ---- empty transfer edge ----
check("no lines at all is not 'received nothing'", ok(resolveReceipt([], undefined)).receivedNothing, false);

// ---- reading a RECEIVED transfer back ----
check("null quantityReceived (pre-Module-65) = no shortfall", lineShortfall(10, null), 0);
check("undefined quantityReceived = no shortfall", lineShortfall(10, undefined), 0);
check("received in full = no shortfall", lineShortfall(10, 10), 0);
check("received 8 of 10 = 2 short", lineShortfall(10, 8), 2);
check("received 0 of 4.5 = 4.5 short", lineShortfall(4.5, 0), 4.5);
check("a bogus received > sent never reports a negative shortfall", lineShortfall(10, 12), 0);
check("transferHasShortfall: legacy lines", transferHasShortfall([{ quantity: 10, quantityReceived: null }]), false);
check(
  "transferHasShortfall: one short among full lines",
  transferHasShortfall([
    { quantity: 10, quantityReceived: 10 },
    { quantity: 4.5, quantityReceived: 4 },
  ]),
  true
);
check("transferHasShortfall: no lines", transferHasShortfall([]), false);

if (failed > 0) {
  console.error(`\n${failed} of ${total} checks FAILED`);
  process.exit(1);
}
console.log(`stock-transfer-receipt: ${total}/${total} checks passed`);
