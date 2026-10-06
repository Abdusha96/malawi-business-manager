/**
 * Module 66: standalone checks for the pure short-stock recovery logic. No
 * database, no framework:
 *   npx tsx scripts/verify-stock-transfer-recovery.ts   (npm run verify:stock-transfer-recovery)
 * Exits non-zero if any check fails.
 *
 * Covers src/lib/stock-transfer-recovery.ts directly. recoverStockTransferShortfall()
 * itself pulls in Prisma at module scope and can't be exercised here (same
 * reason verify-stock-transfer-receipt.ts only tests the pure half).
 */
import {
  resolveRecovery,
  outstandingShortfall,
  lineRecovered,
  transferHasOutstandingShortfall,
  transferHasRecovery,
  validateRecoveryNote,
  RecoverableLine,
  RecoveryResolution,
  MAX_RECOVERY_NOTE_LENGTH,
} from "../src/lib/stock-transfer-recovery";

let failed = 0,
  total = 0;
function check(name: string, actual: unknown, expected: unknown) {
  total++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}
function ok(r: RecoveryResolution) {
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r;
}
function err(r: RecoveryResolution): string {
  return r.ok ? "(no error)" : r.error;
}

// rice: sent 10, got 8 (2 short). oil: sent 4.5, got 4.5 (in full). sugar: sent 6, got 2 (4 short, 1 already back).
const rice: RecoverableLine = { id: "l1", productName: "Rice 50kg", quantity: 10, quantityReceived: 8, quantityRecovered: null, unitCost: 1500 };
const oil: RecoverableLine = { id: "l2", productName: "Cooking oil", quantity: 4.5, quantityReceived: 4.5, quantityRecovered: null, unitCost: 2200.5 };
const sugar: RecoverableLine = { id: "l3", productName: "Sugar", quantity: 6, quantityReceived: 2, quantityRecovered: 1, unitCost: 800.25 };
const legacy: RecoverableLine = { id: "l4", productName: "Salt", quantity: 3, quantityReceived: null, quantityRecovered: null, unitCost: 300 };
const lines = [rice, oil, sugar, legacy];

// ---- outstandingShortfall ----
check("outstanding: short, none recovered", outstandingShortfall(10, 8, null), 2);
check("outstanding: short, zero recovered", outstandingShortfall(10, 8, 0), 2);
check("outstanding: partly recovered", outstandingShortfall(6, 2, 1), 3);
check("outstanding: fully recovered", outstandingShortfall(10, 8, 2), 0);
check("outstanding: arrived in full", outstandingShortfall(4.5, 4.5, null), 0);
check("outstanding: legacy null received", outstandingShortfall(3, null, null), 0);
check("outstanding: undefined received", outstandingShortfall(3, undefined, undefined), 0);
check("outstanding: float drift (0.1+0.2 vs 0.3)", outstandingShortfall(0.3, 0.1 + 0.2, null), 0);
check("outstanding: never negative on over-recovery", outstandingShortfall(10, 8, 5), 0);
check("outstanding: 3 decimals exact", outstandingShortfall(1, 0.333, 0.111), 0.556);
check("outstanding: unreadable 4th decimal received -> 0", outstandingShortfall(10, 8.0001, null), 0);

// ---- lineRecovered ----
check("recovered: null", lineRecovered(null), 0);
check("recovered: undefined", lineRecovered(undefined), 0);
check("recovered: value", lineRecovered(1.5), 1.5);
check("recovered: unreadable -> 0", lineRecovered(1.00001), 0);

// ---- transfer-level helpers ----
check("has outstanding: rice short", transferHasOutstandingShortfall([rice, oil]), true);
check("has outstanding: all in full", transferHasOutstandingShortfall([oil, legacy]), false);
check("has outstanding: all recovered", transferHasOutstandingShortfall([{ ...rice, quantityRecovered: 2 }, oil]), false);
check("has outstanding: empty", transferHasOutstandingShortfall([]), false);
check("has recovery: none", transferHasRecovery([rice, oil]), false);
check("has recovery: sugar", transferHasRecovery([rice, sugar]), true);
check("has recovery: zero recorded is none", transferHasRecovery([{ quantityRecovered: 0 }]), false);

