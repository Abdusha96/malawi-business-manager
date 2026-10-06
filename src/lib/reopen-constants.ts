// Module 50 split this out of reopen-audit.ts so client components (the
// reconciliation and stock-take workspaces) can import numbers without
// pulling in that file's `prisma` import, which is server-only.
//
// Module 51: the cap itself moved from a single hard-coded MAX_REOPENS to
// Business.maxReopens (see the schema comment) – a business's Owner can now
// raise or lower it from /settings/general instead of needing a code change.
// What stays here is the default a new business gets and the bounds the
// Owner can move it within; both are shared by the Prisma column default,
// the settings-form input, and businessMaxReopensSchema so the three can't
// drift out of sync.
export const DEFAULT_MAX_REOPENS = 5;
export const MIN_MAX_REOPENS = 1;
export const MAX_MAX_REOPENS = 20;
