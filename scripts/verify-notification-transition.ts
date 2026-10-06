/**
 * Module 61: standalone checks for the pure "is this a new occurrence"
 * decision. No database, no framework:
 *   npx tsx scripts/verify-notification-transition.ts   (npm run verify:notification-transition)
 * Exits non-zero if any check fails.
 *
 * Covers src/lib/notification-transition.ts::resolveNotificationTransition
 * directly – the orchestration in src/lib/in-app-notifications.ts::upsertActive
 * pulls in Prisma at module scope and can't be exercised here, the same
 * reason scripts/verify-reopen-history-pagination.ts only tests paginateRows.
 */
import { resolveNotificationTransition, NotificationTransitionInput } from "../src/lib/notification-transition";

let failed = 0,
  total = 0;
function check(name: string, actual: unknown, expected: unknown) {
  total++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}

const base: NotificationTransitionInput = {
  wasResolved: false,
  wasDismissed: false,
  existingAmountSnapshot: null,
  newAmount: undefined,
};

// ---- untouched, still-active alert: just a plain refresh ----
check("untouched alert, no amount tracked -> plain refresh", resolveNotificationTransition({ ...base }), {
  isNewOccurrence: false,
  leaveAsIs: false,
  nextAmountSnapshot: null,
});
check(
  "untouched TAX_DUE-style alert, first amount seen -> plain refresh, snapshot set",
  resolveNotificationTransition({ ...base, newAmount: 5000 }),
  { isNewOccurrence: false, leaveAsIs: false, nextAmountSnapshot: 5000 }
);

// ---- resolved-then-recurred: always fresh, regardless of amount tracking ----
check(
  "resolved-then-recurred, no amount tracked -> fresh occurrence",
  resolveNotificationTransition({ ...base, wasResolved: true, wasDismissed: true }),
  { isNewOccurrence: true, leaveAsIs: false, nextAmountSnapshot: null }
);
check(
  "resolved-then-recurred, amount unchanged -> still fresh (resolution wins over amount check)",
  resolveNotificationTransition({
    ...base,
    wasResolved: true,
    wasDismissed: true,
    existingAmountSnapshot: 5000,
    newAmount: 5000,
  }),
  { isNewOccurrence: true, leaveAsIs: false, nextAmountSnapshot: 5000 }
);

// ---- dismissed, condition never cleared, no amount tracked (LOW_STOCK/STALE_TRANSFER/TRIAL_ENDING) ----
check(
  "dismissed, no amount tracked -> leave as-is (dismiss isn't a snooze)",
  resolveNotificationTransition({ ...base, wasDismissed: true }),
  { isNewOccurrence: false, leaveAsIs: true, nextAmountSnapshot: null }
);

// ---- dismissed TAX_DUE, amount unchanged -> leave as-is ----
check(
  "dismissed, amount unchanged -> leave as-is",
  resolveNotificationTransition({ ...base, wasDismissed: true, existingAmountSnapshot: 5000, newAmount: 5000 }),
  { isNewOccurrence: false, leaveAsIs: true, nextAmountSnapshot: 5000 }
);
check(
  "dismissed, amount changed by less than the noise threshold -> leave as-is",
  resolveNotificationTransition({ ...base, wasDismissed: true, existingAmountSnapshot: 5000, newAmount: 5000.005 }),
  { isNewOccurrence: false, leaveAsIs: true, nextAmountSnapshot: 5000 }
);

// ---- dismissed TAX_DUE, amount genuinely moved -> the actual fix ----
check(
  "dismissed, amount increased -> new occurrence, resurfaces",
  resolveNotificationTransition({ ...base, wasDismissed: true, existingAmountSnapshot: 5000, newAmount: 7500 }),
  { isNewOccurrence: true, leaveAsIs: false, nextAmountSnapshot: 7500 }
);
check(
  "dismissed, amount decreased -> new occurrence, resurfaces",
  resolveNotificationTransition({ ...base, wasDismissed: true, existingAmountSnapshot: 7500, newAmount: 5000 }),
  { isNewOccurrence: true, leaveAsIs: false, nextAmountSnapshot: 5000 }
);
check(
  "dismissed, amount moved by exactly the threshold -> counts as changed",
  resolveNotificationTransition({ ...base, wasDismissed: true, existingAmountSnapshot: 5000, newAmount: 5000.01 }),
  { isNewOccurrence: true, leaveAsIs: false, nextAmountSnapshot: 5000.01 }
);

// ---- dismissed, no PRIOR snapshot (pre-Module-61 row, or an alert type that
// never tracked one) even though this sync now passes an amount -> nothing to
// compare against yet, so leave it (matches the old behaviour exactly; the
// snapshot starts getting recorded from here on for next time) ----
check(
  "dismissed, no existing snapshot yet -> leave as-is (nothing to compare)",
  resolveNotificationTransition({ ...base, wasDismissed: true, existingAmountSnapshot: null, newAmount: 5000 }),
  { isNewOccurrence: false, leaveAsIs: true, nextAmountSnapshot: null }
);

// ---- dismissed TAX_DUE whose amount became null/undefined (shouldn't happen
// in practice – the Tax Calendar always computes a number – but the function
// must not throw or misbehave) -> leave as-is, no comparison possible ----
check(
  "dismissed, existing snapshot present but new amount is null -> leave as-is",
  resolveNotificationTransition({ ...base, wasDismissed: true, existingAmountSnapshot: 5000, newAmount: null }),
  { isNewOccurrence: false, leaveAsIs: true, nextAmountSnapshot: 5000 }
);

console.log(`${total - failed}/${total} checks passed`);
if (failed > 0) process.exit(1);