// ---- happy path: partial recovery ----
{
  const a = ok(resolveRecovery(lines, [{ lineId: "l1", quantityRecovered: 1 }]));
  check("partial: one line", a.lineCount, 1);
  check("partial: quantity", a.lines[0].quantity, 1);
  check("partial: outstanding before", a.lines[0].outstandingBefore, 2);
  check("partial: outstanding after", a.lines[0].outstandingAfter, 1);
  check("partial: running total", a.lines[0].recoveredTotal, 1);
  check("partial: value = 1 x 1500", a.lines[0].value, 1500);
  check("partial: not fully recovered", a.lines[0].fullyRecovered, false);
  check("partial: total value", a.totalValue, 1500);
}

// ---- happy path: full recovery of remaining shortfall ----
{
  const a = ok(resolveRecovery(lines, [{ lineId: "l1", quantityRecovered: 2 }]));
  check("full: fully recovered", a.lines[0].fullyRecovered, true);
  check("full: outstanding after zero", a.lines[0].outstandingAfter, 0);
  check("full: value = 2 x 1500", a.totalValue, 3000);
}

// ---- cumulative: line already partly recovered ----
{
  const a = ok(resolveRecovery(lines, [{ lineId: "l3", quantityRecovered: 3 }]));
  check("cumulative: outstanding before = 3", a.lines[0].outstandingBefore, 3);
  check("cumulative: running total = 1 + 3", a.lines[0].recoveredTotal, 4);
  check("cumulative: fully recovered", a.lines[0].fullyRecovered, true);
  check("cumulative: value = 3 x 800.25", a.lines[0].value, 2400.75);
}

// ---- multiple lines ----
{
  const a = ok(
    resolveRecovery(lines, [
      { lineId: "l1", quantityRecovered: 2 },
      { lineId: "l3", quantityRecovered: 1.5 },
    ])
  );
  check("multi: two lines", a.lineCount, 2);
  check("multi: total = 3000 + 1200.38", a.totalValue, 4200.38);
  check("multi: second line running total", a.lines[1].recoveredTotal, 2.5);
}

// ---- value uses the supplied (write-off) cost, rounded to 2dp ----
{
  const cheap: RecoverableLine = { id: "c", productName: "Match", quantity: 10, quantityReceived: 0, quantityRecovered: null, unitCost: 0.333 };
  const a = ok(resolveRecovery([cheap], [{ lineId: "c", quantityRecovered: 3 }]));
  check("value rounds to 2dp (3 x 0.333)", a.lines[0].value, 1);
  const tiny = ok(resolveRecovery([cheap], [{ lineId: "c", quantityRecovered: 0.001 }]));
  check("value below a tambala rounds to 0", tiny.lines[0].value, 0);
}

// ---- refusals ----
check("no inputs refused", err(resolveRecovery(lines, undefined)), "Enter the quantity recovered on at least one line.");
check("null inputs refused", err(resolveRecovery(lines, null)), "Enter the quantity recovered on at least one line.");
check("empty inputs refused (no default-to-full)", err(resolveRecovery(lines, [])), "Enter the quantity recovered on at least one line.");
check(
  "unknown line refused",
  err(resolveRecovery(lines, [{ lineId: "nope", quantityRecovered: 1 }])),
  "A line in the recovery doesn't belong to this transfer."
);
check(
  "duplicate line refused",
  err(resolveRecovery(lines, [{ lineId: "l1", quantityRecovered: 1 }, { lineId: "l1", quantityRecovered: 1 }])),
  "Rice 50kg appears more than once in the recovery."
);
check(
  "zero refused",
  err(resolveRecovery(lines, [{ lineId: "l1", quantityRecovered: 0 }])),
  "Rice 50kg: quantity recovered must be greater than zero."
);
check(
  "negative refused",
  err(resolveRecovery(lines, [{ lineId: "l1", quantityRecovered: -1 }])),
  "Rice 50kg: quantity recovered must be greater than zero."
);
check(
  "4 decimals refused",
  err(resolveRecovery(lines, [{ lineId: "l1", quantityRecovered: 0.0001 }])),
  "Rice 50kg: quantity recovered must be a number with at most 3 decimal places."
);
check(
  "NaN refused",
  err(resolveRecovery(lines, [{ lineId: "l1", quantityRecovered: NaN }])),
  "Rice 50kg: quantity recovered must be a number with at most 3 decimal places."
);
check(
  "Infinity refused",
  err(resolveRecovery(lines, [{ lineId: "l1", quantityRecovered: Infinity }])),
  "Rice 50kg: quantity recovered must be a number with at most 3 decimal places."
);
check(
  "over the outstanding refused",
  err(resolveRecovery(lines, [{ lineId: "l1", quantityRecovered: 2.5 }])),
  "Rice 50kg: only 2 is still missing, so 2.5 can't be recovered. Extra stock is a new transfer or a purchase, not a recovery."
);
check(
  "over the remaining outstanding (already partly recovered) refused",
  err(resolveRecovery(lines, [{ lineId: "l3", quantityRecovered: 3.5 }])),
  "Sugar: only 3 is still missing, so 3.5 can't be recovered. Extra stock is a new transfer or a purchase, not a recovery."
);
check(
  "line that arrived in full refused",
  err(resolveRecovery(lines, [{ lineId: "l2", quantityRecovered: 1 }])),
  "Cooking oil: nothing is outstanding on this line – it arrived in full, or the shortfall has already been recovered."
);
check(
  "legacy (pre-Module-65) line refused",
  err(resolveRecovery(lines, [{ lineId: "l4", quantityRecovered: 1 }])),
  "Salt: nothing is outstanding on this line – it arrived in full, or the shortfall has already been recovered."
);
check(
  "already fully recovered line refused",
  err(resolveRecovery([{ ...rice, quantityRecovered: 2 }], [{ lineId: "l1", quantityRecovered: 1 }])),
  "Rice 50kg: nothing is outstanding on this line – it arrived in full, or the shortfall has already been recovered."
);
check(
  "one bad line fails the whole recovery",
  err(resolveRecovery(lines, [{ lineId: "l1", quantityRecovered: 1 }, { lineId: "l2", quantityRecovered: 1 }])),
  "Cooking oil: nothing is outstanding on this line – it arrived in full, or the shortfall has already been recovered."
);

// ---- float drift on input ----
{
  const drift: RecoverableLine = { id: "d", productName: "Flour", quantity: 0.3, quantityReceived: 0, quantityRecovered: null, unitCost: 1000 };
  const a = ok(resolveRecovery([drift], [{ lineId: "d", quantityRecovered: 0.1 + 0.2 }]));
  check("0.1+0.2 recovers the full 0.3 (no float drift)", a.lines[0].fullyRecovered, true);
  check("0.1+0.2 quantity normalised", a.lines[0].quantity, 0.3);
}

// ---- validateRecoveryNote ----
check("note trimmed", validateRecoveryNote("  second truck  "), { ok: true, note: "second truck" });
check("note null refused", validateRecoveryNote(null), { ok: false, error: "A note is required – say where the missing stock turned up." });
check("note blank refused", validateRecoveryNote("   "), { ok: false, error: "A note is required – say where the missing stock turned up." });
check("note at the limit ok", validateRecoveryNote("x".repeat(MAX_RECOVERY_NOTE_LENGTH)).ok, true);
check(
  "note over the limit refused",
  validateRecoveryNote("x".repeat(MAX_RECOVERY_NOTE_LENGTH + 1)),
  { ok: false, error: `The note is limited to ${MAX_RECOVERY_NOTE_LENGTH} characters.` }
);

console.log(`${total - failed}/${total} checks passed`);
if (failed > 0) process.exit(1);
