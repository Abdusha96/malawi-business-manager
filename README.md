# Malawi Business Manager

Mobile-first SaaS for Malawian SMEs – sales, stock, expenses, customers,
debts, cash, payroll, tax and reports in one app.

## Status: Modules 1–11 (Foundation → Accounting) + Modules 12–35 (AI Assistant & Analysis, Multi-Branch UI, Team Management, Business Documents, Refunds, Credit Redemption, VAT, Withholding Tax, Corporate Tax & Tax Calendar, Fixed Assets & Depreciation, Bank Reconciliation, Stock Take & Inventory Adjustment, Notifications, In-App Notifications, Billing & Subscription Management, Branch Scoping for Purchases/Cashbook/Debt Reporting, Branch-Scoped Inventory (StockLevel & Stock Transfers), Branch Scoping for Employees & Payroll, Branch Scoping for Basic Reports, Branch-Scoped Stock Take, Refund VAT Apportionment, Tax Payments, Report Period & Date Handling Correctness, Business Time Zone, Time Zone on Every Screen, Other Income on the P&L, Atomic Quotation Conversion, Foreign Exchange Gains & Losses, Foreign-Currency Invoices & Settlement Differences, Manual Journal Entries & Income Tax Accounts, Period Close, Sales Credit Notes, Supplier Debit Notes, VAT Partial Exemption, VAT Refund Receipts, VAT Carry-Forward Credit Netting, Bank Reconciliation Reopening, Stock Take Reopening, Reopen History & Cap,
Configurable Reopen Cap, Paginate Reopen History, Per-Branch Reorder Thresholds, Reopen Reason Tied to a Specific
Line, Stock Transfer In-Transit / Approval Workflow, In-Transit Stock Visibility, Stale In-Transit Transfer Alerts,
Configurable Stale-Transfer Alert Threshold, Stock Transfer Dispatch-Time Cost Snapshot, Bulk-Apply Reorder Level
Across All Branches, Dismissed TAX_DUE Alerts Re-Surface When the Estimate Changes)

Real, runnable code, built incrementally. Each module lists what it adds and
what it deliberately leaves for later.

### Module 1 – Foundation (Auth, Multi-Tenancy, RBAC, Subscriptions)

- **Database schema** (`prisma/schema.prisma`): User, Business, Branch,
  BusinessMember, Permission/RolePermission, SubscriptionPlan, Subscription,
  AuditLog, Session, VerificationToken, PasswordResetToken.
- **Auth**: email/phone + password login (NextAuth credentials provider),
  registration, email verification tokens, password reset flow. Password
  hashing via bcrypt. 2FA fields are in the schema but not yet wired up –
  flagged as a follow-up, not silently skipped.
- **Multi-tenancy**: every business-scoped table carries a `businessId`.
  `src/lib/tenant.ts` is the single choke point for confirming a user
  belongs to a business before any query runs – read the comment at the top
  of that file before adding a new module.
- **RBAC**: four roles (Owner, Manager, Cashier, Accountant) with a
  data-driven permission system (`src/lib/permissions.ts`).
- **Subscriptions**: four plans seeded from `src/lib/plans.ts` (Free,
  Business K5,000/mo, Professional K15,000/mo, Enterprise custom). New
  businesses get a 14-day Professional trial automatically on registration.
- **Minimal pages**: register, login, forgot/reset password, placeholder
  dashboard showing business + subscription status.

### Module 2 – Products & Inventory

- **Schema additions**: `Category`, `Product`, `InventoryMovement` (an
  append-only stock ledger – `Product.quantity` is a denormalized running
  total, `InventoryMovement` is the source of truth for *why* it changed).
- **`src/lib/inventory.ts`**: `recordInventoryMovement()` is the *only*
  sanctioned way to change stock – it updates the product quantity and
  writes the audit row in one transaction. The upcoming Sales/Purchases
  modules call this rather than touching `Product.quantity` directly.
- **`src/lib/api-context.ts`**: shared helper every business-scoped API
  route uses to resolve session → tenant membership → permission in one
  call. Use this for every new module's routes rather than re-deriving auth
  logic per route.
- **API routes**: CRUD for categories and products, stock adjustment
  (always requires a reason, always logged), and an inventory summary
  endpoint (low stock / out of stock / total inventory value).
- **Pages**: `/inventory` (list with stock-status badges), `/inventory/new`
  (add product form with opening stock).
- New permission: `inventory.adjust`, separate from `inventory.manage` –
  editing a product's price and writing off damaged stock are different
  levels of trust, and this keeps them separately grantable.

### Module 3 – Sales & Receipts

- **Schema additions**: minimal `Customer` (expanded by the Customers/Debt
  module next), `Sale`, `SaleItem`, `Payment`, `Receipt`. `Payment` is shared
  – both point-of-sale payments and later debt repayments write to the same
  table, so a customer's full payment history is one query, not two
  reconciled code paths.
- **`src/lib/sales.ts`**: the only place a Sale is created or voided.
  - Totals are always recalculated server-side from submitted line items –
    a client-supplied total is never trusted.
  - Creating a sale, decrementing stock (via `recordInventoryMovement`), and
    generating the receipt number all happen in one DB transaction – either
    all of it commits or none of it does.
  - Voiding a sale restores stock and marks it `VOIDED`; it never deletes
    the sale, preserving the audit trail spec section 28 requires.
- **Sale statuses**: `PAID` / `PARTIAL` / `CREDIT` / `VOIDED`, computed from
  `total` vs `amountPaid` – never set directly by a route handler.
- **API routes**: sales CRUD (list/create/get/void), a shared
  `/payments` endpoint for recording debt repayments (used here and by the
  Customer Debt module next), minimal customers CRUD.
- **Pages**: `/sales` (list with status badges), `/sales/new` (cart-style
  form – add products, adjust quantity/price/discount per line, see the
  balance update live), `/sales/[id]/receipt` (printable receipt via the
  browser's print dialog).
- **Deliberately deferred**: PDF generation (a proper shared PDF layout
  engine belongs in the Business Documents module, not bolted on here),
  barcode scanning and offline support (POS module, spec section 7),
  invoices/quotations as separate documents (same Business Documents
  module – the `Receipt` table is structured so those can be added as
  siblings, not a rewrite).

### Module 4 – Expenses

- **Schema addition**: `Expense`, with a fixed `ExpenseCategory` enum
  matching spec section 12's category list exactly. This is a deliberate
  contrast with Product `Category` (a table, business-defined) – expense
  categories aren't something a business needs to customize, so an enum
  keeps grouping/filtering fast and simple.
- **`src/lib/audit.ts`**: new shared helper – `logAudit()`. Expense
  create/update/delete all write an audit row (spec section 41 requires an
  audit trail for financial changes). Later modules touching money
  (payroll, tax config, journal entries) should call this too rather than
  going unlogged.
- **API routes**: expenses CRUD, plus a `/summary` endpoint (today/month
  totals + category breakdown) that the real Dashboard module will consume
  directly for its "Expenses by category" chart.
- **Pages**: `/expenses` (list with month-to-date total) and `/expenses/new`.
- Reuses the `PaymentMethod` enum from the Sales module rather than
  duplicating it – `CREDIT` is excluded from the expense form's options
  since an expense paid on credit is really a supplier liability, which
  belongs to the Suppliers module, not a payment method here.
- Receipt attachment is a `receiptUrl` field that's currently unpopulated –
  it activates once the Storage module (spec section 3, object storage)
  exists; the field is there now so Expense doesn't need a migration later.

### Module 5 – Customers & Debt Management

- **Schema**: `Customer` gains `customerType` (Individual/Business). Total
  purchases / amount paid / outstanding balance are deliberately **not**
  stored columns – see the comment on the `Customer` model. They're always
  computed live from `Sale`/`Payment` in `src/lib/customers.ts`, so a voided
  sale or backdated payment can never leave a stale debt figure sitting
  around.
- **Bug caught and fixed while building this**: a customer-level payment
  (no specific sale attached) previously would have been recorded in the
  `Payment` table but wouldn't have reduced any `Sale.balance` – since
  outstanding balance is computed as a sum over `Sale.balance`, that payment
  would have silently vanished from the customer's debt figure.
  `applyCustomerPayment()` now allocates a general payment across the
  customer's open sales oldest-first (FIFO), updating each sale's
  `amountPaid`/`balance`/`status` as it goes, with graceful handling of
  overpayment (recorded as unallocated credit rather than dropped).
- **Aging dashboard**: `getReceivablesAging()` buckets every open sale's
  balance by age (current / 1–30 / 31–60 / 61–90 / 90+ days) – computed from
  `Sale.saleDate` since regular sales don't carry a separate due date yet
  (that arrives with proper Invoice payment terms in the Business Documents
  module).
- **Reminders**: `buildReminderMessage()` produces the exact message shape
  from spec section 10. Sending is stubbed (logged + audit-logged) until the
  Notifications module wires up a real SMS/WhatsApp provider – same pattern
  as the email stubs in Module 1.
- **API routes**: customer CRUD (list now includes computed outstanding
  balance via one grouped query, not N+1), `/debt-summary` (aging
  dashboard), `/[customerId]/reminder`. The existing `/payments` endpoint
  from Module 3 was fixed as described above rather than left with the gap.
- **Pages**: `/customers` (list with outstanding balance), `/customers/new`,
  `/customers/[id]` (profile: computed summary, sales history, payment
  history, record-payment and send-reminder actions), `/customers/debts`
  (the aging dashboard).

### Module 6 – Dashboard

The "understand your business in 30 seconds" module (spec sections 5 and
39's core product principle). Replaces the Module 1 placeholder dashboard
entirely.

- **Schema addition**: `SaleItem.unitCost` – snapshots `Product.purchasePrice`
  at the moment of sale, the same way `unitPrice` already snapshots the
  selling price. Without this, gross profit for past sales would silently
  drift every time a purchase price changed. `src/lib/sales.ts` was updated
  to populate it.
- **`src/lib/dashboard.ts`**: single aggregation service for every number
  and chart on the dashboard – today/month sales, expenses, and profit;
  gross/net margins; sales and expense growth vs. last month; inventory
  value; outstanding customer debt (reusing Module 5's aging logic); top
  products; payment-method and category breakdowns; a 14-day sales trend.
- **Cash/Mobile Money/Bank "balances" are clearly marked approximate.**
  There's no Cashbook module yet (spec section 13), so these are derived as
  (payments received via that channel) − (expenses paid via that channel),
  all-time. The API response includes `balancesAreApproximate: true` and the
  UI shows an "Estimated" badge rather than presenting a guess as fact. The
  Cashbook module will replace this with real opening balances and transfer
  tracking.
- **Supplier debt shows as "Not tracked yet"** rather than a fake zero
  presented as real – `supplierDebtAvailable: false` in the API response
  flags this until the Suppliers module exists.
- **Role-gated**: new `dashboard.view` permission, granted to Owner,
  Manager, and Accountant – not Cashier, per spec section 1 ("cannot access
  financial reports"). A Cashier hitting `/dashboard` gets a simple
  quick-actions view (record a sale, view sales, customers) instead of a 403
  or a broken page.
- **Charts** use Recharts (v3, actively maintained – the sandbox's default
  npm resolution initially picked the EOL v2 branch, corrected before
  packaging this).
- Sales growth / expense growth show as "–" rather than "0%" when there's no
  prior month to compare against (a brand-new business's first month) –
  `null` is a different fact than "no growth" and the UI doesn't blur them.

### Module 7 – Basic Reports

Scoped to what spec section 40 (MVP Development Order) calls "Basic
reports" – full P&L / Balance Sheet / Cash Flow need real double-entry
accounting (Phase 3, not built yet) and would be dishonest to fake from
these tables directly.

- **`src/lib/reports.ts`**: Sales (daily/weekly/monthly/annual grouping),
  Expenses (by category), Inventory, Customer Debt (reuses Module 5's aging
  logic), Salesperson, and Product Profitability (uses `SaleItem.unitCost`
  from Module 6, so margins are historically accurate).
- **`src/lib/csv.ts`**: every report route supports `?format=csv`. This
  covers "CSV export" directly and "Excel export" loosely (CSV opens fine in
  Excel) – genuine `.xlsx` generation and PDF export are both deferred; see
  the comment in that file for why (not worth a spreadsheet-writing
  dependency for one feature; PDF needs the same shared layout engine noted
  in the Sales module).
- **New permission `reports.basic.view`**: granted to Owner, Manager,
  Accountant – not Cashier, consistent with `dashboard.view`. Kept distinct
  from `reports.financial.view` (reserved for the future full financial
  statements module) in case that ever needs a narrower grant than basic
  reports do.
- **Page**: `/reports` – a single hub with report tabs, a date-range picker
  (for the reports that need one), a generic table renderer, and a CSV
  download button, rather than six near-identical pages.
- A real bug was caught and fixed while building this: the salesperson
  report's name lookup was untyped in a way that broke CSV export's type
  safety – fixed by explicitly typing the `Map<string, string>` rather than
  letting it fall through as `any`.

### Module 8 – Suppliers & Purchases

Closes the inventory restocking loop (previously the only way stock
increased was manual "opening stock" at product creation) and gives the
dashboard's Supplier Debt figure real data instead of the earlier
"Not tracked yet" stub.

- **Schema**: `Supplier`, `Purchase`, `PurchaseItem`. `Product.supplierId`
  (a placeholder plain field since Module 2) is now a real relation.
  `Payment` gained `purchaseId`/`supplierId` – it now represents money in
  *and* money out of the business, not just money in.
- **`src/lib/suppliers.ts`** and **`src/lib/purchases.ts`** deliberately
  mirror `customers.ts`/`sales.ts`: computed (never stored) debt figures,
  FIFO payment allocation (`applySupplierPayment`), and a transactional
  `createPurchase`/`voidPurchase` pair. Restocking goes through the same
  `recordInventoryMovement()` from Module 2 that Sales uses, just with a
  positive delta.
- **Costing choice, stated plainly**: each purchase's `unitCost` becomes the
  product's new `purchasePrice` (last-in cost) – no weighted-average or FIFO
  costing. That's a deliberate simplification; proper costing methods belong
  in the Accounting module once double-entry bookkeeping exists to
  reconcile them. Voiding a purchase reverses stock but does not roll back
  the cost basis it set – documented as an acceptable gap in the code.
- **Two real bugs caught and fixed while wiring this in**:
  1. `getChannelBalances()` (dashboard cash-position calculation) summed
     *all* `Payment` rows as money received – once `Payment` became
     bidirectional, a supplier payment would have been counted as income
     instead of an outflow. Fixed by splitting the query into
     customer-side (received) and supplier-side (paid), the latter now
     added alongside `Expense` on the "money out" side.
  2. The shared `/payments` route needed a stricter permission check for
     the supplier side – `payments.record` (which Cashier has) was too
     permissive for *paying out* to a supplier; that direction now
     additionally requires `suppliers.manage`, which Cashier does not have.
- **New permissions**: `suppliers.manage/view`, `purchases.create/view/void`
  – granted to Owner and Manager (mirrors the existing inventory-adjacent
  scope), view-only for Accountant, none for Cashier.
- **Reports**: added Supplier Debt to the `/reports` hub (Module 7) – a
  flat list, not aged like Customer Debt, since spec section 11 only asks
  to "track" supplier debts, not bucket them by age.
- **Pages**: `/suppliers`, `/suppliers/new`, `/suppliers/[id]` (profile +
  record payment), `/purchases`, `/purchases/new` (cart-style restocking
  form).

### Module 9 – Cashbook

Replaces the Module 6 dashboard's *approximated* cash/mobile-money/bank
balances with a real, purpose-built ledger – spec section 13. This module
touched more existing code than any before it, since every place money
already moved (Sales, Purchases, customer/supplier debt payments, Expenses)
needed to start posting to it.

- **Schema**: `CashAccount` (Cash/Bank/Airtel Money/TNM Mpamba, multiple
  accounts per type allowed – e.g. two different banks), `CashTransaction`
  (an append-only ledger, same pattern as `InventoryMovement`). Balance is
  always computed (`openingBalance` + sum of transactions), never a stored
  running total, for the same reason customer/supplier debt figures are
  computed – nothing to drift.
- **A real bug caught and fixed during schema design, before it ever ran**:
  a `@@unique([businessId, type, isDefault])` constraint meant to enforce
  "only one default account per type" would have also blocked creating a
  *second, non-default* account of the same type (e.g. a second bank
  account) – Postgres treats repeated `false` values as duplicates for
  uniqueness purposes; only `NULL` is exempt. Fixed by dropping the DB
  constraint and enforcing the invariant in application code instead
  (`getOrCreateDefaultAccount` is the only function allowed to set
  `isDefault: true`), documented with the reasoning directly in the schema.
- **Full integration, not a bolt-on**: `src/lib/sales.ts`,
  `src/lib/purchases.ts`, `src/lib/customers.ts` (FIFO debt payments),
  `src/lib/suppliers.ts` (FIFO debt payments), the shared `/payments`
  route, and the Expenses routes were all updated to post real
  `CashTransaction` rows via `postCashTransactionForPayment` /
  `postCashTransactionForExpense` – the dashboard reads this ledger now
  instead of two systems computing balances independently.
- **A second real bug caught while wiring Expenses in**: editing or
  deleting an expense would have left a stale cash-ledger entry behind.
  Fixed with `reverseCashTransactionsForReference()` – posts an
  equal-and-opposite `ADJUSTMENT` entry rather than deleting history, then
  (for edits) reposts the corrected amount.
- **Two gaps flagged rather than silently left**: voiding a *paid* Sale or
  Purchase does not reverse the associated cash – that's really a refund
  decision (cash back? store credit? nothing, because it was a data-entry
  error?) that shouldn't be guessed at by a void function. Documented
  plainly in both `voidSale` and `voidPurchase` for a future Refunds
  module to resolve deliberately.
- **New permissions**: `cashbook.view` (Owner, Manager, Accountant) and
  `cashbook.manage` (Owner, Accountant – transfers between accounts are a
  more sensitive action than viewing balances, so Manager doesn't get it).
- **Pages**: `/cashbook` – account cards with live balances, an expandable
  per-account transaction ledger, a transfer form, and an add-account form.
- **Dashboard updated**: `balancesAreApproximate` is now `false`; the
  "Estimated" badge from Module 6 stops showing automatically since it was
  already conditional on that flag.
- Default accounts (Cash, Bank, Airtel Money, TNM Mpamba) are now seeded at
  business registration (Module 1's register route was extended) so the
  Cashbook has somewhere to post to from day one.

### Module 10 – Employees & Payroll

Spec sections 17-19. Tax rates are explicitly required not to be
hard-coded – this module is built around that requirement from the ground
up, not retrofitted.

- **Schema**: `Employee`, `TaxConfiguration` (PAYE bands stored as JSON
  data, not code), `Payroll` (one row per employee per pay period, unique
  on `businessId + employeeId + payPeriod`).
- **`src/lib/payroll.ts`**: `computePAYE()` applies progressive tax bands
  read entirely from data – verified correct at boundaries (income exactly
  at a band threshold is taxed by the lower band only, matching standard
  progressive-tax convention). `calculatePayroll()` is a pure function (no
  DB access), so it's directly unit-testable without a database.
- **Tax rates are seeded as clearly-labeled EXAMPLE values**, not real
  Malawi Revenue Authority figures – this app is not the source of truth
  for tax law. `TaxConfiguration.isExample` stays `true` until an
  Owner/Accountant explicitly reviews and re-saves the configuration, which
  drives a disclaimer banner shown on both the Payroll run page and the Tax
  Settings page (fulfilling spec section 19's explicit disclaimer
  requirement). I deliberately did not present specific unverified tax
  percentages as fact anywhere in this codebase.
- **Closed a gap from Module 1**: `planHasFeature()` has existed since the
  subscription plan system was built, but nothing ever called it –
  `src/lib/subscription.ts::requirePlanFeature()` is the first real
  enforcement point, gating Payroll behind the Professional plan tier (spec
  section 4). Future Professional/Enterprise-only features should use the
  same function rather than re-deriving plan checks ad hoc.
- **Cashbook integration**: paying a payroll run posts a real ledger
  outflow via `postCashTransactionForPayroll()` (added to
  `src/lib/cashbook.ts`), the same integration pattern Expenses uses.
- **Payroll runs are immutable once PAID** – `upsertPayrollRun()` refuses
  to modify a paid run; correcting one means a new adjustment, following
  the same principle already established for voided sales/purchases and
  cash-ledger corrections.
- **New permissions**: `employees.manage/view`, `payroll.manage/view`
  (`tax.manage` already existed). Restricted to Owner and Accountant, not
  Manager or Cashier – a judgment call for salary confidentiality that
  spec section 1 doesn't explicitly state but is consistent with its
  "sensitive financial settings" carve-out for Manager.
- **Pages**: `/employees`, `/employees/new`, `/employees/[id]` (profile
  with masked bank account display – `••••1234`, never the full number, in
  any UI), `/payroll` (period selector, per-employee calculate/pay
  actions), `/payroll/[id]/payslip` (printable), `/settings/tax` (PAYE band
  editor with the disclaimer banner).

### Module 11 – Double-Entry Accounting

Spec section 20, plus the Financial Reports half of section 21 (P&L,
Balance Sheet, Cash Flow). This is the largest module in the codebase – it
didn't add new screens so much as retrofit real ledger posting into every
transaction type built in Modules 3, 4, 8, 9, and 10.

- **Schema**: `Account` (chart of accounts), `JournalEntry`, `JournalLine`.
  `Account.systemKey` gives the posting engine a stable lookup independent
  of the user-editable `code`/`name` fields – looking up "the AR account"
  by code would break the moment someone renumbers their chart.
- **`src/lib/chart-of-accounts.ts`**: the standard chart seeded for every
  business – cash accounts mapped 1:1 to Module 9's `CashAccountType`, one
  expense account per Module 4's `ExpenseCategory`, plus AR/AP/Inventory/
  PAYE Payable/Pension Payable/etc.
- **`src/lib/accounting.ts`**: the engine. `postJournalEntry()` is the only
  place a journal entry is created and the only place that enforces
  debits = credits – every integration point calls this rather than
  writing to `JournalEntry` directly.
- **`src/lib/accounting-integrations.ts`**: the translation layer. The key
  design decision: **Sales and Purchases post as two independently-balanced
  entries** (Revenue/AR separate from COGS/Inventory) specifically so that
  voiding can reverse only the inventory effect – deliberately mirroring
  the exact gap already documented in `voidSale`/`voidPurchase` (Modules 3
  and 8), where cash already collected/paid is NOT reversed. Accounting
  doesn't pretend to undo money the Cashbook doesn't; it mirrors that
  boundary honestly rather than silently reversing more than the rest of
  the system does. Payroll's entry balances by construction – verified
  algebraically against the net-salary formula from Module 10, not just
  hoped to work.
- **`src/lib/financial-statements.ts`**: Trial Balance, General Ledger
  (per-account drill-down), Profit & Loss, Balance Sheet, and a Cash Flow
  Statement built from the Module 9 Cashbook ledger. Balance Sheet computes
  Retained Earnings as all-time net income rather than requiring a formal
  period-close step – a standard technique, documented as such. Cash Flow's
  Investing and Financing sections are honestly reported as "not yet
  modeled" (this app has no asset-purchase or owner-contribution/loan
  transaction types) rather than fabricating a categorization for
  transaction types that don't exist.
- **Two real bugs caught and fixed while building this**:
  1. A circular import risk: `cashbook.ts` needed to call into
     `accounting-integrations.ts` (for Transfer postings), which already
     imported a helper (`accountTypeForPaymentMethod`) from `cashbook.ts`.
     Fixed by moving that shared helper to `chart-of-accounts.ts`, which
     both files can depend on without depending on each other.
  2. That same refactor introduced a genuine break: `cashbook.ts` was left
     with only a re-export of the moved function (`export { x } from
     "./y"`), which does NOT create a local binding – the three internal
     call sites inside `cashbook.ts` itself were calling a name not in
     scope. `tsc --noEmit` caught it immediately; fixed by adding a real
     `import` alongside the re-export.
  3. A property-name mismatch (`pnlAllTime.totalCOGS` vs. the actual
     `costOfGoodsSold` field returned by `getProfitAndLoss`) in the Balance
     Sheet's Retained Earnings calculation – also caught by `tsc --noEmit`
     before it could produce a silently wrong balance sheet.
- **Pages**: `/accounting` – a tabbed hub (Chart of Accounts, Trial
  Balance, P&L, Balance Sheet, Cash Flow, General Ledger drill-down),
  restricted to Owner and Accountant via the existing `accounting.view`/
  `accounting.manage` permissions from Module 1.

### Module 12 – AI Assistant & Transaction Analysis

Spec sections 22-23. Two genuinely different features sharing one page:
a natural-language Q&A assistant (needs an LLM) and rule-based anomaly
detection (deliberately does NOT).

- **`src/lib/ai-context.ts`**: the security boundary for Mobi Accountant.
  Every field it returns comes from a function that already takes
  `businessId` and filters by it – the same functions Dashboard/Reports/
  Debt tracking use. The AI layer never gets a database connection or a
  means to request "more" data. This is what makes spec section 22's "must
  ONLY use data the authenticated user is authorized to access" true by
  construction – there's no cross-tenant data available for the model to
  leak even in principle, not just a prompt instruction hoping it behaves.
- **`src/lib/ai-assistant.ts`**: calls the Anthropic API directly (the
  business owner supplies their own `ANTHROPIC_API_KEY`; the app degrades
  gracefully with a clear message if it's unset, rather than crashing). The
  system prompt explicitly enforces spec section 22's three-way
  distinction – every part of an answer is labeled `[Data]`, `[Guidance]`,
  or `[Professional advice needed]`. Model name is an env var, not
  hard-coded, since Anthropic's model lineup changes.
- **`src/lib/ai-analysis.ts`**: spec section 23's checks (expense category
  spikes, negative-margin products, thin margins, large overdue debtor
  balances, sudden sales declines, possible duplicate transactions) as
  plain percentage/threshold calculations – not an LLM call. This was a
  deliberate engineering choice: spec section 23's own example ("transport
  expenses increased by 38%") is exactly the kind of precise, deterministic
  check code does reliably and an LLM would do inconsistently and more
  expensively. "Stock discrepancies" from the spec's list isn't
  implemented as a check – `recordInventoryMovement()` (Module 2) already
  prevents stock from going negative, so there's no discrepancy state for
  this system to detect against itself.
- **`AIAnalysis` model**: stores each run's findings (per spec section 29's
  explicit DB model list), so history is browsable, not just the latest run.
- **Plan-gated**: both features require the Professional plan, enforced via
  `requirePlanFeature(businessId, "aiAssistant")` – the same enforcement
  function Module 10 introduced for Payroll.
- **New permission `ai.use`**: Owner, Manager, Accountant – not Cashier,
  matching the `dashboard.view` grant set.
- **Page**: `/ai-assistant` – tabbed between "Ask Mobi Accountant" (chat-
  style, with the spec's own example questions as quick-start buttons) and
  "Transaction Analysis" (run on demand, findings color-coded by severity).
- A genuine bug surfaced and fixed by `tsc --noEmit` during this module:
  the same untyped-`Map` pattern already fixed once in `dashboard.ts`
  (Module 6) recurred in the expense-category comparison here – fixed the
  same way, with an explicitly-typed `Map<string, number>`.

### Module 13 – Multi-Branch UI

- **`src/lib/tenant.ts::resolveBranchScope()`**: the new choke point for
  branch isolation, mirroring how `requireBusinessMember()` is the choke
  point for tenant isolation. `BusinessMember.branchId` has existed since
  Module 1, but nothing enforced it – a branch-restricted member could
  still pass a different `branchId` and read or write another branch's
  data. Every branch-scoped route (Sales, Expenses) now resolves the
  requested branch through this function instead of trusting the raw query
  param or body field.
- **`src/lib/branches.ts`**: branch CRUD plus `listBranchesWithStats()` /
  `getBranchStats()` (sales total + count, expense total, assigned staff
  count per branch). The head office branch can be renamed but never
  deactivated – enforced in `updateBranch()`, not just in the UI.
- **API routes**: `GET`/`POST /api/business/[businessId]/branches`,
  `GET`/`PATCH /api/business/[businessId]/branches/[branchId]`, gated by
  the `branches.manage` permission that was already seeded (Owner/Manager)
  since the permissions system was built.
- **Pages**: `/branches` (list with per-branch stats), `/branches/new`,
  `/branches/[branchId]` (edit + activate/deactivate toggle).
- **Sales and Expenses now actually use `branchId`**: both routes accepted
  it in their schemas since Modules 3–4 but never filtered or enforced it.
  `GET` list routes now filter by branch (auto-scoped for a restricted
  member, optional `?branchId=` for everyone else); the sale/expense forms
  show a branch picker when a business has more than one active branch and
  the current member isn't locked to one; the Sales and Expenses list pages
  show a Branch column.
- **Dashboard**: `getDashboardData()` takes an optional `branchId` and
  filters the Sales- and Expense-derived figures (today/month totals,
  profit, sales-by-day, top products, payment-method and expense-category
  breakdowns) by it. A branch switcher (`/dashboard?branchId=...`) is shown
  to unrestricted members when the business has more than one branch; a
  restricted member's dashboard is always scoped to their branch.
- **Deliberately still business-wide, not branch-scoped**: inventory,
  the Cashbook ledger, customer receivables, and supplier debt – none of
  those models carry a `branchId` in the schema (see the comment on
  `Branch` in `prisma/schema.prisma`). The dashboard and branches list both
  say so in the UI rather than silently implying otherwise.
- **Not built**: a team/member invite UI. `BusinessMember.branchId` (which
  branch a staff member is restricted to) has no screen to set it yet –
  today only the Owner gets a `BusinessMember` row, created at registration
  with no `branchId`. A future Team Management module should let an Owner
  invite members and assign them to a branch; `resolveBranchScope()` is
  already written to enforce that restriction the moment such a row exists.

### Module 14 – Team Management

- **`prisma/schema.prisma`**: new `BusinessInvitation` model (email, role,
  optional branch, token, expiry, who invited them, accepted/revoked
  timestamps). Deliberately separate from `BusinessMember` – an invite can
  exist for someone who has no `User` row yet. Also added the `branch`
  relation on `BusinessMember` itself, which previously only had a bare
  `branchId` string with no relation, so it couldn't be queried with
  `include`.
- **`src/lib/team.ts`**: `inviteMember()`, `acceptInvitation()`,
  `revokeInvitation()`, `updateMember()`, `listTeam()`,
  `getInvitationByToken()`. `acceptInvitation()` handles both cases in one
  function – if the invited email already has a `User` account, it's
  reused as-is; if not, the account is created in the *same transaction* as
  the `BusinessMember` row, so there's no window where an account exists
  without a membership (or vice versa).
- **Plan limits actually enforced now – a gap Module 13 also had.**
  `PlanDefinition.maxUsers` / `maxBranches` (`src/lib/plans.ts`) existed
  since Module 1, and `requirePlanFeature()` (Module 10) checked boolean
  feature flags, but nothing ever checked the numeric ceilings – a Free
  plan (`maxUsers: 1`, `maxBranches: 1`) could invite unlimited team
  members or create unlimited branches. Added
  `requirePlanCapacity(businessId, "users" | "branches", currentCount)` in
  `src/lib/subscription.ts` and wired it into both `inviteMember()` and
  `createBranch()` (retroactively fixing Module 13). The count passed in is
  "how many already exist", so a Free-plan business with 1 branch is
  correctly blocked from adding a 2nd rather than blocked one request late.
- **API routes**: `GET`/`POST /api/business/[businessId]/team` (list,
  invite), `PATCH /api/business/[businessId]/team/[memberId]` (change
  role/branch/active status), `POST
  /api/business/[businessId]/team/invitations/[invitationId]` (revoke) –
  all gated by the `business.members.manage` permission, which was already
  seeded as Owner-only since the permissions system was built and needed
  no changes. Plus two intentionally public, unauthenticated routes: `GET
  /api/invitations/[token]` and `POST /api/invitations/accept`, since the
  person accepting an invite doesn't have a session yet.
- **Pages**: `/team` (members with inline role/branch editing, pending
  invitations with a revoke action), `/team/invite`, and
  `/accept-invitation` (public – shows the business name/role, then either
  "log in to accept" for an existing account or a name+password form to
  create one). A "Team" link was added to the dashboard nav, gated the same
  way as the page.
- **Not built**: real email delivery for invitations – the invite link is
  logged to the console the same way the registration verification email
  is (see Module 1's `TODO(module: notifications)`), not actually sent.
  There's also no self-serve "upgrade your plan" flow yet – hitting a
  `PlanRestrictionError` just shows the message, with nothing to click
  through to billing.

### Module 15 – Business Documents: Quotations & Invoices

Closes the gap flagged since Module 3 – `Receipt`'s comment promised
Invoices/Quotations "as distinct documents, each with independent
numbering," and the receipt page's comment deferred a real PDF download
until a shared layout engine existed. Both now do.

- **Schema additions**: `Quotation` / `QuotationItem` (a pre-sale price
  proposal – deliberately touches neither stock nor the Cashbook/GL, since
  it's not yet a transaction) and `Invoice` (a sibling to `Receipt`, one per
  Sale, generated on demand). `Business.invoicePrefix`/`nextInvoiceNumber`
  had existed, unused, since Module 1 – this module is what finally uses
  them; a new `quotationPrefix`/`nextQuotationNumber` pair was added
  alongside for the same atomic-numbering pattern.
- **`src/lib/pdf.ts`**: the shared PDF layout engine (pdfkit, standard 14
  fonts only – no font files to ship). One `renderBusinessDocumentPdf()`
  function draws the header/bill-to/items-table/totals/footer that
  receipts, invoices, and quotations all reuse, so a future payslip PDF
  (spec section 11) has the same function to call rather than a fourth
  bespoke layout.
- **`src/lib/quotations.ts`**: quotation CRUD (editable only while `DRAFT`),
  status transitions (`DRAFT → SENT → ACCEPTED/DECLINED/EXPIRED`), and
  `convertQuotationToSale()` – which calls the real `createSale()` from
  Module 3 rather than duplicating its totals/stock/receipt/ledger logic, so
  a converted quotation is indistinguishable from a manually-entered sale
  everywhere downstream. A quotation line can be a free-text item not yet in
  inventory (a Sale line cannot); converting is refused with a specific,
  actionable message if any line isn't linked to a real product yet.
- **`src/lib/invoices.ts`**: lazy per-sale invoice generation mirroring the
  `Receipt` pattern – the number is claimed atomically the first time it's
  requested for a sale, and every later request returns the same invoice
  rather than claiming a second number.
- **API routes**: quotations list/create, get/update/status-change, convert-
  to-sale, and PDF download; invoice generate-or-fetch and PDF download for
  any sale; a new PDF download route for the existing receipt.
- **Pages**: `/quotations` (list), `/quotations/new` (cart-style form with
  a "Custom item" option per line for products not yet in inventory),
  `/quotations/[id]` (detail, status actions, convert-to-sale flow with
  payment method/amount, PDF download). The receipt page gained "Download
  PDF" and, for a sale left with a balance, a "Get Invoice" button.
- **New permissions**: `quotations.manage`, `quotations.view`,
  `documents.generate` – granted to Owner/Manager/Cashier (quoting and
  printing documents are front-line tasks) and view-only to Accountant.
  Converting a quotation to a sale is gated by `sales.create`, not
  `quotations.manage`, so a role that can draft quotes but not record sales
  can't achieve the same effect by converting one.
- **KNOWN LIMITATION – CLOSED BY MODULE 38** (wording kept as the historical
  record): `convertQuotationToSale()` calls `createSale()` (its
  own transaction) and then updates the quotation's status as a second,
  separate write, rather than one nested transaction – `createSale()`'s
  signature isn't set up to accept an external transaction client, and
  changing it for every existing caller was judged out of scope for this
  module. In the rare case the second write fails, the sale exists but the
  quotation is left un-marked; an operator would see both and could
  reconcile manually. A future refactor of `createSale()` to optionally
  accept a `tx` would close this properly.
- **Not built**: quotation PDFs and invoice PDFs don't yet carry the
  business's logo (`Business.logoUrl` is stored but no file-storage module
  exists yet to actually host an uploaded image – see Module 4's
  `receiptUrl` writeup for the same gap). Emailing a quotation or invoice
  directly to a customer is deferred to the same future Notifications
  module that already owes real delivery for verification/invitation
  emails (Modules 1 and 14).

### Module 16 – Refunds

Closes the gap flagged since Modules 3, 8, 9, and 11: voiding a paid
`Sale` or `Purchase` restores stock but was always deliberately silent on
what happens to cash already collected or paid – that ambiguity (cash
back? credit? nothing?) needed a real decision, not a guess. This module
also closes a second, unrelated gap discovered while building it: the
`sales.void`/`purchases.void` API routes have existed since Modules 3 and
8, but nothing in the UI ever called them – there was no way to void a
sale or purchase without using a REST client directly.

- **Schema addition**: `Refund` (linked to exactly one `Sale` or
  `Purchase`, enforced in `src/lib/refunds.ts` rather than the DB) with a
  `RefundMethod` of `CASH`, `CREDIT_NOTE`, or `WRITE_OFF`. Multiple refunds
  can exist against the same voided document – e.g. half back in cash now,
  the rest written off later – constrained only by how much was actually
  paid. `Business.refundPrefix`/`nextRefundNumber` follow the same atomic-
  numbering pattern as every other document.
- **`src/lib/refunds.ts`**: `createRefund()` – the one function that
  creates a `Refund` row, requires the target already be `VOIDED`, and
  posts the Cashbook/GL side effects for `CASH` refunds inside the same
  transaction. `getRefundableAmount()` / `getPendingRefunds()` compute the
  unresolved balance live from `Refund` rows rather than a stored running
  total (same reasoning as every other balance in this app).
- **Accounting** (`src/lib/accounting-integrations.ts::postJournalEntryForRefund`):
  what gets posted depends on what void already left standing. A voided
  Sale still has full Revenue recognized and AR already netted to zero by
  any payment, so a `CASH` sale refund debits `SALES_REVENUE` directly (no
  separate "Sales Returns" account needed) and credits Cash. A voided
  Purchase has its Inventory/AP entry fully reversed already, leaving AP
  sitting at a residual debit balance equal to whatever was paid, so a
  `CASH` purchase refund debits Cash and credits `ACCOUNTS_PAYABLE` to
  clear that residual. `CREDIT_NOTE` posts the same Revenue/AP side but
  against two new accounts, `CUSTOMER_CREDITS_PAYABLE` (liability) and
  `SUPPLIER_CREDITS_RECEIVABLE` (asset), instead of Cash. `WRITE_OFF` posts
  nothing further – a deliberate decision that void's existing postings
  stand as-is.
- **`src/lib/accounting.ts::getOrCreateSystemAccountId()`**: backfills a
  system account on the fly if it's missing, used only for the two new
  Module 16 accounts above – a business that registered before this module
  existed has a chart of accounts seeded without them. Mirrors the
  backfill pattern Module 14 used for `planHasFeature()` on already-
  existing data. Established accounts (Cash, AR, Inventory, ...) keep using
  the existing `getSystemAccountId()`, which still throws loudly if one is
  missing – that would mean a genuinely broken chart of accounts, not a
  newer-module gap.
- **`src/lib/cashbook.ts::postCashTransactionForRefund()`**: direction is
  the mirror image of `postCashTransactionForPayment` – a sale refund is
  cash OUT (giving a customer their money back), a purchase refund is cash
  IN (getting money back from a supplier), since it's undoing the original
  transaction's direction, not repeating it.
- **New pages closing the missing-void-UI gap**: `/sales/[saleId]` and
  `/purchases/[purchaseId]` (detail pages that didn't exist before this
  module – previously a sale's only page was its receipt) now show full
  line items, a Void action with a required reason, and, once voided, the
  refund status and a link into the refund flow. `/refunds` lists documents
  awaiting a decision plus full refund history; `/refunds/new` is the
  refund form (amount, method, reason, and – for `CASH` – which cash
  account, with its live balance shown and a sale-side insufficient-balance
  warning).
- **New permissions**: `refunds.manage` (Owner/Manager – mirrors who
  already holds `sales.void`/`purchases.void`) and `refunds.view`
  (additionally Accountant, view-only).
- **KNOWN LIMITATION**: `CREDIT_NOTE` refunds post a real GL
  liability/asset and are exposed via `getCustomerCreditBalance()` /
  `getSupplierCreditBalance()`, but nothing yet lets that credit actually
  be redeemed against a future sale or purchase –
  `applyCustomerPayment()`/`applySupplierPayment()` don't look at it. This
  is the same category of gap as Module 3's "unallocated credit"
  overpayment, which also has no consumption path yet; a future module
  should wire up both at once. **Closed in Module 17.**

### Module 17 – Credit Redemption

Wires up both standing-credit gaps flagged above at once, exactly as
Module 16's write-up asked for: a customer/supplier can end up with credit
either from a `CREDIT_NOTE` refund or from simply overpaying past every
open balance, and until now neither could ever be spent – it just sat on
the profile page as a number forever.

- **Schema addition**: `CreditRedemption` (+ `CreditSourceType` enum:
  `OVERPAYMENT` | `CREDIT_NOTE`) – an audit-trail row per "spend" of credit
  against one specific `Sale` or `Purchase`. Nothing on the original
  `Refund` or unlinked `Payment` row is ever mutated to mark it "used" –
  same computed-live philosophy as every other balance in this app:
  available credit is always gross minus the sum of `CreditRedemption`
  rows against it, recomputed on every read.
- **`src/lib/credits.ts`**: `getCustomerCreditSummary()` /
  `getSupplierCreditSummary()` return `{ overpaymentAvailable,
  creditNoteAvailable, totalAvailable }`, net of prior redemptions.
  `redeemCustomerCredit()` / `redeemSupplierCredit()` spend that credit
  FIFO across open sales/purchases – the exact same oldest-first allocation
  `applyCustomerPayment()`/`applySupplierPayment()` already use for a cash
  payment, because from the customer's side "I have credit" and "I'm
  paying cash" settle debt identically. `amount` is optional: omit it to
  spend as much as fits (used by the automatic sweep below); pass it for a
  manual, operator-chosen partial amount.
- **Two different GL treatments, because the two credit sources already
  live in different accounts for different reasons**: an `OVERPAYMENT`
  redemption posts nothing further – the excess already sits correctly in
  Accounts Receivable from when it was originally collected, and a new
  sale's own Dr AR entry nets against it automatically. A `CREDIT_NOTE`
  redemption is a real reclassification and gets its own journal entry
  (`postJournalEntryForCreditRedemption` in
  `src/lib/accounting-integrations.ts`): Dr Customer Credits Payable / Cr
  Accounts Receivable (sale side), or Dr Accounts Payable / Cr Supplier
  Credits Receivable (purchase side). Within one allocation, `OVERPAYMENT`
  credit is spent before `CREDIT_NOTE` credit simply because the former is
  cheaper to post – a tie-break the customer never sees.
- **Automatic trigger**: `createSale()`/`createPurchase()` now call
  `redeemCustomerCredit()`/`redeemSupplierCredit()` (with no explicit
  amount) right after posting, inside the same transaction. If that
  customer/supplier is carrying any standing credit, it's automatically
  swept against their oldest open balance – which may be the sale/purchase
  that was just created, an older one, or a mix of both, exactly like a
  cash payment would be allocated.
- **Manual counterpart**: `POST /api/business/[businessId]/credits/redeem`
  (`{ customerId | supplierId, amount? }`) for an operator to apply credit
  on demand – e.g. sweeping it onto an old debt without waiting for a new
  transaction. New "Apply Credit" buttons on the customer and supplier
  profile pages (shown only when there's both available credit and an
  outstanding balance) open a small form: type an exact amount, or "Apply
  Maximum Possible" to spend as much as fits. Both pages also now show a
  standing-credit line whenever `totalAvailable > 0`.
- **No new permission**: gated exactly like
  `POST /api/business/[businessId]/payments` – customer-side redemption
  needs `payments.record`, supplier-side needs the stricter
  `suppliers.manage` – since spending existing credit is the same trust
  level as recording a new payment, not a distinct capability.
- **KNOWN LIMITATION**: redemption only ever triggers automatically at
  `createSale()`/`createPurchase()` time, or manually from the profile
  page. It does not run when a payment is recorded against a specific
  existing sale/purchase (`POST /payments` with a `saleId`/`purchaseId`) or
  when `applyCustomerPayment()`/`applySupplierPayment()` is called
  directly – those still only apply the cash actually being paid in that
  moment. In practice this rarely matters (a customer with standing credit
  usually gets it swept in on their very next sale), but it means credit
  can keep sitting unspent indefinitely if a business only ever records
  payments against specific debts and never makes a new sale for that
  customer. A future pass could add the same sweep to the general
  `/payments` route.

### Module 18 – VAT (Value-Added Tax)

Closes the first (and biggest) piece of the "broader tax module" gap
flagged since Module 7: `Sale.tax`/`Purchase.tax`/`Quotation.tax` existed
since Modules 3, 8, and 15 as a manual, cashier-typed number that never fed
into accounting at all – `accounting-integrations.ts` never referenced
`tax` in any form before this module. Withholding tax, corporate tax
estimates, and a tax calendar remain deferred (see below).

- **Off by default, per business**: `Business.vatRegistered` (+
  `vatNumber`) – most small Malawian businesses fall under the MRA VAT
  registration turnover threshold, so a fresh business sees no VAT
  anywhere until an Owner/Accountant explicitly turns it on in Tax
  Settings. Every calculation in this module short-circuits to 0 when
  `vatRegistered` is false, so a non-VAT business is completely unaffected
  by this module's existence.
- **Per-product VAT category**: `Product.vatCategory` (`STANDARD` |
  `ZERO_RATED` | `EXEMPT`, new `VatCategory` enum), set on the product form
  (defaults to `STANDARD`) and editable via the product API. `STANDARD` is
  the only category actually taxed – `ZERO_RATED` and `EXEMPT` both
  compute to 0 VAT but are kept distinct because a real VAT return reports
  zero-rated turnover separately from exempt turnover.
- **`src/lib/vat.ts`**: the calculation engine –
  `computeLineVat()`/`computeVatForLines()` (per-line VAT, applied to each
  line's own net-of-discount total, never to a whole-sale discount – see
  the file's own "Design choices" comment for why), `getVatConfig()`
  (business registration + rate in one call), and `getVatReturn()` (Output
  VAT − Input VAT over a period, broken down by category, in the shape an
  MRA VAT 3 return groups by). `TaxConfiguration.vatStandardRate` is seeded
  as an `EXAMPLE_VAT_STANDARD_RATE` (16.5%, Malawi's standard rate at time
  of writing) and shares `TaxConfiguration.isExample`'s existing disclaimer
  with PAYE – one Tax Settings review covers both.
- **Retrofit of `sales.ts`/`purchases.ts`/`quotations.ts`**: the manual
  `tax` input is gone from all three schemas (`saleSchema`,
  `purchaseSchema`, `quotationSchema`) – VAT is now computed server-side,
  per line, from each product's live `vatCategory` and the business's live
  VAT config, and snapshotted onto `SaleItem.vatCategory`/`vatAmount` (and
  the equivalent on `PurchaseItem`/`QuotationItem`), the same
  snapshot-at-transaction-time pattern `SaleItem.unitCost` already used.
  `convertQuotationToSale()` deliberately does NOT reuse the quotation's
  own snapshotted VAT – `createSale()` recomputes it fresh from the
  linked products' current state, since a quotation can sit as a DRAFT for
  weeks during which the rate, a product's category, or the business's
  registration could all have changed.
- **GL posting split** (`accounting-integrations.ts`):
  `postJournalEntryForSale`/`postJournalEntryForPurchase` now carve the VAT
  portion out of Sales Revenue / Inventory into two new system accounts,
  `VAT_OUTPUT_PAYABLE` (liability) and `VAT_INPUT_RECEIVABLE` (asset) –
  added to `chart-of-accounts.ts` and backfilled onto pre-existing
  businesses via `getOrCreateSystemAccountId`, the same pattern Module 16
  used for `CUSTOMER_CREDITS_PAYABLE`. Because the Profit & Loss and
  Balance Sheet reports (Module 11) are purely GL-account-driven, both
  became VAT-correct automatically once this split existed – no report
  code needed to change.
- **Dashboard fix that fell out of this**: `dashboard.ts`'s headline
  "Revenue" figure was summing `Sale.total`, which is VAT-inclusive –
  harmless while `tax` was always a rarely-used manual 0, but a real bug
  once VAT started being computed automatically. Fixed to subtract
  `Sale.tax`, so Revenue, Gross/Net Profit, margins, and month-over-month
  growth are all correctly VAT-exclusive. Deliberately left VAT-inclusive
  elsewhere it's genuinely correct to be so: "Sales by Day", "Sales by
  Payment Method", and the Sales/Salesperson reports all answer "how much
  money moved", not "what did we earn" – see the comments in
  `dashboard.ts`/`reports.ts` for the full reasoning on that line.
- **VAT Return report**: new tab on the `/accounting` hub (gated by the
  existing `accounting.view`, no new permission – same reasoning Module 17
  used), showing Output VAT and Input VAT by category over a date range,
  and the net payable/refundable figure, with an explicit disclaimer that
  this is a working document for transcribing onto the real MRA form, not
  a filing integration.
- **Documents**: the shared PDF layout (`src/lib/pdf.ts`) now shows a VAT
  registration number line (only when the business is actually
  VAT-registered) and labels the tax line "VAT" rather than the generic
  "Tax" on invoices, receipts, and quotations.
- **KNOWN LIMITATION**: prices are always VAT-exclusive in this app –
  there's no "prices include VAT" toggle with reverse calculation, which
  some Malawian retail shelf-pricing uses. Deliberately not built yet;
  seeing this app get real use will tell us whether shopkeepers actually
  need it.
- **KNOWN LIMITATION**: input VAT on a purchase assumes the supplier
  charged VAT at the product's own category rate – there's no concept of
  "is this supplier VAT-registered" in this app.
- **KNOWN LIMITATION**: refunds (Module 16) don't apportion VAT out of
  their GL posting – a refund still debits/credits the whole amount
  against Sales Revenue / Accounts Payable rather than splitting some of
  it back out of `VAT_OUTPUT_PAYABLE`/`VAT_INPUT_RECEIVABLE`. Documented in
  both `src/lib/vat.ts` and `src/lib/refunds.ts` rather than silently
  assumed – a future pass could split refund postings the same way
  Sale/Purchase postings are split now.
- **KNOWN LIMITATION**: the real MRA rule that a business making exempt
  supplies generally can't reclaim input VAT at all isn't enforced –
  `VAT_INPUT_RECEIVABLE` always accumulates from purchases regardless of
  what the business itself sells. Getting this right needs a business's
  overall exempt/taxable supply ratio, which this app doesn't compute.

### Module 19 – Withholding Tax

- **Reverse direction from VAT**: VAT (Module 18) is added ON TOP of a
  sale price, borne by the customer. Withholding tax is deducted FROM a
  payment the business itself makes – the business is the withholding
  agent, not the taxpayer. That's why this hangs off **Expense** (Module
  4), not Sale or Purchase.
- **Scoped to Expense, not Purchase**: the six categories Malawi's
  withholding tax regime targets – rent, commission, professional/
  consultancy fees, contractor/subcontractor fees, casual labour, and
  public entertainment fees – are payment types this app already records
  as Expenses (RENT is already an `ExpenseCategory`), not goods bought
  through the Purchases/Supplier module. **KNOWN LIMITATION**: a real
  subcontractor relationship run through Purchases (set up as a Supplier)
  won't have withholding tax applied – record it as an Expense instead.
- **Schema**: `WithholdingTaxCategory` enum (`RENT`, `COMMISSION`,
  `PROFESSIONAL_FEES`, `CONTRACTOR_FEES`, `CASUAL_LABOUR`,
  `PUBLIC_ENTERTAINMENT_FEE`); `TaxConfiguration.withholdingTaxRates`
  (nullable `Json` – one flat percent per category, lazily backfilled for
  pre-Module-19 businesses by `getOrCreateTaxConfiguration()` in
  `src/lib/payroll.ts`, the same schema-evolution pattern
  `getOrCreateSystemAccountId()` uses for the chart of accounts); and on
  `Expense`: `withholdingTaxCategory` (nullable – most Expenses aren't
  eligible at all), `withholdingTaxRate`/`withholdingTaxAmount` (both
  snapshotted at creation, mirroring `SaleItem.vatAmount` from Module 18,
  so a later rate change never rewrites history), and `payeeTpin` (the
  payee's own MRA Taxpayer ID, needed on their withholding certificate –
  distinct from `Business.taxpayerId`, this business's own TIN).
- **`src/lib/withholding-tax.ts`** (new file, mirrors `src/lib/vat.ts`'s
  shape and doc-comment style): `getWithholdingTaxConfig()`,
  `computeWithholdingTax()` (flat percentage, not progressive bands – no
  "band" concept needed, unlike PAYE), and `getWithholdingTaxReturn()` (a
  working summary by category for transcribing onto the relevant MRA
  return – not a filing, same framing as the VAT Return).
- **The gross/net split**: `Expense.amount` stays the GROSS figure the
  P&L expenses either way (withholding tax doesn't cost the business
  anything extra) – but the cash that reaches the payee is
  `amount - withholdingTaxAmount`. `postCashTransactionForExpense()` in
  `src/lib/cashbook.ts` now posts that net figure, and
  `postJournalEntryForExpense()` in `src/lib/accounting-integrations.ts`
  splits the entry three ways when withholding applies: Dr Expense (gross)
  / Cr Cash (net) / Cr `WITHHOLDING_TAX_PAYABLE` (withheld) – the same
  "carve the tax portion into its own account" move VAT made for
  `VAT_OUTPUT_PAYABLE`/`VAT_INPUT_RECEIVABLE`.
- **New system account**: `WITHHOLDING_TAX_PAYABLE` (liability,
  `getOrCreateSystemAccountId`-backfilled the same way the two VAT accounts
  were in Module 18).
- **Rates are configurable data, never hard-coded**: one Tax Settings save
  now covers PAYE, pension, VAT, AND withholding tax – six placeholder
  EXAMPLE rates (`src/lib/payroll.ts::EXAMPLE_WITHHOLDING_TAX_RATES`),
  same "not real current MRA figures, review before relying on them"
  disclaimer as PAYE bands and the VAT standard rate.
- **Expense form**: an optional withholding-tax-category picker with a
  live "tax withheld / net paid to payee" preview, plus a payee TPIN field
  that only appears once a category is picked. Editing an Expense
  recomputes withholding tax (at TODAY's configured rate, same as PAYE
  would) whenever the amount or category changes, reversing and reposting
  both ledgers the same way amount/category/paymentMethod edits already
  did for VAT-less Expenses.
- **Withholding tax certificate**: a downloadable PDF
  (`/api/business/[businessId]/expenses/[expenseId]/withholding-certificate`)
  reusing `renderBusinessDocumentPdf()` (Module 15's shared engine) rather
  than a hand-rolled layout – the payee's TPIN rides along as a metaLine
  since the shared `billTo` shape has no field for it. **Not an
  MRA-recognized certificate or a filing** – a working record for the
  payee's own accountant, same disclaimer VAT gives its own "VAT Return."
- **Withholding Tax Return**: new tab on the `/accounting` hub, mirroring
  the VAT Return tab – gross payments and tax withheld broken down by
  category over a date range.
- **Expense report** (`getExpenseReport` in `src/lib/reports.ts`) now
  includes `withholdingTaxCategory`, `withholdingTaxAmount`, and `netPaid`
  columns on every row/CSV export.
- **KNOWN LIMITATION**: like `VAT_OUTPUT_PAYABLE`, this app doesn't model
  actually remitting withheld tax to the MRA – an Owner/Accountant clears
  `WITHHOLDING_TAX_PAYABLE` by recording a regular Expense or manual
  journal entry when they actually pay it over.
- **KNOWN LIMITATION**: the withholding-tax certificate PDF has no
  dedicated sequential numbering scheme (unlike Invoice/Receipt/Quotation,
  each with their own `Business.next*Number` counter) – its reference
  number is derived from the Expense's own id, which is stable but not a
  clean sequential series. Worth a real counter if certificates start
  actually being handed to payees regularly.
### Module 20 – Corporate Tax & Tax Calendar

Closes the last piece of the "broader tax module" gap flagged since
Module 18's own writeup ("withholding tax, corporate tax estimates, and a
tax calendar remain deferred") and repeated in this file's outstanding-gaps
paragraph ever since – spec section 19 beyond PAYE, VAT, and withholding
tax (Modules 10, 18, 19).

- **`TaxConfiguration.corporateTaxRate`**: a flat percent (seeded as
  `EXAMPLE_CORPORATE_TAX_RATE = 30`, Malawi's standard resident-company
  rate at time of writing), sharing `isExample` with PAYE/VAT/withholding
  tax – one Tax Settings review now covers all four. Unlike
  `withholdingTaxRates` (Module 19), this column has a real Postgres
  `@default(30)`, not `Json?` – so a normal `prisma migrate dev` backfills
  every pre-existing business automatically, with no lazy
  `getOrCreateTaxConfiguration()` backfill branch needed for it.
- **`Business.financialYearStartMonth`** (present since Module 1 but never
  editable anywhere) is now surfaced in Tax Settings, bundled into the same
  save as `corporateTaxRate` – a corporate tax estimate's quarterly/annual
  due dates are meaningless without knowing which month the fiscal year
  starts.
- **`src/lib/corporate-tax.ts`** (new): `getCorporateTaxConfig()`,
  `computeCorporateTax()` (flat rate, floored at 0 – a loss never produces
  a negative "tax"), `getCorporateTaxEstimate()` (applies the rate to
  `getProfitAndLoss()`'s `operatingProfit` – Module 11's existing P&L,
  already VAT-exclusive since Module 18), and `getFiscalYear()`/
  `getFiscalQuarters()` helpers used by the Tax Calendar below.
- **KNOWN LIMITATION, stated plainly in the file itself**: "taxable profit"
  here IS accounting operating profit. A real MRA company income tax
  computation adds back disallowed expenses and applies capital
  allowances instead of accounting depreciation – this app has no concept
  of either (no "disallowed" flag on Expense, no fixed-asset/capital-
  allowance schedule anywhere). Every figure this module produces is a
  rough estimate from the books as recorded; an Accountant still has to do
  the real adjustment schedule by hand before filing.
- **`src/lib/tax-calendar.ts`** (new): `getTaxCalendar(businessId, from, to)`
  builds a merged, sorted list of MRA filing/payment deadlines – PAYE and
  withholding tax (due the 14th of the following month), VAT (due the
  25th, only for VAT-registered businesses), quarterly provisional tax
  installments, and the annual income tax return (due 6 months after
  fiscal year-end) – each annotated with a working amount estimate reused
  directly from `getWithholdingTaxReturn()`/`getVatReturn()`/
  `getCorporateTaxEstimate()` rather than recomputed. Due-date
  day-of-month offsets are sourced from MRA's own public payment-due-date
  reminders at time of writing and are hard-coded constants, NOT
  `TaxConfiguration` data – a deliberate difference from the "never
  hard-code a rate" rule: a rate is something this app calculates with, a
  filing deadline is a structural fact of the tax law with nothing for an
  Owner to configure.
- **KNOWN LIMITATION**: the calendar is a computed reminder list, not a
  filing tracker – there's no `FilingRecord` table, so an entry is always
  "overdue" or "upcoming" relative to today and can never be marked
  "done", even after the Owner has actually filed and paid. A future pass
  could add a lightweight per-period acknowledgement.
- **KNOWN LIMITATION**: the quarterly provisional-tax figure applies the
  rate to that quarter's own actual operating profit, not an
  equal-installment forecast off a prior-year assessment (the methodology
  MRA's PTF1/PTF2 forms actually use) – simpler, and honest about what it
  is, but won't match the real equal-installment amount MRA expects,
  especially in a business's first year.
- **Accounting hub**: two new tabs, "Corporate Tax" (date-range estimate,
  same UI shape as the VAT/Withholding Tax Return tabs) and "Tax Calendar"
  (a 3/6/12-month-ahead deadline list with overdue entries highlighted).
  Both carry the same "working estimate, not a filing" disclaimer banner
  every tax report in this app uses.
- **Dashboard**: a compact "Upcoming Tax Deadlines" widget (next 30 days,
  up to 4 entries, linking to the full calendar) – gated by
  `accounting.view` like the Accounting nav link itself, so a Cashier
  never sees it.
- **No new GL account, unlike VAT/withholding tax**: `VAT_OUTPUT_PAYABLE`
  and `WITHHOLDING_TAX_PAYABLE` exist because VAT and withholding tax are
  carved out of an individual Sale/Purchase/Expense at the moment it's
  recorded. Corporate tax was never carved out of a transaction in the
  first place – it's a period-end estimate computed from already-posted
  P&L activity, with no natural posting point analogous to
  `postJournalEntryForSale()`. An Owner/Accountant who wants it on the
  Balance Sheet records a manual journal entry when they've finalized a
  real figure; actually paying MRA is a regular Expense or manual journal
  entry, the same "remittance isn't modeled" pattern Modules 18 and 19
  already established.

### Module 21 – Fixed Assets & Depreciation

Closes the gap Module 20's own writeup named explicitly: "no fixed-asset/
capital-allowance schedule anywhere." This module adds the register and
straight-line depreciation; it deliberately does NOT attempt the MRA
capital-allowance side of that sentence – see the KNOWN LIMITATION below.

- **`FixedAsset`** (new model): the register entry – name, category (Land,
  Buildings, Motor Vehicles, Furniture & Fittings, Computer Equipment,
  Machinery & Equipment, Other), cost, residual value, useful life in
  years, `STRAIGHT_LINE` depreciation method (an enum with one member on
  purpose – a future reducing-balance method has a real value to add
  rather than a string to invent), status (`ACTIVE`/`DISPOSED`), and an
  optional link each to `Branch` and `Supplier`. Land gets
  `usefulLifeYears: null` and is never depreciated, matching how MRA
  treats it.
- **Accumulated depreciation is computed-never-stored**, the same
  treatment Customer/Supplier balances get (Module 5) – there is no
  running-total column on `FixedAsset`. `src/lib/fixed-assets.ts::
  getAccumulatedDepreciation()` sums live from `JournalLine` rows scoped
  to that one asset via a `referenceId` prefix match
  (`"<assetId>:<period>"`), since Accumulated Depreciation itself is one
  shared GL account for the whole business, not one per asset.
- **Accumulated Depreciation modeled as a plain `ASSET`-type account, not
  a new "contra-asset" `AccountType`**: `normalBalanceForType()` (Module
  11) hard-codes `ASSET -> DEBIT`, so crediting this account every
  depreciation run drives its balance negative under that convention.
  `getAccountBalance()` reports that negative number as-is,
  `getTrialBalance()` already had the branch to place a DEBIT-normal
  account's negative balance in the credit column (it just never had an
  account that used it before), and `getBalanceSheet()`'s sum-of-
  asset-balances subtracts it automatically. Zero changes were needed to
  `financial-statements.ts` – the contra-asset behavior was already
  latent in how the posting engine has to work, this module just uses it
  for the first time.
- **Depreciation is an explicit, user-triggered run, not a background
  job** – `src/lib/fixed-assets.ts::postDepreciationForPeriod(businessId,
  period, createdById)` mirrors Payroll's per-period run (Module 10)
  rather than anything cron-like (this app has no scheduler anywhere).
  For each `ACTIVE` asset it posts `Dr Depreciation Expense / Cr
  Accumulated Depreciation` for that period, capped so the final period
  never depreciates past `cost - residualValue`. Idempotent per
  asset+period: it checks for an existing `JournalEntry` with
  `referenceId = "<assetId>:<period>"` before posting, so re-running the
  same period twice is a safe no-op.
- **Acquisition posts to both ledgers in one transaction**, the same
  "create row, then Cashbook, then GL" sequence Expense uses:
  `Dr Fixed Assets (cost) / Cr Cash`. **KNOWN LIMITATION**: CREDIT is
  rejected as a payment method (both in the Zod schema and again inside
  `createFixedAsset()`, so a future non-UI call site can't bypass it) –
  this app's Accounts Payable is specifically the Supplier/Purchase
  (inventory) ledger from Module 8, and there's no "asset financed on
  account" concept. Record a financed/hire-purchase acquisition once
  actually paid, or via a manual journal entry.
- **Disposal** (`src/lib/fixed-assets.ts::disposeFixedAsset()`) posts one
  balanced entry: `Dr Accumulated Depreciation` (whatever had built up),
  `Dr Cash` (proceeds, if any), `Cr Fixed Assets` (original cost), with
  the gain or loss (`proceeds - netBookValue`) as the balancing line –
  debited if it's a loss, credited if it's a gain. Deleting a `FixedAsset`
  row outright is only allowed while it's `ACTIVE` and has never had
  depreciation posted; once depreciation exists, it's part of the
  accounting history and must go through disposal instead, the same
  "void, don't delete" rule Sales/Purchases follow once they've touched
  the ledger for real.
- **KNOWN LIMITATION**: gain/loss on disposal posts to a
  `GAIN_LOSS_ON_DISPOSAL_OF_ASSETS` account typed `EXPENSE`, so a gain
  shows as a negative Operating Expense line on the P&L rather than Other
  Income – this app's `getProfitAndLoss()` has no "Other Income/Expense"
  section to put it in (the same simplification Cash Flow's deferred
  Investing/Financing sections use). Stated here rather than silently
  misclassified; a real "Other Income" P&L section is future work. **CLOSED BY MODULE 37.**
- **KNOWN LIMITATION – the capital-allowance gap Module 20 flagged is
  NOT closed by this module.** `getCorporateTaxEstimate()` (Module 20)
  still applies the corporate tax rate to accounting operating profit,
  which now includes this module's straight-line depreciation expense –
  not MRA's capital allowances, which use different rates and rules
  entirely. This module gives an Accountant a real depreciation schedule
  to work from by hand; it does not compute the MRA adjustment itself.
- **Permissions**: `fixedassets.manage` / `fixedassets.view` – Owner gets
  both automatically, Accountant gets both, Manager gets view only
  (capitalization judgment calls – useful life, method, disposal – stay
  with Accountant/Owner, the same split Financial Settings uses), Cashier
  gets neither. Not plan-gated, consistent with VAT/withholding/corporate
  tax all being available on every plan.
- **New pages**: `/fixed-assets` (register – active/disposed asset lists,
  cost/accumulated-depreciation/NBV totals, a "Run Depreciation" control
  for a chosen period), `/fixed-assets/new`, and `/fixed-assets/[id]`
  (detail, depreciation history, and the dispose action). Linked from the
  dashboard next to Accounting, gated by `fixedassets.view`.

Fiscal year closing entries, weighted-average/FIFO inventory costing
(last-in cost only, see Module 8), branch scoping for inventory/cashbook/
receivables/supplier debt (Sales and Expenses only, see Module 13), real
notification delivery (invitation and verification emails are logged, not
sent – see Modules 1 and 14), a self-serve plan upgrade/billing flow,
admin dashboard, landing/pricing pages, offline mode, real file storage,
.xlsx export, MRA capital-allowance computation (Module 21 tracks
depreciation, not the tax adjustment), financed/hire-purchase fixed asset
acquisitions, and a proper "Other Income" P&L section (so disposal gains
stop showing as negative Operating Expenses).

### Module 22 – Bank Reconciliation

Closes a gap Module 9's own writeup left implicit: the Cashbook trusts that
every real bank/mobile-money movement got recorded through this app. This
module is the check on that assumption – comparing one `CashAccount`'s
book transactions against what the actual bank statement says, for one
statement period at a time, and catching whatever the books never knew
about (a monthly fee, interest earned, a bank error).

- **`BankReconciliation`** (new model): the header for one reconciliation
  – the `CashAccount` being reconciled, the statement's date and ending
  balance, and `bookBalanceAtStart` – a one-time snapshot of the account's
  live book balance taken when the reconciliation opens. This is the one
  deliberate exception to this app's "computed, never stored" rule (see
  Customer/Supplier debt, Fixed Asset accumulated depreciation, ...): it's
  an audit record of what the books said at the moment reconciliation
  began, which matters even after later, unrelated transactions change
  the live balance. Only one `IN_PROGRESS` reconciliation per account at a
  time – `src/lib/bank-reconciliation.ts::openBankReconciliation` rejects
  opening a second one until the first is finished or deleted.
- **`BankStatementLine`** (new model): one line off the real statement –
  date, description, and a signed amount (positive = in, negative = out,
  the same convention `CashTransaction.amount` already uses). Starts
  `UNMATCHED` and moves to exactly one of:
  - **`MATCHED`** – linked to a `CashTransaction` the business already
    recorded (the common case: a Sale receipt or Expense payment that
    also shows up on the bank's side). The `@@unique` on
    `matchedTransactionId` is what actually stops the same book
    transaction being matched to two different statement lines, not
    application logic alone.
  - **`POSTED`** – a bank-only item the books never had (a charge, a fee,
    interest earned). Confirming this posts it for real, in one
    transaction: `Dr/Cr` the account's GL bucket against a new
    `BANK_CHARGES_AND_INTEREST` account, plus the matching
    `CashTransaction` (type `ADJUSTMENT`) – see
    `postJournalEntryForBankReconciliationAdjustment` in
    accounting-integrations.ts and
    `postCashTransactionForBankReconciliationAdjustment` in cashbook.ts.
  - **`IGNORED`** – deliberately excluded (a duplicate line the bank
    printed twice, a line that turns out to belong elsewhere). Always a
    conscious action with an optional reason, never silent – the same
    void-don't-delete philosophy the rest of this app follows once
    something is part of the record.
- **`BANK_CHARGES_AND_INTEREST`** (new system account, EXPENSE type):
  debited for charges, credited for interest earned – reusing, not
  reinventing, the exact "one EXPENSE-typed account holds both directions"
  pattern Module 21 established for `GAIN_LOSS_ON_DISPOSAL_OF_ASSETS`.
  Interest earned shows up as a negative Operating Expense line rather
  than Other Income, the same stated simplification, for the same reason
  (no Other Income section in `getProfitAndLoss()` yet). **Interest now shows under Other Income (Module 37).**
- **Matching is manual, with a suggestion helper, never an auto-match**:
  `suggestBankStatementMatches()` proposes book transactions on the same
  account with the exact same amount within a ±3-day window of the
  statement line's date – shown to the operator to confirm one at a time
  via the normal match action. Never applied automatically: two genuinely
  different transactions can share an amount (two MWK 5,000 sales the
  same week), so only a human call settles which is which.
- **Full undo path while `IN_PROGRESS`**: unmatch (puts a `MATCHED` line
  back to `UNMATCHED`, never touches the real `CashTransaction` it had
  pointed at), unpost (reverses the posted `CashTransaction` and journal
  entry via the same generic `reverseCashTransactionsForReference` /
  `reverseJournalEntriesForReference` every other reversal in this app
  uses, keyed off `referenceType: "BankReconciliationAdjustment"`), and
  un-ignore. A line can only be deleted outright while still `UNMATCHED`
  (never had any book effect); the whole reconciliation can only be
  deleted while nothing on it has been `POSTED` yet.
- **Completion (`completeBankReconciliation`) requires every line to be
  `MATCHED`, `POSTED`, or `IGNORED`** – i.e., the operator has actually
  looked at and accounted for everything the statement says happened,
  which is the real point of reconciling. A non-zero balance difference
  at completion time is shown, not blocked: a same-day transaction the
  bank hasn't processed yet is a normal timing gap, not an error, and
  forcing it to zero would just encourage plugging a fake adjustment to
  make the number match.
- **KNOWN LIMITATION, partly closed by Module 62**: statement lines were
  originally entered by hand only. CSV and OFX/QFX imports now exist; live
  bank-feed import does not.
- **KNOWN LIMITATION, closed by Module 48**: a `COMPLETED` reconciliation
  can now be reopened by the Owner, with a required reason – see Module
  48 below.
- **Permissions**: `bankrecon.manage` / `bankrecon.view` – Owner gets both
  automatically, Accountant gets both, Manager and Cashier get neither
  (reconciling is a controller-level check, the same split
  `cashbook.manage`/`accounting.view` already draw – Manager keeps
  `cashbook.view` only). Not plan-gated, consistent with every other
  accounting feature in this app.
- **New pages**: `/bank-reconciliation` (in-progress and completed lists),
  `/bank-reconciliation/new` (pick an account, statement date, and ending
  balance), and `/bank-reconciliation/[reconciliationId]` (the working
  view – add lines, match/post/ignore each one, run match suggestions,
  and complete or delete the reconciliation). Linked from the dashboard
  next to Fixed Assets, gated by `bankrecon.view`.

### Module 23 – Stock Take & Inventory Adjustment

Closes a gap Module 6's own writeup left implicit: `InventoryMovement`'s
`ADJUSTMENT` type existed for a one-off manual correction, but nothing ever
compared the whole catalog's book quantities against a real physical
count. Same shape as Module 22's Bank Reconciliation, different domain:
open a count, work through every line, post what's genuinely wrong,
complete.

- **`StockTake`** (new model): the header for one count – an optional
  `categoryId` scope (null means the whole active catalog), a free-text
  note, and status `IN_PROGRESS`/`COMPLETED`. Only one `IN_PROGRESS` stock
  take per scope at a time (`src/lib/stock-take.ts::openStockTake`), the
  same rule Module 22 enforces per `CashAccount` – but scoped per category
  rather than business-wide, so two teams can genuinely count two
  different categories on the same day without colliding.
- **`StockTakeLine`** (new model): one line per active product in scope,
  generated in full the moment the stock take opens. `systemQuantityAtCount`
  and `unitCost` are both snapshotted once, at that moment – the same
  deliberate "computed, never stored" exception `BankReconciliation.
  bookBalanceAtStart` makes: `Product.quantity` and `Product.purchasePrice`
  keep moving live (sales, purchases, price edits) while a physical count
  is actually happening on the shop floor, so the variance has to be
  measured against what the books said when counting started, not
  whatever they say by the time someone gets around to posting it.
  Variance itself is never stored – always `countedQuantity -
  systemQuantityAtCount`, computed on read in `getStockTake()`. Starts
  `PENDING` and moves to exactly one of:
  - **`COUNTED`** – a count has been recorded. If the count matches the
    book quantity exactly, that's already a complete, correct state –
    nothing further to do. If it doesn't, the line needs `POSTED` or
    `IGNORED` before the stock take can complete.
  - **`POSTED`** – a genuine variance, corrected for real: an
    `InventoryMovement` (type `ADJUSTMENT`) so `Product.quantity` and the
    stock ledger reflect reality, plus a `JournalEntry` so the balance
    sheet does too, both in one transaction
    (`postStockTakeLineAdjustment`). If the product's snapshotted
    `unitCost` is zero (a free/promotional item), only the quantity is
    corrected – a zero-value journal entry isn't a real entry, so none is
    posted, and that's a stated branch in the code, not a silent skip.
  - **`IGNORED`** – a counted variance deliberately left unadjusted (a
    recount is scheduled, or the amount is judged too small to bother
    correcting the books for). Always a conscious action, never silent –
    the same void-don't-delete philosophy the rest of this app follows
    once something is part of the record.
- **`INVENTORY_SHRINKAGE_AND_ADJUSTMENT`** (new system account, EXPENSE
  type): debited for shrinkage (counted less than the books said),
  credited for found stock (counted more) – reusing, not reinventing, the
  same "one EXPENSE-typed account holds both directions" pattern Module 21
  established for `GAIN_LOSS_ON_DISPOSAL_OF_ASSETS` and Module 22 for
  `BANK_CHARGES_AND_INTEREST`. Found stock shows as a negative Operating
  Expense line rather than Other Income, the same stated simplification,
  for the same reason (no Other Income section in `getProfitAndLoss()`
  yet). See `postJournalEntryForStockTakeAdjustment` in
  accounting-integrations.ts.
- **Full undo path while `IN_PROGRESS`**: re-count (puts a `COUNTED` line
  back to `PENDING`, whatever its variance, in case the count was
  mis-typed), unpost (reverses the posted `InventoryMovement` and journal
  entry via the same generic `reverseJournalEntriesForReference` every
  other reversal in this app uses, keyed off `referenceType:
  "StockTakeAdjustment"`; can fail if a later movement makes the reversal
  impossible – e.g. found stock this line added has since been sold – in
  which case the underlying stock error surfaces as a normal error rather
  than being silently swallowed), and un-ignore. The whole stock take can
  only be deleted outright while nothing on it has been `POSTED` yet.
- **Completion (`completeStockTake`) requires every line to have been
  counted, and every genuine variance to have been `POSTED` or
  `IGNORED`** – the whole point of a physical count is that someone
  actually looked at every product, not just the ones that seemed worth
  checking. Returns the number of lines posted and the net adjustment
  value for a close-out summary.
- **KNOWN LIMITATION**: counted quantities are entered by hand – there's
  no barcode-scanner integration. Same cost/benefit call Module 22 made
  for statement lines: typing in a count sheet is a reasonable cost for
  the reconciliation this unlocks.
- **KNOWN LIMITATION**: a `COMPLETED` stock take can't be reopened – the
  same deliberate scope-cut Bank Reconciliation made until Module 48 gave
  it a reasoned, Owner-only reopen path; a future module could bring
  Stock Take the same treatment.
- **Permissions**: `stocktake.manage` / `stocktake.view` – Owner gets both
  automatically. Unlike Bank Reconciliation (an accounting-level check
  restricted to Owner/Accountant), a physical count is store-floor
  operational work, so Manager gets `stocktake.manage` too – the same tier
  as `inventory.adjust`, which Manager already had. Accountant gets
  `stocktake.view` only, for audit oversight of what gets posted to the
  books. Cashier gets neither. Not plan-gated, consistent with every other
  accounting/inventory feature in this app.
- **New pages**: `/stock-take` (in-progress and completed lists),
  `/stock-take/new` (pick a scope – whole catalog or one category – and
  an optional note), and `/stock-take/[stockTakeId]` (the working view –
  record each product's count, post or ignore each variance, and complete
  or delete the stock take). Linked from the dashboard next to Bank
  Reconciliation, gated by `stocktake.view`.

## Module 24 – Notifications

Doesn't add a new kind of event – it replaces the "and `console.log` it"
half of four events that have existed since Modules 1, 5, and 14:
registration's email-verification link, forgot-password's reset link, a
team invitation, and a customer debt reminder. All four now go through one
place instead of four separate `console.log` calls.

- **`src/lib/notifications.ts`** is the single place every outbound
  email/SMS in this app goes through – `sendEmail()` / `sendSms()` – the
  same "one function, not four inline versions" reasoning
  `postJournalEntry()` follows for ledger postings. Provider selection is
  env-driven and degrades gracefully, the same pattern `ANTHROPIC_API_KEY`
  already established for the AI assistant: no key configured means it
  falls back to logging to the console (and to `NotificationLog`) exactly
  like this app already did – so a fresh clone with nothing configured
  still works end-to-end for local testing. A key configured means a real
  provider is called, and failures are recorded rather than thrown, so a
  provider outage can never break registration, an invite, or a reminder.
- **Providers**: Email via **Resend** (`EMAIL_PROVIDER_API_KEY`,
  `EMAIL_FROM` – both existed as placeholders in `.env.example` since
  Module 1). SMS via **Africa's Talking** (`SMS_PROVIDER_API_KEY` already
  existed; `SMS_PROVIDER_USERNAME` is new). Both chosen for being callable
  with a plain `fetch` – no new SDK dependency. Swapping either for a
  different provider later means changing one `deliver*` function in
  `notifications.ts`; every call site and the `NotificationLog` shape stay
  the same.
- **`NotificationLog`** (new model): one row per send attempt – sent,
  failed, or console-logged – regardless of outcome, so delivery is
  auditable rather than a silent side effect. `businessId` is nullable
  (a password-reset email isn't scoped to one business, the same reason
  that event never gets an `AuditLog` row either); `userId` is nullable
  (a team invitation's recipient usually doesn't have a `User` row yet –
  that's the point of the invite). `status` distinguishes `LOGGED` (no
  provider configured) from `FAILED` (a provider was configured but the
  call to it failed) from `SENT`.
- **New page**: `/notifications` – a business-scoped delivery history
  (most recent 200, filterable by channel/status), with a banner showing
  whether real email/SMS providers are actually configured or the app is
  still console-only. Linked from the dashboard, gated by
  `notifications.view`.
- **Permissions**: `notifications.view` – Owner, Manager, and Accountant
  (the roles who trigger at least one of the four notification-sending
  actions today: Manager sends customer reminders, Owner sends invitations
  and registers the business, Accountant benefits from delivery
  visibility for audit purposes). Cashier gets neither.
- **KNOWN LIMITATION**: no in-app/push notification channel yet – this
  module covers email and SMS only, the two channels the four existing
  stub points already needed. An in-app notification bell (e.g. for low
  stock, an overdue tax filing, a subscription trial ending) is a
  different, additive feature or a future module, not a gap in this one.
- ~~**KNOWN LIMITATION**: SMS delivery via Africa's Talking doesn't parse the per-recipient status~~ **Closed by
  Module 71.** A 200 is no longer recorded as `SENT` on its own; `deliverSms()` reads the per-recipient status in the
  body (`src/lib/sms-delivery.ts`).
- **KNOWN LIMITATION (closed by Module 75)**: no retry queue – a `FAILED` send is recorded and
  visible on `/notifications`, but nothing automatically retries it. An
  Owner/Accountant currently has to notice the failure and re-trigger the
  underlying action (e.g. resend the invitation) by hand.

## Module 25 – In-App Notifications

Picks up the exact forward pointer Module 24 left: *"An in-app
notification bell (e.g. for low stock, an overdue tax filing, a
subscription trial ending) is a different, additive feature."*

- Deliberately a **separate model from `NotificationLog`**, not a new
  channel on it. `NotificationLog` is an immutable append-only audit
  trail of outbound sends; a bell alert is mutable state a person reads
  and dismisses. `InAppNotification` (`src/lib/in-app-notifications.ts`)
  keeps that distinction rather than overloading one table for two
  different lifecycles.
- **No background job** generates alerts – consistent with this app's
  standing choice (Depreciation runs, Bank Reconciliation) to avoid a
  worker process. `syncInAppNotifications(businessId)` re-evaluates all
  three conditions from scratch on every call, and is called from the
  bell's `GET` route and from the dashboard page on every load.
- **Dedupe-and-resolve state machine**: each alert has a deterministic
  `dedupeKey` (`low-stock:<productId>`, `tax:VAT:March 2026`,
  `trial-ending`) so re-syncing updates the same row instead of creating
  duplicates. Two kinds of alert:
  - **Condition-based** (`LOW_STOCK`, `TRIAL_ENDING`): the sync itself
    detects when the condition clears (restocked, trial
    converted/cancelled) and auto-resolves the row.
  - **Never-auto-resolved** (`TAX_DUE`): mirrors the Tax Calendar's own
    Module 20 limitation – there's no `FilingRecord`, so nothing can
    detect "it was actually filed." Dismissing is the only way to clear
    one.
  - A dismissal is only respected while the same occurrence continues.
    If a condition-based alert resolves and later recurs (stock drops
    again after being restocked), it comes back fresh – unread,
    un-dismissed – rather than staying silently hidden because of an old
    dismissal. See the block comment in `in-app-notifications.ts` for the
    full rule.
- **Low stock** only alerts where `reorderLevel > 0` – the field's own
  default is 0 ("not tracked for reordering"), so alerting on that would
  flag every never-configured product the moment it hits zero stock.
- **Tax due** reuses `getTaxCalendar()` (Module 20) with a narrower,
  more urgent window (overdue, or due within 7 days) than the
  dashboard's existing 30-day *preview* widget – the bell is for what
  needs action now, not a forecast.
- **Trial ending** reads `Subscription.status`/`trialEndsAt` directly;
  alerts within 7 days of expiry, `URGENT` inside 2 days or once
  expired. Links to `/dashboard` rather than a billing page, because no
  billing/upgrade UI exists yet (`business.subscription.manage` remains
  an unused permission – see known limitations below).
- **Read/dismiss state is business-scoped, not per-user** – the same
  choice this app makes everywhere else (Customer/Supplier balances,
  AuditLog): if any Owner/Manager/Accountant dismisses a low-stock
  alert, it's dismissed for the whole team, not just for them. Avoids a
  join table for a distinction nothing in this app currently makes.
- **`readById`/`dismissedById` are plain `String?` fields, not Prisma
  relations** – the same choice `StockTake.completedById`/`createdById`
  already made, to avoid a second FK path into `User` for a field that's
  only ever displayed, never joined on.
- **Permission**: reuses `notifications.view` (Owner, Manager,
  Accountant – not Cashier) rather than adding a new key, since it's the
  same audience Module 24 already granted visibility into notification
  activity to. Its description was updated to mention the bell.
- **UI**: a bell (`src/app/dashboard/notification-bell.tsx`) in the
  dashboard header – the one page in this app that already serves as
  the central nav hub, since most other pages don't duplicate the full
  nav. Server-rendered with an already-synced initial list, then
  self-contained (refetches on open, updates optimistically on
  read/dismiss). `/notifications` (Module 24's delivery-history page)
  gained a new "Alerts" section above the email/SMS log, showing full
  history including resolved/dismissed rows – the bell only ever shows
  active ones.
- **KNOWN LIMITATION**: `Postgres enum declaration order` is relied on
  for severity sorting (`orderBy: { severity: "desc" }` puts `URGENT`
  first) instead of a separate priority column – fine today with three
  fixed values, but add a priority column instead of reordering the enum
  if a fourth severity is ever needed that doesn't sort where its
  declaration position would put it.
- **KNOWN LIMITATION**: no dedicated billing/subscription-management
  page exists yet, so the `TRIAL_ENDING` alert can't deep-link anywhere
  more useful than `/dashboard`. Not a gap introduced by this module –
  `business.subscription.manage` has been an unused permission since
  plans were first modeled.
- **KNOWN LIMITATION**: a `TAX_DUE` alert dismissed once stays dismissed
  for that same tax period even as the estimated amount keeps changing
  as more sales/expenses are posted – there's no way to "snooze and
  re-alert on change." Matches the Tax Calendar's own no-`FilingRecord`
  limitation rather than adding new state to work around it.
- **KNOWN LIMITATION**: no push notifications or native mobile alerts –
  the bell only surfaces something when the person has the app open, the
  same scope-cut Module 24 already made for email/SMS being the only
  outbound channels.

## Module 26 – Billing & Subscription Management

Picks up the forward pointer left TWICE in Module 25's write-up: *"no
dedicated billing/subscription-management page yet"* and
`business.subscription.manage` having been *"an unused permission since
plans were first modeled."* While building it, two real pre-existing bugs
turned up and were fixed in the same module rather than filed as more
known limitations:

- **BUG FIXED – trial expiry was never enforced.** `requirePlanFeature()`/
  `requirePlanCapacity()` only ever compared against the literal strings
  `"EXPIRED"`/`"CANCELLED"`, but nothing in this app ever WROTE `EXPIRED`
  – there's no background job (the same standing choice as Depreciation,
  Bank Reconciliation, In-App Notifications) to flip a `TRIAL` subscription
  once `trialEndsAt` passes. A business whose 14-day trial ran out kept
  full Professional-tier access forever. Fixed with a new
  `getEffectiveSubscriptionStatus()` in `src/lib/subscription.ts` – a pure
  function, not a persisted write, consistent with this app's
  "computed, never stored" philosophy (Customer/Supplier balances,
  accumulated depreciation). Every gate, the dashboard, and the billing
  page now read the EFFECTIVE status, never `subscription.status` raw.
- **BUG FIXED – the monthly sales cap was never enforced.**
  `maxSalesPerMonth` has existed on `PlanDefinition`/`SubscriptionPlan`
  since Module 1, same as `maxUsers`/`maxBranches` – but unlike those two
  (fixed by Module 14), nothing ever checked it. `requirePlanCapacity()`
  gained a third resource, `"sales"`, scoped to the current calendar month
  (`getSalesThisMonthCount()`), enforced inside `createSale()`'s own
  transaction – re-checked against the live count, not a stale
  pre-request number, the same reasoning `acceptInvitation()` uses for the
  `"users"` resource. Both direct sales (`POST /sales`) and quotation
  conversion (`convertQuotationToSale()`, which calls the same
  `createSale()`) are covered by this one change.
- **No schema migration.** Billing history reuses the existing `AuditLog`
  table (`action: "subscription.plan_changed"` / `"subscription.cancelled"`,
  `entityType: "Subscription"`) rather than a new model – unlike Module
  25's `InAppNotification`, which needed its own table because it's
  MUTABLE read/dismissed state, plan-change history is exactly what
  `AuditLog` already models: an immutable "what changed, who, when"
  record. This is the first module since at least Module 20 to ship
  without touching `prisma/schema.prisma`.
- **Self-service plan change, not a real payment flow.** There is still no
  mobile money or card gateway in this app. Switching plans on
  `/settings/billing` (`changeSubscriptionPlan()`) takes effect
  immediately – the same "trust model" Modules 18/19 already established
  for VAT/withholding tax remittance (recorded manually, outside the
  app's automated flows). ENTERPRISE (`isCustomPricing`) is deliberately
  excluded from the self-service plan list (`getSelfServicePlans()`) and
  shown as a static "contact your account manager" card instead, since it
  has no fixed price to switch to.
- **Downgrade guard.** Switching to a plan whose `maxUsers`/`maxBranches`
  is below current usage is blocked with a specific message ("you
  currently have N team members; Business allows M – reduce these
  first"), the same "count before adding" reasoning `requirePlanCapacity`
  already uses, just checked against the new plan's own limits.
  `maxSalesPerMonth` is deliberately NOT part of this guard – past sales
  already happened and can't be undone by downgrading; that limit only
  ever applies going forward.
- **Cancellation is immediate – KNOWN LIMITATION.** No grace period
  through `currentPeriodEnd` – since this app never actually collected
  payment for the current period, there's no already-paid-for time to
  honor. A future payment-gateway module should reconsider this once real
  payment dates exist.
- **UI**: `/settings/billing` (Owner-only, gated on the now-actually-used
  `business.subscription.manage`) – status banner (using EFFECTIVE
  status), usage bars for all three countable resources, a monthly/annual
  toggle, FREE/BUSINESS/PROFESSIONAL plan cards with a "Switch to this
  plan" button, a static Enterprise contact card, a cancel-with-optional-
  reason flow, and a history table. The dashboard header now links to it,
  shows the EFFECTIVE trial status, and the In-App Notifications
  trial-ending alert (Module 25) now deep-links here instead of the
  dashboard – closing that module's own documented limitation.
- **KNOWN LIMITATION**: still no real payment gateway (mobile money or
  card) – plan changes and cancellation are both unpaid/unbilled actions
  as far as this app is concerned; a future module should gate
  `changeSubscriptionPlan()` behind an actual payment rather than
  reworking it.
- **KNOWN LIMITATION**: no scheduled/end-of-period downgrade – switching
  plans always takes effect (and resets `currentPeriodStart`/`End`)
  immediately, even for a downgrade a business might reasonably want to
  defer to their next renewal date.

## Module 27 – Branch Scoping for Purchases, Cashbook & Debt Reporting

No explicit forward pointer this time – Module 26's write-up didn't leave one.
Instead of guessing at the next spec section, this module closes a real,
self-documented gap: `src/lib/dashboard.ts` had a comment reading *"Cash/
mobile-money/bank balances, inventory, receivables, and supplier debt aren't
branch-scoped in the schema yet... these stay business-wide regardless of
the selected branch."* Module 13 (`resolveBranchScope()`) only ever enforced
branch isolation for Sale and Expense; nothing extended it to Purchase or
the Cashbook, so a branch-restricted Manager or Cashier could see the
entire business's purchases, cash transactions, and debt figures regardless
of which branch they were locked to – the same class of enforcement gap
Module 26 found and fixed for trial expiry and the sales cap.

- **Schema additions**: `Purchase.branchId` (mirrors `Sale.branchId`/
  `Expense.branchId` exactly – nullable, lazy-backfill) and
  `CashTransaction.branchId`. Both are nullable and need no data migration
  for existing rows.
- **Design choice – CashAccount stays business-wide, CashTransaction
  doesn't.** A "Cash" drawer or "NBS Bank" account is one real pool of
  money a business's branches share – splitting its *balance* per branch
  would require modeling physical cash transfers between branches, which
  doesn't exist. So `CashAccount.balance` (`getCashbookSummary()`) is
  unchanged and stays whole-account. What's new is that each individual
  `CashTransaction` can now be *attributed* to the branch whose activity
  caused it, for reporting/filtering – a different, narrower claim than
  "this branch has its own balance." This is documented directly on both
  models so a future module doesn't try to derive a per-branch balance
  from a shared account.
- **branchId is never accepted from a request for CashTransaction.** Every
  `postCashTransactionFor*()` integration point in `src/lib/cashbook.ts`
  derives it internally from the record that caused the movement:
  `postCashTransactionForPayment` looks up the linked Sale/Purchase's own
  branchId; `postCashTransactionForExpense` reads it straight off the
  Expense; `postCashTransactionForFixedAsset`/`...Disposal` read it off the
  FixedAsset; `postCashTransactionForRefund` looks up the Refund's linked
  Sale/Purchase. `reverseCashTransactionsForReference` (used when a posted
  record is edited/voided) copies the branchId of the entry it's reversing,
  not the source record's current value, so a fully-reversed reference
  nets back to zero within the same branch it was posted to.
- **Deliberately posts branch-null**: `transferBetweenAccounts` (moving a
  business's own money between its own accounts isn't one branch's
  activity), `postCashTransactionForBankReconciliationAdjustment` (a bank
  fee or interest line is a whole-account event), and
  `postCashTransactionForPayroll` (Employee has no branchId yet – a future
  module giving Employee a home branch should wire it through the same way
  Expense's is threaded above, rather than this module guessing).
- **Customer and Supplier deliberately do NOT get their own branchId.**
  Unlike Sale/Expense/Purchase (real events that happened at one place), a
  Customer or Supplier is master data a business can reasonably serve/buy
  from across every branch it has. Branch filtering for receivables and
  supplier debt happens on the transaction (Sale.branchId /
  Purchase.branchId), not the customer/supplier record –
  `getReceivablesAging()` and `getTotalSupplierDebt()`/`getSupplierDebtList()`
  in `src/lib/customers.ts`/`src/lib/suppliers.ts` all gained an optional
  `branchId` parameter that filters the underlying Sale/Purchase query.
- **Dashboard gap closed.** `getDashboardData()` now actually passes its
  `branchId` through to `getReceivablesAging`/`getTotalSupplierDebt` – it
  already computed and threaded `branchId` for sales/expenses/top-products/
  payment-method-breakdown, but silently ignored it for these two figures.
  Cash/mobile-money/bank balances and inventory stay business-wide in the
  dashboard on purpose (see the two points above), which the code comment
  now says explicitly instead of lumping them in with the two that actually
  needed fixing.
- **API routes updated to the established `resolveBranchScope()` pattern**
  (same shape as `/sales` and `/expenses`): `/purchases` (GET+POST),
  `/customers/debt-summary`, and `/cashbook/accounts/[accountId]/transactions`
  (a drill-down list, not the balance – see below). `/cashbook/summary` was
  deliberately left unfiltered, with a comment explaining why, since account
  balances don't change per branch.
- **UI**: `/purchases` list and `/purchases/new` gained the same
  branch column / branch picker `/sales` already has. `/customers/debts`
  now branch-locks a restricted member the same way `/sales` does (it
  previously read `memberships[0]` directly with no branch check at all –
  an oversight this module also closes, not just a missing filter param).
  The Cashbook drill-down transaction table gained a Branch column (shows
  "–" for the deliberately-null cases above, which is the correct answer,
  not a bug).
- **KNOWN LIMITATION carried forward, now documented on the schema
  directly**: Product/inventory is still NOT branch-scoped. This wasn't an
  oversight – it needs a genuinely different data shape (a per-branch
  StockLevel, not a business-wide `Product.quantity` with a branch tag
  attached) plus a stock-transfer concept between branches, neither of
  which this module builds. A future module should design that as its own
  piece of work rather than bolting a branchId onto Product the way this
  one did for Purchase/CashTransaction.
- **KNOWN LIMITATION**: Employee (and therefore Payroll) still has no
  branchId – payroll cash postings stay branch-null. Basic Reports (Module
  7) – the customer-debt and supplier-debt CSV/JSON reports under
  `/reports` – were also left business-wide-only for consistency: no report
  in that module currently accepts a branch filter, so adding one to just
  these two would be an inconsistent one-off rather than a real fix; a
  future module should decide whether Basic Reports as a whole should
  become branch-filterable.
- `tsc --noEmit`: this module adds no new enums, only nullable fields on
  existing models (`Purchase.branchId`, `CashTransaction.branchId`) and new
  back-relation arrays on `Branch` – unlike modules that added enums (which
  reliably added N new "no exported member" stub-client errors), this
  shouldn't add any net-new errors beyond the existing baseline. Not
  verified against a real generated client in this sandbox (see the
  `prisma generate` limitation note below) – run `npx prisma generate`
  then `tsc --noEmit` locally to confirm before trusting that.

## Module 28 – Branch-Scoped Inventory: StockLevel & Stock Transfers

Chosen the same way Module 27 was: no explicit forward pointer in Module
27's own write-up, but a self-documented gap left right on the schema –
the KNOWN LIMITATION comment on `Product` naming exactly this as the
future module's job (*"needs a genuinely different data shape – a
per-branch StockLevel, not a business-wide `Product.quantity` with a
branch tag – plus a stock-transfer concept between branches"*). This
module builds both.

- **`Product.quantity` is unchanged and stays the business-wide total.**
  Every existing caller of `recordInventoryMovement()` – Sales, Purchases,
  Stock Take, manual adjustments – keeps working exactly as it did before
  this module, with zero behavior change, because the business-wide check
  and update inside `recordInventoryMovement()` were left alone. What's
  new is additive: a `StockLevel` row (product × branch quantity) that
  only gets created/updated when a movement is given a `branchId`.
- **New `StockLevel` model.** One row per (product, branch) pair,
  upserted by `recordInventoryMovement()` whenever a `branchId` is passed.
  A row only exists once stock has actually been attributed to that
  branch – there is deliberately **no backfill migration** guessing where
  a business's existing stock physically sits; older stock (or any
  movement recorded with no branch, which has always been allowed since
  Module 13) simply shows as "not yet attributed to a branch" in the UI
  rather than being assumed to be at Head Office.
- **`recordInventoryMovement()` now enforces a second, narrower check**
  when a `branchId` is given: not just "does the business have enough
  stock overall" (the existing check, unchanged) but "does THIS branch
  have enough of its own recorded stock." A branch can run out even while
  the business total looks fine, if the remaining stock is recorded at a
  different branch – this is the whole reason a transfer concept is
  needed rather than just trusting the business-wide number.
- **`Sale.branchId` and `Purchase.branchId` (Module 27) now do real work**
  beyond attribution/reporting: `createSale()`/`voidSale()` and
  `createPurchase()`/`voidPurchase()` all thread their own `branchId`
  through to `recordInventoryMovement()`, so a sale decrements (and a void
  restores) stock at the specific branch it happened at, and a purchase's
  stock arrives at the branch it was ordered for. A sale/purchase left
  "not attributed to a branch" behaves exactly as before – no StockLevel
  touched, business-wide check only.
- **New `StockTransfer`/`StockTransferLine` models + `src/lib/stock-transfers.ts`.**
  Moves stock from one branch to another – always immediate and fully
  applied, no PENDING/in-transit state, the same simplicity choice Module
  9's `transferBetweenAccounts()` made for cash. Each line becomes a
  paired `TRANSFER_OUT` (source branch, negative delta) / `TRANSFER_IN`
  (destination branch, positive delta) call to `recordInventoryMovement()`
  within one transaction. Because both calls touch the same product's
  `Product.quantity`, one decrementing and the other incrementing by the
  same amount, the business-wide total is correctly left unchanged by a
  transfer – only the two branches' `StockLevel` rows actually move.
- **Design choice – no transferring from the "unattributed" bucket.** If a
  branch has no StockLevel row for a product (never had stock explicitly
  attributed to it), it cannot be a transfer source for that product, even
  if the business-wide total has plenty sitting unattributed elsewhere.
  This is intentional, not a rough edge to route around by silently
  defaulting to Head Office – it keeps "where is this branch's stock
  coming from" always traceable to a real prior event (a branch-tagged
  purchase, opening stock, or an earlier transfer in).
- **`InventoryMovement.branchId` added**, mirroring `CashTransaction.branchId`
  from Module 27 exactly: nullable, never accepted raw from a request –
  `recordInventoryMovement()` sets it internally from whatever branchId
  the caller already resolved through `resolveBranchScope()`.
- **`productSchema` gained an optional `branchId`** for opening stock –
  where the opening quantity typed in at product-creation time is
  physically located. Dropped again in `productUpdateSchema` (editing a
  product shouldn't re-trigger an opening-stock branch assignment).
  `stockAdjustmentSchema` also gained an optional `branchId`, so a manual
  adjustment/write-off can be attributed to the branch it happened at.
- **API routes**: `/stock-transfers` (GET list, POST create – gated on
  `inventory.manage` for POST, `inventory.view` for GET, no new permission
  key needed) and `/stock-transfers/[transferId]` (GET). A branch-restricted
  member may create/view a transfer touching EITHER end of their own
  branch – unlike Sale/Purchase's single-branchId `resolveBranchScope()`
  equality check, a transfer inherently spans two branches, so requiring
  both ends to equal a restricted member's one branch would make every
  transfer impossible for them; requiring just one end lets them send
  overstock out or receive an incoming transfer while still blocking a
  transfer between two branches they have no visibility into.
  `/products` (POST) and `/products/[productId]/adjust` (POST) both now
  resolve and thread `branchId` the same way `/purchases` does.
- **UI**: new `/stock-transfers` list, `/stock-transfers/new` (from/to
  branch pickers, dynamic product+quantity line items – same shape as
  `/purchases/new`), and `/stock-transfers/[transferId]` (read-only detail;
  deliberately no void/reverse action, since a transfer is immediate and
  final by design – moving stock back is a second, ordinary transfer in
  the other direction, which keeps the audit trail honest about what
  actually happened). `/inventory` gained a business-wide/per-branch view
  toggle (business-wide is unchanged `Product.quantity`; per-branch reads
  `StockLevel` via the new `getBranchStockList()`), locked to a
  branch-restricted member's own branch the same way `/sales` and
  `/purchases` already are. `/inventory/new` gained the opening-stock
  branch picker, shown only to unrestricted members (same pattern as the
  branch picker on `/sales/new`/`/purchases/new`).
- **KNOWN LIMITATION**: `Product.reorderLevel` (and therefore the
  low/out-of-stock status shown on `/inventory`) is still business-wide
  only – there's no per-branch reorder threshold, so a branch genuinely
  low on stock doesn't surface as "Low stock" unless the *business-wide*
  total also crosses the threshold. A future module could add a per-branch
  threshold once StockLevel has been in real use long enough to trust it.
- **KNOWN LIMITATION – CLOSED by Module 31**: Stock Take (Module 23) still reconciles the
  business-wide `Product.quantity`, not a per-branch count – extending it
  to count and reconcile one branch's `StockLevel` at a time is left for a
  future module, once StockLevel is established as a trustworthy
  per-branch source of truth to check a physical count against.
- **KNOWN LIMITATION**: a `StockTransfer` is immediate with no in-transit
  state, approval step, or partial-fulfillment/backorder handling – the
  same simplicity Module 9 chose for cash transfers, carried over here.
- `tsc --noEmit`: this module adds two new enum values
  (`TRANSFER_OUT`/`TRANSFER_IN` on `InventoryMovementType`) plus three new
  models (`StockLevel`, `StockTransfer`, `StockTransferLine`) and one new
  nullable field (`InventoryMovement.branchId`) – expect the usual
  N-new-stub-client-errors cascade the enum addition brings (same pattern
  Module 24 diffed and confirmed), on top of the existing baseline. Not
  verified against a real generated client in this sandbox – run
  `npx prisma generate` then `tsc --noEmit` locally to confirm before
  trusting that.

## Module 29 – Branch Scoping for Employees & Payroll

Chosen the same way Modules 27 and 28 were: not an inferred gap, but an
explicit forward pointer left in the code. `src/lib/cashbook.ts`'s
`postCashTransactionForPayroll()` comment has said, since Module 27,
*"Employee (and therefore Payroll) has no branchId yet – a future module
giving Employee a home branch should wire it through here."* This module
does exactly that, extending the branch attribution Modules 13/27/28 built
for Sale/Expense/Purchase/CashTransaction/Inventory to the last major
model that was missing it.

- **`Employee.branchId`** (nullable, lazy-backfill) – an employee's home
  branch. Unlike `Product`'s opening-stock `branchId` (a one-time fact
  about where stock physically arrived, deliberately dropped from
  `productUpdateSchema`), an employee's branch is an ongoing attribute that
  can genuinely change – a real transfer between branches – so it's kept
  in `employeeUpdateSchema` too, not just at creation.
- **`Payroll.branchId`** – deliberately **not** just a live join through
  `employee.branchId`. `upsertPayrollRun()` snapshots it from the
  employee's *current* branch every time a DRAFT run is (re)calculated –
  the same "always recalculates, never silently drifts" philosophy this
  function already applies to `grossSalary` (re-read from the employee)
  and PAYE/pension (re-read from `TaxConfiguration`). Once a run is PAID,
  `upsertPayrollRun` already refuses further changes, so the branch
  snapshot becomes permanent at that point too. This matters because an
  employee can be reassigned to a different branch after a past payroll
  run was paid – that history must keep showing where it actually
  happened, not silently follow the employee to their new branch.
- **`postCashTransactionForPayroll()`** now takes the branchId already
  snapshotted onto the `Payroll` row and threads it through to the
  `CashTransaction` it posts, the same way `postCashTransactionForExpense`
  threads `Expense.branchId` – closing the gap the Module 27 comment
  named. A run still attributed to no branch (employee never assigned one,
  or the run predates this module) posts branch-null exactly as before –
  a real answer, not a gap.
- **Design choice – `Payroll` doesn't take a `branchId` directly from the
  request.** Sale/Purchase accept a `branchId` field because the caller is
  choosing where a brand-new event happened; a payroll run doesn't have
  its own independent "where" – it inherits the employee's. So the access
  check for `POST /payroll` isn't the usual `resolveBranchScope()`
  request-vs-membership comparison; it's "does this employeeId belong to
  my branch," checked directly against the employee record before calling
  `upsertPayrollRun()` – the same shape of check Module 28's stock-transfer
  route uses for "does this transfer touch my branch," adapted from two
  ends to one.
- **Found (and fixed) two real pre-existing gaps while building this**:
  neither `/employees` nor `/payroll` (list routes, or the pages backing
  them) did any branch filtering at all – every member, restricted or not,
  saw every employee and every payroll run business-wide. Both list routes
  and both list pages now call `resolveBranchScope()`, matching the
  pattern every other branch-scoped model (`Sale`, `Purchase`,
  `CashTransaction`, `StockTransfer`) already follows. The `/employees` and
  `/payroll` pages also read `memberships[0]` directly with no branch
  resolution at all – the same class of bug Module 27 fixed on
  `/customers/debts` – now fixed here too.
- **Single-record GET-by-id stays business-id-only, not branch-checked** –
  confirmed this is the established pattern (checked
  `/purchases/[purchaseId]` and `/sales/[saleId]` before assuming): the
  branch lock governs what's *browsable* in a list, not whether a direct
  link to one record already-known record 404s for someone in the same
  business. `/employees/[employeeId]` and `/payroll/[payrollId]` follow
  that same precedent unchanged – the one exception is `PATCH
  /employees/[employeeId]`, where a restricted member reassigning an
  employee's `branchId` DOES go through `resolveBranchScope()`, since
  that's a write that could otherwise move an employee across branches
  the member has no visibility into.
- **UI**: `/employees` gained a Branch column and a branch-scoped list
  (mirrors `/sales`, `/purchases`); `/employees/new` gained a branch picker
  shown only to unrestricted members (same `branches.length > 1` pattern
  as `/purchases/new`), defaulting a restricted member's new hire to their
  own branch automatically. `/employees/[employeeId]` now shows the
  employee's branch in its header line. `/payroll`'s employee picker is
  now branch-filtered server-side, so a restricted member never sees (and
  therefore never tries to pay) an employee outside their own branch –
  belt-and-braces alongside the API-level check.
- No new permission key – `employees.manage`/`employees.view` and
  `payroll.manage`/`payroll.view` already existed and already cover this;
  branch scoping is an added filter under the same permissions, the same
  choice Module 28 made for `inventory.manage`/`inventory.view`.
- `tsc --noEmit`: this module adds two new nullable fields
  (`Employee.branchId`, `Payroll.branchId`) and two new `Branch` back-relation
  arrays (`employees`, `payrollRuns`) – no new enums, so (unlike Module 24's
  or Module 28's enum additions) this should NOT trigger the usual
  N-new-stub-client-errors cascade; expect zero net-new errors beyond the
  existing baseline, the same "nullable fields + back-relation arrays only"
  case Module 27 was in. Not verified against a real generated client in
  this sandbox – run `npx prisma generate` then `tsc --noEmit` locally to
  confirm before trusting that.

## Module 30 – Branch Scoping for Basic Reports

Chosen the same way Modules 27–29 were: closing an explicit, previously
documented gap rather than an inferred one. Module 27's own write-up named
it directly: *"Basic Reports (Module 7)'s customer-debt/supplier-debt CSV
reports deliberately left business-wide-only too, for consistency – no
report in that module currently branch-filters, so singling out just
these two would be inconsistent."* This module removes that inconsistency
by branch-scoping all seven reports at once, closing out the branch-scoping
work that's spanned Modules 13/27/28/29 across every other major model.

- **All seven report functions in `src/lib/reports.ts`** (`getSalesReport`,
  `getExpenseReport`, `getInventoryReport`, `getCustomerDebtReport`,
  `getSupplierDebtReport`, `getSalespersonReport`,
  `getProductProfitabilityReport`) now take an optional trailing
  `branchId` – `undefined`/`null` stays business-wide (the existing AI
  assistant call sites in `ai-context.ts`/`ai-analysis.ts` were left
  untouched and simply never pass one, same as before this module).
- **Sales, Expenses, Salesperson, Product Profitability** filter the
  underlying `Sale`/`Expense`/`SaleItem` query by `branchId` directly –
  those models have carried it since Modules 13/27.
- **Customer Debt, Supplier Debt** thread the branchId straight into
  `getReceivablesAging()`/`getSupplierDebtList()` (Module 27 already built
  these to accept one – this module is the first caller to actually pass
  it from a report).
- **Inventory is the one genuinely different case.** `Product.quantity`
  is still the business-wide total (an intentional Module 28 decision, not
  something this module changes), so a per-branch report can't just filter
  the same `Product` query. When a `branchId` is given, `getInventoryReport`
  switches to `getBranchStockList()` – the Module 28 function built for
  exactly this – and derives quantity, stock value, and out-of-stock count
  from each branch's own `StockLevel` rows. Low-stock count applies
  `Product.reorderLevel` (still business-wide only – real KNOWN LIMITATION,
  unchanged here) to each branch's own quantity; that's the closest
  available per-branch reading of that threshold, not a claim that the
  threshold itself is now branch-specific.
- **Every report route** (`/api/business/[businessId]/reports/*`) now
  resolves `branchId` via `resolveBranchScope()` before calling into
  `src/lib/reports.ts`, the identical shape `/sales`'s GET route already
  uses – a restricted member is locked to their own branch's figures
  automatically; an unrestricted member gets business-wide unless they
  pass one.
- **UI**: `/reports` gained a Branch picker (`All Branches` + one option
  per branch), shown only to unrestricted members – same
  `branches.length > 0` / server-supplied-empty-array-for-restricted-
  members pattern the dashboard's `BranchSwitcher` established, reused
  directly rather than re-invented. It's plain client state on
  `ReportsHub` (not a URL param like the dashboard's `?branchId=`, since
  this page's tab/date-range filters were already client state, not
  routing) and is included in both the live fetch and the CSV download
  URL.
- No new permission key – `reports.basic.view` already gates every route
  in this module; branch scoping is an added filter under the same
  permission, the same choice every prior branch-scoping module
  (27/28/29) made for its own permissions.
- `tsc --noEmit`: this module adds zero new schema fields, enums, or
  models – every change is application code (new optional function
  parameters, an added `where` clause, a UI dropdown). Expect zero
  net-new errors of any kind, not even the usual stub-Prisma-client
  cascade, since nothing here touches the schema. Not verified against a
  real generated client in this sandbox – see the note below.
- KNOWN LIMITATION carried forward, unchanged: `Product.reorderLevel` is
  still business-wide only (Module 28) – this module reads that one
  threshold per-branch for the Inventory report's low-stock count, but
  doesn't add a real per-branch reorder threshold column.

## Module 31 – Branch-Scoped Stock Take

Chosen by closing the KNOWN LIMITATION Module 28 documented on its own
Stock Take entry and deliberately deferred: *"extending it to count and
reconcile one branch's `StockLevel` at a time is left for a future
module, once StockLevel is established as a trustworthy per-branch
source of truth to check a physical count against."* Module 30 is what
established that trust – it already reads `StockLevel` as the real
per-branch source for the Inventory report – so Stock Take is the next
and, per Module 28's own note, intended consumer.

- **`StockTake.branchId`** added (nullable, lazy-backfill) – fixed at
  open time and never editable afterward, the same immutability
  `Purchase.branchId` has, since a stock take is inherently a "where and
  when" event, not an ongoing fact like `Employee.branchId`.
- **`openStockTake()`**: when a `branchId` is given, each line's
  `systemQuantityAtCount` is snapshotted from that branch's own
  `StockLevel.quantity` instead of the business-wide `Product.quantity` –
  0 for any product with no `StockLevel` row at that branch yet, since
  physically counting a branch is exactly how stock nobody ever
  explicitly attributed there becomes attributed for the first time. The
  scope still includes every active product in category scope regardless
  of whether it has a `StockLevel` row – most will legitimately start
  from 0 – because the point is to count what's physically at the branch,
  not just what the books already suspect is there.
- **Concurrency scope widened**: the existing "one IN_PROGRESS stock take
  per scope at a time" rule (Module 23) now scopes by `(categoryId,
  branchId)` together, not `categoryId` alone – two branches can now
  genuinely count the same category on the same day without colliding,
  which is the actual point of doing this per-branch.
- **Posting/unposting an adjustment** now threads the stock take's
  `branchId` through to `recordInventoryMovement()` – no new inventory
  logic was needed here at all; Module 28 already built
  `recordInventoryMovement()` to upsert a branch's `StockLevel` row and
  re-check business-wide `Product.quantity` together whenever a
  `branchId` is passed, so a branch stock take's adjustment moves both in
  the same transaction exactly like a branch sale or purchase already
  does.
- **`GET /stock-take`** (the list route) previously did zero branch
  filtering at all – a real pre-existing gap, the same class Module 27/29
  found and fixed on other list routes/pages. It and the `/stock-take`
  page now both call `resolveBranchScope()`, so a branch-restricted
  member only ever sees their own branch's stock takes.
- **UI**: `/stock-take/new` gained a branch picker (unrestricted members
  only, same `branches.length > 1` pattern as `/purchases/new` and
  `/employees/new`); `/stock-take` gained the dashboard's `BranchSwitcher`
  reused directly (same `?branchId=` URL-param shape, since this is a
  plain server component with no other client-side filters, unlike
  Module 30's Reports page); the workspace page shows the branch in its
  header and relabels the book-quantity column to "Branch Book Qty" when
  scoped.
- No new permission key – `stocktake.manage`/`stocktake.view` already
  gate every route; branch scoping is an added filter under the same
  permissions, the same choice every prior branch-scoping module made.
- Single-record GET-by-id (`/stock-take/[stockTakeId]` and its
  sub-routes) stays business-id-checked only, not branch-checked – same
  established rule as every other module (a direct link to an
  already-known record isn't subject to the list-level branch lock).
- `tsc --noEmit`: one new nullable field + one new back-relation array –
  expect the usual stub-Prisma-client cascade on top of baseline, nothing
  else. Not verified against a real generated client in this sandbox.
- KNOWN LIMITATION, unchanged from Module 23: a completed stock take
  can't be reopened, and counts are still entered by hand (no
  barcode-scanner integration).

## Module 32 – Refund VAT Apportionment

Chosen by closing the KNOWN LIMITATION `src/lib/vat.ts` (Module 18)
documented on its own file since Module 16's Refunds were built: *"a
future pass could split refund postings the same way Sale/Purchase
postings are split here"* – a sale refund's GL entry debited the whole
refunded amount against `SALES_REVENUE` without carving out the VAT
portion, leaving the original sale's `VAT_OUTPUT_PAYABLE` entry standing
even though a refund means some of that output VAT is no longer owed.

- **`postJournalEntryForRefund()`** (`src/lib/accounting-integrations.ts`)
  now takes an optional `vatAmount`. For a SALE refund it splits the
  previous single `Dr SALES_REVENUE (whole amount)` line into
  `Dr SALES_REVENUE (net of vat)` + `Dr VAT_OUTPUT_PAYABLE (vat)`, for
  both CASH and CREDIT_NOTE methods – the credit side (Cash or Customer
  Credits Payable) is unchanged and still posts the full gross amount,
  since that's genuinely what the customer is owed/paid back.
- **`createRefund()`** (`src/lib/refunds.ts`) computes that `vatAmount` by
  apportioning the *original* sale's `tax`/`total` in proportion to how
  much of the sale this specific refund covers – e.g. a MWK 5,000 refund
  against a MWK 20,000 sale that included MWK 2,400 VAT carves out MWK
  600, leaving the correct MWK 1,800 still owed on the unrefunded
  MWK 15,000. This means a partial refund, or several refunds against the
  same sale over time, each only ever carve out their own fair share –
  never more than the sale's actual VAT in total. Both `sale.total` and
  `sale.tax` are read from the same `tx.sale.findUnique()` already done to
  validate the refund (they're immutable once a sale is created, unlike
  `amountPaid`/`balance`, so no second query was needed).
- **Investigated, and deliberately left unchanged: the purchase side.**
  Tracing what `voidPurchase` actually reverses (rather than assuming
  Sale/Purchase are symmetric) showed `postJournalEntryForPurchase` posts
  Inventory + `VAT_INPUT_RECEIVABLE` + Accounts Payable as ONE combined
  entry, and `reverseJournalEntryForVoidedPurchase` reverses that entry in
  full when a purchase is voided – unlike a Sale, which is split into two
  entries specifically so voiding only reverses the inventory half. So a
  voided purchase's input VAT has already been fully unwound by the time a
  refund happens; there's nothing left standing for a purchase refund to
  carve out. `postJournalEntryForRefund`'s PURCHASE branch is untouched.
- Uses `getSystemAccountId` (throws loudly if missing), not
  `getOrCreateSystemAccountId`, for `VAT_OUTPUT_PAYABLE` in the refund
  path – a refund with a real `vatAmount` can only exist against a sale
  that itself already posted VAT (and backfilled the account if needed) at
  creation time, so a missing account here would be a real bug, not a
  legitimate backfill case.
- Confirmed this doesn't affect `getVatReturn()` (`src/lib/vat.ts`)
  either way: it already excludes every VOIDED sale/purchase entirely
  (computed fresh from `SaleItem`/`PurchaseItem` rows, not from GL account
  balances), and a refund can only exist against an already-voided
  sale/purchase. The bug this module fixes was purely a GL ledger-balance
  issue (an overstated `VAT_OUTPUT_PAYABLE` balance, visible on the
  Balance Sheet and anywhere else that account's balance is read) – the
  VAT Return report itself was never affected.
- No schema changes, no new permission key, no new UI – this is a pure GL
  correction. Journal entries render generically through the existing
  General Ledger API wherever they're already displayed, so the extra
  `VAT_OUTPUT_PAYABLE` line needs no new page to show up correctly.
- `tsc --noEmit`: zero net-new errors of any kind expected, not even the
  usual stub-Prisma-client cascade – no schema touched, and the one new
  parameter (`vatAmount`) is optional with a single call site already
  updated. Not verified against a real generated client in this sandbox.
- KNOWN LIMITATION found but out of scope: `Refund` doesn't persist a
  `vatAmount` column – it's recomputed on the fly from the linked
  Sale/Purchase's still-standing `total`/`tax` (both immutable), same
  "computed, not stored" philosophy as Customer/Supplier balances, so
  there was nothing to snapshot that could ever drift.


## Module 33 – Tax Payments (Remittances to the MRA)

Chosen by closing a limitation Modules 18, 19 and 20 each documented
separately: VAT output tax, withholding tax and PAYE all accumulate as
liabilities (`VAT_OUTPUT_PAYABLE`, `WITHHOLDING_TAX_PAYABLE`,
`PAYE_PAYABLE`) that nothing in the app could clear – an Owner/Accountant
had to hand-roll an Expense or manual journal entry. Two downstream
limitations closed with it: Module 20's *"nothing on the Tax Calendar can
be marked done"* and Module 25's *"TAX_DUE alerts can only be dismissed"*.

- **`TaxPayment`** (new model, `TaxPaymentType`/`TaxPaymentStatus` enums,
  `Business.taxPaymentPrefix`/`nextTaxPaymentNumber`, numbered `TXP-000001`).
  One row = one payment against one obligation period, identified by
  `(taxType, periodKey)` – the same key the calendar generates
  (`src/lib/tax-period.ts`: `"YYYY-MM"` for VAT/PAYE/withholding tax, the
  period's first day for provisional/annual). There is no separate
  "obligation" table; the calendar stays computed.
- **One active payment per period, enforced by the DB**:
  `activePeriodKey String? @unique` holds `<businessId>|<type>|<key>` while
  RECORDED and is nulled on void – Postgres treats NULLs as distinct, so this
  is the partial unique index Prisma can't express directly.
- **Posting** (`createTaxPayment` in `src/lib/tax-payments.ts`), all in one
  transaction: `postCashTransactionForTaxPayment` (branch-null outflow) and
  `postJournalEntryForTaxPayment`:
  PAYE → `Dr PAYE Payable`; withholding tax → `Dr Withholding Tax Payable`;
  VAT → `Dr VAT Output Payable / Cr VAT Input Receivable / Cr Cash`
  (netted in one entry, since the amount owed is output minus input);
  provisional/annual income tax → `Dr Income Tax Paid / Prepaid`; any
  penalty → `Dr Tax Penalties & Interest`; always `Cr Cash` for tax + penalty.
  Entry date is the payment date, not "now".
- **VAT's amount is server-computed** from the period's VAT Return, never
  typed in (a typed figure couldn't be netted correctly); a supplied
  mismatching amount is rejected.
- **Guards**: period must have ended; no second RECORDED payment for a
  period; PAYE/withholding principal can't exceed the liability account's
  current balance (the feature can't push a liability negative); the paying
  cash account must hold the total; payment date can't be in the future.
- **Void** (`voidTaxPayment`): equal-and-opposite GL and cashbook reversals,
  row kept as `VOIDED` with who/when/why, `activePeriodKey` freed so a
  corrected payment can be recorded.
- **Two new system accounts**: `INCOME_TAX_PREPAID` (1130, ASSET – a
  prepayment, deliberately not an expense: expensing it would feed back into
  the P&L that `getCorporateTaxEstimate` computes tax from, and this app
  never accrues income tax expense/payable – Module 20) and
  `TAX_PENALTIES_AND_INTEREST` (5160, EXPENSE). Both backfill lazily via
  `getOrCreateSystemAccountId`.
- **Tax Calendar**: entries now carry `periodKey`/`periodStart`/`periodEnd`
  and a `payment` summary, and can be `status: "paid"`. The accounting hub's
  Tax Calendar tab shows a green Paid badge (linking to the payment) or a
  "Record payment" link once the period has ended. The dashboard's upcoming
  deadlines widget hides paid entries.
- **Bell**: `syncTaxDueAlerts` resolves the TAX_DUE alert when the entry is
  paid; voiding the payment brings it back fresh (existing resolved-then-
  recurred behaviour). Still can't detect a payment made to the MRA but
  never recorded here – dismiss remains for that.
- **Corporate tax**: recorded penalties/interest are ADDED BACK in
  `getCorporateTaxEstimate` (`getNonDeductibleTaxPenalties`) – otherwise the
  penalty would shrink the very tax base it's a penalty on. The estimate now
  also returns `penaltiesAddedBack`, shown on the Corporate Tax tab.
- **Permissions**: new `taxpayments.manage` / `taxpayments.view`, Owner +
  Accountant only (like bank reconciliation). **Re-run `npx prisma db seed`**
  after migrating so the new keys are created and granted.
- **UI**: `/tax-payments` (history + totals), `/tax-payments/new` (type +
  period picker, live preview of the working estimate / VAT breakdown /
  liability balance, prefilled from the calendar's "Record payment" link),
  `/tax-payments/[paymentId]` (detail + void). Dashboard nav link.
  API: `/tax-payments` (GET/POST), `/preview`, `/[paymentId]`, `/[paymentId]/void`.
- **Cash Flow**: `TaxPayment` joins the Operating reference types.

### Pre-existing bugs found and fixed along the way

- **Fixed-asset disposal with proceeds > 0 always failed.**
  `disposeFixedAsset` passed the `CashAccount.id` the operator picked into a
  `JournalLine` as though it were a GL `Account.id` – a foreign-key
  violation that rolled the whole transaction back. `postJournalEntryForFixedAssetDisposal`
  now takes the account's TYPE and resolves the GL bucket through
  `CASH_ACCOUNT_KEYS`, as Refunds and Bank Reconciliation already did.
- **`getOrCreateSystemAccountId` could fail on a code collision**: `Account`
  is unique on `(businessId, code)` and users can pick their own codes, so a
  business that had hand-made account `1130`/`5160` would have failed its
  first tax payment. It now steps to the next free code (only `systemKey`
  carries logic).
- **Cash Flow dropped cash reversals**: only RECEIPT/PAYMENT rows were read,
  so a voided Expense/Payroll/TaxPayment (reversed by an ADJUSTMENT row)
  stayed in Operating outflows. Reversals carrying an operating
  `referenceType` are now included.
- **Tax Calendar estimates dropped the last day of every period** (they
  passed midnight at the start of the last day as an inclusive upper bound).
  Now end-of-day.

### Found, NOT fixed (out of scope) – BOTH CLOSED BY MODULE 34

- The accounting-hub report tabs (VAT Return, Withholding Tax, Corporate Tax,
  P&L, Trial Balance…) parse a date-only `to` query param as midnight, so the
  chosen last day's activity is excluded – same root cause as the calendar
  bug above. Module 33's own code (payment preview/create, calendar) uses
  end-of-day, so the calendar's "Est." can differ from the VAT Return tab
  for the same month until those routes are fixed. A shared "date-only `to`
  means end of that day" helper for those routes is the right fix.
- The Tax Calendar tab's window starts at the first of the current month, so
  overdue obligations older than about one cycle never appear there. The new
  payment form has its own period picker for that reason.

### KNOWN LIMITATIONS

- One payment per (tax, period): no installments or partial payments.
- A net-refundable VAT period (input > output) can't be recorded; its input
  VAT stays as a receivable and isn't netted into a later period.
- Penalty-only payments aren't modeled (principal must be > 0).
- "Paid" means a remittance was RECORDED here, not that a return was filed.
- Annual income tax balance payments also debit `INCOME_TAX_PREPAID` (there is
  no Income Tax Payable account); the Accountant books
  `Dr Income Tax Expense / Cr Income Tax Paid / Prepaid` by manual journal
  entry when finalizing the year (Module 20's existing manual step).
- The calendar's annual "Est." is still the gross estimate; only the payment
  form's suggestion nets off provisional payments already recorded.
- Not verified against a real generated Prisma client (see below).
- `tsc --noEmit`: baseline was 318 errors on the stub client; this module adds
  18, all the usual stub cascade (implicit-any on untyped query results and
  `Prisma` not exported) – no other category. Run `npx prisma generate` and
  `tsc --noEmit` locally as the real gate.


## Module 34 – Report Period & Date Handling Correctness

Chosen by closing the two "Found, NOT fixed" items Module 33 documented:
the accounting-hub routes parsed a date-only `to` as midnight (dropping the
last day), and the Tax Calendar tab's window started at the current month.
Testing them turned up a wider family of the same bug, all fixed here. No
schema change, no new permission – re-seeding is not needed.

- **One definition of a date-only string** (`src/lib/date-range.ts`, pure and
  client-safe; `date-range-api.ts` wraps it for routes like
  `requireApiContext`): `"2026-03-31"` names a whole LOCAL calendar day – start
  of day as a lower bound, end of day (23:59:59.999) as an upper bound or
  `asOf`. A value with a time is an exact instant. Unparseable input (incl.
  `2026-02-31`) is now a 400, not an unhandled 500; an empty `to=` still means
  "not provided"; `from > to` is still not rejected.
- **Routes moved onto it**: VAT Return, Withholding Tax, Corporate Tax, P&L,
  Cash Flow, General Ledger, Trial Balance, Balance Sheet, Tax Calendar,
  Expenses list, Fixed Assets `asOf`, and the four dated Basic Reports.
  `parseReportDateRange` (reports.ts) is removed in favour of it. Result: a
  calendar "Est." now equals the same month's report tab.
- **Browser date defaults**: `new Date(...).toISOString().slice(0, 10)` converts
  to UTC first, so in Malawi (UTC+2) every "From" picker defaulted to the last
  day of the previous month and "today" was yesterday from 00:00–02:00. All
  such defaults (accounting hub, reports hub, tax payment, fixed asset,
  disposal, bank reconciliation forms) now use `todayYmd()` /
  `firstOfMonthYmd()` / `lastOfMonthYmd()`.
- **Day buckets**: Sales Report daily/weekly/monthly keys, the expense report
  date column and the dashboard sales-by-day chart used UTC via `toISOString()`;
  now local calendar fields.
- **Tax Calendar**: (1) an obligation is overdue only after its whole due day
  has passed (`isPastDue`, tax-period.ts) – it used to flip at 00:00 on the due
  day, and the dashboard widget (which started at "now") dropped it that day;
  the widget now starts at start-of-today. (2) No obligation is generated for a
  period that ended before `Business.createdAt`. Before, a business created
  mid-September saw 23 phantom "overdue" entries (zero-amount periods it never
  existed for) and URGENT bell alerts. (3) The accounting-hub tab gained a
  "Look back" selector (this month / 3 / 6 / 12 months, default 3) and an
  "Unpaid only" checkbox.
- **Depreciation dating**: a run's journal entry was dated when it was clicked,
  so a March run done in April landed in April's P&L, and the "fully
  depreciated" cap couldn't see earlier periods of the same backlog run. Now
  dated by `monthEndEntryDate(period)`: the period's last day, or now if the
  month is still open (never future-dated). Entries already posted keep their
  old dates.
- **Verification**: `scripts/verify-date-range.ts` (no framework/DB); run under
  several zones, e.g. `TZ=Africa/Blantyre npx tsx scripts/verify-date-range.ts`.
  Passed under Africa/Blantyre, UTC, America/New_York, Pacific/Kiritimati. The
  calendar change was also exercised with stubbed data (not shipped).
- `tsc --noEmit`: re-measured baseline on the uploaded zip is 337 (README said
  336); after Module 34 the error set is identical – zero net-new.

### KNOWN LIMITATIONS

- **No per-business time zone.** – **CLOSED BY MODULE 35** (`Business.timezone`).
  ("Local" used to mean the runtime's zone, so on a UTC server activity between
  00:00 and 02:00 Malawi time was filed under the previous day.)
- User-picked date-only values (acquisition date, statement date…) are still
  stored as UTC midnight and shown with `toLocaleDateString()` – right for
  UTC+ browsers, a day early for UTC− ones. **Display half CLOSED BY MODULE 36:**
  they are now shown in the business's zone, which is UTC+0 or east by
  construction, so they show the day the user picked in any browser. Storage is
  unchanged.
- The bell (Module 25) still looks back only 120 days for unpaid overdue tax
  (kept deliberately: each look-back month costs corporate-tax estimate
  queries on every dashboard load), and the tab reaches back at most 12 months.
- A business that migrated existing books mid-year has no in-app obligations
  for periods before it registered.
- Not verified against a real generated Prisma client.

## Module 35 – Business Time Zone

Chosen by closing the first KNOWN LIMITATION Module 34 documented, and named
its own durable fix: *"No per-business time zone… the durable fix is a
`Business.timezone` that these helpers read."* Module 34 defined "a day" as a
day in the runtime's local zone – correct in a Malawi browser or a server
started with `TZ=Africa/Blantyre`, wrong on the usual UTC host, where every
day/month boundary, daily sales bucket, "today", tax due date and depreciation
period sat two hours off Malawi's clock.

- **`Business.timezone String @default("Africa/Blantyre")`** – a real Postgres
  default, so every existing business becomes Malawi-time when the migration
  runs (no lazy backfill needed). Validated on write against
  `SUPPORTED_TIME_ZONES`; read through `getBusinessTimeZone(businessId)`
  (server, `src/lib/business-timezone.ts`, one small uncached select) or
  `resolveTimeZone(business.timezone)` (when the business row is already
  loaded, e.g. `membership.business` in pages). Both fall back to the default
  zone, never to the server's clock.
- **`src/lib/timezone.ts`** (pure, client-safe): `zonedParts`, `zonedDate`
  (the zone-aware `new Date(y, m, d…)`, same overflow normalisation),
  `ymdIn`/`monthKeyIn`/`startOfDayIn`/`endOfDayIn`/`startOfMonthIn`/`addDaysIn`,
  and `formatDateIn`/`formatDateTimeIn` for display. Intl-based, so correct for
  any IANA zone (DST included – verified) even though the picker only offers
  fixed-offset ones. **No function in the chain reads the process time zone.**
- **`tz` is a REQUIRED parameter, on purpose.** `tax-period.ts`
  (`ymd`, `monthKey`, `parseYmd`, `endOfDay`, `isPastDue`, labels…),
  `date-range.ts` (`parseDateInput`, `readDateRange`, `monthToDate`, `todayYmd`,
  `firstOfMonthYmd`, `lastOfMonthYmd`, `monthEndEntryDate`, `startOfDay`) and
  `fiscal-period.ts` all take it, so a caller that forgets is a compile error
  instead of a silent return to the server's clock. That is how every call site
  was found (tsc diff against the pre-change error set).
- **Server code moved onto it**: Tax Calendar (period starts/ends, due dates,
  overdue, business start), Tax Payments (period resolution, preview, period
  picker), Corporate Tax fiscal years/quarters (now `fiscal-period.ts`,
  re-exported from `corporate-tax.ts`), dashboard (today / this month / last
  month / 14-day chart), Sales Report buckets (daily/weekly/monthly/annual –
  `report-period.ts`) and Expense Report dates, the monthly-sales plan
  allowance reset (`getCurrentMonthStart(tz)`), AI context/analysis month
  windows, depreciation period bounds and entry dates, bell tax-due text,
  invoice/receipt/quotation/withholding-certificate PDFs (`documentDate` needs
  a `timeZone`), expenses summary, and all 15 date-range routes (accounting
  hub, basic reports, expenses list, fixed-assets `asOf`).
- **Client components** get the zone as a prop (`timeZone`) from their server
  page: Accounting hub (via a small React context), Reports hub, tax payment
  form, fixed-asset/disposal forms, bank reconciliation forms, payroll period,
  depreciation button. Default dates, the "current month" and displayed dates
  are the business's, whatever the browser's zone is.
- **Settings**: `/settings/general` (Owner, `business.settings.manage`, no new
  permission – no re-seed needed) with a zone picker and a live "right now in
  this zone" line; `GET/PUT /api/business/[id]/timezone`; changes write a
  `business.timezone_changed` audit row. Dashboard nav gained a Settings link.
- **Extra bugs the same root cause hid, fixed**: depreciation `periodBounds`
  used UTC month bounds, so an asset bought 00:00–02:00 on the 1st Malawi time
  was depreciated a month early; the plan's monthly sales allowance reset at
  02:00 Malawi time; the dashboard's 14-day chart used 24-hour steps rather
  than calendar days; a Sunday-night/Monday-early sale was filed in the wrong
  ISO week on a UTC host.
- **Verification**: `scripts/verify-timezone.ts` (no framework/DB; replaces
  Module 34's `verify-date-range.ts`, whose cases it re-expresses with explicit
  UTC instants). 82 checks, and the point is that the SAME results hold under
  any process zone:
  `TZ=UTC|Africa/Blantyre|America/New_York|Pacific/Kiritimati npx tsx scripts/verify-timezone.ts`
  – all four pass. Covers the 01:00-Malawi-sale regression, March range
  inclusion/exclusion at both edges, overdue at Malawi midnight, fiscal year at
  New Year's Eve, weekly buckets across Sunday/Monday, DST correctness of
  `zonedDate`, and `resolveTimeZone` fallbacks.
- `tsc --noEmit`: zero net-new errors versus the same tree before the module
  (measured 280 in this sandbox against the stub client; the README's earlier
  337 came from a differently-stubbed run). Only stub-cascade noise (one
  implicit-any `tx` in the new route). Not verified against a real generated
  Prisma client – run `npx prisma migrate dev` (adds the column) and
  `npx prisma generate`, then `tsc --noEmit`. **No re-seed needed.**

### WHY ONLY SOME ZONES ARE OFFERED

User-picked date-only values (expense date, acquisition date, statement date,
tax payment date…) are still sent by the browser as
`new Date("2026-03-31").toISOString()` – **UTC midnight** – and stored that
way. UTC midnight is on the right calendar day in any zone at UTC+0 or east and
on the previous day west of Greenwich. So the picker lists 15 African zones at
UTC+0…+3 with no daylight saving. Adding a western zone is a data-model change
(store date-only fields as a calendar date, or as start-of-day in the business
zone), not a dropdown entry – deliberately not attempted here.

### KNOWN LIMITATIONS

- Existing date-only values stay UTC midnight (see above); only the
  zone list is constrained, nothing was migrated.
- Changing a business's zone re-buckets reports for activity near midnight;
  posted entries are not touched, and old depreciation entries keep the dates
  they were posted with.
- **Display formatting is only partly moved.** – **CLOSED BY MODULE 36** (the
  wording below is kept as the historical record). Everything that computes or
  buckets dates, plus PDFs, the bell text, the accounting/tax/expense/dashboard
  pages and hub tabs, now formats in the business zone. The remaining ~35
  server-rendered list/detail pages (sales, purchases, customers, employees,
  stock, quotations, payslips…) still call a bare `toLocaleDateString()`, i.e.
  the SERVER's zone. Effect: only a timestamp between 22:00 and 24:00 UTC can
  show one day early on those pages (date-only values are unaffected).
  Mechanical follow-up: `formatDateIn(d, resolveTimeZone(membership.business.timezone))`.
  Setting `TZ=Africa/Blantyre` on the host still helps until then.
- Bell alert de-duplication keys use the period label text
  (`tax:VAT:March 2026`); a zone change cannot alter a label except at a month
  edge, but the label locale is still the server's default locale.
- The bell's 120-day look-back and the tab's 12-month reach are unchanged.
- Not verified against a real generated Prisma client.

## Module 36 – Business Time Zone on Every Screen

Chosen by closing the display half of Module 35's last-listed KNOWN LIMITATION:
*"the remaining ~35 server-rendered list/detail pages … still call a bare
`toLocaleDateString()`, i.e. the SERVER's zone… Mechanical follow-up:
`formatDateIn(d, resolveTimeZone(membership.business.timezone))`."* Module 35
made every date the app COMPUTES a business-zone date; a sale rung up at 01:00
Malawi time was filed under 1 April in every report, then printed as 31 March
next to it on the sale page of a UTC host. This module removes that last
disagreement between what the books say and what the screen says.

- **35 call sites in 27 files moved to `formatDateIn` / `formatDateTimeIn`.**
  Server pages take the zone from data they already load, with no extra query:
  `resolveTimeZone(membership.business.timezone)` (`listUserBusinesses` already
  includes `business`), or `resolveTimeZone(sale.business.timezone)` /
  `run.business.timezone` on the receipt and payslip pages, which include the
  business row. Pages: sale, purchase, quotation (detail + list), employee,
  customer, supplier, fixed asset (list + detail), stock transfer (list +
  detail), bank reconciliation list, stock take list, tax payment detail,
  notifications log, receipt, payslip.
- **Client components get a `timeZone` prop** from their server page, the same
  shape Module 35 used for the accounting hub and reports hub: `CashbookView`,
  `TeamManager`, `BillingClient`, `StockTakeWorkspace`. The reconciliation
  workspace already had the prop and now uses it for its four date displays.
- **`formatDateIn` / `formatDateTimeIn` now accept `Date | string | number`.**
  A client component receives `createdAt` as an ISO string, so it can format it
  directly (no `new Date()` wrapper at each call site). An unparseable value
  prints `–` instead of `Invalid Date`. Existing callers are unaffected.
- **Date-only values now show the day the user picked.** They are stored as UTC
  midnight (Module 35). Every zone the picker offers is UTC+0 or east, so UTC
  midnight is on the same calendar day there. Formatting them in the business
  zone shows that day in every browser, including a UTC− one, where the old
  `toLocaleDateString()` showed the day before.
- **`scripts/check-date-formatting.ts` keeps it fixed.** A text scan of every
  `.ts`/`.tsx` under `src/` that fails on bare `toLocaleDateString`,
  `toLocaleTimeString`, `toDateString`, `toTimeString`, `toLocaleString` on a
  date-named value, and the runtime-local getters/setters (`getMonth`,
  `getDate`, `setHours`…). `src/lib/timezone.ts` is exempt; a correct line
  (a duration, say) opts out with `// tz-ok: reason`. Run against the Module 35
  tree it reports 36 violations; against this tree, 0. Also wired as
  `npm run check:dates`.
- **`scripts/verify-timezone.ts` grew from 82 to 89 checks**: string/number
  inputs match the Date result, invalid input prints `–`, a UTC-midnight
  date-only value shows as the 31st in all 15 offered zones, and a 01:00 Malawi
  timestamp shows as 1 April / 01:00 in Malawi and 31 March / 23:00 in Accra.
  All 89 pass under `TZ=UTC`, `Africa/Blantyre`, `America/New_York` and
  `Pacific/Kiritimati` (`npm run verify:timezone`).
- **No schema change, no migration, no re-seed, no new permission.**
- `tsc --noEmit`: the error set is identical to the Module 35 tree, compared
  message by message with line numbers stripped (339 both, all stub-client
  noise; the count differs from Module 35's 280 only because this run
  installed the real dependency set). A missed `timeZone` prop on any of the
  four client components would show up as a new error, and none did. Not
  verified against a real generated Prisma client – run
  `npx prisma generate`, then `tsc --noEmit`.

### KNOWN LIMITATIONS

- **The zone is pinned; the locale is not.** `formatDateIn` still uses the
  runtime's default locale, as every bare call did. A server-rendered page
  prints in the SERVER's locale (typically `en-US`, `3/31/2026`) and a client
  component in the BROWSER's. `TeamManager` renders its invitation dates on the
  server from props, so a browser whose locale differs can log a hydration
  mismatch warning there; the other three client components fetch after mount
  and never render a date on the server. A single `DISPLAY_LOCALE` (`en-GB`
  gives the `31/03/2026` Malawians expect) in `timezone.ts` would fix both. It
  changes how every date reads, so it is left as a product decision.
- Storage of user-picked date-only values is unchanged (UTC midnight), so the
  offered zones are still limited to UTC+0 and east (Module 35).
- The guard script is a text scan. It cannot see a date formatted through a
  helper it does not know, or `toLocaleString()` on a date held in a variable
  with an unrelated name. It catches the patterns this codebase actually used.
- Not verified against a real generated Prisma client.

## Module 37 – Other Income & Other Expenses on the Profit & Loss

Chosen by closing a limitation stated in Modules 21, 22 and 23 and never
scheduled: *"a gain shows as a negative Operating Expense line rather than Other
Income – `getProfitAndLoss()` has no Other Income section."* A disposal gain,
or interest earned on the bank, printed as a negative line inside Operating
Expenses.

- **No account, posting or journal row changed.** The mixed-direction accounts
  stay EXPENSE / debit-normal, so posting, Trial Balance, General Ledger and
  Balance Sheet are untouched. Only how the P&L *reads* them changed, so
  existing tenants get the corrected layout on deploy with no backfill.
- **`src/lib/pnl-layout.ts` (new, pure).** `buildProfitAndLoss()` takes
  per-account period debit/credit and returns the statement. For
  `GAIN_LOSS_ON_DISPOSAL_OF_ASSETS` and `BANK_CHARGES_AND_INTEREST`, net credit
  for the period goes under **Other Income** ("Gain on Disposal of Assets",
  "Bank Interest Earned"), net debit under **Other Expenses** ("Loss on Disposal
  of Assets", "Bank Charges & Interest"). Both are listed in
  `NON_OPERATING_ACCOUNTS`.
- **New result fields:** `otherIncome`, `totalOtherIncome`, `otherExpenses`,
  `totalOtherExpenses`, `profitBeforeTax`. `operatingProfit` now EXCLUDES those
  items; `profitBeforeTax` equals the old `operatingProfit` exactly.
- **Inventory Shrinkage & Adjustment deliberately stays operating.** Stock lost
  or found is a trading cost; a net-found period is a negative operating expense.
- **Consumers moved to `profitBeforeTax`:** Balance Sheet retained earnings
  (keeps it balanced) and `getCorporateTaxEstimate()` (`accountingProfit`). Tax
  figures are unchanged in value. The tax tab label now reads "Profit before tax
  for period".
- **Also fixed:** Cost of Goods Sold was found by `code === "5000"`, a
  user-editable field; it now uses `systemKey`.
- **UI:** Profit & Loss tab shows Operating Profit, then Other Income / Other
  Expenses (only when present), then Profit Before Tax.
- **Verification:** `scripts/verify-profit-and-loss.ts` (`npm run verify:pnl`),
  24 checks, no DB: classification, reversal netting, the shrinkage exception,
  and that `profitBeforeTax` equals the raw net of every account (the Balance
  Sheet invariant) and the old operating profit. `npm run check:dates`: 0
  violations. `tsc --noEmit`: 339 → 328 (only stub-client noise in the rewritten
  function removed; zero new errors, message-by-message diff).
- **No schema change, no migration, no re-seed, no new permission.**

### KNOWN LIMITATIONS

- **Netted per account.** Reversals post opposite entries, so a gross split would
  show a voided charge as both income and expense. Consequence: a 200 gain and a
  50 loss in one period show as one 150 gain; 40 interest and 15 charges show as
  25 interest.
- **Bank charges are non-operating here; a business may prefer them operating.**
  It is one entry in `NON_OPERATING_ACCOUNTS`.
- Profit Before Tax is not reduced by corporate tax (never posted to the GL).
- The P&L still lists only `isActive` accounts (unchanged).
- Not verified against a real generated Prisma client.

## Module 38 – Atomic Quotation Conversion

Chosen by closing a limitation stated in Module 15 and repeated in the code
comment on `convertQuotationToSale()` ever since: *"two separate writes …
if the second write fails, the sale exists but the quotation is left
un-marked."* Reading it closely, the gap was worse than "an operator can
reconcile": the "already converted?" check was a plain read, so **two people
pressing Convert on the same quotation at the same moment could both pass it
and both create a Sale** – stock deducted, cash and revenue posted, receipts
issued, twice.

- **`createSale()` takes an optional `tx`** (`Prisma.TransactionClient`). With
  it, the whole sale – stock movements, receipt, payment, cashbook, GL,
  credit sweep – joins the caller's transaction; without it, it opens its own
  exactly as before. The body moved into a private `createSaleInTransaction()`;
  no line of sale logic changed. Its only other caller (`POST /sales`) is
  untouched. There is still one sale-creation path.
- **`convertQuotationToSale()` is one transaction:** (1) *claim* the quotation
  with a conditional write (`status IN (DRAFT, SENT, ACCEPTED)` → `CONVERTED`);
  (2) validate the lines, then `createSale({ tx })`; (3) set `convertedSaleId`.
  The claim row-locks the quotation, so a concurrent second conversion waits,
  re-evaluates the condition after the first commits, matches **zero rows** and
  is refused with "already been converted". Any failure after the claim – free-
  text line, insufficient stock, the monthly sales cap, a ledger error – rolls
  the claim back with everything else, so the quotation is exactly as it was.
  The "sale exists but the quotation says otherwise" state can no longer occur.
- **Same-shaped races closed on the neighbours:** `setQuotationStatus()` was
  read-then-write and could overwrite `CONVERTED` with `SENT`/`DECLINED` if a
  conversion committed in between; it is now one conditional `updateMany`
  (`status NOT IN (CONVERTED)`). `updateQuotation()` checked "is DRAFT" before
  its transaction, so an edit could delete and replace the items of a quotation
  a conversion had just turned into a Sale; it now claims the row (a no-op
  write matching only `DRAFT`) as the first step *inside* its transaction.
- **Behaviour the user sees is unchanged** – same messages, same status codes
  (`QuotationValidationError` → 400, `PlanRestrictionError` → its own status).
  A `SaleValidationError` raised inside the transaction is mapped to a
  `QuotationValidationError` outside it, after the rollback.
- **No schema change, no migration, no re-seed, no new permission, no UI change.**
- **Verification:** `scripts/verify-quotation-conversion.ts`
  (`npm run verify:quotations`), 43 checks, no DB: happy path (sale created with
  the shared `tx`, claim happens *before* `createSale`, linked); a second convert
  is refused with no second sale; every failure after the claim (stock, plan cap,
  free-text line, no items, credit sale without a customer) restores the original
  status and leaves no sale, from each of DRAFT/SENT/ACCEPTED; DECLINED/EXPIRED/
  wrong tenant/unknown id are refused and untouched; `setQuotationStatus` cannot
  overwrite `CONVERTED`; `updateQuotation` refuses a non-DRAFT and leaves its items
  alone. `npm run check:dates`: 0 violations. `npm run verify:pnl`: 24/24.
  `tsc --noEmit`: 328 → 330, both new errors the usual stub-client cascade
  (`Prisma` not exported from the stub in `sales.ts`; an untyped `tx` callback
  parameter in `quotations.ts`); message-by-message diff shows nothing else.
- **What that script cannot prove:** it uses an in-memory fake with real
  rollback semantics, so it checks the orchestration, not Postgres locking. It
  passes 41 of 43 against the Module 37 code – the two failures are the
  "claim before `createSale`" and "shared `tx`" checks – because run one call at
  a time the old code also refuses a second conversion; only genuine simultaneity
  exposed the bug. To see the fix under real concurrency, against a dev database
  fire two `POST .../quotations/<id>/convert` requests at once (e.g. two `curl`s
  with `&`): exactly one returns 201, the other 400 "already been converted", and
  `/sales` shows one sale.

### KNOWN LIMITATIONS

- **Free-text quotation lines still block conversion.** *(Closed by Module 68 - the convert form now lets you
  choose a product for each such line.)* Unchanged from Module
  15: the user must edit the quotation and link each such line to a product first.
  A "map free-text lines to products at convert time" step is the natural next
  step; it needs a UI change, not a data-model one.
- **The claim is a status flip, not a lock the user can see.** A second person
  pressing Convert at the same instant gets the "already converted" message, which
  is accurate a moment later but may briefly confuse them.
- Interactive transactions time out after Prisma's default (5 s). A conversion is
  a sale creation plus two small writes, comparable to `POST /sales`, so it sits in
  the same envelope; a very large quotation on a slow database could exceed it and
  would roll back cleanly (nothing half-done) with a 500 rather than a message.
- Not verified against a real generated Prisma client or a live Postgres.

## Module 39 – Foreign Exchange Gains & Losses

Raised by the owner: the system is in kwacha but had **no foreign exchange gains &
losses account**, and no journal-entry screen to book one by hand, so a business
holding USD or ZAR had nowhere honest to put a rate difference.

- **New system account `FOREIGN_EXCHANGE_GAIN_LOSS` (code 5170).** EXPENSE /
  debit-normal, both directions, the same shape as the disposal and bank-charges
  accounts. New businesses get it at registration; existing ones get it on the
  first posting (`getOrCreateSystemAccountId`), so **no backfill is needed**.
- **P&L treatment from day one.** Listed in `NON_OPERATING_ACCOUNTS`
  (`src/lib/pnl-layout.ts`): net credit shows as **Foreign Exchange Gain** under
  Other Income, net debit as **Foreign Exchange Loss** under Other Expenses. It never
  touches operating profit, and Profit Before Tax / the Balance Sheet stay in step.
- **`ForeignExchangeAdjustment` (new model, `FXA-000001` numbering).** Records one
  gain or loss, in kwacha, against one **cash / bank / mobile-money account** that
  holds foreign currency. **Realised** (actually converted or received at a different
  rate) or **Unrealised** (a period-end revaluation). The figure is either worked out
  from `foreignAmount × (newRate − bookRate)` or typed in as gain/loss + amount. The
  currency, foreign amount and rates are a **memo** of how the figure was reached.
- **Both ledgers, one transaction.** Cashbook `ADJUSTMENT` (own `referenceType`) plus
  a GL entry: gain = Dr cash bucket / Cr FX; loss = Dr FX / Cr cash bucket. The stored
  `gainLossAmount` is the signed figure that posted; **void** reverses exactly it in
  both ledgers and keeps the row as history (claimed with a conditional write, so two
  simultaneous voids can't both reverse). No edit – void and re-record, like Tax Payments.
- **Guards.** A loss can't exceed what the account carries, and a gain can't be voided
  once the account no longer holds it (either would push the cashbook negative). The
  currency can't be the business's own; the date can't be in the future.
- **Cash Flow.** The statement gets an **Effect of Exchange Rate Changes** line
  (`exchangeRateEffect`), included in Net Change in Cash. A revaluation moves no cash,
  so it is not counted as operating.
- **UI:** `/fx-adjustments` (list with realised / unrealised / total), `/new` (live
  preview of the gain or loss), `/[id]` (detail + void); a **Foreign Exchange** link on
  the dashboard. **Permissions:** new `forex.manage` / `forex.view`, Owner + Accountant.
- **Also fixed (not part of the feature, found while verifying):**
  - `accountTypeForPaymentMethod()` was typed as returning `string`; it now returns
    `CashAccountType | null` (4 real `tsc` errors in `cashbook.ts`).
  - `team/team-manager.tsx` `Invitation.role` didn't accept Prisma's `BusinessRole`
    (1 real `tsc` error).
  - `/login`, `/reset-password` and `/accept-invitation` used `useSearchParams()` with
    no `<Suspense>` boundary, which made **`next build` fail** while prerendering.
    Wrapped each in one; no behaviour change.
- **Deploy:** `npx prisma migrate dev --name fx_adjustments` (new enums, table and two
  `Business` columns with real Postgres defaults), then **`npx prisma db seed`** to
  register the two new permissions (Owner/Accountant grants are seeded there).
- **Verification:** `scripts/verify-foreign-exchange.ts` (`npm run verify:fx`), 45
  checks, no DB: sign convention and rounding, journal-line shape and balance, the
  account entry, P&L classification (gain, loss, mixed period nets, void nets to
  nothing, `profitBeforeTax` equals the raw net), permission grants, request schema,
  summary. `verify:pnl` 24/24, `verify:quotations` 43/43, `check:dates` 0 violations,
  `verify:timezone` passes.
  **This is the first module verified against a real generated Prisma client:**
  `prisma generate` runs in a sandbox when `PRISMA_QUERY_ENGINE_LIBRARY` and
  `PRISMA_SCHEMA_ENGINE_BINARY` point at any existing file (it needs no engine to
  generate types). Result: `tsc --noEmit` **0 errors** (the historical 330 was stub
  noise hiding the 5 real ones fixed above), `prisma validate` valid, `next build` passes.

### KNOWN LIMITATIONS

- **Not multi-currency accounting.** No foreign-currency balances, no per-transaction
  currency, no stored rates, no automatic revaluation and no rate feed. The owner or
  accountant enters the rate and the app books the kwacha difference.
- **Cash accounts only – no receivables/payables.** A gain or loss on a USD supplier
  invoice or customer invoice is not covered: posting it to Accounts Payable/Receivable
  would make the GL disagree with the customer/supplier balances (computed from
  `Sale.balance` / `Purchase.balance`). Doing it properly needs a currency and rate on
  each Sale/Purchase – the natural next module.
- **Gain/loss is from the cash account's point of view** (asset: higher rate = gain).
  Foreign-currency liabilities move the other way and aren't handled here.
- **Bank reconciliation:** an unrealised revaluation has no bank statement line, so it
  stays as an unmatched book transaction on that account.
- **Cash Flow timing:** the exchange-rate line uses the cashbook row's creation time,
  like the operating lines, not the adjustment date.
- **Tax:** the corporate tax estimate includes exchange gains/losses in accounting
  profit, realised or not. Whether the MRA taxes unrealised gains or allows unrealised
  losses is not encoded – the accountant should adjust; the Realised/Unrealised split
  on each record is there for that.
- Netted per account on the P&L like the other non-operating accounts: a 500 gain and a
  200 loss in one period print as one 300 gain.
- The two-ledger transaction and Postgres behaviour were not run against a live
  database (Prisma's engine download is blocked in the build sandbox).

## Module 40 – Foreign-Currency Invoices & Realised Exchange Differences

Closes Module 39's main KNOWN LIMITATION ("cash accounts only – no receivables/payables"). A
sale to an NGO invoiced in USD, or a purchase from a South African supplier in ZAR, can now be
booked in kwacha **with its currency and rate**, and settled later at a different rate – the
difference lands in `FOREIGN_EXCHANGE_GAIN_LOSS` automatically.

- **Sale and Purchase gain `currency` + `exchangeRate`** (both null = an ordinary kwacha
  document; existing rows need no backfill). The kwacha `total`/`balance` and the AR/AP
  postings are **unchanged**, so customer/supplier balances, aging, VAT and the GL still agree –
  the reason Module 39 wouldn't post a difference to AR/AP without a document-level rate. The
  foreign total/balance is **computed** (kwacha ÷ book rate), never stored. `currency` can't be
  the business's own.
- **Settling: `POST /foreign-settlements`** (`src/lib/foreign-settlement.ts`). You state the
  payment **in the document's currency** plus today's rate. The server clears
  `foreign × book rate` off the balance; the cash that moves is `foreign × settlement rate`; the
  difference is a realised gain/loss. From the business's point of view: **receiving** a stronger
  currency than booked, or **paying** a weaker one, is a gain (`src/lib/fx-calc.ts`).
- **One posting path.** The settlement creates an ordinary `Payment` (new columns `currency`,
  `foreignAmount`, `settlementRate`, `fxGainLoss`; `amount` stays the kwacha applied to the
  document). `postCashTransactionForPayment` posts the cash actually moved (`amount ± fxGainLoss`)
  and `postJournalEntryForPayment` takes an optional `fxGainLoss`, adding the FX line – Dr cash /
  Cr AR / Cr FX on a receipt gain; Dr AP / Cr cash / Dr FX on a payment loss. Payments with no
  difference post exactly as before.
- **Concurrency.** The document is claimed with a conditional write on its balance (Module 38's
  lesson), so two simultaneous settlements can't both clear the same balance. A settlement can't
  exceed what is owing; the last few tambala of rounding snap so the document closes.
- **UI:** an optional *Foreign currency* block on New Sale / New Purchase (with a live foreign
  total); on the sale/purchase page a *Record USD payment* form (live preview of cleared amount,
  cash and gain/loss – same `computeSettlement()` as the server), the currency line and a
  foreign-payments list; the Foreign Exchange page shows the net booked by settlements.
- **Permissions:** none new. Receiving = `payments.record`; paying a supplier = `suppliers.manage`
  (same split as `POST /payments`). **No re-seed.**
- **Deploy:** `npx prisma migrate dev --name foreign_currency_documents` (two nullable columns on
  each of Sale/Purchase, four on Payment; `fxGainLoss` has a real default of 0), then
  `npx prisma generate`.
- **Verification:** `npm run verify:fx` now **99 checks** (was 45): sign convention both sides,
  partial settlements, rounding snap, journal lines balance for receive/pay × 3 rates, cash leg
  equals what moved, P&L classification, request-schema rules. `verify:pnl` 24/24,
  `verify:quotations` 43/43, `check:dates` 0 violations, `verify:timezone` passes,
  `tsc --noEmit` **0 errors**, `next build` passes. Not run against a live Postgres.

### KNOWN LIMITATIONS

- **Prices are still typed in kwacha.** The currency/rate is a memo on the document; the form
  shows the foreign total but you don't yet enter unit prices in USD/ZAR.
- **Only per-document settlement computes a difference.** The customer/supplier-level "pay what
  they owe, oldest first" payment is a kwacha payment and clears foreign documents at the book
  rate – no gain/loss. Settle the invoice itself to recognise one.
- **No period-end revaluation of open foreign invoices** (unrealised difference on receivables/
  payables). Doing it needs a GL line against AR/AP, which the balances don't have. Use a
  Module 39 unrealised adjustment on the cash account for now.
- **Refunds/voids of a foreign document work in kwacha at the booked figure**; the difference
  already booked on its settlement stays (like every payment, Module 9).
- **Payment-method breakdowns** that sum `Payment.amount` show the kwacha applied to documents,
  which differs from cash by `fxGainLoss` on foreign settlements. The cashbook, GL and Cash Flow
  use the real cash.
- **Quotation → sale conversion** produces a kwacha sale; a quotation can't carry a currency yet.
- **Invoice/receipt PDFs** don't print the foreign amount yet.
- Whether the MRA taxes realised/unrealised differences isn't encoded (unchanged from Module 39).

## Module 41 – Manual Journal Entries, Income Tax Accounts & Custom Accounts

Closes a gap four earlier modules pointed at. Modules 18, 19, 20 and 33 each end a limitation
with "an Accountant books this by manual journal entry" (book the company income tax charge,
clear a tax liability). No screen or route existed to do that, and for income tax **the accounts
did not exist either**. There is now a Journal Entries page (`/manual-journals`), the two
missing accounts, and a way to add your own accounts.

- **`ManualJournal` (`MJ-000001`)** is the record: date, narration, supporting-document reference,
  notes, total, status, void trail. It stores **no lines**. The lines are one ordinary
  `JournalEntry` posted by `postJournalEntry()` (same balance check, same `JE-` numbering), tagged
  `referenceType "ManualJournal"` / `referenceId` = the record. The record therefore can't disagree
  with the ledger, and voiding reuses `reverseJournalEntriesForReference()` unchanged.
- **Post, view, void. No edit.** A void posts an equal-and-opposite entry dated today; nothing is
  deleted. The row is claimed with a conditional write (`status: RECORDED`, count 0 = refused) so two
  simultaneous voids can't both post a reversal (Module 38's lesson). A void that finds no posted
  entry fails and rolls back rather than marking the record voided with nothing reversed.
- **Sub-ledger accounts are off limits.** Cash, Bank, Airtel Money, TNM Mpamba, Accounts
  Receivable/Payable, Inventory, customer/supplier credits, Fixed Assets and Accumulated Depreciation
  are GL mirrors of records the app computes itself (Cashbook, `Sale.balance`, `Purchase.balance`,
  `Product.quantity`, the asset register). A manual line there would move the GL and leave the
  sub-ledger alone with nothing to reconcile them, the reason Module 39 refused the same thing. The
  form and the server say which page to use instead. Everything else is allowed: equity, revenue,
  expenses, VAT, PAYE, pension, withholding, income tax and custom accounts.
- **Balance is checked in whole tambala** (`src/lib/manual-journal-rules.ts`), not floating point,
  so `0.1 + 0.2 = 0.3` balances and one tambala out never does. More than two decimals is rejected,
  never rounded. At least two different accounts, one side per line, at most 40 lines. The rules file
  is pure and shared by the server (the authority), the form's live totals and the verify script.
  The server re-reads and re-checks the accounts **inside** the posting transaction.
- **The date is a calendar day in the business time zone** (Modules 34/35). `"2026-03-31"` is stored as
  the start of that day in the business zone, so the entry lands on the right day in every report
  whatever zone the server runs in. The future is refused by comparing calendar dates. Back-dating is
  allowed and audit-logged as `backDated` (see limitations).
- **Income tax accounts.** New system accounts `INCOME_TAX_PAYABLE` (2700, liability) and
  `INCOME_TAX_EXPENSE` (5180, expense). Existing businesses get them lazily
  (`ensureManualJournalAccounts`, the `getOrCreateSystemAccountId` pattern) the first time the journal
  form loads. Two templates on the form: **accrue** (Dr Income Tax Expense / Cr Income Tax Payable) and
  **apply provisional payments** (Dr Income Tax Payable / Cr Income Tax Paid / Prepaid, the account
  Module 33's provisional/annual payments debit).
- **P&L and Balance Sheet.** `INCOME_TAX_EXPENSE` is its own line **below** Profit Before Tax
  (`incomeTaxExpense`, `profitAfterTax` in `src/lib/pnl-layout.ts`). Profit Before Tax is unchanged by
  it, so the Corporate Tax estimate is not lowered by the very charge booked against it (the trap
  Module 33 named). The Balance Sheet's retained earnings now use **profit after tax**, because the
  charge is a real debit; using profit before tax would leave the sheet out by exactly the tax booked.
  For a business that has booked no income tax the two are equal and nothing changes value. The
  Corporate Tax tab shows "income tax already booked" beside the estimate.
- **Custom accounts** (`src/lib/account-admin.ts`, Chart of Accounts tab). Add an account (4-8 digit
  code, name, type), rename **any** account, deactivate a custom account. Type is fixed at creation;
  normal balance is derived; a created account never has a `systemKey`, so the app never posts to it
  automatically. **An account that has ever been posted to can't be deactivated** (balances and P&L
  read active accounts only, so it would vanish from the Trial Balance and the Balance Sheet would stop
  balancing). There is no delete (`JournalLine` restricts it).
- **Permissions: none new, no re-seed.** `accounting.view` reads, `accounting.manage` (Owner +
  Accountant, already granted since Module 11) posts, voids and edits the chart. Journal entries are
  business-wide, so a **branch-locked member can view but not post or void** (403).
- **API:** `GET/POST /manual-journals`, `GET /manual-journals/[id]`, `POST /manual-journals/[id]/void`,
  `GET /accounting/journal-accounts`, `POST /accounting/accounts`, `PATCH /accounting/accounts/[id]`,
  `GET /accounting/chart-of-accounts?includeInactive=1`.
- **Deploy:** `npx prisma migrate dev --name manual_journals` (one new table, one enum, two `Business`
  columns with real defaults), then `npx prisma generate`. No re-seed.
- **Verification:** `npm run verify:journal` **90 checks** (tambala arithmetic, every controlled account
  blocked, template accounts real and postable, chart entries, income tax P&L and a Balance Sheet
  invariant through accrue / apply / void, permissions, request schemas). `verify:fx` 99/99,
  `verify:pnl` 24/24, `verify:quotations` 43/43, `verify:timezone` passes, `check:dates` 0 violations,
  `tsc --noEmit` **0 errors**, `next build` passes. Not run against a live Postgres.

### KNOWN LIMITATIONS

- **No period close.** CLOSED BY MODULE 42. Nothing stopped a back-dated entry landing in a month whose
  VAT return or tax payment was already filed.
- **Owner capital and drawings still can't be recorded.** Both move cash, and cash accounts are off
  limits here by design. They need a Cashbook feature that posts both ledgers (and would fill the
  "Financing" section of Cash Flow, still empty). Owner's Equity is available for entries that don't
  touch cash.
- **Custom accounts are all "operating".** Non-operating P&L classification is by `systemKey`
  (`NON_OPERATING_ACCOUNTS`), which a custom account doesn't have, so a custom REVENUE account prints
  under Revenue and a custom EXPENSE account under Operating Expenses.
- **Income tax is still not automatic.** The accounts, templates and P&L line exist; the figure is typed
  from the Accountant's assessment. The app does not accrue it, and the Corporate Tax estimate is
  unchanged (add-backs and capital allowances still not modelled).
- **A void is dated today**, not the original date, like every other void here. The original stays in its
  period and the reversal lands in the period of the void.
- **The General Ledger tab shows the `JE-` number**, not the `MJ-` number; the MJ page shows both. No
  link from a ledger line back to the journal page yet.
- **No recurring or template-saving entries, no attachments** (the document reference is text only).
- **Deactivate-vs-post is not serialisable.** *Closed by the technical correctness follow-up.* Account
  deactivation and the shared `postJournalEntry()` path now take the same account-row lock before checking
  or writing history; ledger posting also rejects inactive and cross-business accounts.

## Module 42: Period Close (Books Closed Through)

Closes Module 41's first known limitation. Nothing stopped a back-dated record landing in a month whose VAT
return or tax payment was already filed. The books now have a "closed through" day. Everything dated on or
before it is locked. The page is `/period-close`.

- **One date, not a table of periods.** `Business.booksClosedThrough` is a bare `"YYYY-MM-DD"` string (nullable,
  no default, so every existing business is open when the migration runs). A string and not a DateTime because
  it names a calendar day, not an instant: an Owner changing `Business.timezone` (Module 35) can't move it.
  There is no per-month status to keep in step with a calendar and no way to close April while March is open.
- **The ledger choke point covers four modules with one check.** `postJournalEntry()` refuses an entry whose
  explicit `entryDate` is on a closed day (`PeriodClosedError`, a subclass of `AccountingError`, so routes that
  already return 400 for accounting errors need no change). Manual journals, depreciation runs, tax payments and
  foreign exchange adjustments all pass an explicit date. An undated entry is dated now and is never checked, so
  a time zone change can never lock the business out of posting.
- **Records that reports read directly are guarded at the record.** The VAT return and the reports read sales,
  purchases and expenses from their own rows, not from the ledger. Voiding a March sale in April posts its
  reversal on an April date, which the ledger accepts, yet the March VAT return would change. So:
  - a sale or purchase dated in a closed period **can't be voided**;
  - an expense dated there can't be created, edited (or moved into it) or deleted;
  - a fixed asset can't be acquired, disposed of or deleted with a date in it;
  - a depreciation run for a closed month is refused **before** the loop, because each asset posts in its own
    transaction and a run that crossed the lock partway would leave some assets posted.
  Records that live only in the ledger (a manual journal, an FX adjustment, a tax payment) **can still be voided**:
  the reversal is dated today, so closed days are never touched. That is Module 41's void rule, unchanged.
- **Close and post serialise on the Business row.** `lockBookState()` updates the Business row (Postgres takes the
  row lock) and returns the row as of that lock. `postJournalEntry()` already did this to number the entry. A
  posting and a close in the same instant therefore run one after the other, and whichever commits first is what the
  other sees. The record guards call `lockBookState()` first inside their transaction for the same reason.
- **Permissions: none new, no re-seed.** `accounting.manage` (Owner and Accountant) closes. Reopening, meaning any
  move of the date backwards, also needs `business.settings.manage` (Owner) and a reason. A branch-locked member can
  view the state but not change it (403), like manual journals.
- **Only finished days can be closed.** The latest day is yesterday in the business zone. A request for the day
  already in force is refused. Presets on the page: end of last month, end of the last finished fiscal quarter and
  end of the last finished fiscal year (from `financialYearStartMonth`, the same helpers Corporate Tax uses).
- **Readiness warnings.** Before closing, the page lists draft payroll for months inside the period and bank
  reconciliations still in progress dated inside it. These are informational. Payroll is paid, and a reconciliation
  completed, on a date of their own, so the lock does not block them.
- **Audit trail.** Every change writes `period.closed` or `period.reopened` to `AuditLog` (entityType `PeriodClose`)
  with the old day, new day and reason. The page shows the last 30. No new table.
- **Journal form.** The date picker starts the day after the closed day and shows a warning. The server stays the
  authority.
- **API:** `GET /period-close` (add `?through=YYYY-MM-DD` for readiness), `POST /period-close` with
  `{ closedThrough: "YYYY-MM-DD" | null, reason? }`.
- **Deploy:** `npx prisma migrate dev --name books_closed_through` (one nullable column), then `npx prisma generate`.
  No re-seed.
- **Verification:** `npm run verify:period` **65 checks** (calendar helpers, closed-day boundary, zone-dependent day,
  messages, close and reopen planning, presets for January and July fiscal years, the ledger choke point and the
  record guard against a fake transaction, permissions, request schema). `verify:journal` 90/90, `verify:fx` 99/99,
  `verify:pnl` 24/24, `verify:quotations` 43/43, `verify:timezone` passes, `check:dates` 0 violations,
  `tsc --noEmit` **0 errors**, `next build` passes. Not run against a live Postgres. Manual test for the lock: close
  through yesterday, then send two simultaneous requests, one `POST /manual-journals` dated yesterday and one
  `POST /period-close`; the journal must either post before the close commits or be refused, never post after it.

### KNOWN LIMITATIONS

- **A return from a closed month needs the Owner.** Refunds in this app follow a void, and a sale in a closed period
  can't be voided. The Owner reopens the period, the void and refund happen, and the Owner closes again. Every step
  is audited. The proper fix is a credit note dated in the open period, which needs the VAT return to count it in the
  period of the credit note. That is the natural next module.
- **Not gated:** payroll runs, bank reconciliations and stock takes. Their ledger effects are dated now, so closed
  days are not touched, but a payroll run for a closed month still changes that month's PAYE figures.
- **Payments and refunds are dated now** and so are never blocked. A customer payment recorded today against a
  closed-period sale is correct and stays allowed.
- **A time zone change can move a boundary.** The closed day is a calendar day, so it does not move, but a record
  dated near midnight can fall on the other side of it after a zone change.
- **Reopen has no partial approval flow.** One Owner action with a reason. There is no second approver.
- **Deactivating an account, renaming one, or editing the chart is not gated** by the lock.
- **Not run against a live Postgres.** The row-lock ordering is reasoned from Postgres's read-committed behaviour and
  covered by the manual test above.

## Module 43: Sales Credit Notes

Closes Module 42's known limitation. A credit note reverses part of a sale – a return, a price adjustment, or
both – and is always dated today, so it never touches a closed period and never needs an Owner reopen. `Sale.total`
and `Sale.amountPaid` never change; only `Sale.balance` moves. The page is `/credit-notes`, reached from a sale's
own page.

- **Every sale item has a pool, and a credit draws it down.** `computePools()` (`src/lib/credit-note-calc.ts`) takes
  each `SaleItem`'s own quantity, net and VAT and subtracts what earlier credit notes on the same sale already took.
  A return takes its share of what is **left**, not of the original – returning 1 of 4 units takes a quarter of the
  remaining pool, and the last unit takes exactly the remainder, so a run of small credits ends on the sale's exact
  total with no rounding drift (`verify:credit-notes` checks this directly). A price adjustment instead names a net
  amount; VAT follows it in proportion to what is left.
- **The sale-level discount comes back in proportion.** `Sale.discount` is a flat lump that never reduces VAT (see
  the VAT design note in `vat.ts`), so crediting a line returns a matching share of it – crediting the whole sale
  returns exactly `Sale.total`. The credit that empties the sale takes whatever share of the discount is still
  unreturned, for the same no-drift reason as the pool.
- **The customer's own debt is reduced first.** A credit is applied to `Sale.balance` before anything else. Only the
  excess – money the customer had already paid – needs a decision: refunded in cash, or kept as `CUSTOMER_CREDIT`.
  A `CUSTOMER_CREDIT` settlement lands in the same pool `getCustomerCreditBalance()` already reads for Module 17's
  redemption (`src/lib/credits.ts`), so it's spent by the same mechanism a `Refund` with method `CREDIT_NOTE` is –
  no new spend path.
- **`voidSale()` refuses a sale that has credit notes.** A void restocks every unit and reverses all the revenue; a
  credit note has already done part of that. The correction path for a wrong credit note is a **new sale** – there
  is no edit and no void of a `CreditNote`. Reversing one is its own future module: it would have to take restocked
  units back out, un-apply a balance, and claw back customer credit that may already be spent.
- **The sale row is the lock.** `createCreditNote()` writes to the sale row first (a no-op `updatedAt` touch) before
  reading, so Postgres serialises it against another credit note on the same sale, a payment, a foreign settlement,
  or a void – same pattern Module 41/42 use for the Business row. `voidSale()` now takes the same lock before its own
  checks, closing a gap where a credit note and a void racing on a fully-paid sale (balance unchanged either way)
  could otherwise both win.
- **VAT return: credit notes count in the period they were ISSUED, not the period of the sale.** `getVatReturn()`
  now nets output VAT by the credit notes whose `issuedAt` falls in the range – the same instant the ledger entry is
  dated, so the return and the ledger always agree. `sales.grossOutputVat` keeps the pre-credit figure for
  transparency; `sales.outputVat` (consumed everywhere else – Tax Payments, the Tax Calendar) is the net figure.
  A March sale credited in April lowers April's output VAT and leaves March's filed return untouched.
- **Netted, at the credit note's own `issuedAt`:** the Sales report (`creditNotes`/`netSales` columns), the
  Salesperson report (credited against the salesperson of the **original** sale), Product Profitability
  (`quantityReturned`, revenue and – only for restocked lines – cost), the dashboard's revenue/cost and top-products
  figures, branch totals, and the AI sales-decline check. `src/lib/credit-note-queries.ts` holds the shared read
  helpers so none of these import the posting path in `credit-notes.ts`.
- **Cost reverses only when goods are restocked.** Each credit line has its own `restock` flag. A restocked line
  posts `Dr Inventory / Cr Cost of Goods Sold` for its cost and moves stock back to the sale's branch with an
  `InventoryMovement` of type `RETURN_IN`. A damaged return or a pure price adjustment credits the customer but
  leaves cost and stock untouched – the goods are gone.
- **Ledger: two journal entries, both dated now.** `postJournalEntryForCreditNote()` (`accounting-integrations.ts`)
  posts `Dr Sales Revenue (net) / Dr VAT Output Payable / Cr Accounts Receivable (applied to balance) / Cr
  Cash-or-Bank-or-Mobile-Money (if settled in cash) or Cr Customer Credits Payable (if kept as credit)`, then a
  second entry for restocked cost. A cash settlement also posts a `postCashTransactionForCreditNote()` cashbook row
  (`referenceType "CreditNote"`), added to the Cash Flow statement's operating outflow types alongside `Refund`,
  which – a genuine pre-existing gap – had been missing from Operating Activities entirely.
- **Cash flow fix, incidental to this module:** `financial-statements.ts`'s operating type list was missing
  `"Refund"`. Cash refunds (Module 32) were posting to the cashbook correctly but never reaching the Cash Flow
  statement. Both `"Refund"` and the new `"CreditNote"` are in the list now.
- **No new permission.** A credit note is issued (`refunds.manage`) and read (`refunds.view`) with the same
  authority as a refund – Owner and Manager issue, Accountant reads. No re-seed. A branch-locked member can only
  credit a sale made at their own branch.
- **Numbering.** `Business.creditNotePrefix` (default `"CN"`) and `Business.nextCreditNoteNumber`, incremented the
  same way every other document number in this app is (`Business` row update inside the transaction).
- **Foreign-currency sales.** A credit note on one credits the kwacha the sale booked, at the sale's own book rate –
  no new exchange difference. A cash refund is the kwacha amount; Module 40's settlement flow is untouched.
- **Client-side preview reuses the server's own math.** `credit-note-calc.ts` is pure (no database import), so the
  credit note form (`src/app/credit-notes/new/credit-note-form.tsx`) imports it directly and shows the exact figures
  the server will post before the operator submits – the same trick Module 3's receipt total preview uses, just with
  richer math underneath.
- **API:** `GET/POST /api/business/[businessId]/credit-notes`, `GET .../credit-notes/[creditNoteId]`,
  `GET .../credit-notes/[creditNoteId]/pdf`, `GET .../credit-notes/for-sale/[saleId]` (what the form needs: items,
  what's still creditable, and whether the sale is blocked – voided, wrong branch, or already fully credited).
- **Deploy:** `npx prisma migrate dev --name credit_notes` (two new tables, two new `Business` columns), then
  `npx prisma generate`. No re-seed.
- **Verification:** `npm run verify:credit-notes` **35 checks** (pool draw-down and the exact-remainder rule, price
  adjustments, the discount coming back in proportion, balance-first application and settlement planning, sale
  status after balance, the VAT roll-up, and every input-validation error). Pure math, no database – the sale-row
  lock ordering is reasoned the same way Module 42's Business-row lock is, with the same manual two-request test
  recommended (two simultaneous requests, one issuing a credit note and one voiding the same sale; exactly one must
  succeed). `verify:period` 65/65, `verify:journal` 90/90, `verify:fx` 99/99, `verify:pnl` 24/24,
  `verify:quotations` 43/43, `verify:timezone` passes, `tsc --noEmit` **0 errors**. Not run against a live Postgres.

### KNOWN LIMITATIONS

- **Sales side only.** There is no supplier debit note – a returned purchase still follows the void-then-refund path
  from Module 32, unchanged, and so still needs the period reopened if the purchase was dated in a closed month.
  A `SupplierDebitNote` mirroring this module's design is the natural next candidate. *(Closed by Module 44.)*
- **No edit and no void of a credit note.** The correction path is a new sale. See the design note above for why.
- **Dashboard charts that group by payment method or by day stay gross.** Only the figures this module explicitly
  lists above (revenue, cost, top products, the three reports, branch totals, VAT, the AI sales-decline check) are
  netted. A chart not in that list still shows the sale's original numbers.
- **A credit note cannot itself be paid out over time.** `settlement = CASH` posts and pays in the same instant; there
  is no "credit note awaiting a refund decision" queue the way a void's refund can sit pending.
- **Not run against a live Postgres.** As with Module 42, the row-lock ordering is reasoned from Postgres's
  read-committed behaviour, not exercised by an integration test.

## Module 44: Supplier Debit Notes

Closes Module 43's own known limitation. `SupplierDebitNote` is the purchase-side mirror of `CreditNote` – a
document reversing part of a purchase (goods sent back to the supplier, a price adjustment, or both), always dated
today so it never touches a closed period. `Purchase.total` and `Purchase.amountPaid` never change; only
`Purchase.balance` moves. The page is `/debit-notes`, reached from a purchase's own page.

- **Same pool-draw-down math as credit notes, minus the discount share.** `computePools()`
  (`src/lib/debit-note-calc.ts`) takes each `PurchaseItem`'s own quantity, net and VAT and subtracts what earlier
  debit notes on the same purchase already took, with the same "last unit takes exactly the remainder" no-drift rule
  (`verify:debit-notes` checks this directly). Purchase has no discount field, so there is no proportional-discount
  math here – `PurchaseItem.total` is already the whole line net, unlike `Sale.discount`'s flat-lump apportionment.
- **`stockOut` replaces `restock`, reversed in meaning.** `CreditNoteLine.restock = true` means goods came back onto
  our shelf. `SupplierDebitNoteLine.stockOut = true` means goods left our shelf, back to the supplier
  (`InventoryMovement` type `RETURN_OUT`, same branch the purchase was received at). Either way it only controls
  whether `Product.quantity`/`StockLevel` actually moves – the Inventory GL account falls by the line's `net`
  regardless, same as a credit note's Revenue account always falling regardless of `restock`.
- **One journal entry, not two – because Purchase itself only ever posts one.** Sale splits Revenue from
  Inventory/COGS into two independently-reversible entries (Module 32's own finding), so a credit note needs two
  entries to mirror that split. Purchase has only one asset account on the debit side (Inventory) and posts it in
  ONE combined entry with VAT Input and Accounts Payable – so `postJournalEntryForDebitNote()` is one entry too:
  `Cr Inventory (net) / Cr VAT Input Receivable (vat) / Dr Accounts Payable (applied to balance) / Dr
  Cash-or-Bank-or-Mobile-Money (if settled in cash) or Dr Supplier Credits Receivable (if kept as supplier credit)`.
- **What we still owe the supplier is reduced first.** A debit is applied to `Purchase.balance` before anything
  else. Only the excess – money we had already paid – needs a decision: collected in cash, or kept as
  `SUPPLIER_CREDIT`. Unlike `CreditNote`'s `hasCustomer` check (a walk-in sale may have no customer to hold credit
  for), `Purchase.supplierId` is always set, so `SUPPLIER_CREDIT` is always available – `planSettlement()` has no
  equivalent "nobody to credit" branch. A `SUPPLIER_CREDIT` settlement lands in the same pool
  `getSupplierCreditBalance()` already reads for Module 17's redemption, reusing the existing `CREDIT_NOTE`
  `CreditSourceType` rather than adding a new one – same choice Module 43 made folding `CUSTOMER_CREDIT` into the
  customer side of that same pool.
- **`voidPurchase()` refuses a purchase that has debit notes**, exactly mirroring `voidSale()`/`CreditNote`. It now
  takes the purchase row lock first (a no-op `updatedAt` touch), the same fix Module 43 made to `voidSale()`, so a
  debit note and a void racing on the same purchase serialise correctly instead of both potentially winning.
- **The purchase row is the lock**, same pattern: `createDebitNote()` writes to the purchase row first before
  reading, so Postgres serialises it against another debit note, a payment, a foreign settlement, or a void.
- **VAT return: debit notes count in the period they were ISSUED, not the period of the purchase.** `getVatReturn()`
  now nets input VAT by the debit notes whose `issuedAt` falls in the range. `purchases.grossInputVat` keeps the
  pre-debit figure for transparency; `purchases.inputVat` (consumed everywhere else – Tax Payments) is the net
  figure, mirroring exactly what Module 43 did to `sales.outputVat`.
- **The Supplier Debt report needed zero code changes.** `getSupplierDebtList()`/`getTotalSupplierDebt()` already
  read `Purchase.balance` live, and a debit note reduces that balance directly – same reasoning that already made
  Module 43 a no-op for the customer-receivables report on the sale side.
- **Cash flow fix, incidental to this module.** `financial-statements.ts`'s operating type list was missing
  `"SupplierDebitNote"` – the exact same bug class Module 43 found and fixed for `"Refund"`: the WHERE clause
  already matches any RECEIPT/PAYMENT row regardless of `referenceType`, but the `operating` filter right after it
  re-checks `referenceType` against this list and silently drops anything left out. A cash-settled debit note posts
  a plain RECEIPT, so without this fix it would never have reached the Cash Flow statement.
- **No new permission.** A debit note is issued (`refunds.manage`) and read (`refunds.view`) with the same
  authority as a refund and a credit note. No re-seed. A branch-locked member can only debit a purchase received at
  their own branch.
- **Numbering.** `Business.debitNotePrefix` (default `"DBN"`) and `Business.nextDebitNoteNumber`, incremented the
  same way every other document number in this app is.
- **Foreign-currency purchases.** A debit note on one debits the kwacha the purchase booked, at the purchase's own
  book rate – no new exchange difference, same treatment Module 43 gives foreign-currency sales.
- **Client-side preview reuses the server's own math**, same trick as `credit-note-calc.ts`:
  `src/app/debit-notes/new/debit-note-form.tsx` imports `debit-note-calc.ts` directly.
- **API:** `GET/POST /api/business/[businessId]/debit-notes`, `GET .../debit-notes/[debitNoteId]`,
  `GET .../debit-notes/[debitNoteId]/pdf`, `GET .../debit-notes/for-purchase/[purchaseId]`.
- **Deploy:** `npx prisma migrate dev --name supplier_debit_notes` (two new tables, two new `Business` columns), then
  `npx prisma generate`. No re-seed.
- **Verification:** `npm run verify:debit-notes` **31 checks** (pool draw-down and the exact-remainder rule, price
  adjustments, balance-first application and settlement planning, purchase status after balance, the VAT roll-up,
  and every input-validation error). Pure math, no database – the purchase-row lock ordering is reasoned the same
  way Module 43's sale-row lock is, with the same manual two-request test recommended. All eight prior verify
  scripts re-run clean (`verify:credit-notes` 35/35, `verify:period` 65/65, `verify:journal` 90/90, `verify:fx`
  99/99, `verify:pnl` 24/24, `verify:quotations` 43/43, `verify:timezone` passes). `tsc --noEmit` **0 errors** and
  `next build` **passes**, both against a real generated Prisma client – the first module verified this way since
  Module 39.

### KNOWN LIMITATIONS

- **No edit and no void of a debit note.** The correction path is a new purchase from the supplier – same
  reasoning as `CreditNote`.
- **No dashboard/branch/AI netting.** Unlike credit notes, purchases were never surfaced in the dashboard, branch
  totals, or AI assistant to begin with (checked directly – there is no "Total Purchases" figure anywhere in
  `dashboard.ts`/`branches.ts`/`ai-analysis.ts`), so there was nothing to net there. The VAT return and the
  Supplier Debt report are the only places a debit note needed to change anything.
- **A debit note cannot itself be paid out over time.** `settlement = CASH` posts and receives in the same instant;
  there is no "debit note awaiting a cash decision" queue.
- **Not run against a live Postgres.** Same as every row-lock-dependent module since Module 41/42/43.

## Module 45: VAT Partial Exemption (Input VAT Apportionment)

Closes the KNOWN LIMITATION `src/lib/vat.ts` has documented since Module 18: input VAT accumulated in
`VAT_INPUT_RECEIVABLE` in full regardless of a business's exempt sales, when real MRA rules generally restrict how
much a business making exempt supplies can reclaim. The VAT Return now apportions a period's input VAT by that
period's own taxable-vs-exempt sales mix, and Tax Payments remits only the reclaimable share.

- **Simplified residual method, stated plainly.** This app has no per-purchase attribution to a specific sale (no
  "this input fed an exempt supply" link), so real partial-exemption's direct-attribution step isn't possible –
  the whole period's input VAT is treated as residual and apportioned by ONE ratio: taxable sales (STANDARD +
  ZERO_RATED, net of credit notes) ÷ total sales for that same period. Zero-rated counts as taxable – only EXEMPT
  restricts recovery. Pure math in `src/lib/vat-apportionment.ts` (`apportionInputVat()`), documented there as a
  working simplification, not a transcription of MRA's actual partial-exemption rules.
- **De minimis relief.** A period where exempt sales are at or below `TaxConfiguration.vatDeMinimisPercent` of
  total sales keeps full recovery – an incidental exempt sale doesn't cost an otherwise-fully-taxable business its
  input VAT. Defaults to 0% (no relief) until an Owner/Accountant sets a real threshold in Tax Settings. An
  explicit `vatPartialExemptionEnabled` toggle (default ON – the safer default, since over-claiming is the actual
  compliance risk) lets an Accountant who has determined this method doesn't fit their business turn it off
  entirely, falling back to the old full-recovery behaviour.
- **Per period, not cumulative.** Each VAT Return date range is apportioned on its own sales mix, like everything
  else `getVatReturn()` computes for that range – a business whose mix varies month to month will see some periods
  apportioned and others not.
- **`purchases.inputVat` keeps its existing meaning** – the full ledger-posted figure (net of debit notes only),
  unchanged from Module 44. The new `partialExemption` object sits alongside it with `recoverableInputVat` /
  `irrecoverableInputVat` / `apportioned` / `exemptRatioPercent` / `recoveryRatioPercent`. `netPayable` is now
  `outputVat − recoverableInputVat`, not the gross figure – this is the actual change in what's owed to the MRA.
- **Tax Payments clears only the reclaimable share.** `getTaxPaymentPreview()`'s `vat.inputVat` is now
  `partialExemption.recoverableInputVat`; the VAT remittance's `vatInputCleared` (and therefore the GL credit to
  `VAT_INPUT_RECEIVABLE`) only ever clears that amount. The irrecoverable share is deliberately left sitting in
  `VAT_INPUT_RECEIVABLE` – remitting tax and writing off irrecoverable VAT are different events.
- **The irrecoverable share is written off by manual journal entry**, the same "period-end figure, booked by
  hand" pattern Modules 20/33/41 established for income tax. New EXPENSE account `IRRECOVERABLE_INPUT_VAT` (code
  5185) – an ordinary operating expense, unlike `INCOME_TAX_EXPENSE`, since irrecoverable input VAT genuinely is a
  cost of doing business, not a tax on profit, so it needed no special `pnl-layout.ts` placement. New manual
  journal template `WRITE_OFF_IRRECOVERABLE_VAT` (`Dr IRRECOVERABLE_INPUT_VAT / Cr VAT_INPUT_RECEIVABLE`), added to
  `TEMPLATE_ACCOUNT_KEYS` so `ensureManualJournalAccounts()` lazily backfills the new account for businesses that
  registered before this module.
- **Schema:** `TaxConfiguration.vatPartialExemptionEnabled` (`Boolean @default(true)`) and
  `vatDeMinimisPercent` (`Decimal @default(0)`) – real column defaults, like `corporateTaxRate`, so no lazy
  backfill branch is needed in `getOrCreateTaxConfiguration()`.
- **Tax Settings** gained the toggle and threshold under the VAT section, bundled into the same one-review save as
  every other rate (`taxConfigurationSchema`). **VAT Return** shows the apportionment breakdown (exempt ratio,
  recovery ratio, irrecoverable amount) and an amber banner when a period is actually apportioned. **Tax Payment
  preview** notes the irrecoverable amount when relevant.
- **Verification:** `npm run verify:vat-apportionment` **10 checks** (pure, no database) – no exempt sales, a mixed
  ratio, the de minimis boundary (inclusive) and just past it, the disabled escape hatch, zero sales (no
  division-by-zero), an all-exempt business (0% recovery), rounding-drift (`recoverable + irrecoverable ==
  gross`), and a negative gross input VAT period (debit-note-dominated) still apportioning proportionally. All
  nine prior verify scripts re-run clean (`verify:debit-notes` 31/31, `verify:credit-notes` 35/35, `verify:period`
  65/65, `verify:journal` 94/94 – up from 90/90, the four new checks are the new template's own line-by-line
  `TEMPLATE_ACCOUNT_KEYS` coverage checks, not a regression – `verify:fx` 99/99, `verify:pnl` 24/24,
  `verify:quotations` 43/43, `verify:timezone` passes). `tsc --noEmit` **0 errors** and `next build` **passes**,
  both against a real generated Prisma client. `prisma validate` could not be run this session – the sandbox's
  network policy blocked the schema-engine binary fetch even with the `PRISMA_SCHEMA_ENGINE_BINARY` env-var trick
  that unblocks `prisma generate` (that trick only lets `generate` skip needing a *working* engine; `validate`
  actually needs to run one). Run it locally as an extra check alongside the required migration.
- **Deploy:** `npx prisma migrate dev --name vat_partial_exemption` (two new `TaxConfiguration` columns, one new
  system account), then `npx prisma generate`. No re-seed – both new columns carry real defaults and
  `IRRECOVERABLE_INPUT_VAT` is lazily backfilled like every account added after Module 1.

### KNOWN LIMITATIONS

- **Sales-mix apportionment, not true direct attribution.** A business that could clearly attribute specific
  purchases to specific exempt or taxable activity (e.g. a dedicated exempt-only sideline with its own suppliers)
  would get a more accurate answer from direct attribution than this residual-only method gives – flagged in
  `vat-apportionment.ts` rather than silently assumed.
- **The de minimis check is a single configurable percentage**, not a transcription of any specific real-world
  de minimis test (which often combines a percentage AND a fixed value threshold) – same "working estimate, not
  tax advice" disclaimer every rate in this app already carries.
- **The irrecoverable write-off isn't automatic.** Nothing prompts an Accountant to run the manual journal
  template after a period is apportioned – it's discoverable (the VAT Return banner names the amount, the
  template is one click away) but not enforced or reminded, the same "an Accountant does this by hand" gap
  Modules 20/33/41 already accepted for income tax.
- **Not run against a live Postgres / `prisma validate`.** See the verification note above.

## Module 46: VAT Refund Receipts

Closes the other half of the KNOWN LIMITATION `src/lib/tax-payments.ts` has documented since Module 33: a
net-REFUNDABLE VAT period (reclaimable input VAT exceeds output VAT) previously couldn't be recorded at all – its
input VAT just sat as a receivable forever. Tax Payments can now record the MRA actually paying that refund out.

- **Same form, opposite direction.** `getTaxPaymentPreview()` now returns `isRefund` alongside the existing
  `suggestedPrincipal` (which is now always a positive magnitude – the sign lives in `isRefund`, not the number).
  `createTaxPayment()` branches on it: a refund clears VAT_OUTPUT_PAYABLE and VAT_INPUT_RECEIVABLE exactly like a
  remittance does, but the cash leg is a RECEIPT into the chosen account instead of a PAYMENT out of it, and no
  penalty/interest is allowed (there's nothing to charge a penalty on when the MRA owes money).
- **New pure `src/lib/vat-payment-direction.ts::resolveVatDirection()`** turns one period's `netPayable` into
  `{ isRefund, magnitude }`. Split into its own file (no imports) the same way `vat-apportionment.ts` is split from
  `vat.ts` – `tax-payments.ts` pulls in Prisma at module scope, which a plain-Node verify script can't load, so the
  one function worth unit-testing lives somewhere that import doesn't reach. Both the preview and the create path
  call it, so the form's suggestion and what actually gets posted can never disagree about direction.
- **Journal posting (`postJournalEntryForTaxPayment`), Module 46 addition:** `Dr VAT_OUTPUT_PAYABLE` (if any) /
  `Cr VAT_INPUT_RECEIVABLE` / `Dr <cash>` for the difference – the mirror image of the remittance entry, still one
  balanced entry, still fully clearing both VAT accounts for the period. `postCashTransactionForTaxPayment` gained
  an `isRefund` flag that flips the `CashTransaction` from `PAYMENT` (outflow) to `RECEIPT` (inflow); the existing
  Cash Flow Statement `operatingTypeList` already includes `"TaxPayment"` and buckets by the transaction's signed
  `amount`, so a refund shows up correctly as an operating inflow with no change needed there.
- **No new balance check for a refund** – money is coming IN, so `createTaxPayment()` skips the "does the account
  have enough" guard for `isRefund` (it still applies to an ordinary remittance).
- **UI:** the tax-payment form relabels itself when the previewed period is refundable – "Received into" instead
  of "Paid from", the penalty field hidden, "Record Refund" instead of "Record Payment" – driven entirely by the
  same preview response, no separate route or page. The list page adds a "VAT refunds received" summary card and a
  blue "Refund" badge per row; "Tax paid" no longer double-counts refund principal. The detail page swaps its
  labels the same way ("Refund received", "Total received").
- **Still one row per `(taxType, periodKey)`** – a period is either paid or refunded, never both, so the existing
  `activePeriodKey` unique-index guard from Module 33 covers this without change. Voiding a refund reverses through
  the same generic `reverseCashTransactionsForReference`/`reverseJournalEntriesForReference` path as everything
  else – no Module 46-specific reversal code was needed.
- **Verification:** `npm run verify:vat-refunds` **12 checks** (pure, no database) – an ordinary net-payable period,
  a net-refundable period, exactly zero, the 1-cent rounding tolerance on both sides of zero, real (tiny) amounts
  just outside that tolerance on both sides, magnitude always positive regardless of direction, and 2-decimal
  rounding. All ten prior verify scripts re-run clean (`verify:vat-apportionment` 10/10, `verify:debit-notes`
  31/31, `verify:credit-notes` 35/35, `verify:period` 65/65, `verify:journal` 94/94, `verify:fx` 99/99,
  `verify:pnl` 24/24, `verify:quotations` 43/43, `verify:timezone` passes). `tsc --noEmit` **0 errors** and
  `next build` **passes**, both against a real generated Prisma client (offline `prisma generate` trick). `prisma
  validate` again could not run in-sandbox – same network-blocked schema-engine fetch noted in Module 45; the
  `generate` trick only works because `generate` doesn't need a *working* engine, `validate` does.
- **Deploy:** `npx prisma migrate dev --name tax_payment_refunds` (one new `TaxPayment.isRefund` column, `Boolean
  @default(false)` – a real default, no lazy backfill needed). `npx prisma generate`. No re-seed.

### KNOWN LIMITATIONS

- **Carry-forward netting still isn't modeled.** This module only covers the MRA actually paying a refund out in
  cash. The more common Malawian practice – electing to CARRY a refundable period's excess input VAT forward
  against a future period's liability instead of claiming a cash refund – still isn't recordable: since each VAT
  Return is computed fresh from that period's own sales/purchases (`getVatReturn(businessId, period.start, to)`),
  a later period's remittance never automatically nets an earlier uncleared credit against it. True carry-forward
  would need the VAT Return to track a running receivable balance across periods rather than a per-period
  snapshot – documented in `tax-payments.ts` as a bigger change left for a future module, not silently assumed
  away.
- **No partial refunds.** Like a remittance, a refund is always for the period's full computed amount – the MRA
  paying out less than the full refundable amount (a partial refund, or one reduced by an offsetting assessment)
  isn't representable; it would have to be recorded as the full refund plus a manual journal adjustment for the
  difference.
- **Not run against a live Postgres / `prisma validate`.** See the verification note above.

## Module 47: VAT Carry-Forward Credit Netting

Closes the KNOWN LIMITATION `src/lib/tax-payments.ts` has documented since Module 46: a VAT period that ended
net-refundable and was never recorded (the business elected to carry the credit forward – the more common MRA
practice in Malawi than claiming a cash refund) previously sat unaddressed forever, because each period's net
payable was computed fresh from only that period's own sales and purchases. A later remittance never automatically
netted an earlier uncleared credit against it. It now does.

- **`getVatCarryForward()` (new, in `src/lib/tax-payments.ts`)** walks every monthly VAT period between the most
  recent RECORDED VAT payment (remittance or refund – whichever is newer) and the period now being recorded, checks
  each for an existing `TaxPayment` row, and for whichever ones still have none, sums their own `getVatReturn()`
  `netPayable` (same sign convention: positive = still owed to the MRA, negative = a credit). For a business with no
  VAT payment ever recorded, the walk starts from its earliest Sale or Purchase instead of scanning forever.
- **`getTaxPaymentPreview()` folds the sum in before deciding direction.** `adjustedNetPayable = netPayable +
  carryForward.amount` is what `resolveVatDirection()` (Module 46) actually receives – so an old unaddressed credit
  can reduce, or even flip, what would otherwise have been a remittance, and an old unaddressed payable adds to it.
  The period's own `netPayable`/`outputVat`/`inputVat` keep their existing meaning for the breakdown; `carryForward`
  and `adjustedNetPayable` sit alongside them, `carryForward` only populated when there's actually something to
  fold in.
- **The GL entry genuinely clears the carried amount, not just this period's own figure.** `createTaxPayment()`
  widens `vatOutputCleared`/`vatInputCleared` by the carry-forward amount (added to whichever side it belongs on),
  so `postJournalEntryForTaxPayment`'s existing "output cleared minus input cleared must equal principal" invariant
  (Module 46) still holds arithmetically – this is real netting posted to `VAT_OUTPUT_PAYABLE`/
  `VAT_INPUT_RECEIVABLE`, not a display-only adjustment layered on top.
- **Self-bounding going forward.** Every payment recorded from this module on clears everything up to its own
  period end – its own figure AND any carry-forward – so it becomes the new "everything before this is settled"
  boundary for the next payment's walk. The walk only ever stays long for a business with a genuinely long
  unrecorded gap.
- **Capped at `MAX_CARRY_FORWARD_MONTHS` (36)**, in the new pure `src/lib/vat-carry-forward.ts`. A gap longer than
  that keeps only the most recent 36 months and sets `truncated: true` on the result rather than silently dropping
  older months or scanning a business's entire lifetime on every preview – flagged to the Accountant in the form,
  not hidden.
- **New pure `src/lib/vat-carry-forward.ts`** (no imports – same reason `vat-payment-direction.ts` is import-free:
  `tax-payments.ts` pulls in Prisma at module scope, which the plain-Node verify script can't load): `"YYYY-MM"`
  month-key arithmetic (`nextMonthKey`, `enumerateMonthKeysBetween` – fixed-width zero-padded keys sort
  lexicographically the same as chronologically, so it's plain string comparison, no Date math) plus
  `sumCarryForward()`.
- **Schema:** `TaxPayment.carryForwardApplied` (`Decimal?`) and `carryForwardPeriods` (`String?`, e.g. `"2026-01"`
  or `"2026-01 to 2026-03"`) – snapshot the combined effect at recording time (the individual periods that
  contributed aren't separately recorded anywhere else, so this string is the only record of which months were
  involved). Both nullable, no backfill needed.
- **UI:** the tax-payment form shows a carry-forward line (amount, direction, which periods, and a note if
  truncated) alongside the existing period breakdown, and a "combined net payable/refundable" total that's what's
  actually being recorded. The Module 46 refund guidance ("leave it on the books") was updated – carrying a credit
  forward now genuinely nets automatically against whatever VAT period gets recorded next, rather than sitting
  inert. The payment detail page shows "Carried forward (<periods>)" when a recorded payment included one.
- **Verification:** `npm run verify:vat-carry-forward` **21 checks** (pure, no database) – month-key rollover
  (ordinary, December→January), range enumeration (empty, single month, a year boundary, exclusive of `to`/
  inclusive of `from`, a 50-month gap enumerating in full since truncation is the caller's job not this function's),
  and summation (empty, single payable, single refundable, mixed periods netting to either a payable or a credit,
  float-drift rounding, exact offset to zero). All ten prior verify scripts re-run clean (`verify:vat-refunds`
  12/12, `verify:vat-apportionment` 10/10, `verify:debit-notes` 31/31, `verify:credit-notes` 35/35, `verify:period`
  65/65, `verify:journal` 94/94, `verify:fx` 99/99, `verify:pnl` 24/24, `verify:quotations` 43/43, `verify:timezone`
  passes) – 341/341 checks total across all eleven scripts. `tsc --noEmit` **0 errors**, `next build` **passes**,
  both against a real generated Prisma client (offline `prisma generate` trick). **`prisma validate` ran clean this
  session** – unlike Modules 45/46, the sandbox's network policy didn't block the schema-engine fetch this time.
- **Deploy:** `npx prisma migrate dev --name vat_carry_forward` (two new nullable `TaxPayment` columns, no defaults
  needed since both are nullable). `npx prisma generate`. No re-seed.

### KNOWN LIMITATIONS

- **Doesn't reach before a business's most recent recorded VAT payment, beyond the cap.** The walk starts from the
  most recent RECORDED VAT payment (or, for a business with none, its earliest sale/purchase, capped at 36 months
  back). A gap that predates a business's very first Module-47-era payment and exceeds the cap isn't picked up
  retroactively – it would need catching up by hand (e.g. recording a VAT payment directly for one of those old
  periods). Flagged via `truncated` on the preview, not silently dropped.
- **Assumes the standard MRA VAT period is monthly**, matching every other VAT period in this app – a business on
  a different filing cadence isn't modeled (same assumption Module 18 already makes throughout).
- **No way to explicitly write off a stale carry-forward** the business has decided it will never recover (e.g. an
  MRA dispute) – it stays in the walk, growing the amount folded into every future payment, until either recorded
  directly or bypassed by the 36-month cap.
- **Not run against a live Postgres.** `prisma validate` passed this session; migration and `db seed` (not needed
  here) still run locally as always.

## Module 48: Bank Reconciliation Reopening

Closes the KNOWN LIMITATION Module 22 has documented on `src/lib/bank-reconciliation.ts` since it was written: a
`COMPLETED` reconciliation could never be reopened, so a mistake found afterwards – a line matched to the wrong
transaction, a bank-fee adjustment posted twice, a line ignored that shouldn't have been – had no way back into the
reconciliation itself and could only be patched around with a disconnected manual journal.

- **Same close/reopen permission split Period Close (Module 42) already established.** Completing a reconciliation
  stays an ordinary `bankrecon.manage` act (Owner + Accountant). Reopening a `COMPLETED` one also needs
  `business.settings.manage` (Owner only) – undoing a signed-off statement match is a bigger deal than making one.
  No new permission, so no re-seed; the API route resolves both checks and passes the result into the library
  function as a plain `canReopen` boolean, the same division of labour `requireApiContext`/`hasPermission` already
  follow everywhere else.
- **A reason is required, never a silent reopen** – validated server-side (`reopenBankReconciliationSchema`,
  trimmed, 1–500 chars) and logged to `AuditLog` (`bankrecon.reopen`, with the reason and the previous
  `completedAt` in its metadata).
- **Schema: three new nullable columns on `BankReconciliation`** – `reopenedAt`, `reopenedById` (plain actor id,
  not a relation, same choice `InAppNotification.readById` already makes), `reopenReason`. Deliberately NOT a
  history table: these hold only the most recent reopen, the same "one field, not a log" choice
  `Business.booksClosedThrough` makes – the full history of every reopen already lives in `AuditLog`, queryable by
  `entityId`. `completedAt`/`completedById` are deliberately left untouched by a reopen (not cleared) so "was this
  ever finished, and when" survives until the reconciliation is completed again and they're naturally overwritten.
- **Reopening doesn't restart anything – it resumes it.** `bookBalanceAtStart` stays exactly as it was snapshotted
  when the reconciliation was first opened. Every existing per-line action (match/unmatch, post/unpost an
  adjustment, ignore/unignore, add/delete a line) works completely unchanged once reopened, because they all gate
  on `status === IN_PROGRESS`, which a reopen genuinely restores – including `unpostBankStatementLineAdjustment`,
  so a `POSTED` line's real Cashbook + GL entries can now actually be undone after the fact, not just a `MATCHED`
  line re-matched.
- **Guards the one real hazard: a newer reconciliation already in progress on the same account.** If the business
  completed March's reconciliation and has already opened April's (now `IN_PROGRESS`), reopening March is refused
  – `openBankReconciliation`'s own "only one `IN_PROGRESS` reconciliation per account" invariant would otherwise be
  silently broken by having two at once. The error points at finishing or deleting the newer one first.
- **No interaction needed with Period Close (Module 42).** A reconciliation's own adjustments always post dated
  "now" (never a past date the operator picked), so they were never blocked by a closed period and reopening one
  doesn't need to check `booksClosedThrough` either – closed-period protection in this app is about back-dated
  entries, and nothing here is back-dated.
- **UI**: the reconciliation detail page shows a "Reopen this reconciliation" panel (reason input + button) to
  Owners once a reconciliation is `COMPLETED`, and an amber banner naming the reopen date and reason once it has
  been. The reconciliation list's "In Progress" section now labels a reopened one "Reopened" instead of "In
  progress", so an Accountant can tell at a glance which entries in that section are a fresh reconciliation versus
  one being corrected.
- **Verification**: no new pure-logic module – this is a straightforward state-transition guarded by two boolean
  checks (permission, non-empty reason) and one query (no conflicting `IN_PROGRESS` reconciliation), not the kind
  of standalone calculation this app's `verify:*` scripts exist for. `tsc --noEmit` and `next build` are the gate,
  same as every schema-only/plumbing module before it that didn't introduce new pure math (e.g. Module 29, 36).
- **Deploy:** `npx prisma migrate dev --name bank_reconciliation_reopen` (three new nullable `BankReconciliation`
  columns). `npx prisma generate`. No re-seed.

### KNOWN LIMITATIONS

- **KNOWN LIMITATION – CLOSED BY MODULE 50**: no limit on how many times a reconciliation could be reopened, and
  no in-app view of that history, even though `AuditLog` had it – see Module 50 below.
- **Reopening doesn't itself flag which specific lines might need re-examining** – the operator has to know what
  they're going back in to fix; the reason field is free text, not tied to a specific line.

## Module 49: Stock Take Reopening

Closes the KNOWN LIMITATION Module 48 flagged as the natural next candidate once Bank Reconciliation got this
treatment: `src/lib/stock-take.ts` had documented, since Module 23, that a `COMPLETED` stock take could never be
reopened, so a mistyped count or a wrongly-posted adjustment found afterwards had no way back into the stock take
itself and could only be patched around with a disconnected manual journal.

- **Mirrors `reopenBankReconciliation()` (Module 48) field for field, check for check** – `reopenStockTake()` in
  `src/lib/stock-take.ts`. Same close/reopen permission split: completing stays an ordinary `stocktake.manage` act
  (Owner + Accountant); reopening a `COMPLETED` one also needs `business.settings.manage` (Owner only). No new
  permission, so no re-seed; the API route resolves both checks and passes the result into the library function as
  a plain `canReopen` boolean.
- **A reason is required, never a silent reopen** – validated server-side (`reopenStockTakeSchema`, trimmed, 1–500
  chars) and logged to `AuditLog` (`stocktake.reopen`, with the reason and the previous `completedAt` in its
  metadata).
- **Schema: three new nullable columns on `StockTake`** – `reopenedAt`, `reopenedById` (plain actor id, not a
  relation, same choice `BankReconciliation.reopenedById` makes), `reopenReason`. Deliberately NOT a history table,
  same "one field, not a log" reasoning as Module 48 – the full history lives in `AuditLog`, queryable by
  `entityId`. `completedAt`/`completedById` are deliberately left untouched by a reopen so "was this ever finished,
  and when" survives until the stock take is completed again.
- **Reopening doesn't restart anything – it resumes it.** Every line keeps whatever status it already reached
  (`COUNTED`/`POSTED`/`IGNORED`); nothing is reset to `PENDING`. Every existing per-line action (count/uncount,
  post/unpost an adjustment, ignore/unignore) works completely unchanged once reopened, because they all gate on
  `status === IN_PROGRESS`, which a reopen genuinely restores – including `unpostStockTakeLineAdjustment`, so a
  `POSTED` line's real inventory + GL effect can now actually be undone after the fact.
- **Guards the one real hazard: a newer stock take already in progress on the same scope.** If the business
  completed a whole-catalog count and has since opened a fresh one for the same (category, branch) scope, reopening
  the older one is refused – `openStockTake`'s own "only one `IN_PROGRESS` stock take per scope" invariant would
  otherwise be silently broken. The error points at finishing or deleting the newer one first.
- **No interaction needed with Period Close (Module 42)**, for the same reason Module 48 documented for Bank
  Reconciliation: stock take adjustments always post dated "now", never a past date, so they were never blocked by
  `booksClosedThrough` and reopening one doesn't need to check it either.
- **UI**: the stock take detail page shows a "Reopen this stock take" panel (reason input + button) to Owners once
  a stock take is `COMPLETED`, and an amber banner naming the reopen date and reason once it has been. The stock
  take list's "In Progress" section now labels a reopened one "Reopened" instead of "In progress".
- **Verification**: no new pure-logic module, same reasoning as Module 48 – this is a state-transition change (two
  boolean checks + one conflict query), not new pure math. `tsc --noEmit` and `next build` are the gate. All 11
  prior verify scripts re-run clean (341/341 – unchanged, since this module adds no new pure calculation).
- **Deploy:** `npx prisma migrate dev --name stock_take_reopen` (three new nullable `StockTake` columns).
  `npx prisma generate`. No re-seed.

### KNOWN LIMITATIONS

- **KNOWN LIMITATION – CLOSED BY MODULE 50**: both reopenable resources (Bank Reconciliation, Stock Take) shared
  the same gap – no limit on reopen count, no in-app history view – see Module 50 below.
- **A reopen's reason is still free text, not tied to a specific line** – unrelated cut, still open on both
  resources.
- **Product.reorderLevel/low-stock status is still business-wide only** – unrelated to this module, still open
  since Module 28.

## Module 50: Reopen History & Cap

Closes the KNOWN LIMITATION Module 48 and Module 49 each documented, word for word, the moment their own reopen
path shipped: nothing capped how many times a `COMPLETED` reconciliation or stock take could be flipped back to
`IN_PROGRESS`, and nothing in the app surfaced that history to an Owner even though every reopen was already being
written to `AuditLog`. One shared fix for both resources, since they already mirror each other field for field.

- **New `src/lib/reopen-audit.ts`** – the one place this logic lives for both resources. `countReopens()` and
  `getReopenHistory()` both query `AuditLog` directly by `(businessId, entityType, entityId, action)`; nothing new
  is written to either model. This is the same "computed, never stored" principle the app already applies to
  balances and accumulated depreciation – `AuditLog` is already the single source of truth for every reopen event,
  so counting against it live can't drift the way a second, cached counter could. **No schema change, no
  migration, on either `BankReconciliation` or `StockTake`.**
- **`MAX_REOPENS = 5`**, in its own `src/lib/reopen-constants.ts` so the client-side workspace components can
  import just the number without pulling in `reopen-audit.ts`'s `prisma` import. `reopenBankReconciliation()` and
  `reopenStockTake()` both count prior reopens for the record before allowing a new one, and refuse the 6th with a
  message pointing at Manual Journal Entries (Module 41) as the honest correction path once a record has genuinely
  been reopened that many times.
- **`getBankReconciliation()` and `getStockTake()`** (the same functions both detail pages already call) now also
  return `reopenCount`, `reopensRemaining`, and `history` – a newest-first timeline of every `complete`/`reopen`
  event for that record, each with who did it, when, and the reason (for reopens). No new API route was needed:
  both existing `GET` detail routes already pass their library function's return value straight through.
- **UI**: both detail pages now show the running "N of 5 reopens used" count in the existing reopen banner, the
  reopen form itself is replaced with a plain message once the cap is reached, and a collapsible "Reopen history"
  panel lists the full timeline. Nothing changed on either list page.
- **Verification**: no new pure-logic module – like Modules 48/49, this is a query plus a boundary check, not the
  kind of standalone calculation `verify:*` exists for. `tsc --noEmit` (0 errors), `prisma validate` (valid), and
  `next build` all passed against a real generated Prisma client this session. All 11 prior verify scripts +
  `check:dates` re-run clean.
- **Deploy:** no migration and no `prisma generate` step is strictly required for the schema (unchanged), but
  `npx prisma generate` is harmless to re-run. No re-seed.

### KNOWN LIMITATIONS

- **KNOWN LIMITATION, closed by Module 51**: the cap was a shared constant (5), not configurable per business – a
  business with a genuinely unusual need to reopen more than five times had no in-app way to raise it.
- **The reopen history panel isn't paginated** – it shows the most recent 20 `complete`/`reopen` events, which is
  more than five reopens' worth of round trips would ever produce, so this hasn't been a real constraint yet.
- **A reopen's reason is still free text, not tied to a specific line** – carried forward from Modules 48/49,
  still open.
- **Product.reorderLevel/low-stock status is still business-wide only** – unrelated to this module, still open
  since Module 28.

## Module 51: Configurable Reopen Cap

Closes the KNOWN LIMITATION Module 50 documented the moment it shipped: `MAX_REOPENS = 5` was a shared code
constant, so a business with a genuinely unusual need to reopen a bank reconciliation or stock take more than five
times had no in-app way to raise it – only a direct database edit or a code change (and a redeploy) would do it.

- **`Business.maxReopens`** – a new `Int @default(5)` column, same "real Postgres default, no lazy-backfill branch
  needed" reasoning as `corporateTaxRate` (Module 20): every pre-existing business becomes 5 the moment the
  migration runs. Replaces the `MAX_REOPENS` constant everywhere it was read.
- **`src/lib/reopen-constants.ts`** now holds `DEFAULT_MAX_REOPENS` (the column default, kept as one named place a
  future reader can find it, since a Prisma `@default` value isn't otherwise discoverable from application code) and
  `MIN_MAX_REOPENS`/`MAX_MAX_REOPENS` (1–20) – the bounds an Owner can move the setting within. All three are
  shared by the settings-form input and `businessMaxReopensSchema` so they can't drift out of sync with each other.
- **`reopenCapMessage()`** (`src/lib/reopen-audit.ts`) now takes the resolved `maxReopens` as a parameter instead of
  reading a constant, so a caller can't accidentally check a record against the old shared default. `getBankReconciliation()`/
  `getStockTake()` and `reopenBankReconciliation()`/`reopenStockTake()` each fetch the business's current
  `maxReopens` alongside their existing `countReopens()`/`getReopenHistory()` calls (one extra small query, run in
  the same `Promise.all`) rather than importing a constant.
- **New `GET`/`PUT /api/business/[businessId]/max-reopens`** – mirrors Module 35's timezone route exactly: `GET` is
  readable by any member (both workspace pages display it), `PUT` needs `business.settings.manage` (Owner), the
  same permission Modules 48/49 already require to reopen a completed record in the first place. No new
  permission, no re-seed. Every change is audit-logged (`business.max_reopens_changed`, before/after) – same
  reasoning as the timezone change, since it affects what a future reopen attempt is allowed to do.
- **UI**: a new "Reopen limit" section on `/settings/general`, right below the time zone one, with a bounded number
  input (1–20) and the same save/disabled-for-non-Owners pattern `TimeZoneForm` established. Both reconciliation
  and stock-take workspace pages dropped their `import { MAX_REOPENS }` in favor of the `maxReopens` value the
  detail API already returns, so a business's own limit – not a hard-coded number – is what the "N of 5 reopens
  used" banner and the reopen-form/cap-reached message now read.
- **Lowering the cap doesn't touch a record that already exceeds it** – the check only ever gates the *next* reopen
  attempt (`priorReopens >= business.maxReopens`), so a business that reopened something four times under the old
  cap of 5 and then lowers it to 3 simply can't reopen that record again until raised back up; nothing is
  retroactively invalidated.
- **Verification:** no new pure-logic verify script – like Modules 48/49/50, this is a config value plus the same
  boundary check that already existed, not new standalone math. `tsc --noEmit` (0 errors), `prisma validate`
  (valid), and `next build` all passed against a real generated Prisma client this session (offline dummy-engine
  trick). All 11 prior verify scripts + `check:dates` re-run clean.
- **Deploy:** `npx prisma migrate dev --name business_max_reopens` (one new `Business` column with a real Postgres
  default – no backfill script, no re-seed).

### KNOWN LIMITATIONS

- **A reopen's reason is still free text, not tied to a specific line** – carried forward from Modules 48/49, still
  open.
- **Product.reorderLevel/low-stock status is still business-wide only** – unrelated to this module, still open
  since Module 28.

## Module 52: Paginate Reopen History

Closes the KNOWN LIMITATION Module 50 documented and Module 51 flagged as more plausible: the reopen history panel
was hard-capped at the most recent 20 complete/reopen events with no way to see anything older. Module 51 raising
`maxReopens` to as high as 20 made that a real ceiling rather than a generous ceiling – a business on a high cap
reopening a record repeatedly could genuinely reopen it more times than the panel could ever show.

- **`src/lib/pagination.ts`** – new pure `paginateRows(rows, limit)` helper: the "fetch `limit + 1` rows, slice, and
  flag `hasMore`" trick, pulled out of `reopen-audit.ts` so the one place an off-by-one could hide (does exactly
  `limit` rows, no more, get mistaken for "there's a next page"?) is unit-testable without a database – same
  reasoning `vat-carry-forward.ts` and `debit-note-calc.ts` already apply to keep their own pure math
  import-free and separately verifiable.
- **`getReopenHistory()`** (`src/lib/reopen-audit.ts`) now takes an optional `{ cursor, limit }` and returns
  `{ rows, nextCursor }` instead of a flat, capped array. Paginated on the AuditLog row's `id` (a cuid), not
  `createdAt` – two audit rows written in the same request (the reopen action and its own audit entry) can share a
  timestamp down to the millisecond, so `createdAt` alone isn't a safe page boundary; `id` is unique and, being a
  cuid, sorts consistently with insertion order at the same instant `createdAt` does. `cursor` is the `id` of the
  last row the caller already has; omitted for page one.
- **`getBankReconciliation()`/`getStockTake()`** unchanged in shape apart from this: `history` is still the first
  page, embedded for free in the existing detail fetch (`getReopenHistory()` called with no cursor), plus a new
  `historyNextCursor` telling the UI whether a further page exists.
- **New `GET /api/business/[businessId]/bank-reconciliation/[reconciliationId]/reopen-history` and the stock-take
  equivalent** – `?cursor=<id>` for the next page, same `bankrecon.view`/`stocktake.view` permission the parent
  detail route already requires. No new permission, no re-seed.
- **UI**: both workspace pages' "Reopen history" `<details>` panel gained a "Load more" button under the list,
  shown only while a `historyNextCursor` exists; clicking it appends the next page to client-side state rather than
  re-fetching everything, and a fresh `load()` (after a reopen or complete) resets back to page one.
- **`AuditLog` gained `@@index([businessId, entityType, entityId])`** – the exact three fields `getReopenHistory()`
  filters on. Worth adding now specifically because this query, previously read once per page load, now runs
  again every time "Load more" is clicked.
- **Verification:** new `scripts/verify-reopen-history-pagination.ts`, 11/11 checks (pure) – empty input; fewer
  rows than the limit; *exactly* `limit` rows (must report no more – the case the `limit + 1` fetch exists to
  disambiguate from the next one); one row past the limit; well past the limit; limit of 1; degenerate limit (0,
  negative); order preserved on the returned page. `tsc --noEmit` (0 errors), `prisma validate` (valid), and
  `next build` all passed against a real generated Prisma client this session (offline dummy-engine trick). All 12
  prior verify scripts + `check:dates` re-run clean.
- **Deploy:** `npx prisma migrate dev --name auditlog_reopen_history_index` (one new index, no data migration).

### KNOWN LIMITATIONS

- **A reopen's reason is still free text, not tied to a specific line** – carried forward from Modules 48/49, still
  open.
- **Product.reorderLevel/low-stock status is still business-wide only** – closed by Module 53 below.

## Module 53: Per-Branch Reorder Thresholds

Closes the KNOWN LIMITATION Module 28 first documented and Modules 30/31/51 all carried forward unchanged: a
business with branches only ever had one reorder threshold – `Product.reorderLevel` – applied everywhere, even
though a branch's own typical stock level can be a small fraction of the business-wide number. A branch that
normally carries 10 units of something the business as a whole stocks 200 of was either never flagged as low (the
business-wide threshold was set for the 200) or flagged constantly (set for the 10, then applied business-wide too).

- **`StockLevel.reorderLevel`** – new nullable `Decimal` column on the existing per-branch stock table (Module 28).
  `null` (every pre-existing row gets this for free, no backfill) means "no override, keep using the business-wide
  `Product.reorderLevel`"; a number – including an explicit `0`, meaning "don't track this branch at all", the same
  convention `Product.reorderLevel` already uses – overrides it. Reusing `StockLevel` rather than adding a new
  table means no new join anywhere that already reads per-branch stock.
- **`resolveEffectiveReorderLevel(productReorderLevel, branchOverride)`** (`src/lib/inventory.ts`) – the one pure
  function that decides which of the two numbers applies. Every place that used to read `product.reorderLevel`
  directly in a per-branch context now goes through this instead.
- **`getBranchStockForProduct()`/`getBranchStockList()`** – both now also return `reorderLevelOverride` (the raw
  per-branch value, or `null`) and `effectiveReorderLevel` (the resolved one), so callers never have to re-derive
  the fallback themselves.
- **`setBranchReorderLevel(businessId, productId, branchId, reorderLevel)`** – `null` clears an override (a no-op
  if none existed); a number sets one, upserting a `StockLevel` row with `quantity: 0` if this branch has never had
  stock attributed to it yet – a business can now watch a branch's threshold before any stock has physically moved
  there.
- **New `GET`/`PUT /api/business/[businessId]/products/[productId]/branch-reorder-levels`** – reuses
  `inventory.view`/`inventory.manage`, the same permissions the product itself is already gated on. No new
  permission, no re-seed. A branch-restricted member only sees/edits their own branch's row.
- **Inventory Report** (`getInventoryReport()`, per-branch view) now flags low stock against the effective
  (branch-aware) threshold instead of always reading `Product.reorderLevel` – closing the exact gap that report's
  own KNOWN LIMITATION comment named since Module 30. Rows also expose `reorderLevel`/`isLowStock` for the CSV
  export.
- **In-app alerts** (`src/lib/in-app-notifications.ts`) – new `syncBranchLowStockAlerts()`, deliberately narrower
  than the business-wide `syncLowStockAlerts()`: it only alerts for a `(product, branch)` pair that has an
  *explicit* override set, not every pair that happens to have a `StockLevel` row. Without an override, that
  branch's stock is already covered by the existing business-wide alert; alerting again off the same business-wide
  threshold applied to a branch's smaller number would mostly be noise. Setting an override is the signal that
  someone specifically wants that branch watched. Resolves itself the same way the business-wide alert does –
  quantity recovers, the override is cleared, or the product/branch is deactivated.
- **New product detail page (`/inventory/[productId]`)** – didn't exist before this module (the inventory list was
  plain enough that nothing needed one); added because a per-branch override editor needs somewhere to live.
  Table of every branch, its quantity, and an inline field to set/clear its override. Both inventory list views
  link a product's name here, and the branch-scoped `/inventory?branch=` list shows a "Low at this branch" badge
  using the effective threshold.
- **Verification:** no new verify script – `resolveEffectiveReorderLevel()` is a one-line fallback, the same class
  of change Module 51 judged not to need one ("config value plus the same boundary check"). `tsc --noEmit` (0
  errors), `prisma validate` (valid), and `next build` all passed against a real generated Prisma client this
  session (offline dummy-engine trick). All 12 prior verify scripts + `check:dates` re-run clean.
- **Deploy:** `npx prisma migrate dev --name stocklevel_reorder_level` (one new nullable column, no data migration)
  + `npx prisma generate`. No re-seed.

### KNOWN LIMITATIONS

- **A reopen's reason is still free text, not tied to a specific line** – carried forward from Modules 48/49,
  **closed by Module 54**.
- **Correction, not a new gap**: the bullet that stood here through Module 53 ("StockTake still reconciles the
  business-wide total, not a per-branch count") was stale – restating a limitation Module 31 had already closed
  (see that module's own KNOWN LIMITATIONS, marked "CLOSED by Module 31" further up this file). Module 53 carried
  it forward by mistake without re-checking it; the code has snapshotted branch-level `StockLevel.quantity` per
  line since Module 31, and Module 53 itself never touched that path. No behavior changed here – this entry only
  corrects the record.
- **In-app low-stock alerts still can't tell a business "every branch, always"** without setting an override on
  each one – there's no bulk "apply this branch's threshold everywhere" action yet, so a business with many
  branches wanting per-branch alerts on all of them has to set each override individually.

## Module 54: Reopen Reason Tied to a Specific Line

Closes the KNOWN LIMITATION Modules 48 and 49 both documented the moment their own reopen path shipped: a reopen's
reason was always free text, with no way to say *which* line of the reconciliation or stock take it was actually
about – "wrong amount on the Airtel Money line" had to be typed out by hand rather than pointed at.

- **`BankReconciliation.reopenLineId` / `StockTake.reopenLineId`** – new nullable plain-id columns (no relation,
  same choice `reopenedById` already makes), added to both models field-for-field. `null` means the reopen wasn't
  about one specific line (a book-balance issue, a general correction); a value names the exact
  `BankStatementLine`/`StockTakeLine` involved. Same "most-recent-reopen-only" slot as `reopenedAt`/`reopenedById`/
  `reopenReason` – a second reopen simply overwrites it, since the full history already lives in AuditLog.
- **`reopenBankReconciliation()`/`reopenStockTake()`** now accept an optional `lineId`, verified to actually belong
  to the record being reopened (a `BankStatementLine`/`StockTakeLine` lookup scoped by both the line's own id and
  the parent id) before anything is written – the same "don't trust an id without checking ownership" rule every
  other line lookup in these files already follows.
- **AuditLog metadata gains `lineId` + a snapshotted `lineLabel`** – resolved once, at reopen time, from the line's
  own fields (`description` + date for a statement line, product name + SKU for a stock take line) rather than
  re-joined live when history is read later. This matters because a `BankStatementLine` genuinely can be deleted
  later (while `UNMATCHED`, per `deleteBankStatementLine`) and a product can be renamed – the history should keep
  reading correctly either way, the same reasoning that already justified capturing `reason` as free text at the
  moment it's true rather than deriving it afterward.
- **`reopen-audit.ts`**: `ReopenHistoryRow` gained `lineLabel: string | null`, read straight off the metadata
  blob `getReopenHistory()` already parses – no new query, no schema change to `AuditLog` itself.
- **UI**: both workspace pages' reopen form gained an optional "Which line / product?" dropdown listing the
  record's own lines; the reopen banner and the "Reopen history" panel both show `(re: <label>)` when a reopen
  named one; the specific line/product row itself now shows a small "↩ Reason for the most recent reopen" note
  when it's the one `reopenLineId` currently points at – resolved client-side against the lines the detail fetch
  already returns, no extra request.
- **Validation**: `reopenBankReconciliationSchema`/`reopenStockTakeSchema` both gained an optional `lineId` – Zod
  only checks it's a string; ownership is checked in the library function, where the database actually is.
- **Correction, not a new gap** (see the KNOWN LIMITATIONS note carried into Module 53's own section above): fixed
  a stale limitation bullet that had been re-copied forward since Module 30/31 without being re-checked against
  what the code actually does.
- **Verification**: no new verify script – this is a lookup-then-snapshot change on an existing state-transition
  path, the same class Modules 48/49/50/51/53 judged didn't need one. `tsc --noEmit` (0 errors), `prisma validate`
  (valid), and `next build` all passed against a real generated Prisma client this session (offline dummy-engine
  trick). All 12 prior verify scripts + `check:dates` re-run clean.
- **Deploy**: `npx prisma migrate dev --name reopen_line_reference` (two new nullable columns, one per model, no
  data migration) + `npx prisma generate`. No re-seed – both reopen routes already require the same permissions.

### KNOWN LIMITATIONS

- **A reopen naming a line doesn't do anything beyond labeling** – picking a line doesn't pre-fill or restrict what
  gets corrected once the record is back `IN_PROGRESS`; it's a pointer for whoever looks at the history later, not
  a workflow change. A future module could use it to jump the UI straight to that line.
- **The line dropdown lists every line on the record, including ones already `POSTED`/`IGNORED`/settled** – there's
  no filtering to "only lines that still look wrong," since the reopen might be about a line that looked fine and
  now doesn't (a later transaction revealed a stale match), not necessarily one still showing an obvious problem.
- **In-app low-stock alerts still can't tell a business "every branch, always"** without setting an override on
  each one (carried forward from Module 53, still open).

## Module 55: Stock Transfer In-Transit / Approval Workflow

Closes the KNOWN LIMITATION carried unchanged since Module 28's own comment: a `StockTransfer` was always immediate
and fully applied in one step – both the `TRANSFER_OUT` and `TRANSFER_IN` legs posted the instant it was created –
with no way to model the real gap between dispatch and arrival, and no confirmation step for the destination branch.

- **New `StockTransferStatus` enum** (`IN_TRANSIT`, `RECEIVED`, `CANCELLED`) on `StockTransfer`, plus
  `receivedAt`/`receivedById` and `cancelledAt`/`cancelledById`/`cancelReason` (all nullable, plain actor ids – no
  relation, same choice `reopenedById` already makes elsewhere). The Prisma column default is deliberately
  **`RECEIVED`, not `IN_TRANSIT`** – every pre-Module-55 transfer already has both legs posted, so Postgres backfills
  every existing row to `RECEIVED` (correct, since they already are) at migration time, while `createStockTransfer()`
  explicitly passes `IN_TRANSIT` for every transfer created from here on. Getting this backfill direction backwards
  would let an already-fully-applied historic transfer be "received" a second time and double-post its `TRANSFER_IN`.
- **`createStockTransfer()` now only posts `TRANSFER_OUT`** – the goods have genuinely left `fromBranch`, so its
  `StockLevel` reflects that immediately. Nothing moves at `toBranch` until someone confirms it arrived.
- **New `receiveStockTransfer()`** posts the deferred `TRANSFER_IN` leg at `toBranch` and moves the transfer to
  `RECEIVED`. **New `cancelStockTransfer()`** (takes a required `reason`, same convention as void/refund reasons)
  reverses the original `TRANSFER_OUT` instead – a `TRANSFER_IN` movement back at `fromBranch`, reusing the existing
  movement type since it genuinely is stock arriving back at a branch, just not the one it was headed to
  (`referenceType: "StockTransferCancel"` keeps it distinguishable from an ordinary receipt in the movement history).
  Both are refused once a transfer has left `IN_TRANSIT` – a `RECEIVED` transfer is done (send a new transfer the
  other way to correct it); an already-`CANCELLED` one can't be cancelled twice.
- **Race safety without a separate lock-then-read step**: both actions run an `updateMany({ where: { id,
  businessId, status: "IN_TRANSIT" }, data: { status: "IN_TRANSIT" } })` – an UPDATE that sets a column to its own
  current value still takes a real row lock in Postgres – before touching inventory. `count === 0` means a
  concurrent receive or cancel of the *same* transfer got there first, and this one is refused cleanly instead of
  double-posting. Cheaper than Sale/Purchase's own row-lock-then-read pattern since there's no earlier read this
  needs to protect – the whole decision is "is it still `IN_TRANSIT` right now".
- **New routes**: `POST .../stock-transfers/[id]/receive` and `.../cancel`, both reusing `inventory.manage`
  (Owner+Manager) – no new permission, no re-seed. A branch-restricted member can only receive a transfer landing at
  their *own* branch, and can only cancel one that left their *own* branch – the mirror image of each other, and of
  the existing create route's "either end" check (dispatching can be initiated from either side; receiving and
  cancelling are each specifically one side confirming its own half).
- **UI**: the list page gained a status badge (amber "In transit", green "Received", gray "Cancelled"); the detail
  page moved from a static server-rendered view to a client workspace component (same split Bank Reconciliation and
  Stock Take already use) with a status banner and, while `IN_TRANSIT`, Confirm Receipt / Cancel Transfer actions –
  cancelling opens an inline reason field before the action is confirmed. The dispatch form's button now reads
  "Dispatch Transfer" instead of "Complete Transfer", since dispatch is no longer the end of the story.
- **Audit**: `stocktransfer.create`/`.receive`/`.cancel` all logged via `logAudit()`, same as every other
  state-changing action in the app – no in-app history panel built on top of it yet (a future module could add one
  the way Module 50 did for reopens, if this workflow turns out to need it).
- **Verification**: no new verify script – this is a state-transition-plus-reversal change on an existing model, the
  same class Modules 48/49/54 judged didn't need one (no new pure math to unit-test). `tsc --noEmit` (0 errors),
  `prisma validate` (valid), and `next build` all passed against a real generated Prisma client this session
  (offline dummy-engine trick). All 12 prior verify scripts + `check:dates` re-run clean.
- **Deploy**: `npx prisma migrate dev --name stock_transfer_in_transit` (new enum + 6 new nullable columns on
  `StockTransfer`, one real column default) + `npx prisma generate`. No re-seed – both new routes reuse
  `inventory.manage`, an existing permission.

### KNOWN LIMITATIONS

- **All-or-nothing at both ends** – no partial-fulfillment/backorder handling. A transfer either arrives and is
  received in full, or the whole thing is cancelled; a line that only partly arrives can't be split into
  received-quantity and outstanding-quantity. *(Receipt side closed by Module 65: a line can now be received short.
  Dispatch is still all-or-nothing – no backorder, no second instalment against one transfer number.)*
- **No in-transit inventory bucket or dashboard view** – while `IN_TRANSIT`, the stock has left `fromBranch`'s
  `StockLevel` and simply isn't anywhere yet (not counted at either branch); a future module wanting to show
  "goods in transit" as its own line on a report would need to compute it from open `IN_TRANSIT` transfers, the
  same "computed, never stored" principle the rest of the app already applies to balances.
- ~~**No damaged/short-received path**~~ – *closed by Module 65.* Receiving takes the quantity that actually arrived
  per line; the shortfall is written off at dispatch-time cost with a recorded reason.
- **Concurrent receive/cancel claim** – *closed by the technical correctness follow-up.* The transaction now claims
  the transfer by changing its state from `IN_TRANSIT` before applying stock movements; the state and movements
  commit or roll back together, so only one competing receive/cancel can succeed.
- **In-app low-stock alerts still can't tell a business "every branch, always"** without setting an override on
  each one (carried forward from Module 53, still open).

## Module 56: In-Transit Stock Visibility

Closes the KNOWN LIMITATION Module 55's own header documented the moment the in-transit workflow shipped: dispatched
stock already leaves `fromBranch`'s `StockLevel` the instant `createStockTransfer()` posts `TRANSFER_OUT`, but
doesn't arrive at `toBranch`'s until `receiveStockTransfer()` runs – for that whole window the quantity is real and
owed to a specific branch, but wasn't counted or shown anywhere.

- **Zero schema changes.** Purely a read-side aggregation off the existing `StockTransfer`/`StockTransferLine`
  tables (`status IN_TRANSIT`), the same "computed, never stored" principle the app already applies to accumulated
  depreciation and customer/supplier debt. No migration this module.
- **New query logic lives directly in `inventory.ts`** (querying `prisma.stockTransferLine` inline) rather than
  importing from `stock-transfers.ts` – that file already imports FROM `inventory.ts`
  (`recordInventoryMovement`, `StockError`), so importing back would create a circular dependency between the two
  files for the sake of a handful of lines.
- **`getBranchStockForProduct()`** gained `inTransitIn`/`inTransitOut` per branch row. **`getBranchStockList()`**
  gained the same per product, plus synthetic 0-quantity rows for a product arriving at a branch that has no
  `StockLevel` row there yet – otherwise inbound-only stock would stay invisible until actually received. New
  **`getInTransitSummary(businessId)`** returns a business-wide transfer count/quantity/estimated value (using each
  product's CURRENT `purchasePrice`, since an in-transit line never snapshots a cost – transfers don't post to the
  GL) for dashboard/inventory-page use.
- **Wired through with no new permissions or routes anywhere**: the `branch-reorder-levels` GET route (product
  detail page) and the `inventory/summary` GET route both just pass the new fields through; the dashboard gained a
  "Stock In Transit" health stat (shown only when count > 0); `/inventory` gained per-row "+N arriving"/"N in transit
  out" badges on the branch-scoped view plus a business-wide banner linking to `/stock-transfers`;
  `/inventory/[productId]` shows "arriving"/"departed, not yet confirmed" per branch; the per-branch Inventory
  Report gained an `inTransitIn` field, auto-rendered by the reports page's generic key-driven table with no UI
  change needed there.
- **Verification**: no new verify script – pure read-aggregation (filter/reduce over existing rows), same class as
  Module 53's one-line fallback function; exercised by `tsc`/`next build` rather than dedicated unit tests. `tsc
  --noEmit` (0 errors), `prisma validate` (valid), and `next build` all passed against a real generated Prisma
  client this session. All 12 prior verify scripts + `check:dates` re-run clean.
- **Deploy**: `npx prisma generate` only – no migration needed.

### KNOWN LIMITATIONS

- **In-transit value estimate uses current product cost, not the cost at dispatch time** – transfers were never
  costed, so there's no dispatch-time snapshot to use instead.
- **No "stale transfer" alert** for a transfer that's been `IN_TRANSIT` unusually long – would belong with In-App
  Notifications' existing alert patterns, not this module. **Closed by Module 57.**
- All limitations carried from Module 55 unrelated to visibility (no partial-fulfillment/backorder, no
  damaged/short-received path) remain open.

## Module 57: Stale In-Transit Transfer Alerts

Closes the KNOWN LIMITATION Module 56 flagged, in its own write-up, as the natural next candidate the moment
in-transit visibility shipped: nothing warned anyone that a `StockTransfer` had been sitting `IN_TRANSIT`
unusually long – a truck that never arrived, or a receiving clerk who simply never confirmed it, had no way to
surface itself anywhere in the app.

- **New pure, import-free `src/lib/stale-transfer.ts`** – `STALE_TRANSFER_ALERT_DAYS` (3) and
  `STALE_TRANSFER_URGENT_DAYS` (6, the two-tier escalation mirroring `TAX_DUE`'s overdue/due-soon split),
  `daysInTransit()`, and `isStaleTransfer()`. Deliberately has no imports – not even `./prisma` – for the same
  reason `vat-payment-direction.ts` (Module 46) does: it needs to be safely importable from BOTH a server module
  that imports Prisma at module scope (`in-app-notifications.ts`) and the `"use client"`
  `StockTransferWorkspace` component, which must never pull a Prisma import into the browser bundle.
- **New `InAppNotificationType.STALE_TRANSFER`** enum value – additive only, no backfill needed (mirrors how
  `LOW_STOCK`/`TAX_DUE`/`TRIAL_ENDING` were each added without touching existing rows).
- **New `syncStaleTransferAlerts()`** in `in-app-notifications.ts`, wired into `syncInAppNotifications()`'s
  `Promise.all` alongside the other four. CONDITION-BASED like `LOW_STOCK`, not payment-cleared like `TAX_DUE` –
  there's no separate "resolve" event to watch for; a transfer stops being stale the moment it's no longer
  `IN_TRANSIT` (received or cancelled), which the sync's own "no longer in the stale set → resolve" pass already
  handles the same way `syncLowStockAlerts()` does for a restocked product.
- **The threshold is a constant, not a `Business` column** – same choice `TAX_ALERT_WINDOW_DAYS`/
  `TRIAL_ALERT_WINDOW_DAYS` already make in `in-app-notifications.ts`. A future module could promote it to a
  per-business setting the way Module 51 did for the reopen cap, if a real business ever needs a different number
  (a business with routine multi-day rural transfer routes, say) – not built ahead of an actual need.
- **UI**: the `/stock-transfers` list gets a small red "Stale" tag next to the amber "In transit" badge once a row
  crosses the threshold; the detail page's status banner shows the same condition with the exact day count and a
  one-line nudge ("check whether it arrived, or cancel it"). Both compute this client-side from `createdAt` via the
  same pure helper – no extra query, no new field returned by either route. `alerts-section.tsx`'s `TYPE_LABEL`
  map gained `STALE_TRANSFER: "Stale transfer"`.
- **No new permission, no new route, no re-seed.** Schema change is a single additive enum value.
- **Verification**: no new verify script – `daysInTransit()`/`isStaleTransfer()` are one-line pure arithmetic, the
  same class Module 53's `resolveEffectiveReorderLevel()` judged didn't need one; exercised by `tsc`/`next build`.
  `tsc --noEmit` (0 errors), `prisma validate` (valid), `next build` all passed against a real generated Prisma
  client this session. All 12 prior verify scripts + `check:dates` re-run clean.
- **Deploy**: `npx prisma migrate dev --name stale_transfer_alert_type` (one additive enum value) + `npx prisma
  generate`. No re-seed.

### KNOWN LIMITATIONS

- **The 3-day threshold is a shared constant, not configurable per business** – a business whose normal transfer
  routes genuinely take longer than 3 days would see false alarms with no in-app way to raise the number (same
  gap Module 51 closed for the reopen cap; not built here ahead of an actual need). **Closed by Module 58.**
- **Doesn't distinguish "forgotten" from "genuinely still in transit"** – the alert only knows elapsed time, not
  whether anyone has looked at the transfer since dispatch; a business that checks and consciously decides to wait
  gets the same alert as one that never noticed.
- All other Stock Transfer limitations carried from Modules 55/56 (no partial-fulfillment/backorder, no
  damaged/short-received path, in-transit value estimate uses current cost not dispatch-time cost) remain open.

## Module 58: Configurable Stale-Transfer Alert Threshold

Closes the KNOWN LIMITATION Module 57 documented the moment it shipped, echoing the exact gap Module 51 closed for
the reopen cap: `STALE_TRANSFER_ALERT_DAYS` was a shared code constant (3 days), so a business whose ordinary
transfer routes genuinely take longer had no in-app way to raise the number without seeing false "stale" alarms.

- **New `Business.staleTransferAlertDays` (`Int @default(3)`)** replaces the constant everywhere it was read – same
  "real Postgres default, no lazy-backfill branch needed" reasoning `maxReopens` (Module 51) already documents.
- **`src/lib/stale-transfer.ts` reshaped**: `STALE_TRANSFER_ALERT_DAYS`/`STALE_TRANSFER_URGENT_DAYS` constants are
  gone, replaced by `DEFAULT_STALE_TRANSFER_ALERT_DAYS`/`MIN_STALE_TRANSFER_ALERT_DAYS` (1)/
  `MAX_STALE_TRANSFER_ALERT_DAYS` (30) bounds plus a new `staleTransferUrgentDays(alertDays)` helper (the urgent
  tier stays a fixed 2x multiple of whatever the business configured, not its own separate setting – known
  limitation below). `isStaleTransfer()` now takes `alertDays` as a required parameter, no default – the same
  "compiler finds a forgotten one" discipline the timezone helpers' `tz` parameter already enforces.
- **`syncStaleTransferAlerts()`** (`in-app-notifications.ts`) fetches the business's own `staleTransferAlertDays`
  alongside its existing `StockTransfer` query (one extra small query in the same `Promise.all`, same pattern
  Module 51 used for `reopenBankReconciliation()`/`reopenStockTake()`).
- **New `GET`/`PUT /api/business/[businessId]/stale-transfer-threshold`**, mirroring Module 51's max-reopens route
  field for field: GET readable by any member, PUT needs `business.settings.manage` (Owner) – the same permission
  Module 57 needed none of. No new permission, no re-seed. Every change audit-logged
  (`business.stale_transfer_threshold_changed`).
- **UI**: new "Stale transfer alert" section on `/settings/general`, below the reopen-limit one, same
  save/disabled-for-non-Owners pattern as `MaxReopensForm`. The Stock Transfers list page and the transfer
  workspace/detail page both dropped their implicit reliance on the old constant in favor of the business's own
  `staleTransferAlertDays`, threaded down as a prop from the server page in each case (no extra request on the
  detail page – the value comes from the same `membership.business` the page already loads).
- **Lowering the threshold below a transfer's current in-transit age doesn't retroactively do anything special** –
  the very next `syncInAppNotifications()` call simply evaluates the new number, the same "only gates the next
  check" behavior Module 51 documents for the reopen cap.
- **Verification**: no new verify script – config value plus the same pure arithmetic Module 57 already shipped,
  same class as Modules 48/49/50/51. `tsc --noEmit` (0 errors), `prisma validate` (valid), and `next build` all
  passed against a real generated Prisma client this session. All 12 prior verify scripts + `check:dates` re-run
  clean.
- **Deploy**: `npx prisma migrate dev --name stale_transfer_alert_days` (one additive `Int` column with a real
  default) + `npx prisma generate`. No re-seed.

### KNOWN LIMITATIONS

- **The "urgent" escalation tier is still a fixed 2x multiple of the configured threshold, not its own setting** –
  a business that wants, say, "warn at 5 days, urgent at 20" rather than "warn at 5, urgent at 10" has no way to
  set that independently.
- All other Stock Transfer limitations carried from Modules 55/56/57 (no partial-fulfillment/backorder, no
  damaged/short-received path, in-transit value estimate uses current cost not dispatch-time cost, doesn't
  distinguish "forgotten" from "genuinely still in transit") remain open.

## Module 59: Stock Transfer Dispatch-Time Cost Snapshot

Closes the KNOWN LIMITATION Module 56 documented the moment in-transit visibility shipped, and which every module
touching Stock Transfers since (57, 58) carried forward unchanged: `getInTransitSummary()`'s "what's currently on a
truck" value estimate used each product's CURRENT `purchasePrice`, so the figure silently drifted if a later
purchase changed a product's cost while an earlier transfer of it was still sitting in transit – two transfers of
the identical quantity, dispatched weeks apart, could show different "value at dispatch" even though neither had
actually changed.

- **New nullable `StockTransferLine.unitCostAtDispatch` (`Decimal(14,2)`)**, snapshotted from `Product.purchasePrice`
  the moment `createStockTransfer()` creates the line – the exact same "capture the cost now, don't recompute it
  later" principle `SaleLine.unitCost`/`PurchaseLine.unitCost` already apply, just arriving eleven modules later for
  transfers because Module 28 never needed a cost snapshot until Module 56 introduced a value estimate to snapshot
  it *for*. Nullable rather than backfilled: a transfer created before this module never captured what its cost was
  at ITS OWN dispatch time, and there's no way to recover that number retroactively – the same honest gap every
  nullable-added-later column in this app carries (`reopenedAt`, `receivedAt`, etc.).
- **`getInTransitSummary()`** (`src/lib/inventory.ts`) now values each line at `unitCostAtDispatch` when present,
  falling back to the product's current `purchasePrice` only for the (shrinking, over time non-existent) set of
  lines created before this module – so the business-wide banner on `/inventory` and the dashboard health stat stay
  accurate for every transfer dispatched from here on, and don't silently misrepresent pre-Module-59 ones either.
- **Stock Transfer detail page** (`stock-transfer-workspace.tsx`) gained an "Est. value at dispatch" column on the
  line table, using the same snapshot-or-fallback logic, with a small "(current cost)" note on any line still
  relying on the fallback so it's visible on the one page, not just implied by a business-wide total.
- **`getBranchStockForProduct()`/`getBranchStockList()`/the per-branch Inventory Report were NOT touched** – none of
  them show a monetary value for in-transit quantity, only counts (`inTransitIn`/`inTransitOut`), so there was
  nothing there for a cost snapshot to improve.
- **Verification**: no new verify script – this is a single-field snapshot-and-prefer-it change with no new pure
  math of its own (same class as Modules 48/49/50/51/58, all of which added a column and read it back rather than
  computing something new). `tsc --noEmit` (0 errors), `prisma validate` (valid), and `next build` all passed
  against a real generated Prisma client this session. All 12 prior verify scripts + `check:dates` re-run clean.
- **Deploy**: `npx prisma migrate dev --name stock_transfer_line_unit_cost_at_dispatch` (one additive nullable
  `Decimal` column, no data migration, no backfill) + `npx prisma generate`. No re-seed.

### KNOWN LIMITATIONS

- **Pre-Module-59 in-transit transfers still value at current cost** – `unitCostAtDispatch` is null on any line
  created before this module shipped, and nothing can recover what the cost actually was back then; this only
  self-resolves as those older transfers get received or cancelled.
- All other Stock Transfer limitations carried from Modules 55/56/57/58 (no partial-fulfillment/backorder, no
  damaged/short-received path, doesn't distinguish "forgotten" from "genuinely still in transit", urgent-alert tier
  still a fixed 2x multiple not its own setting) remain open.

## Module 60: Bulk-Apply Reorder Level Across All Branches

Closes the KNOWN LIMITATION Module 53 documented from the moment per-branch reorder-level overrides shipped: setting
an override was strictly one branch at a time, so a business standardizing a new threshold across every branch –
or clearing every override back to the business-wide default after a policy change – had to repeat the identical
save once per branch.

- **New `applyReorderLevelToAllBranches()`** (`src/lib/inventory.ts`) sets (or clears) the same override across every
  branch the business has, in one transaction – all-or-nothing, so a failure partway through never leaves some
  branches updated and others not. Both it and the existing single-branch `setBranchReorderLevel()` now share one
  internal `applyReorderLevelToBranchIds()` helper (a plain loop of upsert-or-`updateMany` calls run inside whichever
  transaction the caller opened) – one place that knows how to set-or-clear an override, whether for one branch or
  all of them.
- **Audited, unlike the single-branch PUT (which never was)**: `product.bulk_reorder_level_applied` with
  `{ reorderLevel, branchCount }` – a one-click change touching every branch at once is exactly the kind of "could
  be disputed later" action `audit.ts`'s own header calls for, even though the narrower per-row edit this module
  otherwise wraps still isn't.
- **New `POST .../products/[productId]/branch-reorder-levels/apply-to-all`**, a separate route rather than a flag on
  the existing PUT – same reasoning Stock Transfers' receive/cancel endpoints (Module 55) already established: an
  action that touches every branch, not the one named in the request body, deserves its own explicit endpoint and
  its own audit action name. Reuses `inventory.manage` – no new permission. Unlike the single-branch route, a
  branch-restricted member is blocked outright (403) rather than narrowed to their own branch – there's no sensible
  per-branch scoping for an inherently all-branches action.
- **UI**: a small "Apply one level to every branch" control above the per-branch table on `/inventory/[productId]`,
  visible only to an unrestricted Owner/Manager (mirrors the route's own permission check). A number applies it
  everywhere; leaving it blank clears every override back to the business-wide level. Either action asks for
  confirmation first (`window.confirm`) since it overwrites whatever a branch already had set – the same
  "can't be undone by re-checking a box" reasoning Stock Transfer cancellation already required a typed reason for.
- **Verification**: no new verify script – a set-or-clear loop over existing per-branch logic, same class as Modules
  48/49/50/51/58/59. `tsc --noEmit` (0 errors), `prisma validate` (valid), and `next build` all passed against a
  real generated Prisma client this session. All 12 prior verify scripts + `check:dates` re-run clean.
- **Deploy**: no schema change – pure application-layer addition on top of Module 53's existing `StockLevel.reorderLevel`
  column. No migration, no re-seed.

### KNOWN LIMITATIONS

- **Bulk-apply overwrites every branch unconditionally** – there's no "only branches that don't already have their
  own override" option; it's all-or-nothing by design (matching the confirmation copy), not selective.
- All other tracked limitations (Reopen line-naming label-only; Stock Transfer no partial-fulfillment/backorder, no
  damaged/short-received path, doesn't distinguish "forgotten" from "still in transit", stale-alert urgent tier
  fixed 2x, pre-Module-59 lines value at current cost) remain open.

## Module 61: Dismissed TAX_DUE Alerts Re-Surface When the Estimate Changes

Closes the KNOWN LIMITATION tracked since Module 25 shipped TAX_DUE as a payment-cleared (not condition-based) alert
type: once a person dismissed a "PAYE due soon" or "VAT overdue" bell alert, it stayed dismissed for the rest of
that obligation's life even if the working estimate it quoted kept moving underneath it – a payroll run entered
late, a new withholding-tax expense recorded after the fact, a fixed asset disposed mid-period. The person dismissed
one number and had no way to learn the number had since changed short of reopening the Tax Calendar tab themselves.

- **New `InAppNotification.amountSnapshot`** (`Decimal(14,2)?`) records the working-estimate amount an alert's
  title/body reflected the last time its content was set. Nullable and lazy-backfilled like every other
  Module-N-adds-a-column change in this codebase – populated only for TAX_DUE today (see `AlertInput.amount` in
  `src/lib/in-app-notifications.ts`); every other alert type passes no amount and is unaffected.
- **New pure `src/lib/notification-transition.ts::resolveNotificationTransition()`** replaces the two-line
  "dismissed-and-not-resolved → leave it" check `upsertActive()` used to do inline. It still treats a
  resolved-then-recurred alert (any type) as a fresh occurrence, and still leaves a dismissed-and-never-resolved
  alert alone by default (Module 25's rule: dismiss isn't a five-minute snooze) – but now makes one exception: a
  dismissed alert whose tracked amount has moved by at least MWK 0.01 (i.e. any real change past float noise) since
  the snapshot the person actually saw is treated the same as resolved-then-recurred – dismissal, unread state, and
  `resolvedAt` all clear, and it comes back with the new number.
- **`syncTaxDueAlerts()`** now passes `amount: entry.amount` into `upsertActive()`. No other sync function
  (`syncLowStockAlerts`, `syncBranchLowStockAlerts`, `syncStaleTransferAlerts`, the trial-ending check) passes an
  amount, so `resolveNotificationTransition()`'s amount-change branch can never fire for them – behavior for every
  other alert type is byte-for-byte unchanged.
- **Backfill behavior, deliberately gentle**: a TAX_DUE alert dismissed before this module shipped has
  `amountSnapshot = null`, and the function requires an existing snapshot to compare against – so its first sync
  after upgrade leaves it exactly as before (still dismissed) rather than spuriously resurfacing every old dismissal
  the moment the column appears. The snapshot is recorded on that same sync, so genuine future changes are caught
  from then on.
- **Verification**: new `npm run verify:notification-transition` (12 checks) covers the pure decision function
  directly – untouched/plain-refresh, resolved-then-recurred (with and without an amount), dismissed-unchanged,
  dismissed-changed in both directions, exactly-at-threshold, no-prior-snapshot, and a null-amount edge case – the
  same "test the pure function, not the Prisma orchestration around it" split `verify-reopen-history-pagination.ts`
  and `verify-vat-refunds.ts` already use. `tsc --noEmit` (0 errors), `prisma validate` (valid), and `next build` all
  passed against a real generated Prisma client this session. All 12 prior verify scripts + `check:dates` re-run
  clean.
- **Deploy**: one new nullable `InAppNotification` column, no backfill needed (see above) – `prisma migrate` +
  `prisma generate`; no re-seed.

### KNOWN LIMITATIONS

- **Still no distinction between "the estimate changed a little" and "the estimate changed a lot"** – any move of at
  least one tambala resurfaces the alert; there's no minimum-materiality threshold beyond float-noise absorption.
- **Only TAX_DUE tracks an amount** – a future alert type with its own "the number changed" concern (there currently
  isn't one) would need to pass its own `amount` into `upsertActive()` to get the same treatment; nothing else does
  today.
- All other tracked limitations (bulk-apply reorder level is all-or-nothing; Reopen line-naming label-only; Stock
  Transfer no partial-fulfillment/backorder, no damaged/short-received path, doesn't distinguish "forgotten" from
  "still in transit", stale-alert urgent tier fixed 2x, pre-Module-59 lines value at current cost) remain open.

## Module 62: Bank Statement CSV Import

Closes the KNOWN LIMITATION Module 22 documented from day one: a bank or mobile-money statement could only be typed
in one line at a time. A real month's statement is often 50-300 lines, which made reconciliation a chore in exactly
the businesses that need it most. Module 22's reasoning for deferring it was that a parser for one bank's format
would be "a bet on a specific bank rather than a general feature" - so this module is deliberately NOT per-bank. It
detects the layout from the file's own header instead.

- **New pure, import-free `src/lib/bank-statement-csv.ts`** (same split as `vat-payment-direction.ts`,
  `stale-transfer.ts`, `pagination.ts`: no Prisma, no zod, testable without a database). It contains an RFC 4180-style
  record parser (quotes, escaped quotes, embedded newlines, CRLF, BOM), delimiter detection (comma / semicolon / tab),
  date parsing, amount parsing, header detection, and duplicate flagging.
- **What it understands.** The file needs a header row (up to 20 non-blank rows above it - account name, period - are
  ignored) with a Date column, a Description column (Description / Narration / Details / Particulars / Reference ...),
  and EITHER one signed Amount column OR separate Debit and Credit columns (Withdrawals/Deposits, Money out/in ...).
  On a statement a Debit is money OUT and a Credit is money IN; the import converts both layouts to this app's signed
  convention (positive = in, negative = out). Other columns (running balance etc.) are ignored. Column choice follows
  alias priority, not column order, so "Date" wins over "Value Date".
- **Dates**: ISO, `01/09/2026` (day-first by default - the Malawian convention - with a Month/Day/Year switch in the
  UI), dash/dot separators, two-digit years, `01 Sep 2026`, `1-Sep-26`, `Sep 1, 2026`; a trailing time is ignored;
  impossible dates (31 April, 29 Feb in a non-leap year) are rejected, never rolled over.
- **Amounts**: `1,234.50`, `-1,234.50`, `(1,234.50)`, `1234.50-`, `MWK 1,234.50`, `K1,500`, `1.234,50` and `1234,50`
  (decimal comma), `1,234.50 DR` / `CR`, and a lone `-` as "empty". More than two decimal places is an error rather
  than a rounding.
- **Nothing is dropped silently.** Every row that can't be read is reported with its row number and reason. A real
  import is REFUSED while any row is unreadable unless the person consciously ticks "skip these rows and import the
  rest"; the result then reports how many were skipped.
- **Duplicates are count-aware.** A row is flagged "already here" when the reconciliation already holds a line with the
  same date, description (case/space-insensitive) and amount - but only up to the number that already exist. Two
  identical K500 airtime lines on one statement are normal, so re-importing the same file flags every row, while a file
  with one MORE identical line than the reconciliation has still imports the extra one. Duplicates are skipped by
  default and the person can turn that off.
- **New `importBankStatementCsv()`** in `src/lib/bank-reconciliation.ts` adds only what needs the database: the
  IN_PROGRESS guard, the duplicate lookup against this reconciliation's own lines, and the write. The write is one
  transaction (all lines or none) that re-checks the reconciliation is still IN_PROGRESS inside the transaction, and
  writes ONE audit row (`bankrecon.import_lines`: imported / skipped-duplicate / skipped-invalid counts, date order).
  Imported lines start `UNMATCHED` exactly like typed ones - importing never matches, posts, or touches the books.
- **New `POST /api/business/[businessId]/bank-reconciliation/[reconciliationId]/lines/import`** - a separate route
  (same reasoning as Stock Transfers' receive/cancel), reusing `bankrecon.manage`. No new permission, no re-seed.
  `dryRun: true` is the Preview step: parses and reports, writes nothing. The CSV travels as text in the JSON body
  (read in the browser with `File.text()`), so there is no multipart handling.
- **UI**: a collapsible "Import statement lines from CSV or OFX/QFX" panel under the manual add-line form. Choosing a file
  runs a preview immediately: counts, which columns were used, unreadable rows with reasons, the first 15 rows with an
  "already here" tag, then an Import button labelled with the real number of lines it will create.
- **Limits**: 1,000 data rows and 500,000 characters per file (split larger statements) - enforced in the pure parser
  so the API and any future caller share one cap.
- **Verification**: new `npm run verify:bank-statement-csv` (90 checks) covers the pure layer: record parsing, delimiter
  detection, every date and amount form above, signed and debit/credit layouts, preamble/blank rows, per-row error
  reporting, alias priority, the row cap, and count-aware duplicate flagging. `tsc --noEmit` (0 errors), `prisma
  validate` (valid), and `next build` all passed against a real generated Prisma client this session. All 13 prior
  verify scripts + `check:dates` re-run clean.
- **Deploy**: no schema change, no migration, no re-seed. `prisma generate` optional/harmless.

### KNOWN LIMITATIONS

- **CSV and OFX/QFX files are supported; live bank-feed import remains open.** Some banks only offer PDF or Excel; export or "Save as CSV" from Excel first.
- **CLOSED by Module 63**: a separate Dr/Cr indicator column. Signed amounts, `DR`/`CR` written next to the amount, and
  Debit/Credit column pairs were supported here; an unsigned Amount plus a "Dr/Cr" or "Type" column is now understood
  too (see Module 63).
- **Duplicate detection only looks inside this reconciliation.** A line imported into a previous month's reconciliation
  isn't compared against - two overlapping statement files for different reconciliations can each import the overlap.
- **CLOSED by Module 64**: lines dated outside the statement period were accepted without a word. The import preview
  and a typed line now both warn (see Module 64).
- All other tracked limitations remain open.

## Module 63: Dr/Cr Indicator Column in Bank Statement Import

Closes the KNOWN LIMITATION Module 62 documented the moment CSV import shipped: some bank and mobile-money exports
print one UNSIGNED Amount column and a separate column saying whether each line is a debit or a credit ("Dr/Cr",
"Debit/Credit", "Type"). Module 62 understood a signed Amount, a `DR`/`CR` written next to the amount, and Debit +
Credit column pairs, but this third layout came out as every line being money IN - the worst kind of wrong, because
nothing looked unreadable. This module reads it properly and refuses to guess when it can't.

- **Same pure file, no new module.** All changes are in `src/lib/bank-statement-csv.ts` (still import-free): new
  `parseDirectionIndicator()`, an `indicator` field on `StatementColumns`, and a `warnings` list on the parse result.
  Same convention as Module 62's Debit/Credit columns: `DR` / `D` / `Debit` / `Withdrawal` = money OUT,
  `CR` / `C` / `Credit` / `Deposit` = money IN. The amount cell supplies the magnitude, the indicator the direction.
- **Two kinds of indicator header.** A header that can only mean direction (`Dr/Cr`, `Cr/Dr`, `Debit/Credit`,
  `Indicator`, `DC` ...) is trusted on its name alone. A generic `Type` / `Transaction Type` header is NOT: many
  statements use "Type" for Card / ATM / Transfer. A generic column is used only when EVERY filled cell in it is a
  recognisable DR/CR value; otherwise it is ignored and the import shows an amber warning naming the column and one
  offending value, and reads the amounts as printed. It only ever applies next to an Amount column - in a Debit +
  Credit column layout the filled column already says the direction, so any Type column is ignored without a warning.
- **Never guessed, per row.** A blank indicator, an unrecognised one (`XX`), or one that contradicts a signed amount
  (`-500` with `CR`) is reported as an unreadable row with its row number and reason, so it blocks a real import
  unless the person consciously skips those rows - the same rule as every other unreadable row. A negative amount
  with `DR` is consistent and simply reads as money out.
- **Plumbing.** `importBankStatementCsv()` passes `warnings` through on its result and records the indicator column
  name in the `bankrecon.import_lines` audit metadata. The import panel's "Columns used" line now shows which column
  supplied money in/out, shows the warning box when there is one, and the help text lists the third layout. No route
  change (the JSON response gained fields), no new permission.
- **Verification**: `npm run verify:bank-statement-csv` grew from 90 to 132 checks (indicator vocabulary, strict and
  generic headers, ignored generic column with warning, blank/unknown/contradictory cells, Debit/Credit layout
  ignoring Type, semicolon + decimal comma, all-blank Type column). Two Module 62 column-shape checks were updated
  for the new `indicator: null` field. `tsc --noEmit` (0 errors), `prisma validate` (valid), and `next build` passed
  against a real generated Prisma client this session. All 13 other verify scripts + `check:dates` re-run clean.
- **Deploy**: no schema change, no migration, no re-seed. `prisma generate` optional/harmless.

### KNOWN LIMITATIONS

- **Indicator values are a fixed vocabulary** (DR/D/DB/Debit/Withdrawal, CR/C/Credit/Deposit). A bank that prints
  something else there gets per-row "couldn't read" errors, never a guess; add the word to `parseDirectionIndicator()`.
- **A generic `Type` column that mixes DR/CR with other words is ignored as a whole** (with a warning) rather than
  used row by row - rename the header to "Dr/Cr" if it really is the direction column.
- **Statement perspective is assumed** to be the account holder's (Debit = money out). An export written from the
  bank's own ledger perspective would read backwards; the preview shows the signed amounts so it is visible.
- Other Module 62 limitations (no live bank feed, duplicates checked only inside one reconciliation, no warning for lines
  dated outside the statement period) remain open, as do all other tracked limitations.

## Module 64: Statement-Period Check for Bank Statement Lines

Closes the KNOWN LIMITATION Module 62 documented (and Module 63 carried forward): a statement line dated after the
reconciliation's statement date, or months before it, was accepted without a word. The commonest way to hit it is not a
bad bank file - it is reading `03/09/2026` day-first when the file meant month-first, or importing last month's
statement into this month's reconciliation. Both used to land silently and then sit UNMATCHED forever, because the
books side of a reconciliation stops at the statement date.

- **Pure functions in the existing `src/lib/bank-statement-csv.ts`** (still import-free): `daysBetweenYmd()`,
  `classifyLineDate()`, `flagOutOfPeriod()`, and the `OUT_OF_PERIOD_LOOKBACK_DAYS` constant (92). Calendar-day maths on
  `YYYY-MM-DD` strings via `Date.UTC`, so no time-zone drift (same principle as `Business.booksClosedThrough`).
- **Two flags, deliberately not equal in confidence.** A reconciliation stores only its END date (`statementDate`) -
  there is no start date - so:
  - `AFTER_STATEMENT` is **definite**: the line is dated after the statement date, so it cannot match a book
    transaction in scope for this reconciliation.
  - `LONG_BEFORE` is a **heuristic**: more than 92 days (about a quarter, with slack) before the statement date.
    Probably an earlier statement's line or a wrong day/month order, but a quarterly statement is legitimate.
- **Warns, never blocks.** Bank posting dates can genuinely straddle a statement date, and manual entry has always
  accepted any date, so the import does the same by default. Nothing is silently dropped: the person can tick
  "Leave these rows out" (`skipOutOfPeriod`, default false) and the result reports how many were left out.
- **`importBankStatementCsv()`** flags each readable row, returns `statementDate`, `afterStatementRows`,
  `longBeforeRows`, `outOfPeriodOnlyRows` and `skippedOutOfPeriod`, and records the counts in the
  `bankrecon.import_lines` audit metadata. A row that is both a duplicate and out of period is counted as a duplicate
  only, so the skip counts never overlap (`outOfPeriodOnlyRows` is exactly what the checkbox would remove when
  duplicates are also being skipped).
- **`addBankStatementLine()`** now returns `{ line, periodFlag }` and `POST .../lines` includes `periodFlag` in its
  response; the workspace shows an amber note under the add-line form. The line is still saved.
- **UI**: an amber "Dates outside this statement's period" box in the import preview (the day/month switch is hinted at
  in the `LONG_BEFORE` text), a per-row tag next to "already here", the skip checkbox, and an Import button whose
  count mirrors the server's arithmetic.
- **Verification**: `npm run verify:bank-statement-csv` grew from 132 to 159 checks (day arithmetic incl. leap years and
  year end, the 92/93-day boundary, custom lookback, unparseable dates never flag, composition with duplicate flagging,
  a MDY-read date surfacing as an error rather than a wrong date). `tsc --noEmit` (0 errors), `prisma validate`
  (valid), and `next build` passed against a real generated Prisma client this session. All 13 other verify scripts +
  `check:dates` re-run clean.
- **Deploy**: no schema change, no migration, no re-seed, no new permission. `prisma generate` optional/harmless.

### KNOWN LIMITATIONS

- **The 92-day lookback is a fixed constant**, not a per-business setting. It exists because a reconciliation has no
  stored start date; adding a `periodStart` to `BankReconciliation` would make "before the period" exact and is the
  natural follow-up if this proves noisy.
- **Only warns for typed lines** - it doesn't offer to leave them out (there is one line, the person can just delete it).
- Other Module 62 limitations (no live bank feed, duplicates checked only inside one reconciliation) remain open, as do all
  other tracked limitations.

## Module 65: Short / Damaged Receipt of a Stock Transfer

Closes the KNOWN LIMITATION Module 55 documented the moment the in-transit workflow shipped (and every later stock
transfer module carried forward): receiving was all-or-nothing. A truck that arrived with two split bags of rice, or
one carton fewer than the load sheet said, could only be received in full and then corrected with a separate
adjustment - which left the books showing stock at the destination that was never physically there.

- **What a shortfall is, in the books.** `createStockTransfer()` already took the goods off `fromBranch`'s
  `StockLevel` **and** off the business-wide `Product.quantity` at dispatch (`recordInventoryMovement()` always moves
  both). So a unit that never arrives is *already gone* from the quantity books - no extra inventory movement is
  needed or posted. What still carries it is the GL **Inventory** account, because a transfer never touches the GL.
  Each short line is therefore written off at cost: **Dr Inventory Shrinkage & Adjustment / Cr Inventory**, the same
  account Stock Take shrinkage uses, so every "stock we no longer have" figure lands in one place. The movement
  history stays truthful without a third row: `TRANSFER_OUT -10`, then `TRANSFER_IN +8` already shows 8 arrived; the
  line row records the other 2 and why.
- **Schema (two nullable columns on `StockTransferLine`)**: `quantityReceived Decimal(14,3)?` and
  `shortfallReason String?`. Written for **every** line at receive time (full lines included), so `NULL` afterwards
  only ever means "received before Module 65" (they could only be received in full) - the same null-means-legacy
  convention as `unitCostAtDispatch`. Not backfilled; nothing to recover.
- **New pure, import-free `src/lib/stock-transfer-receipt.ts`**: `resolveReceipt()` decides per line what arrived and
  what the shortfall is worth; `lineShortfall()`/`transferHasShortfall()` read a RECEIVED transfer back. Import-free so
  the "use client" workspace runs the **same** function the server does - the form previews exactly what the server
  will accept or refuse. Quantities are compared in whole thousandths, never as floats, so `0.1 + 0.2` against `0.3`
  is a full receipt, not a phantom 5e-17 shortfall.
- **Rules (never guessed, never clamped)**: `0 <= received <= dispatched`; at most 3 decimals; a reason (trimmed,
  max 200 chars) is **required** when a line is short and is discarded on a line that arrived in full; an unknown or
  duplicated line id is refused; one bad line fails the whole receipt. Receiving **more** than was dispatched is
  refused - extra stock is a new transfer or a purchase, not a receipt. A line missing from the request defaults to
  "in full", so the person only has to name the lines that differed.
- **`receiveStockTransfer()`** takes an optional `lines`. `resolveReceipt()` runs **before** the atomic
  `updateMany` claim and before any write, so a bad body leaves nothing half-applied. `TRANSFER_IN` posts for the
  received quantity only (skipped at zero); short lines write off via the new
  `postJournalEntryForTransferShortfall()` in `accounting-integrations.ts`, one entry per short line keyed
  `StockTransferShortfall` + line id; guarded to skip a shortfall worth under a tambala or a zero-cost product (the
  line is still recorded as short). The entry is dated "now" (no explicit `entryDate`), so it can never land in a
  closed period - same reasoning as credit notes and stock-take adjustments (see Module 42's note).
- **Value used**: `unitCostAtDispatch`, falling back to current `purchasePrice` for a pre-Module-59 line - the same
  rule Module 59 uses for the in-transit estimate.
- **Route**: `POST .../stock-transfers/[transferId]/receive` now accepts an optional body
  `{ lines: [{ lineId, quantityReceived, shortfallReason? }] }`. No body, `{}` or an empty `lines` still means
  "everything arrived in full", so a Module 55 client keeps working unchanged. Same `inventory.manage` permission,
  same destination-branch-only guard for a restricted member. No new permission, no re-seed. Malformed JSON is a 400.
- **Audit**: `stocktransfer.receive` metadata gained `shortLineCount`, `totalShortfallValue`, `receivedNothing` and,
  only when short, a `shortLines` array (line id, product, dispatched, received, reason).
- **UI**: the one-click **Confirm Receipt** is unchanged. A new **Received short or damaged...** panel lists each
  line with a quantity box (blank = as dispatched); once a quantity is below what was sent, a reason field and a live
  "N short - MWK X written off" line appear. It warns when *nothing* arrived on any line and points at Cancel instead
  (goods that never left or came back belong at the source; lost or unusable goods belong here). A RECEIVED
  transfer's table gains a Received column with "N short - reason" under any short line, an orange "Received short"
  banner, and the list page shows an orange **Short** tag next to the green Received badge.
- **Verification**: new `npm run verify:stock-transfer-receipt` (55 checks: full/short/all-zero receipts, reason
  rules, every refusal, 3-decimal precision and float-safety at the boundary, zero-cost products, reading a legacy
  receipt back). `tsc --noEmit` (0 errors), `prisma validate` (valid) and `next build` passed against a real generated
  Prisma client this session. All 14 other verify scripts + `check:dates` re-run clean.
- **Deploy**: `npx prisma migrate dev --name stock_transfer_short_receipt` (two new nullable columns on
  `StockTransferLine`, no backfill) + `npx prisma generate`. No re-seed.

### KNOWN LIMITATIONS

- **Dispatch is still all-or-nothing.** There is no backorder or second instalment against one transfer number; a
  shortfall is written off, not kept open as "still owed". *(If the missing goods turn up later, Module 66 now
  reverses the write-off - see below - rather than needing a Stock Take found-stock adjustment.)*
- ~~**A shortfall can't be edited or reversed after the receipt is confirmed**~~ - *closed by Module 66 for the case
  that matters most: stock that turns up later can now be recovered against the transfer that lost it. A shortfall
  that was recorded WRONG (typo in the received quantity) still can't be edited - correct it by Manual Journal Entry.*
- **The reason is free text**, not a category (damaged / missing / theft), so there is no "loss in transit by cause"
  report yet. The audit metadata and line rows carry the data if a future module wants one.
- **The loss is not attributed to a branch in the GL** (journal entries don't carry a branch), so a per-branch
  profit view doesn't show it against either the source or the destination. It is visible per transfer.
- **A receipt of nothing is allowed** (everything lost or unusable) but is a judgement call the form only warns
  about; there is no approval step.
- All other tracked limitations remain open.

## Module 66: Recovering Stock Written Off as Short

Closes the KNOWN LIMITATION Module 65 documented the moment short receipt shipped: "a confirmed shortfall can't be
edited or reversed". Stock that "didn't arrive" often does - the second truck, the carton found behind a pallet, the
courier who finally delivers. Until now the only fix was a hand-built Manual Journal plus a stock adjustment, and
nothing tied the recovered goods back to the transfer that lost them.

- **What a recovery is, in the books.** The exact mirror of Module 65. The receipt wrote the shortfall off at
  dispatch-time cost (Dr Inventory Shrinkage & Adjustment / Cr Inventory) and left the quantity books alone (the
  TRANSFER_OUT had already removed the units). A recovery therefore posts (a) a real `TRANSFER_IN` at the
  **destination** branch for the recovered quantity - this is a genuine stock increase - and (b) the write-off
  reversed for those units: **Dr Inventory / Cr Inventory Shrinkage & Adjustment**, via the new
  `postJournalEntryForTransferRecovery()` in `accounting-integrations.ts`, `referenceType: "StockTransferRecovery"`,
  keyed to the line.
- **Same cost as the write-off, never today's.** Recovered units are valued at `unitCostAtDispatch` (falling back to
  current `purchasePrice` for a pre-Module-59 line) - exactly what Module 65 used. Recovering at a different cost would
  leave a residue in the shrinkage account that no real loss explains. Dated "now" (no explicit `entryDate`), so it
  never lands in a closed period even if the write-off it reverses does - reopening a period just to undo a write-off
  would be disproportionate.
- **Schema (one nullable column on `StockTransferLine`)**: `quantityRecovered Decimal(14,3)?` - the running **total**
  brought back so far. Cumulative on purpose: a line can come back in several instalments. `NULL` = nothing recovered
  (every transfer before this module, every line that arrived in full). Not backfilled. The per-recovery detail (note,
  quantities) lives in the AuditLog, not in more columns.
- **New pure, import-free `src/lib/stock-transfer-recovery.ts`**: `resolveRecovery()`, `outstandingShortfall()`
  (dispatched - received - recovered, never negative), `lineRecovered()`, `transferHasOutstandingShortfall()`,
  `transferHasRecovery()`, `validateRecoveryNote()`. Import-free so the "use client" workspace runs the **same**
  function the server does. Thousandths, not floats, as in Module 65.
- **Rules (never guessed, never clamped)**: at least one line must be named - unlike a receipt there is **no
  "omitted means full" default**, because recovering stock is a positive act; quantity > 0, at most 3 decimals, and no
  more than what is **still** outstanding (extra stock is a new transfer or a purchase, not a recovery); a line that
  arrived in full, is pre-Module-65, or is already fully recovered is refused; unknown/duplicate line ids are refused;
  one bad line fails the whole recovery. A note (trimmed, max 200) saying where the stock turned up is required.
- **`recoverStockTransferShortfall()`** (`stock-transfers.ts`): only a RECEIVED transfer can have a shortfall
  (IN_TRANSIT and CANCELLED get specific refusals). `resolveRecovery()` runs before any write. **Concurrency**: each
  line's `updateMany` is conditioned on `quantityRecovered` still holding the value that was read (NULL included), so
  two people recovering the same line at once cannot both claim the same units - the loser matches zero rows and the
  whole recovery is refused with a "reload and try again" message. Same fail-closed idea as the `status` claim in
  receive/cancel, applied to the one column that changes here.
- **Route**: new `POST .../stock-transfers/[transferId]/recover`, body `{ lines: [{ lineId, quantityRecovered }], note }`.
  Reuses `inventory.manage`; a branch-restricted member may only do it for a transfer that landed at their **own**
  branch (the units go into that branch's stock). No new permission, no re-seed.
- **Audit**: `stocktransfer.recover_shortfall` with `note`, `totalValue` and per-line `recovered` /
  `outstandingAfter` / `fullyRecovered`.
- **UI**: on a RECEIVED transfer with stock still missing, a **Missing stock turned up...** panel lists only the lines
  still short, with a quantity box (blank = none of it), a live "N back into stock - MWK X of the write-off reversed"
  line, and a required note. The Received column shows "N recovered later, M still missing". The orange "Received
  short" banner clears once nothing is outstanding (a green line explains it arrived short but was fully recovered),
  and the list page's orange **Short** tag becomes a quiet gray **Recovered** tag.
- **Verification**: new `npm run verify:stock-transfer-recovery` (65 checks: outstanding maths incl. legacy/float
  cases, partial/full/cumulative/multi-line recoveries, value rounding, every refusal, 0.1+0.2 precision, the note
  rules). `tsc --noEmit` (0 errors), `prisma validate` (valid) and `next build` passed against a real generated Prisma
  client this session. All 15 other verify scripts + `check:dates` re-run clean.
- **Deploy**: `npx prisma migrate dev --name stock_transfer_recovery` (one new nullable column on
  `StockTransferLine`, no backfill) + `npx prisma generate`. No re-seed.

### KNOWN LIMITATIONS

- **A wrongly-entered shortfall still can't be edited** - only genuinely recovered stock can be brought back. A typo in
  the received quantity is corrected by Manual Journal Entry (and a stock adjustment if the quantity books are wrong).
- **Recovery is not a receipt of damaged goods.** Only stock that turned up **usable** should be recovered; goods that
  arrived damaged stay written off.
- **A recovery can't be undone.** Recovering too much is refused, but a recovery entered against the wrong line is
  corrected by a Manual Journal Entry plus a stock adjustment.
- **Recovered units go to the destination branch only.** If the goods physically turned up back at the source branch,
  cancel-style handling doesn't apply (the transfer is RECEIVED) - use a new transfer or a Stock Take found-stock
  adjustment there.
- **The recovery note is free text**, stored in the AuditLog only, so there is no "recovered stock" report yet.
- All other tracked limitations remain open (dispatch still all-or-nothing, reason not categorised, loss not attributed
  to a branch in the GL).

## Module 67: Tax Payment Installments

Closes the KNOWN LIMITATION `src/lib/tax-payments.ts` has carried since Module 33: one RECORDED payment per (tax type,
period), no installments. A business that pays the MRA its PAYE in two instalments had to record one lump sum after
the fact, or leave the Tax Calendar showing an overdue obligation that was half paid.

- **Scope.** PAYE, withholding tax, provisional tax and annual income tax. **VAT stays one payment**: its principal is
  computed from the return and cleared against VAT_OUTPUT_PAYABLE / VAT_INPUT_RECEIVABLE as a whole, so a part-payment
  has nothing sound to clear. A VAT part-payment is refused, not ignored.
- **Schema (two columns on `TaxPayment`, both with real defaults, no backfill)**: `installmentNo Int @default(1)` and
  `settlesPeriod Boolean @default(true)`. Every existing row is therefore "instalment 1, closes its period" - exactly what
  it meant before. `activePeriodKey` keeps its unique index: instalment 1 uses the original
  `<businessId>|<taxType>|<periodKey>`, instalment 2+ appends `|<n>`. Two people recording the same instalment number at
  once still collide on the index (P2002 -> readable message).
- **New pure, import-free `src/lib/tax-installments.ts`**: `summarizeSettlement()`, `decideInstallment()`,
  `installmentKey()`, `supportsInstallments()`. Import-free so the client form and the server share one definition.
  Money is compared in whole tambala, not floats (0.1 + 0.2 reaches 0.3).
- **When a period is settled** - computed live, never stored: any RECORDED payment with `settlesPeriod` true, **or** the
  recorded principals reaching the period's figure (a zero figure is settled by any payment). Voiding a part-payment
  therefore re-opens the period by itself; there is no stale "paid" flag to repair.
- **Rules (never clamped)**: a normal payment behaves exactly as before (`partial` absent = closes the period, and the
  first payment keeps its old freedom to exceed the estimate, still capped by the PAYE/WHT liability balance). A payment
  marked **part-payment**, or any payment after the first, must fit inside what is still owed; a part-payment for
  exactly the remainder is recorded as the final one; a settled period refuses further payments (extra is
  penalty/interest, or void a wrong one). Instalment numbers continue from the highest RECORDED one.
- **`createTaxPayment()`** takes optional `partial`. Each instalment posts to both ledgers exactly like a single payment
  (cashbook + GL, principal + penalty), so nothing about journal posting, voiding or reversal changed. A penalty can ride
  on any instalment. Audit `taxpayment.create` metadata gained `installmentNo`, `settlesPeriod`.
- **`getTaxPaymentPreview()`** now also returns `installments` (count, paid, remaining, settled, the payments) and
  `canPayInInstallments`. `alreadyRecorded` now means **settled** for non-VAT types, so the record form only blocks a
  period that is actually done.
- **Tax Calendar**: `status: "paid"` now means settled. A part-paid entry keeps overdue/upcoming and gains
  `partPaid { paid, remaining, installmentCount }`; every entry has `installmentCount`. The hub shows
  "Part-paid: X in N payments - Y left" and the link becomes "Record next payment".
- **Bell alerts**: a part-paid period keeps its TAX_DUE alert, the body says what is still to pay, and the tracked
  `amount` is the **remaining** figure - so paying another instalment resurfaces a dismissed alert via Module 61's
  amount snapshot, and a settled period resolves it as before.
- **UI**: the record form suggests the remaining amount, lists payments already made for the period and offers a
  "this is a part-payment" checkbox; the detail page shows the instalment and every payment recorded for the period with
  a running total; the list page tags part/final instalments.
- **Verification**: new `npm run verify:tax-installments` (88 checks: settlement maths, key format, every refusal, float
  safety, VAT rules, a three-step sequence and voiding a middle instalment). `tsc --noEmit` (0 errors), `prisma validate`
  (valid) and `next build` passed against a real generated Prisma client. All 16 other verify scripts + `check:dates`
  re-run clean.
- **Deploy**: `npx prisma migrate dev --name tax_payment_installments` (two columns with defaults) + `npx prisma generate`.
  No re-seed.

### KNOWN LIMITATIONS

- **The period's figure is a live estimate.** For PAYE it is the PAID payroll for the month, for withholding and income
  tax a computed estimate; if it moves after part-payments, "remaining" moves with it. The MRA's receipt is the source
  of truth for what is owed.
- **A payment flagged as final settles the period even if the total is below the figure** - that is the point of the
  flag (the MRA assessed less). Voiding it re-opens the period.
- **No due-date per installment or payment plan schedule** - the Tax Calendar still has one due date per period.
- **VAT can't be part-paid**, and a VAT period with carried-forward credit is unchanged.
- **An installment can't be edited**, only voided and re-recorded.
- All other tracked limitations remain open.

## Module 68: Free-Text Quotation Lines Can Be Linked to a Product at Convert Time

Closes the KNOWN LIMITATION carried since Module 15 and repeated in Module 38: a quotation with a free-text line (an
item not yet in inventory) could not be converted to a sale. The person had to leave the page, edit the quotation,
link the line, come back and convert - the one step standing between "customer accepted" and "sale recorded", and the
usual case for a shop that quotes before it has stocked.

- **What changes.** The convert form now lists each free-text line with a product picker. Choosing a product for every
  such line enables "Complete Sale". The sale takes stock from the chosen product **at the quoted price and quantity**
  (the quoted description, price and totals are what the customer was shown and are not rewritten); VAT is computed by
  `createSale()` from the chosen product, exactly as for a linked line.
- **New pure, import-free `src/lib/quotation-line-mapping.ts`**: `resolveLineMapping()` and `freeTextLines()`. The
  client form and the server share it, so the button is only enabled for a choice the server will accept. Rules, never
  guessed or clamped: a choice may only name a line on this quotation; only a line that is **still free-text** (an
  already-linked line is never re-pointed - edit the quotation for that); a line can be chosen once (even with the same
  product twice); after applying the choices **every** line must be linked. Anything left over is refused by name
  ("A", "B", "C" and 2 more...). The same product may be chosen for several lines.
- **`convertQuotationToSale()`** takes optional `input.lineProducts: [{ itemId, productId }]` (validated by
  `convertQuotationSchema`, max 200). After the Module 38 claim it resolves the mapping, checks each chosen product
  exists **in this business** and is **active**, writes the link to `QuotationItem.productId`, then calls `createSale()`
  with the resolved products. All of it is inside the claim's transaction, so a refused choice, a stock failure, the
  monthly sales cap or the partial-payment-needs-a-customer check rolls the link back too: the line is free-text again
  and the quotation is exactly as it was.
- **Why write the link back.** So the converted quotation shows what each line was sold as. Only `productId` is written.
  Omitting `lineProducts` behaves exactly as before (every line must already be linked), so existing API clients are
  unchanged apart from the refusal message wording.
- **UI.** `/quotations/[id]` fetches the active catalog only when there is a free-text line, the quotation is not yet
  converted and the person may convert (`sales.create`, the same permission as before - no new permission, no
  re-seed). If there are no active products to choose from, the old "add it to inventory or edit the quotation" note
  is shown instead.
- **No schema change, no migration, no re-seed.**
- **Verification:** new `npm run verify:quotation-line-mapping` (55 checks: the pure resolver's every refusal and
  ordering, plus the real `convertQuotationToSale()` against an in-memory fake with rollback semantics - link persisted
  on success, and unknown / other-business / inactive product, already-linked, unknown and duplicate line choices, a
  stock failure after the link and the customer check all leave the line free-text with no sale). The Module 38 script
  needed line ids in its fake and one message updated (43/43). `tsc --noEmit` 0 errors, `prisma validate` valid,
  `next build` passes, all 17 other verify scripts + `check:dates` clean.
- **Deploy:** nothing to migrate. Deploy the code.

### KNOWN LIMITATIONS

- **The quotation's own totals are not recomputed.** A linked free-text line keeps its quoted price, description and VAT
  estimate (which assumed STANDARD for a free-text line); the Sale prices VAT from the chosen product. If the product
  is exempt or zero-rated the sale's VAT will differ from the quotation's printed figure - the sale is the truth.
- **The chosen product is not checked against the quoted price.** A line quoted at 500 can be sold as a product whose
  selling price is 2,000; the picker shows selling prices to make that visible, nothing more.
- **A link can't be undone after conversion** (the quotation is CONVERTED and not editable). Correct with a credit note.
- **The picker lists up to 1,000 active products** in name order, no search box; a larger catalogue needs one.
- **Free-text lines still can't be sold without a product** - there is no "sell a non-stocked service" path; that would
  be a data-model change (a product type for services with no stock).
- All other tracked limitations remain open.

## Module 69: Recorded Statement Start Date (Exact Out-of-Period Check)

Closes the KNOWN LIMITATION Module 64 documented (and Module 62/63 carried): a bank reconciliation stored only its END
date (`statementDate`), so "this line is dated before the statement" could only be guessed (more than 92 days before the
end). A quarterly statement was at risk of false warnings; a line from last month's statement, one day before this one
begins, was never caught.

- **Schema (one nullable column, no backfill)**: `BankReconciliation.periodStart DateTime?` - the FIRST day the
  statement covers, stored like `statementDate` (calendar day at UTC midnight). NULL = unknown, so every existing
  reconciliation behaves exactly as under Module 64. It is informational: the books side is still cut off at
  `statementDate`; nothing about which transactions are in scope changed.
- **Pure additions in `src/lib/bank-statement-csv.ts`** (import-free, shared by server and client):
  `classifyLineDate()`/`flagOutOfPeriod()` take an optional `periodStart`; new `PeriodFlag` value **`BEFORE_START`**
  (definite, like `AFTER_STATEMENT`). With a start date the 92-day guess is not used at all (no `LONG_BEFORE`); without
  one, Module 64 behaviour is unchanged. An unusable start string is treated as absent, never as a reason to flag
  every row. Also `nextDayYmd()`, `validatePeriodStart()` (must be a real day, not after the statement date; a
  one-day statement is allowed) and `suggestPeriodStart()`.
- **Opening**: the "Start a Reconciliation" form has an optional "First day on the statement" field, pre-filled with
  **the day after the same account's latest COMPLETED statement that ends before this one** (new
  `getSuggestedPeriodStart()`, `GET .../bank-reconciliation/period-start-suggestion?accountId=&statementDate=`). It is a
  suggestion the person confirms or clears, never applied silently (statements can have gaps or overlap); once they
  edit the box a later suggestion never overwrites it. `openBankReconciliation()` refuses a start after the statement
  date by name; it is never clamped.
- **Setting later**: new `setBankReconciliationPeriodStart()` / `PUT .../[reconciliationId]/period-start`
  (`{ periodStart: ISO | null }`) sets, changes or clears it while IN_PROGRESS, so reconciliations opened before this
  module can get the exact check. The write is an `updateMany` conditioned on IN_PROGRESS inside a transaction, audited
  as `bankrecon.set_period_start` (previous, new, out-of-period count). It changes how lines are FLAGGED only - no line
  is deleted, ignored, re-matched or rewritten. `bankrecon.manage`, no new permission, no re-seed.
- **Where the exact check applies**: typed lines (`addBankStatementLine()` returns `BEFORE_START` in `periodFlag`), CSV
  import (`ImportBankStatementResult` gained `periodStart` and `beforeStartRows`; the existing "leave these rows out"
  option covers them; audit metadata gained both), and lines already in the reconciliation: `getBankReconciliation()`
  returns `outOfPeriodLines` computed live (never stored) and the workspace tags each such line ("after statement" /
  "before start" / "long before") and shows a banner. The client runs the same pure classifier as the server, so tags and
  counts always agree.
- **UI**: header shows "Statement period: A to B" (or "start date not recorded") with Set/Change/Clear start date;
  import preview and add-line notice mention the start date.
- **Verification**: new `npm run verify:bank-statement-period-start` (57 checks: boundaries on the first and last day,
  one-day statement, quarterly statement not hit by the guess, fallbacks and garbage input, month/year/leap-year
  rollover in `nextDayYmd`, validation refusals, suggestion choice among several statements). `tsc --noEmit` 0 errors,
  `prisma validate` valid, `next build` passes, all 18 other verify scripts + `check:dates` clean (Module 62-64's 159
  checks unchanged).
- **Deploy**: `npx prisma migrate dev --name bank_reconciliation_period_start` (one nullable column) + `npx prisma
  generate`. No re-seed.

### KNOWN LIMITATIONS

- **Reconciliations opened before this module have no start date** until someone sets one; they keep the 92-day guess
  (no backfill - a start date can't be recovered reliably from earlier statements, which may have gaps).
- **The suggestion only looks at COMPLETED statements** for the same account; an in-progress earlier one is ignored.
- **Overlaps between consecutive statements are not detected.** A start date earlier than the previous statement's end
  is accepted (some banks overlap); lines are still de-duplicated only within one reconciliation (Module 62).
- **Start date is informational**: it doesn't limit which book transactions are considered, and a completed
  reconciliation's start date can't be edited (reopen it first).
- **Fixed 92-day guess stays for unknown-start reconciliations**; live bank-feed support (Module 62) remains open.
- All other tracked limitations remain open.

## Module 70: Cross-Statement Overlap & Repeated-Line Check

Closes two limitations Module 69 documented (and 62 before it): "overlaps between consecutive statements are not
detected" and "duplicates are only checked within one reconciliation". Why it matters: a line already settled on an
earlier statement has its book transaction matched THERE, and one book transaction can settle only one statement line
(`matchedTransactionId` is unique). Import the same line again into a later reconciliation and it sits UNMATCHED forever,
blocking completion.

- **No schema change, no migration, no re-seed, no new permission** (`bankrecon.manage` as before). Everything is
  computed live from rows that already exist, never stored.
- **New pure, import-free `src/lib/statement-overlap.ts`** (same split as `bank-statement-csv.ts`):
  - `findOverlappingStatements(current, others)` - which OTHER statements of the same account share calendar days with
    this one. Needs BOTH ranges known: a statement with no recorded start (anything before Module 69) is counted in
    `notComparable`, never guessed at (unlike Module 69 there is no sensible heuristic, so the honest answer is "can't
    tell"). Sharing one boundary day counts as a 1-day overlap (some banks repeat the closing day) and is only a warning.
    Unusable ranges (start after end, impossible dates) are `notComparable`, not errors.
  - `flagRepeatsOfOtherStatements(rows, otherLines, skip?)` - rows whose date + description + amount already sit on
    another statement of the account. COUNT-AWARE like Module 62 (if another statement holds a key twice, only the first
    two matching rows are flagged, so a genuinely new identical line still gets through). The `skip` callback lets the
    caller pass over rows that are already within-statement duplicates WITHOUT using up a count, so one row is never both
    flags and skip counts never overlap. `repeatKey()` is the same key as Module 62's `statementLineKey()` (a check pins them equal).
  - `lineDateSpan()` bounds the database query to the dates in the file, so a long history stays cheap.
  - `describeOverlap()` - one sentence, shared by the banner and the import preview.
- **Import** (`importBankStatementCsv()`): new `skipOtherStatementRepeats` option (default false - warns only, because a
  genuinely repeated transaction across statements is possible). Result gained `repeatedElsewhereRows`,
  `repeatedElsewhereOnlyRows`, `skippedRepeatedElsewhere` and `statementOverlaps`; each preview row has
  `repeatsOtherStatement`; audit metadata gained the repeat counts and `overlappingStatementIds`. Precedence when a row
  has several problems: within-statement duplicate, then repeated elsewhere, then out of period - each skipped row is
  counted once. `outOfPeriodOnlyRows` now also excludes repeated-elsewhere rows, so it is still exactly what "leave these
  rows out" removes.
- **Typed lines**: `addBankStatementLine()` returns `repeatsOtherStatement` alongside `periodFlag`; the line is still
  added, the workspace shows an amber note.
- **Existing lines**: `getBankReconciliation()` returns `statementOverlaps`, `overlapNotComparable` and
  `repeatedLineIds` (count-aware), so lines imported before this module get tagged too.
- **UI**: an amber banner on the reconciliation page listing overlapping statements (each links to that statement); a
  banner plus an "on another statement" tag per repeated line; the import preview gains an overlap note, a repeated-rows
  box with a "Leave these rows out" checkbox, and a per-row tag. The "Import N lines" count now comes from the server's
  own dry run, which re-runs whenever a skip option changes - three interacting skip options made a client-side
  re-derivation error-prone.
- **Verification**: new `npm run verify:statement-overlap` (56 checks: adjacent, partial, contained, single boundary day,
  leap-day and year rollover, unknown/garbage ranges, sorting and tie-breaks, key equality with Module 62, count-aware
  flagging, the skip callback, the interaction with `flagDuplicates`, date span). `tsc --noEmit` 0 errors, `prisma
  validate` valid, `next build` passes, all 19 other verify scripts + `check:dates` clean (Modules 62-64's 159 checks unchanged).
- **Deploy**: nothing to migrate. `npm install` and, if the client is stale, `npx prisma generate`. No re-seed.

### KNOWN LIMITATIONS

- **Overlap needs both start dates.** Statements opened before Module 69 (or without a start) can't be compared; the
  banner-side count is `overlapNotComparable` and nothing is inferred from their end dates.
- **Repeat detection matches exact date + description + amount** (whitespace and case ignored). A bank that words the
  same transaction differently on two statements is not caught; nothing fuzzy is attempted.
- **The check only looks at lines on other reconciliations of the SAME account.** A line imported into the wrong account
  is not detected.
- **Warns, never blocks**, and only the import has a "leave out" option; a repeated typed line is deleted by hand.
- **Overlap is not repaired**: no tool moves or merges lines between statements, and a completed statement's lines still
  can't be edited without reopening it.
- **Statement ranges are compared as-is**: no attempt is made to work out which statement "owns" a shared day.
- Live bank-feed support (Module 62) remains open. All other tracked limitations remain open.

## Module 71: Reading Africa's Talking's Per-Recipient Delivery Status

Closes a limitation Module 24 documented the day SMS sending shipped: `deliverSms()` recorded ANY HTTP 200 from Africa's
Talking as `SENT`. But the gateway answers 200/201 when it accepted the *request*, and reports each recipient's outcome
inside the body (`SMSMessageData.Recipients[].statusCode`). An invalid number, an unsupported number type, an empty
Africa's Talking balance or an opted-out recipient all come back as HTTP 200, so `/notifications` showed a green `SENT`
(and the customer reminder screen said "Reminder sent.") for a text that never left. Chosen autonomously: it is the
most misleading of the tracked notification gaps, because it reports success that did not happen.

- **No schema change, no migration, no re-seed, no new permission, no new route.** The reason for a failure goes in the
  existing `NotificationLog.errorMessage`.
- **New pure, import-free `src/lib/sms-delivery.ts`** (same split as `bank-statement-csv.ts`: `notifications.ts` imports
  Prisma at module scope, so anything a plain-Node script must exercise lives in its own file):
  - `parseAfricasTalkingResponse(bodyText)` returns `{ status: "SENT" | "FAILED", confirmed, errorMessage?, recipients }`.
  - A recipient is accepted ONLY for `statusCode` 100 (Processed), 101 (Sent) or 102 (Queued). Every other code, and any
    code the file doesn't know, is a failure that names the code, the gateway's own word and, for the documented ones, a
    plain-words hint (405 = "the Africa's Talking account balance is too low - top it up", 403 = "check the phone number,
    including the +265 country code", and so on).
  - **The code beats the word**: a row with code 403 that also says `"Success"` is a failure; a row with code 101 and a
    failure word is a success. The status word is consulted only when the numeric code is missing.
  - An **empty `Recipients` list is a failure** (that is how the gateway reports a number it refused outright), reported
    with its own `Message` text.
  - Several recipients with any failure = the whole send is `FAILED` and the message says which (`sendSms()` only ever
    dials one number, so this is defensive rather than a designed bulk path). Messages are clipped to 300 characters.
  - **A body that can't be read at all is neither called a failure nor a clean success.** The request was accepted, and
    calling it `FAILED` would invite a duplicate resend of a text that may have gone out; but silently calling it
    `SENT` is the bug this module fixes. It is `SENT` with `confirmed: false` and an explanatory `errorMessage`
    ("...delivery is unconfirmed"). Covers non-JSON, JSON that isn't an object, no `SMSMessageData`, no `Recipients` list.
- **`deliverSms()`** now passes the raw body through the parser. The non-2xx path (HTTP error) is unchanged. Network
  errors are unchanged.
- **UI**: the Notifications page shows a `SENT` row's `errorMessage` in amber (it only ever shows the unconfirmed note,
  a confirmed success carries none); FAILED rows still show it in red, now with the real reason. The customer reminder
  route's message now distinguishes "Reminder sent." / "handed to the SMS provider, but delivery could not be confirmed"
  / "logged, but the SMS was not delivered" / "no provider configured".
- **Verification**: new `npm run verify:sms-delivery` (168 checks: every documented code, the code-beats-word rule,
  unknown/missing/fractional/non-numeric codes, null rows, empty list, single and mixed multi-recipient bodies, ten
  unreadable-body shapes, clipping, `describeRecipientFailure()`). `tsc --noEmit` 0 errors, `prisma validate` valid,
  `next build` passes, all 20 other verify scripts + `check:dates` clean.
- **Deploy**: nothing to migrate. `npm install` and, if the client is stale, `npx prisma generate`. No re-seed. Nothing to
  configure: the same `SMS_PROVIDER_API_KEY` / `SMS_PROVIDER_USERNAME`.

### KNOWN LIMITATIONS

- **The parser was written from Africa's Talking's documented response shape and status codes, not against a live
  account.** The tests use bodies of that shape; nobody has sent a real text from this build. If the gateway adds or
  renames a code, an unrecognised code fails closed (a failure naming the code) rather than being trusted.
- **"Accepted" is not "delivered to the handset".** Codes 100-102 mean the gateway took the message; the final handset
  delivery report arrives later by webhook, which this app does not receive. `SENT` still means "accepted by the gateway".
- **The provider's message id and cost are parsed but not stored** (no column for them); only failures and the
  unconfirmed note are written down.
- **Still no retry queue** (closed by Module 75) for a `FAILED` send, no bulk-SMS path, and email (Resend) is unchanged. `FAILED` is now more
  common than before because refusals that used to hide behind a 200 are visible: that is the point, but an Owner with
  many bad phone numbers will see it.
- **No phone-number normalisation**: the number is sent as typed on the customer record. A local `0999...` number is a
  likely `InvalidPhoneNumber` refusal, and the hint says to include +265.
- All other tracked limitations remain open.

## Module 72: Phone-Number Normalisation for SMS

Closes the limitation Module 71 documented last: "No phone-number normalisation". Customer and supplier phones are free
text ("0999 123 456", "099-912-3456", "265999123456"), and `sendSms()` handed that text to Africa's Talking untouched, so
anything but strict `+265999123456` was likely an `InvalidPhoneNumber` refusal. Chosen autonomously, then extended in the
same module to clear the four limitations its first cut listed (stored numbers not rewritten, `auth.ts` left on the old
rule, no landline/operator detection, supplier and employee phones never texted).

- **No schema change, no migration, no re-seed, no new permission.** Two new routes, one new script.
- **`src/lib/phone.ts`** (pure, import-free): `normalizePhoneNumber()` returns `{ ok, e164, changed, assumedMalawi,
  foreign, lineType, operator }` or `{ ok: false, reason }`.
  - Malawi is understood in every written form: `0999123456`, `999123456`, `265999123456`, `+265999123456`,
    `00265999123456`, `+265 (0) 999 123 456`, and the 7-digit landline forms (`01771234`, `+265 1 771 234`,
    `2651771234`). Spaces, dashes, dots and brackets are ignored.
  - A `+`/`00` number with another country code passes through as international, length-checked only (8 to 15 digits,
    no leading zero). Other countries' rules are not known to this build.
  - **Refused, never guessed**: a field with more than one number ("a / b", "a, b", "a or b"), letters or symbols, a
    misplaced `+`, and a number with no `+`/`00`/leading 0 whose length is not 9 or 12 digits. Each refusal carries a
    one-sentence reason.
  - **Line type and operator** (from the MACRA numbering plan, read off the prefix after +265): starts with `1` or `21`
    = LANDLINE; 9 digits starting `8`/`9`, or `77` = MOBILE; anything else (`31` VoIP, `22`, foreign) = UNKNOWN, never
    refused on a guess. Operator is a display-only prefix guess (88/89 TNM, 98/99 Airtel; numbers can be ported) and never
    blocks anything.
  - `checkSmsDeliverable()`: a readable LANDLINE is refused for SMS (a fixed line cannot receive a text); MOBILE and
    UNKNOWN go to the gateway, which has the final word.
  - `preparePhoneForSave()` (what gets stored) and `planPhoneRewrite()` (what the backfill does), both pure.
- **Stored numbers are now rewritten.** Customer, supplier and employee create/edit routes store the canonical `+...`
  form and answer 400 `invalid_phone` with the reason for an unreadable one (a landline IS stored; it is only refused at
  send time). An unchanged legacy value is left as is, so editing another field of an old record is never blocked by a
  phone nobody touched. Employee create checks the phone before taking an employee number.
- **Backfill for existing rows**: `npm run phones:normalize` (dry run) / `npm run phones:normalize -- --apply` rewrites
  User, Business, Customer, Supplier and Employee phones. Unreadable values are reported, never changed or blanked.
  `User.phone` is unique and the login key: a rewrite that would collide with another account is skipped and reported.
  Safe to re-run. Logic lives in `src/lib/phone-backfill.ts`.
- **Login/registration use the same reader**: `auth.ts::normalizePhone()` now delegates to `phone.ts` (unreadable input
  is returned trimmed, never throws). Login tries the normalised number first, then the pre-Module-72 form, so an account
  saved with an odd number (for example from a team invite) is not locked out before the backfill has run. Accepting a
  team invitation now refuses an unreadable phone with a reason instead of storing it.
- **`sendSms()`** normalises first, dials `+265...`, logs that in `NotificationLog.recipientAddress`, and logs an
  unreadable or landline number as `FAILED` with `providerName = "phone-check"` before any provider is called. It returns
  `dialedTo`. The customer reminder route reports the same.
- **Suppliers and employees can now be texted**, manually only (nothing sends on its own):
  - `POST /api/business/:id/suppliers/:supplierId/payment-notice` `{ paymentId }` (`suppliers.manage`): "Text supplier"
    beside each payment on the supplier page. The payment must belong to this business and supplier (else 404).
    Template `supplier_payment_notice`; audit `supplier.payment_notice_sent`.
  - `POST /api/business/:id/payroll/:payrollId/notify` (`payroll.manage`): "Text employee" on a PAID payroll row, behind a
    confirm because the message carries the net pay. Refused unless the run is PAID (`not_paid`); a branch-restricted
    member can only do it for their own branch's employees. Template `employee_pay_notice`; audit
    `payroll.pay_notice_sent`.
  - Wording in pure `src/lib/party-messages.ts`. No phone on file returns a plain note instead of failing.
- **UI**: `src/components/phone-hint.tsx` under the phone field on the customer, supplier and employee forms and on the
  customer, supplier and employee pages ("Texts will go to +265999123456 (Airtel)." or an amber "Cannot be texted: ...");
  `src/components/send-notice-button.tsx` for the two new buttons.
- **Verification**: `npm run verify:phone` (147 checks: every Malawian spelling, landline and operator classes, foreign
  passthrough, every refusal class, save and backfill decisions, the backfill run against in-memory stores including unique
  collisions and re-run safety, and the exact SMS wording). `tsc --noEmit` 0 errors, `prisma validate` valid,
  `next build` passes, all 22 verify scripts and `check:dates` clean.
- **Deploy**: nothing to migrate. `npm install`, and `npx prisma generate` if the client is stale. To tidy existing data
  run `npm run phones:normalize`, read the plan, then `npm run phones:normalize -- --apply`. No re-seed.

### KNOWN LIMITATIONS

- **The backfill script and the two new routes were type-checked and built but not run against a live database in the
  build environment** (no Prisma engine available there); the backfill's decisions are verified against in-memory stores.
  Run the dry run on staging first.
- **Numbering-plan data is a snapshot** (MACRA 2009 plan, plus the 31 VoIP range announced in 2017). A new prefix shows as
  UNKNOWN and is still sent to the gateway; it is never blocked. Operator names are prefix guesses and ignore porting.
- **Only Malawi's rules are known**; a foreign number is checked for length only.
- **Registration still accepts only the strict `0`/`+265` + 9 digits form** (`registerSchema`); it is stricter than the
  shared reader on purpose and was left alone.
- **Unreadable stored numbers are reported, not fixed**: a person has to correct them on the record.
- **No automatic supplier or employee texting**: both notices are a button press. There is no "notify on every payment"
  setting and no per-business message template.
- Everything else Module 71 listed remains open: accepted is not delivered, message id/cost not stored, no retry queue (closed by Module 75).

## Module 73: Payment Gateway for Subscriptions (PayChangu)

Closes the limitation Modules 26 and 72's predecessors kept repeating: "no real payment gateway". A paid plan can now only
be taken by paying for it. Mobile money (Airtel Money, TNM Mpamba) and cards go through PayChangu's hosted checkout; the
app never sees a card number or a PIN. Chosen autonomously: PayChangu because it is the Malawi gateway callable over
plain HTTPS with no SDK (like Resend and Africa's Talking), hosted checkout so card data stays off this server.

- **One schema change (new table), no new permission.** `GatewayPayment` (+ `GatewayPaymentStatus`): one row per attempt,
  with our own `txRef` (`MBM-SUB-<24 hex>`, unique), the plan, cycle and price snapshotted at checkout start, and
  `status` PENDING -> SUCCEEDED | FAILED. Run `npx prisma migrate dev` (this repo has no migrations folder) and
  `npx prisma generate`. No re-seed.
- **Flow.** `POST /subscription/checkout` validates the plan change first (nobody pays for a change that would be refused),
  writes a PENDING row, asks PayChangu for a checkout link and returns it; the page redirects there. Nothing about the
  subscription changes yet. The customer pays; PayChangu then (a) POSTs `/api/webhooks/paychangu` and (b) sends the customer
  back to `/settings/billing?tx_ref=...`, which calls `POST /subscription/payments/[txRef]/check`. Both routes run the same
  `settleGatewayPayment()`. Either alone is enough, and both at once is safe.
- **Nothing is taken on trust.** The settle step never reads "success" from the webhook or the URL. It asks PayChangu's
  verify endpoint and applies the plan only if the INNER payment status is success AND the reference is ours AND the
  currency is MWK AND the amount is at least the snapshotted price (more is accepted, since a gateway may add its fee). An
  underpayment, wrong currency or wrong reference is recorded FAILED with both figures in the reason and the plan is not
  applied. Paid but missing amount/currency/reference, an unknown status word, a non-JSON body or an HTTP error reads as
  "could not confirm" and the row stays PENDING (Module 71's rule: fail closed on the unknown, never call unconfirmed
  confirmed). A 404 is also PENDING, because an abandoned or not-yet-created checkout may still be paid.
- **Applied exactly once.** The claim is a conditional `updateMany WHERE status = PENDING` inside the same transaction as the
  plan change and its audit row, so the webhook and the return page racing each other cannot both apply it. An unexpected
  error (database down) rolls the claim back and the payment stays PENDING for the next retry or press of Check status.
- **Money received but plan change refused** (limits changed while the customer was paying, e.g. a branch was added): the
  payment is kept SUCCEEDED with `applyError` set, a `subscription.payment_apply_failed` audit row is written, and Billing
  shows "Paid, but the plan was not changed" with the reference. A confirmed payment is never silently dropped; a person
  has to apply or refund it.
- **Webhook security.** Public (outside `src/proxy.ts`'s matcher, no session). If `PAYCHANGU_WEBHOOK_SECRET` is set the
  HMAC-SHA256 of the raw body must match (constant-time) or the call is 401; if not set the call is accepted, because the
  gateway is asked directly afterwards anyway. A body with no reference of ours, or an unknown one, is answered 200 so the
  gateway doesn't retry forever; a real failure is a 500 so it does.
- **Plan change rules shared, not copied.** `changeSubscriptionPlan()` was split into `validatePlanChange()` (all the rules,
  no writes) and `applyPlanChange()` (the writes, inside the caller's transaction). The immediate path and the gateway path
  both use them; the rules run again at settle time because limits can change in between.
- **Routing by configuration** (`paymentRouteFor`): the Free plan never needs money. A paid plan with `PAYCHANGU_SECRET_KEY` +
  `NEXTAUTH_URL` set can ONLY be taken through checkout (`changeSubscriptionPlan()` now refuses it). A paid plan with no
  gateway configured still switches immediately and unbilled, as before, so a fresh clone works, UNLESS
  `BILLING_REQUIRE_PAYMENT=true`, in which case it is refused. Production should set that.
- **Renewal.** Paying again for the plan you are on is offered ("Renew"). Renewing the same plan and cycle while ACTIVE stacks
  onto the end of the paid period (paying early loses no days); anything else starts a new period now.
- **Env** (all server-only, never sent to the browser): `PAYCHANGU_SECRET_KEY`, `PAYCHANGU_WEBHOOK_SECRET` (optional but
  recommended), `PAYCHANGU_BASE_URL` (default `https://api.paychangu.com`), `BILLING_REQUIRE_PAYMENT`, and `NEXTAUTH_URL` must
  be the public https origin (PayChangu can't call `localhost`). In PayChangu's dashboard point the webhook at
  `<NEXTAUTH_URL>/api/webhooks/paychangu` and use the same secret.
- **UI** (`/settings/billing`): the old "No payment gateway yet" banner now reflects the real state (online / not set up /
  not set up and required); paid plan buttons read "Pay MWK N and switch" or "Renew"; a Payments table lists attempts (Paid,
  Failed with reason, Waiting for payment with Check status and Continue payment, "No payment received" after 24 hours,
  Paid but not applied with the reference); history gains payment started/failed/apply-failed rows and "paid MWK N" on a
  paid change. Returning from the gateway auto-checks the payment named in the URL.
- **Verification**: `npm run verify:payment-gateway` (106 checks: configuration and routing, reference shape, request body,
  every checkout and verify reply shape including each fail-closed case, the settlement decision incl. over/underpayment,
  currency and reference mismatch, webhook signatures, renewal stacking, and the settle path against an in-memory Prisma
  stand-in: apply, apply twice, underpayment, unreadable, paid-but-not-applied, rollback then retry, forged webhook, tenant
  scoping). `tsc --noEmit` 0 errors, `prisma validate` valid, `next build` passes, all verify scripts and `check:dates` clean.

### KNOWN LIMITATIONS

Module 73's limitations were worked through in Module 74 below; what remains is listed there.

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Set up PostgreSQL** and copy `.env.example` to `.env`, filling in
   `DATABASE_URL`, `NEXTAUTH_URL`, and `NEXTAUTH_SECRET`
   (`openssl rand -base64 32`). `JWT_SECRET` is not used by the current app.

3. **Run migrations and generate the Prisma client**
   ```bash
   npx prisma migrate dev --name init
   ```
   This also runs the seed script automatically (subscription plans +
   permissions) – required before registration will work. If it doesn't
   run automatically, use:
   ```bash
   npx prisma db seed
   ```

4. **Time zone** (Module 35): each business now has its own time zone
   (default Africa/Blantyre, editable under Settings → `/settings/general`), so
   day/month boundaries and every displayed date no longer depend on the
   server's `TZ` (Module 36 moved the last displays). Setting `TZ` on the host
   is no longer needed.

5. **Start the dev server**
   ```bash
   npm run dev
   ```
   Visit `http://localhost:3000`, click **Start Free**, register a business,
   log in, then visit `/inventory` to add your first products.

### Production deployment

Use `npm run check:production-env` before release and follow
[`docs/production-deployment.md`](docs/production-deployment.md). It covers
production migrations, secret configuration, staging provider checks and a
verified database restore. `.env.example` lists the application variables.
Production migrations use `npx prisma migrate deploy`, never
`prisma migrate dev`.

## Module 74: Gateway Hardening, Renewals, Receipts, Refunds and Invoice Payments

Clears the limitations Module 73 listed: unverified field names, no background reconciliation, no renewal handling, no
proration, no refunds, no receipts, immediate-only cancellation, and subscription-only payments. Chosen autonomously.

**A real bug found by reading PayChangu's docs, and fixed.** Module 73 sent `callback_url` = the webhook route. PayChangu
redirects the customer's BROWSER there after paying (the webhook is configured separately in their dashboard), and that route
only answers POST, so a customer who paid landed on a 405 page. Now both `callback_url` and `return_url` are
`/settings/billing/return/<txRef>` (a page; PayChangu appends its own `tx_ref`/`status` query string, so the reference lives in
the path), which hands over to Billing, which asks the server to verify. Also confirmed against the docs: header `Signature`
(HMAC-SHA256 of the raw body), `verify-payment/{tx_ref}`, `data.checkout_url`, inner `data.status`, `data.currency`,
`data.amount`, `data.authorization.channel`; webhooks must be answered 200 and are retried 3 times 30 minutes apart; the docs
tell you not to rely on webhooks alone. Their sample webhook payloads carry `reference`/`charge_id` and no `tx_ref`, so a
webhook naming no reference of ours is now normal and triggers a throttled reconcile of pending payments instead of being ignored.

- **Schema (additive; `prisma migrate dev` + `prisma generate`; no re-seed).** `Subscription`: `requiresPayment`,
  `cancelAtPeriodEnd`, `renewalReminderStage`, `renewalReminderPeriodEnd`. `GatewayPayment`: `prorationCredit`, `excessAmount`,
  `channel`, `lastCheckedAt`, `refundedAmount`, `refundedAt`, `refundNote`. New: `BusinessGatewayConfig`, `SalePayLink`,
  `InvoicePayment` (same refund columns). New enum value `InAppNotificationType.SUBSCRIPTION_RENEWAL`. No new permission.
- **Reconciliation without a scheduler.** `POST|GET /api/cron/billing` (guarded by `CRON_SECRET`, 503 until set) reconciles
  pending subscription AND invoice payments and sends renewal reminders; this Vercel project calls it daily at 01:00 UTC.
  Other hosts can choose their own cadence. Idempotent and safe to overlap. Opening Billing also reconciles that business's recent pending
  payments (max 3, throttled to one look per minute each), and a reference-less webhook reconciles too. The app still runs nothing by itself.
- **Renewal.** True auto-charge is impossible here: mobile money and the hosted card page are approved by the payer each time and
  nothing is stored to charge later. Instead: a paid period now really lapses (`requiresPayment` is set only by a confirmed
  payment, so the unbilled legacy mode still never lapses): PAST_DUE for 3 days (access continues), then EXPIRED. Reminders: an
  in-app bell alert from 7 days out (no scheduler needed) and an email + SMS at 7 days and at 1 day (cron; claim-then-send so
  overlapping runs can't duplicate; one per stage per period end).
- **Proration.** Moving to a DIFFERENT plan or cycle during a paid, ACTIVE period credits the unused whole days of the old plan
  (old list price / cycle days x days left, capped at the new price). The amount asked of the gateway is the price less the credit,
  snapshotted on the row with the credit; if the credit covers the whole price the change is applied immediately with no charge.
  Billing shows the credit on each plan card. Renewing the same plan and cycle is not a change and still stacks onto the paid time.
- **Cancellation.** A paid, still-running period is kept: `cancelAtPeriodEnd` is set, access continues, and the status turns
  CANCELLED by itself when the end passes. "Keep my subscription" undoes it. Trials, unbilled plans and lapsed periods still
  cancel immediately. No refund of paid time.
- **Receipts.** PDF (`GET .../subscription/payments/[txRef]/receipt`, same layout engine as other documents) and an HTML email on
  confirmation (best effort, logged like other messages). Seller details come from `PLATFORM_NAME` / `PLATFORM_EMAIL` /
  `PLATFORM_PHONE` / `PLATFORM_ADDRESS`. The receipt number is derived from the reference (no counter). No tax line is printed:
  the operator's VAT position is unknown to the app.
- **Refunds (operator tool).** PayChangu's hosted checkout has no refund call (only direct card charges do), so this app cannot
  move the money. `npm run gateway:payments` lists confirmed payments needing a person (paid-but-not-applied, unrefunded excess);
  `-- apply <txRef> --apply` applies a paid-but-refused subscription payment once the cause is fixed; `-- refund <txRef> <amount>
  "<how paid back>" --user <userId> --apply` records a refund you made from your PayChangu account, validated against what was paid
  and cumulative. Dry run unless `--apply`. Tenants see "refunded MWK N" on Billing and the receipt. Never a tenant action.
- **Customer invoice payments.** Money must reach the business, so each business enters ITS OWN PayChangu keys on
  `/settings/online-payments` (`business.settings.manage`), stored AES-256-GCM encrypted (`APP_ENCRYPTION_KEY`, 32 bytes hex or
  base64; the feature switches itself off without it, and keys are never returned, only the last 4 characters). A sale with a
  balance gets a pay link (`payments.record`): `/pay/<32-char token>`, one per sale, revocable, showing only business name,
  invoice number and amount due. The customer pays through the business's own checkout; the business's webhook URL
  (`/api/webhooks/paychangu/business/<businessId>`, shown on the settings page, signed with THEIR webhook secret) plus the return
  page plus the cron job all run the same idempotent settle: ask the gateway with the business's key, compare reference, currency
  and amount, then in ONE transaction claim the row and book an ordinary customer Payment (cashbook receipt + journal entry via the
  same helpers as a hand-typed payment). The method comes from the reported channel (Airtel / TNM / card, else BANK). If the invoice
  was paid some other way meanwhile, only what is still owed is applied and the rest is recorded as excess for the operator.
  Foreign-currency and voided invoices can't be paid online. The public endpoints are rate limited (in memory, per process).
- **Verification**: `npm run verify:payment-gateway` is now 214 checks (adds the documented sample reply/webhook shapes, the redirect
  fix, proration, lapse and cancel-at-end status, reminder staging, refunds, channel mapping, invoice application, encryption incl.
  tamper/wrong-key, rate limit, receipt escaping, and the invoice settle path against an in-memory Prisma: apply, apply twice,
  underpay, unreadable, already-paid-meanwhile, part-paid, voided, ledger failure rollback then retry). `tsc` 0 errors, `prisma
  validate` valid, `next build` passes, all verify scripts and `check:dates` clean.
- **Env added**: `CRON_SECRET`, `APP_ENCRYPTION_KEY`, `PLATFORM_NAME`/`_EMAIL`/`_PHONE`/`_ADDRESS` (all optional except where a
  feature needs them). Module 73's variables are unchanged.

### KNOWN LIMITATIONS

- **Still never run against a live PayChangu account or database.** Shapes now match the published docs, but nothing has talked to
  PayChangu. Use sandbox keys first; a mismatch fails closed (payments stay PENDING). The business webhook assumes the same
  `Signature` scheme as the platform's.
- **No automatic charge.** Renewal is reminders plus a one-tap Renew, because the payer must approve every mobile money/card payment.
- **Proration uses today's list price,** not what was actually paid, and a part-day is not credited.
- **Refunds are recorded, not performed.** The operator pays the money back outside the app; invoice-payment refunds are recorded
  but do not reverse the customer Payment, the sale balance or the journal entry (use the existing refund/credit-note flow for that).
- **The cron job needs production configuration.** `vercel.json` schedules it daily at 01:00 UTC (03:00 in Malawi). Set
  `CRON_SECRET`; Vercel Hobby may invoke it up to an hour after the scheduled time. Daily runs mean payment reconciliation,
  renewal reminders, and notification retries can wait until the next run.
- **Invoice payments:** per-process rate limiting only; one PayChangu account per business; no receipt is generated for the
  customer beyond PayChangu's own email; the link can be paid by anyone who holds it (by design); the gateway fee is not modelled.
- **Receipt/seller tax details** are not printed, and `APP_ENCRYPTION_KEY` loss or change means businesses must re-enter their keys.

## Module 75: Automatic Retry of Failed Emails and SMS

Closes the limitation carried since Module 24 and repeated by 71, 72 and 74: a `FAILED` send stayed failed. Chosen
autonomously, and now cheap and necessary: Module 74 added the cron route, and its renewal reminders are claim-then-send
with nobody watching, so a provider hiccup at 03:00 meant the reminder was simply lost ("a missed reminder beats a
duplicate"). The aim is to remove that trade, so the one thing the queue must never do is send a message twice.

- **Schema (additive; `prisma migrate dev` + `prisma generate`; no re-seed; no new permission).** `NotificationLog` gains
  `attempt` (default 1), `firstAttemptAt`, `retryOfId`, `nextRetryAt`, `retriedAt`, `retryNote` and an index on
  `nextRetryAt`. Not backfilled: a `FAILED` row from before this module has no `nextRetryAt`, so an old failure is never
  resurrected into a message that is weeks late.
- **Every attempt is its own row.** The log stays an append-only record of what was tried. The failed row is "taken over"
  (`retriedAt` set, `nextRetryAt` cleared) and the new attempt (`attempt + 1`, `retryOfId`, same `firstAttemptAt`) is a new row.
- **Only a temporary failure is retried automatically** (`classifyFailure()` in the pure `src/lib/notification-retry.ts`):
  HTTP 408/425/429/5xx, a dropped connection or timeout, Africa's Talking codes 500/501/502. Never retried by the queue:
  a number the app refused (Module 72), a refused/opted-out/landline recipient (403/404/406/407/409), bad credentials or
  an empty SMS balance (401/403, 402/405: a person must fix the account first, then use Retry), and anything not recognised
  (it could even have been delivered). An "accepted but unconfirmed" send (Module 71) is `SENT`, so it is never retried;
  that would be the duplicate.
- **Only unwatched messages are retried automatically** (`RETRY_POLICIES`): password reset, email verification, team
  invitation, plan renewal reminder, subscription receipt. A customer debt reminder, supplier notice or pay notice was sent
  by a person who was shown the result on screen, so those get a Retry button instead of a silent second text.
  Each policy has a number of tries, growing delays (e.g. invitation +10m, +1h, +4h) and a maximum age (a password-reset
  link dies in 30 minutes, so its queue stops at 25).
- **Re-checked when the retry runs, not just when queued.** Past its age limit: dropped. Then a relevance check
  (`isStillRelevant`): a renewal reminder is dropped if the plan was renewed, cancelled or ended; an invitation if it was
  accepted, withdrawn or expired; a verification email if the address is already verified. The reason is written to
  `retryNote` and shown on the row.
- **Cannot double-send.** The row is claimed with a conditional `updateMany` (still `FAILED`, `retriedAt` null, same
  `nextRetryAt`) BEFORE anything is sent. Overlapping cron runs, or a run and a person clicking Retry, race on that write and
  exactly one wins. A row whose retry threw an error stays claimed (annotated "use Retry"), never auto-resent.
- **Cron.** `/api/cron/billing` now also runs `retryFailedNotifications()` (up to 100 due rows per call, oldest first),
  after the renewal reminders, and returns `retries` counts (considered, skipped, sent, logged, failedAgain, dropped, errors).
  Same `CRON_SECRET` and schedule as before; with no cron, the queue simply waits (nothing retries by itself).
- **Retry button.** `/notifications` shows "Attempt N", "Will be retried automatically after ...", the give-up/drop reason,
  and a Retry button on a `FAILED` row that retrying could help. `POST /api/business/[businessId]/notifications/[logId]/retry`
  (`notifications.view`, business-scoped, audit `notification.retry`) refuses a refused recipient, a non-failed row and an
  already-retried row (409 on a race). No age or relevance check there: a person pressing Retry has decided.
- **Verification**: `npm run verify:notification-retry` (96 checks: failure classification for Resend, Africa's Talking, network and
  phone-check cases, policy sanity incl. reset-link lifetime, retry scheduling and give-up, age cap, manual-retry rules,
  displayed state, and the batch runner against an in-memory queue with the same conditional claim: only due rows, idempotent
  second run, overlapping runs send once, person-first race, too-old and irrelevant drops, failed-again/logged counts, one
  throwing row isolated, limit and ordering). `tsc` 0 errors, `prisma validate` valid, `next build` passes, all other verify
  scripts and `check:dates` clean.

### KNOWN LIMITATIONS

- **Never run against a live database or provider.** The Prisma-backed claim/find code is exercised only through the pure
  runner and an in-memory twin; run a cron call against a staging database once.
- **The failure classes are read from error text** (HTTP status and Africa's Talking code in the message). A provider that
  changes its wording lands in UNKNOWN, which is safe (not retried automatically) but means the Retry button, not the queue,
  handles it.
- **A timeout is retried although the first request may have been delivered.** A dropped connection after the provider
  accepted the message looks identical to one before it. Sending twice is possible there; the first-attempt window is short
  (minutes) and only unwatched, low-harm templates are retried this way.
- **The cron job still has to be scheduled by the host.** Retry delays are "not before"; with this project's daily schedule,
  a failed message may wait up to about 24 hours for its next retry attempt.
- **Watched sends (debt reminders, supplier/pay notices) are never retried by the queue,** only by a person.
- Africa's Talking "accepted" is not handset delivery - **closed by Module 76** (delivery-report webhook, below); bulk SMS is still absent.

## Module 76: Africa's Talking Delivery Reports (did the text reach the handset?)

Closes the limitation carried since Module 71 and repeated by 72 and 75: `SENT` only ever meant "the gateway accepted the
request". Whether the text reached the phone is reported later, by a separate HTTP callback (a *delivery report*) that
Africa's Talking makes to a URL you give it. A text to a phone that is switched off, a number on a do-not-disturb list
or a network that dropped it all showed a green SENT. Chosen autonomously over per-installment tax due dates, a
service-product type and a scheduled downgrade: it is the last place the Notifications page can still report success
that did not happen, and the customer-debt and supplier/pay notices (sent by a person who is told "sent" on screen)
are exactly the messages where that matters.

- **`SENT` keeps its meaning.** Nothing that reads `NotificationLog.status` changes. What the network said is a second,
  separate field: `deliveryState` (`NotificationDeliveryState`: `IN_PROGRESS` = handed to the network, `DELIVERED` =
  confirmed on the handset, `UNDELIVERED` = the network gave up). `NULL` = no report (every email, every pre-76 row,
  every console/LOGGED row, and an SMS whose report has not arrived).
- **Schema (additive; `prisma migrate dev` + `prisma generate`; no re-seed; no new permission).** `NotificationLog` gains
  `providerMessageId`, `providerCost`, `deliveryState`, `deliveryReportedAt`, `deliveryFailureReason` and two indexes
  (`providerMessageId`; `businessId, deliveryState`). Not backfilled: an old SMS has no message id to match against.
- **The message id is finally kept.** Module 71 parsed the gateway's per-recipient `messageId` and `cost` and threw them
  away. `deliverSms()` now returns them for a confirmed, single-recipient accept and `sendSms()` stores them. An
  "accepted but unconfirmed" send (Module 71) has no id, so no report can ever be matched to it, and the page says
  nothing about it rather than promising a report that cannot come.
- **New public endpoint `POST /api/webhooks/africastalking/delivery`** (outside `src/proxy.ts`'s matcher, like the
  PayChangu webhooks). Africa's Talking does **not** sign this callback, so it is protected by a long random secret in
  the URL: `...delivery?token=<AT_DELIVERY_REPORT_SECRET>` (the `x-delivery-secret` header is accepted too). **503 until
  the secret is set; 401 on a wrong token before the body is read or the database touched**; compared in constant time;
  body read as text and capped at 8,000 characters; per-process rate limit (600/min per address). Form-encoded body
  (JSON accepted in case a proxy rewrites it).
- **A report can only change the one row it names, and only forward.** Pure, import-free
  `src/lib/sms-delivery-report.ts`:
  - `parseDeliveryReport()` needs an id in a recognisable form and a status word it knows (Success, Sent, Submitted,
    Buffered, Queued, Failed, Rejected). **An unrecognised word changes nothing; it is never read as success.**
  - `phonesMatch()`: if the report names a number it must be the one we dialled (last nine digits when both have them),
    else 409 and nothing is written.
  - `decideDeliveryUpdate()`: nothing -> in progress -> delivered|undelivered, forward only. Reports arrive out of order
    and twice; **a late "Sent" never undoes "Success"**, a repeat is a no-op, and **the first final answer wins** - a
    contradicting later one is refused ("conflict") rather than silently overwriting what a person may have acted on.
  - `processDeliveryReport()` is the whole webhook with its outside effects injected (secret, find, conditional write,
    reload), so the verify script runs the real logic against an in-memory twin.
  - Only a row with `channel SMS` and `providerName africastalking` can be touched; an email or console row is "not found".
- **Cannot lose a race.** The write is `updateMany` conditional on `deliveryState` still being what was read (NULL
  included), the same fail-closed claim Modules 55/66/75 use. Two reports landing together: the loser re-reads, decides
  again (usually "stale") and, after three lost rounds, gives up quietly with `concurrent`.
- **Why it was not delivered** (`classifyDeliveryFailure()`): `PERMANENT_RECIPIENT` (invalid/unsupported number, opted
  out, DND, inactive line), `TEMPORARY_RECIPIENT` (phone off / out of coverage), `ACCOUNT` (balance, sender id),
  `NETWORK`, `UNKNOWN` (shown exactly as the gateway wrote it, control characters stripped, clipped to 100).
- **Notifications page.** Under an SMS row: green "Delivered to the handset (time)", blue "Handed to the mobile
  network...", red "Not delivered: <reason in plain words>", and - only once reports are switched on and the id exists -
  grey "Waiting for a delivery report", turning amber after 24 hours ("the text may still have arrived; check the
  callback URL"). A "Not delivered" filter lists only `UNDELIVERED` rows. The SMS banner says whether reports are on and
  shows the callback path to give Africa's Talking.
- **Retry of an undelivered text is a person's decision.** `checkManualRetry()` now also accepts a `SENT` row that is
  `UNDELIVERED`, unless the reason is `PERMANENT_RECIPIENT` (same number, same answer; fix the number on the record). The
  server claim is conditional on the row *still* being that way, so a delivery report landing mid-click cannot turn a retry
  of a delivered text into a second send. **The queue (Module 75) never retries an undelivered text by itself**: it was
  accepted, the network may still have it in a buffer, and the cron retry would be the duplicate that module exists to avoid.
- **Env added:** `AT_DELIVERY_REPORT_SECRET` (optional; long random string; without it the endpoint answers 503 and the
  page says reports are off). Set the same value in the Africa's Talking dashboard: SMS -> Delivery Reports -> callback
  URL `https://your.domain/api/webhooks/africastalking/delivery?token=<secret>`. To rotate, change both.
- **Verification**: new `npm run verify:sms-delivery-report` (156 checks: status words, parsing and every refusal,
  reason classification, number matching, every forward-only transition including late/duplicate/conflicting reports,
  constant-time compare, the webhook against an in-memory table - auth order, 503/401/400/404/409, other-channel rows,
  a race lost to Success, an endless race, a row deleted mid-flight - the page view, and manual retry of an undelivered
  text with Module 75's rules unchanged). `tsc` 0 errors, `prisma validate` valid, `next build` passes, all other verify
  scripts and `check:dates` clean.
- **Deploy**: `npx prisma migrate dev --name sms_delivery_reports` + `npx prisma generate`; set
  `AT_DELIVERY_REPORT_SECRET`; register the callback URL with Africa's Talking. No re-seed.

### KNOWN LIMITATIONS

- **Never run against a live Africa's Talking account.** The callback's field names and status/failure words come from
  the published documentation. A word this file does not know is refused (status) or shown as written (reason), never
  guessed; send one real text to your own phone and check the row before relying on it.
- **A report that arrives before its log row exists is lost.** The send is logged after the gateway answers; a report
  in that window finds no row and gets 404. Africa's Talking may or may not re-send; the row then stays "waiting".
- **The secret is in the URL**, so it can appear in a reverse proxy's access log. Use a long random value, keep logs
  private and rotate it if it leaks. The endpoint cannot do more than move a matching row forward once.
- **Delivery reports are not retried or alerted on.** An undelivered watched notice (debt reminder, supplier or pay
  notice) shows on the Notifications page and under the "Not delivered" filter, but there is no bell alert and no
  automatic resend. Nothing tells a person who is not looking at that page.
- **Only Africa's Talking.** Email (Resend) delivery events, bounces and complaints are still not read; bulk SMS is
  still absent.
- **Old rows have no report** (no message id). A conflicting later report is refused and not recorded anywhere
  except being ignored.
- **No cost reporting.** `providerCost` is stored as the gateway printed it but nothing sums or displays it.

## Module 77: Service Products and Converted-Quotation Totals

Closes the carried limitation "quotation totals not recomputed after linking and no service/non-stocked product type".

**Service products.** A product can now be a service: `Product.isStocked` (default `true`, so every existing product is unchanged). A service can be quoted and sold like any product. It has no quantity, no stock level, no reorder level and no cost of goods.

- **Create.** The new-product form has a "This is a service (no stock)" checkbox. It hides opening quantity, reorder level and the branch picker. The API refuses a service with an opening quantity, reorder level or expiry date.
- **Sell, void, credit.** `recordInventoryMovement()` ignores `SALE` and `RETURN_IN` for a service (no movement row, no stock level), so selling, voiding and crediting a delivery fee all work. Every other movement type is refused with a clear message. The cost snapshot on a sale line is 0, so the journal never credits Inventory for something that was never in it.
- **Switch type.** The product page has a "Make this a service" button. It is refused while the product has stock on hand, stock at any branch, a line on an in-transit transfer, or a line on an in-progress stock take. Becoming a service clears the reorder level and expiry date and deletes the product's branch stock-level rows (all zero by then; they only carried reorder overrides). Making it stocked again is always allowed.
- **Where services are left out.** Low-stock and out-of-stock lists and alerts, inventory value, the stock report, stock takes, the purchase form and the stock transfer form. The inventory list shows "Service" with no quantity. The sale form shows "(service)" and no stock warning.
- **Quotations.** A service can be linked to a free-text line at convert time like any product.

**Converted-quotation totals.** `convertQuotationToSale()` now brings the quotation's VAT and total in line with what the sale charged. VAT is recomputed with the same function and inputs `createSale()` uses (each linked product's category, the business's current VAT settings). The per-line category and VAT, `tax` and `total` are updated. Subtotal, discount, prices, descriptions and net line totals stay as quoted. When the figures changed, the originals are kept in `Quotation.quotedTax` and `quotedTotal`, and the quotation page and PDF say "Quoted at X. The sale charged Y". An earlier quoted figure is never overwritten. When nothing changed, nothing is written.

**Files.** `src/lib/product-kind.ts` and `src/lib/quotation-refresh.ts` (pure, import-free); changes in `inventory.ts`, `sales.ts`, `quotations.ts`, `stock-take.ts`, `reports.ts`, `validation.ts`; product routes; product form, product page (`product-kind-form.tsx`), inventory list, sale form, quotation page and PDF route.

**Upgrading.** Additive schema (`Product.isStocked`, `Quotation.quotedTax`, `Quotation.quotedTotal`). Run `prisma migrate` and `prisma generate`. No re-seed, no new permission, no new env var.

**Verify.** `npm run verify:service-products` (77 checks): the pure rules, the movement behaviour against an in-memory fake, and the conversion refresh across a zero-rated link, an unchanged link, a rate change, VAT deregistration, mixed lines with a document discount, and a refused conversion.

**Limitations.**

- Never run against a live database. The fakes cannot prove Postgres behaviour.
- A quotation converted before this module keeps its old figures; there is no backfill.
- Stock-take reports and past sales for a product later made a service are unchanged history.
- A service has no per-unit cost, so its sales show full margin. A cost for services (subcontractor, labour) is not modelled.
- Credit notes against a service line can still choose "restock"; the restock is ignored, but the form does not hide the option.
- Purchases cannot buy a service, so a service bought for resale or a subcontractor bill goes through an expense instead.

## Module 78: Closing the Module 77 Limitations

Closes all four limitations Module 77 listed.

**1. Quotations converted before Module 77.** `npm run quotations:backfill` (dry run) and `npm run quotations:backfill -- --apply`. For every converted quotation that has not been refreshed, tax and total are taken from the sale it created, and the old figures are kept as `quotedTax` / `quotedTotal` when they differ. A line's VAT is updated only when it matches exactly one sale line (same product, quantity, unit price, discount, total). Lines it cannot match, such as two identical lines, are reported and left alone. Subtotal, discount, prices and descriptions are never touched. Safe to run twice: a refreshed quotation is skipped. Decisions live in `planConvertedQuotationBackfill()` in `src/lib/quotation-refresh.ts`.

**2. Services now carry a cost.** `Product.purchasePrice` on a service means what it costs you to provide one unit (labour, subcontractor, delivery bill). The product form says so. A sale line snapshots it like any cost, so the dashboard and product profitability report show a real margin. The ledger needs somewhere to credit it, so there is a new system account, **1210 Service Cost Clearing**, the Inventory equivalent for services:

- Sale: `Dr Cost of Goods Sold` (goods cost + service cost), `Cr Inventory` (goods), `Cr Service Cost Clearing` (services).
- Purchase of a service: `Dr Service Cost Clearing`. Goods lines still debit Inventory.
- Debit note on a service line: `Cr Service Cost Clearing`. Goods lines still credit Inventory.
- Voiding a sale or purchase reverses its whole entry, so nothing extra is needed.

A debit balance on the account is service cost bought but not yet sold. A credit balance is service cost recognised on sales but not yet billed by the supplier. It is created on first use for existing businesses. Services sold before this module have a cost of 0 and stay that way.

**3. Credit notes and restock.** The restock tick box is hidden for a service line, and `computeCreditNote()` refuses `restock` on one with a clear message, so the API cannot be used to bypass the form.

**4. Purchases can buy a service.** The purchase form lists services (marked "(service)"). A service line adds no stock and moves the product's cost to the price paid, the same last-in rule goods use. Voiding a purchase skips the stock check and stock movement for service lines. On a debit note the "sent back to supplier" box is hidden for service lines and refused by `computeDebitNote()`; a service line can still be debited for a price adjustment.

**Files.** New: `scripts/backfill-quotation-figures.ts`. Changed: `chart-of-accounts.ts`, `accounting-integrations.ts`, `product-kind.ts` (`splitLineCosts`, `splitNetByKind`; `saleLineUnitCost` removed), `sales.ts`, `purchases.ts`, `credit-note-calc.ts`, `credit-notes.ts`, `debit-note-calc.ts`, `debit-notes.ts`, `quotation-refresh.ts`, the credit note and debit note routes, pages and forms, the purchase form and page, the product form.

**Upgrading.** No schema change. No `prisma migrate` needed (run `prisma generate` only if you have not since Module 77). Run the backfill once, dry run first.

**Verify.** `npm run verify:service-products` now runs 109 checks: the Module 77 ones plus the cost split, the backfill planner, the credit and debit note refusals, and every ledger entry above (balanced, correct accounts, goods-only and service-only cases).

**Limitations.**

- Never run against a live database. The fakes cannot prove Postgres behaviour.
- The backfill needs the quotation line's product to match the sale line. A quotation edited after conversion may not match; those lines are reported, not guessed.
- A product that becomes a service after a purchase of it as goods: voiding that old purchase skips the stock check and reverses the whole Inventory entry. The product cannot become a service while holding stock, so the common case is safe, but the edge exists.
- Service cost is recognised at the product's cost when sold, and the supplier's bill clears it later. Differences between the two stay in Service Cost Clearing until someone adjusts them with a manual journal. There is no automatic variance posting.
- A service's cost on a past sale is not restated if the product's cost changes later (same as goods).

## Module 79: Settling Service Cost Clearing

Closes Module 78's limitation "no automatic variance posting between service cost recognised and supplier bill (stays in clearing account until a manual journal)". Chosen autonomously: it was the one tracked gap that leaves a wrong-looking balance in the books for ever.

**What was wrong.** A service's cost is credited to account 1210 Service Cost Clearing when it is sold and debited there when the supplier's bill is recorded. The two rarely agree, and nothing ever cleared the difference.

**Why it is not automatic.** A debit balance can be a bill that arrived before the job was sold; a credit balance can be a job sold before its bill arrived. Both are normal while work is in flight. Only a person knows the difference is final, so a settlement is a deliberate act.

- **Per-service balance (computed, never stored).** `billed - debited - recognised - costUp + costDown`, in whole tambala: supplier bills net of VAT (voided purchases ignored), debit notes, cost taken on sales (quantity x the unit cost snapshotted on the line, voided sales ignored) and recorded settlements. New page `/service-cost-clearing` (linked from Accounting) lists each service with what it means in plain words ("Billed by the supplier, cost not yet taken on a sale" / "Cost taken on sales, supplier has not billed it").
- **The ledger stays the authority.** The page also shows what account 1210 really holds and the difference the per-service figures cannot explain. Up to 10 tambala is called rounding; more is flagged "review" with likely causes (a manual journal posted straight to the account, a product that became a service later).
- **Settle.** All of a service's leftover, or part of it, with a required reason (max 200). The direction is derived from the balance, never chosen, and a settlement can never push a balance past zero. Debit balance: `Dr Cost of Goods Sold / Cr Service Cost Clearing`. Credit balance: `Dr Service Cost Clearing / Cr Cost of Goods Sold`.
- **Void.** Posts an equal and opposite entry dated today and keeps the row as history. A conditional write claims the row first, so two voids cannot both post. If the ledger and the record disagree (not exactly one entry to reverse) the void is refused and rolled back.
- **Concurrency.** Settle and void take a row lock on the product, then re-read the balance inside the transaction, so two settlements of the same service queue and the second sees the first.
- **Dated now**, never back-dated, so a settlement can never land in a closed period.

**Schema (additive).** New table `ServiceCostSettlement` with enums `ServiceCostSettlementDirection` and `ServiceCostSettlementStatus`. Run `prisma migrate` and `prisma generate`. No re-seed, no new permission (`accounting.view` to look, `accounting.manage` to settle or void, Owner and Accountant; a branch-restricted member can look only), no new env.

**Files.** New: `src/lib/service-cost-clearing.ts` (pure), `src/lib/service-cost-clearing-run.ts`, three routes under `/api/business/[businessId]/service-cost-clearing` (`GET`, `settle`, `settlements/[settlementId]/void`), `src/app/service-cost-clearing/` (page and workspace), `scripts/verify-service-cost-clearing.ts`. Changed: `schema.prisma`, `validation.ts`, `accounting/page.tsx`, `package.json`.

**Verify.** `npm run verify:service-cost-clearing` (90 checks): the pure balance, settlement planner and report; then the real DB layer against an in-memory fake (voided documents ignored, other business ignored, part and full settlement in both directions, ledger agreement, refusals writing nothing, void reversal, double void, ledger/record disagreement rolling back). `tsc` 0 errors, `prisma validate` valid, `next build` passes, all 27 verify scripts and `check:dates` clean.

**Limitations.**

- Never run against a live database. The fake cannot prove Postgres behaviour, including the row lock.
- ~~Settlement is manual, per service, with no bulk "settle everything" button and no alert when a balance has sat for a long time.~~ Closed by Module 80.
- Cost is recognised at the product's cost when sold; the settlement does not restate past sales or the product's profitability report, so margin reports still show the unsettled cost.
- Unattributed differences (manual postings, a product that became a service later) are shown but cannot be settled from this page; use a manual journal after reading the account.
- A settlement is not attributed to a branch (the GL has none).

## Module 80: Bulk Settle and Aged-Balance Alert for Service Cost Clearing

Closes the Module 79 limitation "settlement is manual, per service, with no bulk settle button and no alert when a balance has sat for a long time". Chosen autonomously over per-installment tax due dates and a partial-dispatch path for stock transfers: it finishes the clearing account's workflow while Module 79 is fresh, and an unnoticed leftover is the way that account goes wrong.

**Age (computed, never stored).** A service's age is whole days since the newest event that touched its balance: a non-voided sale date, a non-voided supplier bill date, a debit note date or a recorded settlement. A leftover is **aged** when it is at least K1.00 (either side, so rounding dust never alerts) and its age reaches `Business.serviceCostAlertDays`. A service with no usable date has an unknown age and is never called aged. A voided sale or purchase does not reset the age; a voided settlement is not read, so voiding does not reset it either.

**Bell alert.** New `InAppNotificationType.SERVICE_COST_CLEARING`, synced by `syncServiceCostClearingAlert()` with the other alerts. ONE business-wide alert (not one per service) so a busy month cannot flood the bell: "N services have had cost sitting in Service Cost Clearing for a long time", naming the oldest. WARNING, escalating to URGENT when the oldest has sat for twice the threshold (the same fixed 2x rule as the stale-transfer alert). Condition-based like LOW_STOCK: it resolves itself when nothing is aged, no scheduler. No amount snapshot is passed, so a dismissed alert does not come back after every sale of a service. The text carries counts and days, never kwacha figures, because the bell is visible to every member.

**Threshold.** New `Business.serviceCostAlertDays` (`Int @default(30)`, bounds 7 to 365 enforced on write). `GET`/`PUT /api/business/[businessId]/service-cost-alert-threshold` mirrors Module 58 field for field (`business.settings.manage` to write, audit `business.service_cost_alert_threshold_changed`); new section on `/settings/general`.

**Bulk settle.** `POST /api/business/[businessId]/service-cost-clearing/bulk-settle` with `{ items: [{ productId, expectedBalance }], reason }`, up to 200 services, `accounting.manage`, branch-restricted members refused (as for a single settle).

- It always clears the **whole** leftover of each service with ONE shared reason. A part amount is what the single Settle is for.
- It is N independent Module 79 settlements, not one big transaction: each service takes its own row lock, posts its own entry, writes its own audit row and can be voided on its own. One service refusing does not stop the others; the response lists every service as `SETTLED` or `SKIPPED` with the reason, and the HTTP status is 200 whenever the request itself was valid.
- **`expectedBalance` is the leftover the person saw.** It is checked inside each service's locked transaction against the balance re-read there. A sale or bill that landed after the page loaded makes that service refuse ("the leftover changed since you looked") instead of settling at a figure nobody reviewed. The single settle gained the same optional field and the page now sends it.
- Request-level refusals post nothing: no reason, empty selection, more than 200, the same service twice, an expected balance that is not a number with at most two decimals. A service that is unknown, belongs to another business, is not a service, or has nothing left is skipped.
- An unexpected error on one service rolls back that service only, is logged, and is reported as "Unexpected error; this service was not settled." The rest carry on.
- One summary audit row `service_cost.bulk_settle` records the whole act (counts, total, settlement ids, what was skipped and why), beside each settlement's own row.

**UI.** `/service-cost-clearing` gains an "Untouched for" column with an amber tag on aged rows, a fourth stat ("Left over for N+ days"), checkboxes, "Select aged", "Select all" and "Clear", and a "Settle N selected..." form with one reason and a result panel listing what was settled and what was skipped and why.

**Schema (additive).** One column `Business.serviceCostAlertDays` and one enum value `SERVICE_COST_CLEARING`. Run `prisma migrate` and `prisma generate`. No re-seed, no new permission, no new env.

**Files.** New: `scripts/verify-service-cost-aging.ts`, routes `service-cost-clearing/bulk-settle` and `service-cost-alert-threshold`, `src/app/settings/general/service-cost-alert-form.tsx`. Changed: `schema.prisma`, `service-cost-clearing.ts` (pure: `balanceAgeDays`, `isAgedBalance`, `summariseAgedBalances`, `planBulkSettlement`, bounds), `service-cost-clearing-run.ts` (dates in `loadClearingFacts`, `getAgedServiceCostSummary`, `settleManyServiceCosts`, `expectedBalance`), `in-app-notifications.ts`, `validation.ts`, the settle route, the clearing page and workspace, `settings/general/page.tsx`, `notifications/alerts-section.tsx` (labels for the new type and the missing renewal type), `package.json`. Module 79's verify fake was updated to return the new date fields; its 90 checks are unchanged.

**Verify.** `npm run verify:service-cost-aging` (77 checks): pure ageing (day maths, future dates, unknown age, dust, thresholds, 2x escalation), the bulk planner (stale, sign flip, duplicates, bounds), then the real DB layer against an in-memory fake (newest-touch age, voided sale not resetting it, other business ignored, `expectedBalance` refusal writing nothing, bulk in request order, directions derived, one entry and audit row per service plus the summary row, one bulk settlement voided on its own, an unexpected failure isolated to one service). `tsc` 0 errors, `prisma validate` valid, `next build` passes, all 28 other verify scripts and `check:dates` clean.

**Limitations.**

- Never run against a live database. The fake cannot prove Postgres behaviour, including the row lock.
- The alert is recomputed on every bell sync from every sale, bill, debit note and settlement line of the business's services. Fine at small-business scale; a business with a very large history of service sales would want a cached figure. A business with no service products costs one count query.
- A bulk settlement clears whole leftovers only, with one shared reason; part settlements stay one service at a time.
- A bulk settlement is not atomic across services (by design, see above); a crash between two services leaves the earlier ones settled. The summary audit row is written last, so in that case only the per-settlement rows exist.
- Age is "since the last touch", so any new sale of a service restarts the clock even when an older part of the leftover is stale. Past sale margins are still not restated (carried from Module 79).
- Unattributed differences (manual postings, a product that became a service later) are still shown but cannot be settled from this page; use a manual journal. Settlements are not attributed to a branch (the GL has none). The alert has no per-service threshold and no push channel.

## ERP application shell (UI redesign, Phase 1 of 16)

The signed-in app now sits inside one persistent ERP shell: top header (business, branch, fiscal year and month, Ctrl+K page search, notification bell, user menu), a collapsible grouped sidebar, breadcrumbs, and a status bar. Mobile gets a drawer.

**How it is wired.** Every authenticated route directory moved, unchanged, into the route group `src/app/(app)/`. A route group adds no URL segment, so no URL changed and nothing was duplicated. `src/app/(app)/layout.tsx` loads the session, the member's first business (what every page already uses), the permission keys the menu depends on, the branch name, the fiscal-year label and an unread-alert count, then renders `AppShell`. Public pages (`/`, login, register, pay, about, ...) and `/api` stay outside the group and get no shell.

**Pieces.**
- `src/components/erp/nav-config.ts`: the menu tree. Only routes that exist are listed. Each item has "any of" permission keys; the layout resolves exactly those keys.
- `src/components/erp/app-shell.tsx`, `permission-gate.tsx` (`PermissionProvider`, `useCan`, `PermissionGate`), `display.tsx` (`AmountDisplay`, `StatusBadge`, `PageHeader`, `KpiCard`).
- `src/lib/erp/format.ts`: central `formatMoney` (`MWK 1,250,000.00`, negatives `(MWK 250,000.00)`), `formatAmount`, `formatPercent`, `formatNumber`. Dates still go through `formatDateIn` (Module 36 rule).
- Design tokens: CSS variables in `globals.css`, exposed as `erp-*` Tailwind colours. A dark set is defined; `darkMode: "class"` is on.
- Dashboard: the link-row navigation and its bell moved to the shell; the page keeps its alert sync, uses `PageHeader` and `KpiCard`, and formats through `format.ts`.
- Printing: shell parts carry `erp-chrome` and are hidden under `@media print`, so receipts and payslips print clean.

**No schema change, no migration, no new env, no re-seed.**

**Known limitations (deliberate, not hidden).**
- **No business switcher.** Every page and API call resolves the business as the member's first membership. A real switcher needs a selected-business cookie read by that one resolver and every page migrated to it; that is a tenant-boundary change and was not done in a UI pass. The header shows the active business and a tooltip when the login has several.
- **No branch switcher in the header.** It shows the member's branch or "All branches". The dashboard keeps its own `?branchId=` switcher.
- **Ctrl+K searches pages, not records.** Searching customers, invoices, journals needs a tenant-scoped search API that does not exist yet.
- **Dark mode is exposed in the signed-in user menu.** ERP pages follow the saved theme; the public site, sign-in, registration and invitation pages intentionally remain light. A browser pass at mobile and desktop widths is still needed for visual QA.
- **Existing pages are not redesigned yet.** They render inside the shell with their own headings. Phases 3 to 16 (DataTable, customers/suppliers, sales, ... settings, audit drawer, mobile workflows) remain.
- **Wish-list screens with no backing module** (bank rules, recurring invoices, purchase orders, stock counts as listed, asset disposal pages, VAT returns page) are not in the menu; there are no dead links.
- **Not checked in a browser.** `tsc`, `check:dates` and `next build` pass in the sandbox; visual verification (spacing, density, drawer) still needs a real browser run.

## ERP UI redesign, Phase 2 (rest) and Phase 3: DataTable and dashboard panels

**DataTable** (`src/components/erp/data-table.tsx`). Search, click-to-sort (numeric-aware, with an optional `sortKey` so a formatted date sorts by its real value), column visibility, row selection, paging, sticky header and first column, footer totals, right-aligned tabular amounts with negatives in red, Arrow Up/Down between rows and Enter to open the record, and CSV export (the selection if any, else the filtered rows; cells starting with `= + - @` are escaped against spreadsheet formula injection). Columns are plain data so a Server Component can pass them; the server formats dates with `formatDateIn`. `TableSkeleton` plus `src/app/(app)/loading.tsx` give a loading state, and `src/app/(app)/error.tsx` shows a plain-language failure with the raw message only behind "Technical details".

**Where it is used.** Customers list (selectable, with an Outstanding total; "+ Add Customer" is wrapped in `PermissionGate`). Dashboard: Accounts Receivable Aging, Outstanding Invoices (largest 15) and Low Stock. The aging and low-stock lists come from `getDashboardData().lists`, the same queries as the headline figures; outstanding invoices are a business- and branch-scoped query in the page.

**Known limitations.**
- **Client-side paging and search.** The table works over the rows the page loads. Customers loads all active customers, as it did before. A list that can reach many thousands of rows needs server-side paging in its query first.
- **No column resizing, no inline editing, no virtualization.**
- **Aging is by sale date.** A regular sale has no due date (existing limitation), so the buckets are age since sale, and the panel says so. The brief's "Due Date" column does not exist in the data.
- **Not built because the data does not exist:** Cash Flow line chart, Revenue vs Expenses bar chart on the dashboard, Accounts Payable aging, the Recent Transactions (debit/credit/running balance) panel, dashboard widget personalization. The ledger needs a dashboard query for these; I did not fake any.
- **Other list pages** (suppliers, sales, purchases, inventory, and so on) still use their old tables. Suppliers moved in Phase 4; sales, purchases and inventory are Phases 5 to 7.
- **Not checked in a browser.** `tsc`, `check:dates` and `next build` compile; the Prisma "initialization" line during build is the sandbox's dummy engine, as in earlier modules.

## ERP UI redesign, Phase 4: customers and suppliers

No schema change, no new routes, no new API. Every query, permission check and tenant guard is unchanged; this phase is presentation only.

- **Suppliers list** now uses `DataTable` (search, sort, selection, "We Owe" total, CSV), matching Customers. "+ Add Supplier" is wrapped in `PermissionGate perm="suppliers.manage"`.
- **Customer and supplier profiles**: `PageHeader`, `KpiCard` summary row, and the sales / purchase / payment histories as `DataTable`s (10 per page, dates sort by real value, status as a badge, rows open `/sales/[id]` or `/purchases/[id]`). The customer profile shows the credit limit and marks "Over limit"; new credit sales now check current exposure against that limit inside the transaction and show the projected balance while composing a sale. Record Payment, Apply Credit, Send Reminder and "Text supplier" are hidden without `customers.manage` / `suppliers.manage`; the API routes still enforce this, hiding is not the guard.
- **Customer Debt Dashboard** (`/customers/debts`): KPI cards for total receivables and the five age buckets, and the debtors in a `DataTable` with a total.
- **Add Customer / Add Supplier forms**: visible labels, a required marker, hints, an error banner with `role="alert"`, autofocus on the name. New `Field` and `FormCard` in `src/components/erp/display.tsx` and an `.erp-input` class in `globals.css`; use them for the forms in later phases.
- **Customer and supplier management:** their profile pages now link to edit forms; those forms can also deactivate and reactivate records. Active and inactive lists are separate, history stays visible on the profile, and sale/purchase creation rejects inactive contacts at the transaction boundary. Customer statements and per-customer notes still need product modules and schema support. The supplier payment history remains a small hand-written table so each row can carry its "Text supplier" button; `DataTable` cells cannot hold components yet.
- **Not verified in this sandbox.** `check:dates` passes (431 files, 0 violations). `prisma generate` is blocked here (403 from the engine host), so the full `tsc` / `next build` cannot run and shows implicit-any noise across the whole app; I filtered the `tsc` output to the files changed in this phase and found no other kind of error. Run `npm run build` once on your machine and open the customer and supplier pages in a browser.

## ERP UI redesign, Phase 5: sales

No schema change, no new routes, no new API. Queries, permission checks and branch scoping are unchanged; this phase is presentation only.

- **Lists on `DataTable`:** Sales (now with a Date column, a hidden-by-default Branch column, totals for Total and Balance, and a Receipt link per row), Quotations, Credit Notes, and Refunds (both "Awaiting a Decision" and "Refund History"). "+ New Sale" is wrapped in `PermissionGate perm="sales.create"`.
- **Sale and quotation detail:** `PageHeader` with a status badge, a `DetailList` of header facts, read-only `LineItemsTable`, and a `TotalsPanel` (discount shows in brackets, as negatives do everywhere in the ERP). The optional blocks (foreign-currency payments, credit notes, refund) are `Panel`s. Pay link, FX settlement, void, quotation actions and the convert form are untouched.
- **New shared components** in `src/components/erp/display.tsx`: `DetailList`, `LineItemsTable`, `TotalsPanel`, `Panel`. Purchases (Phase 6) and credit/debit note detail pages should reuse them.
- **Sales list limit:** it now loads the latest 200 sales (it was 50). Search and sort run only over those rows, and the page says so when the cap is hit. Anything older needs server-side search, which does not exist yet.
- **Not done in this phase.** The New Sale form (`sale-form.tsx`), New Quotation, New Credit Note, Process Refund, the receipt page and the quotation action buttons keep their old fields and styling; only the New Sale page header moved. The receipt is a print layout and was left alone on purpose. Credit note detail pages were not restyled. The Refund History table has no date column because the list query does not return one.
- **Not verified in this sandbox.** `check:dates` passes (431 files, 0 violations). `prisma generate` is blocked here (403 from the engine host), so full `tsc` / `next build` cannot run; filtered to this phase's files, `tsc` shows only the missing-Prisma-type errors that exist across the app. Run `npm run build` and open the sales and quotation pages in a browser.

## ERP UI redesign, Phase 6: purchases

No schema change, no new routes, no new API. Queries, permission checks and branch scoping are unchanged; this phase is presentation only.

- **Lists on `DataTable`:** Purchases (new Date column, hidden-by-default Branch column, totals for Total and Balance; "+ New Purchase" wrapped in `PermissionGate perm="purchases.create"`) and Debit Notes. The purchases list loads the latest 200 (was 50) and says so when the cap is hit; search and sort cover only the loaded rows.
- **Purchase detail:** same layout as the sale page (`PageHeader`, `DetailList`, `LineItemsTable` with an "Unit Cost" heading, `TotalsPanel`, `Panel`s for foreign-currency payments, debit notes and refund). Void, FX settlement and refund controls are untouched.
- **Credit and debit note detail pages** (the credit note page was left over from Phase 5): both now use `PageHeader`, `DetailList`, a new `NoteLinesTable` (net, VAT and the Restocked / Sent back flag) and `TotalsPanel`.
- **Supplier payments** are recorded from the supplier profile, which moved in Phase 4; there is no separate supplier-payments page to restyle.
- **Not done in this phase.** The New Purchase form (`purchase-form.tsx`), New Debit Note, New Credit Note and Process Refund forms keep their old fields; only the New Purchase page header moved. Void forms were not restyled.
- **Not verified in this sandbox.** `check:dates` passes (431 files, 0 violations). `prisma generate` is blocked here (403 from the engine host), so full `tsc` / `next build` cannot run; filtered to this phase's files, `tsc` shows only the missing-Prisma-type errors that exist across the app. Run `npm run build` and open the purchase and note pages in a browser.

## ERP UI redesign, Phase 7: inventory

No schema change, no new routes, no new API. Queries, permission checks, branch scoping and stock logic are unchanged; this phase is presentation only.

- **Inventory list** on `DataTable` in both views. Business-wide: Product, Category, Qty, Selling Price, a Status badge (In stock / Low stock / Out of stock / Service), and a hidden-by-default Unit column. Per-branch view: Product, Category, Qty, Unit and a Notes column that carries "Low at this branch", "+N arriving" and "N in transit out". The business/branch switcher pills, the in-transit banner and "+ Add Product" (wrapped in `PermissionGate perm="inventory.manage"`) use the ERP tokens.
- **Stock Transfers** on `DataTable`. The old per-state tags (Stale, Short, Recovered) are now one status badge: "In transit", "In transit · Stale", "Received", "Received · Short", "Received · Recovered" or "Cancelled". The decisions behind each label (`isStaleTransfer`, `transferHasOutstandingShortfall`, `transferHasShortfall`) are the same calls as before.
- **Stock Take**: Completed list on `DataTable`; In Progress cards, the manual-count notice and the no-access message use the ERP tokens. The branch switcher is unchanged.
- **Product detail**: header, three KPI cards (selling price, business-wide quantity, reorder level) and the per-branch reorder levels in a `Panel`. The product-kind and reorder-level forms are untouched.
- **Not done in this phase.** Stock transfer detail, stock take detail and their workspaces, New Product, New Transfer and New Stock Take keep their old styling (only the New Product page header moved). The stock-transfer list still loads the latest 50, as before. Categories, stock adjustments and a stock movement history have no page today, so there is nothing to restyle.
- **Not verified in this sandbox.** `check:dates` passes (431 files, 0 violations). `prisma generate` is blocked here (403 from the engine host), so full `tsc` / `next build` cannot run; filtered to this phase's files, `tsc` shows only the missing-Prisma-type errors that exist across the app. Run `npm run build` and open the inventory, transfer and stock take pages in a browser.

## ERP UI redesign, Phase 8: banking

No schema change, no new routes, no new API. The cashbook still reads the same two endpoints; reconciliation queries and permission checks are unchanged. Presentation only.

- **Cashbook** (`cashbook-view.tsx`): a Total Cash Position card (red when negative), each account as an expandable row with its balance, and the expanded transaction list on `DataTable` (search, sort, paging, CSV; amounts and running balances use the ERP money format, so outflows show in brackets and red instead of "-MWK"). The Branch column is hidden by default. The Transfer and Add Account forms use `Field`, `FormCard` and `.erp-input`, with labels, hints and an `role="alert"` error.
- **Bank Reconciliation list**: Completed reconciliations on `DataTable` with an Ending Balance column; In Progress cards, the manual-entry notice and the no-access message use the ERP tokens.
- **Page headers** of the reconciliation detail and Start Reconciliation pages moved to `PageHeader`.
- **Not done in this phase.** The reconciliation workspace (`reconciliation-workspace.tsx`, the matching screen) and the Start Reconciliation form keep their old styling; they are large client components with their own matching logic and were not touched. There is no bank-feed import, no bank rules and no reconciliation report page today, so nothing was built for them.
- **Not verified in this sandbox.** `check:dates` passes (431 files, 0 violations). `prisma generate` is blocked here (403 from the engine host), so full `tsc` / `next build` cannot run; filtered to this phase's files, `tsc` shows only the missing-Prisma-type errors that exist across the app. Run `npm run build` and open the cashbook and reconciliation pages in a browser.

## ERP UI redesign, Phase 9: accounting

No schema change, no new routes, no new API. Ledger, journal, FX and period-close logic and permission checks are unchanged; presentation only.

- **Journal Entries** list on `DataTable` (Amount total, status badge; the All / Recorded / Voided pills and the server-side search box are kept, and the table's own search filters only the rows already loaded). **Journal detail**: `PageHeader`, `DetailList`, and the ledger entry / reversal tables with debit and credit totals in the ERP table style. Void form untouched.
- **Foreign Exchange** list on `DataTable` with three `KpiCard`s (realised, unrealised, total); gain/loss amounts use the ERP money format. **FX detail** uses `DetailList`.
- **Period Close** and **Accounting** page headers moved to `PageHeader`; the Accounting quick links are now header buttons.
- **Expenses** list on `DataTable` (Amount and Withheld totals, Certificate link per row, Branch hidden by default). "+ Add Expense" is now wrapped in `PermissionGate perm="expenses.manage"`. The list still shows the latest 100, as before.
- **Not done in this phase.** `accounting-hub.tsx` (ledger, chart of accounts, tax calendar tabs, 838 lines), `period-close-client.tsx`, the New Journal and New FX adjustment forms, the New Expense form and the Service Cost Clearing workspace keep their old styling. They hold their own client logic and were left alone. There is no trial balance or general ledger page outside the hub; reports are Phase 10.
- **Not verified in this sandbox.** `check:dates` passes (431 files, 0 violations). `prisma generate` is blocked here (403 from the engine host), so full `tsc` / `next build` cannot run; filtered to this phase's files, `tsc` shows only implicit-any errors that come from the missing Prisma types. Run `npm run build` and open the journal, FX and expense pages in a browser.

## ERP UI redesign, Phase 10: reports

No schema change, no new routes, no new API. The seven report routes, their permission check (`reports.basic.view`), branch scoping and CSV output are unchanged; presentation only.

- **Reports hub** (`reports-hub.tsx`) now uses `PageHeader`, an ERP tab bar (`role="tablist"`), a filter bar of `Field` + `.erp-input` controls, `KpiCard`s and one `DataTable` per report. Column sets are plain data in `COLUMNS`, keyed by report.
- **KPI cards** come only from figures the routes already return: Sales (gross, credit notes, net, count), Expenses (total, entries), Inventory (value, low, out of stock), Customer debt (receivables), Supplier debt (payables), Salesperson (net sales) and Product profitability (revenue, profit, overall margin, summed from the rows). Low and out-of-stock turn red when above zero.
- **Expenses by category** is now shown in a panel. The route already returned `byCategory`; the old page ignored it.
- **Inventory** gets a status badge (Out of stock, or Low on the per-branch view, the only view where the report carries a low-stock flag per row). Quantities use the new `formatQuantity()` (up to 3 decimals) because the `number` column type rounds to whole units.
- **Two CSV buttons, on purpose.** "Download full CSV" in the header still calls the server route (the whole report, as before). "Export CSV" in the table saves only the rows currently shown after search and column choices.
- **Fixes while here.** A failed request used to leave the page on "Loading..." forever; it now shows a readable error (403 gets its own message). A slow response from an earlier tab or date range can no longer overwrite the current table.
- **Money format.** Amounts use the central formatter (negatives in brackets, red). The old hub used `toLocaleString()` with no decimals.
- **Not done in this phase.** There are still no Trial Balance, General Ledger, Balance Sheet or Cash Flow reports on this page. The Profit and Loss and VAT views live in the accounting hub and tax pages and keep their old styling. Rows are filtered, sorted and paged in the browser over what the route returns (no server paging). No chart. No printable layout.
- **Not verified in this sandbox.** `check:dates` passes (431 files, 0 violations). `prisma generate` is blocked here, so full `next build` cannot run; `tsc` shows no errors in the files this phase touched. Run `npm run build` and open each of the seven report tabs in a browser, including with a branch selected.

## ERP UI redesign, Phase 11: tax

No schema change, no new routes, no new API. Tax payment recording, VAT preview, carry-forward, installment, void and tax-configuration logic and permission checks are unchanged; presentation only.

- **Tax Payments** list on `DataTable` (Date sorts on the real date, Type badge for Payment/Refund, Installment column for part and final payments, Status badge, Account hidden by default) with three `KpiCard`s. The "+ Record Payment" button is wrapped in `PermissionGate perm="taxpayments.manage"`. The MRA disclaimer is kept. Totals still count recorded payments only; voided rows stay listed as history. The table has no footer total because it would mix payments, refunds and voided rows.
- **Payment detail** uses `PageHeader`, `DetailList` (installment, dates, account, VAT cleared, carry-forward, reference, notes, void details) and `TotalsPanel` (tax paid or refund received, penalty, total). The installments list is a `Panel`. Same figures and wording as before.
- **Record a Tax Payment** page header and `FormCard`. **Tax Settings** page header.
- **Forms restyled by class only** (`tax-payment-form.tsx`, `void-form.tsx`, `tax-settings-form.tsx`): `.erp-input`, ERP colour tokens for errors, notices and buttons. No state, fetch or validation logic was touched, so the forms do not yet use `Field` and still carry their own inline labels.
- **Not done in this phase.** The Tax Calendar and VAT/PAYE/WHT period views live in `accounting-hub.tsx` and keep their old styling. Tax Payments and the form previews still format amounts with `toLocaleString()` in the form's preview text (left alone with the logic); the list and detail pages use the central formatter. Payments list is not paged on the server.
- **Not verified in this sandbox.** `check:dates` passes (431 files, 0 violations). `prisma generate` is blocked here, so full `next build` cannot run; `tsc` filtered to this phase's files shows only implicit-any errors that come from the missing Prisma types. Run `npm run build` and open the list, a payment detail (with installments if you have one), Record a Tax Payment (VAT and a non-VAT type) and Tax Settings in a browser.

## ERP UI redesign, Phase 12: payroll

No schema change, no new routes, no new API. PAYE, pension, payroll calculation, pay and payslip-notification logic and API permission checks are unchanged; presentation only.

- **Employees** list on `DataTable` (Employee name links to the profile, Code, Position, Department, Branch, Monthly Salary with footer total). "Run Payroll" is wrapped in `PermissionGate perm="payroll.manage"` and "+ Add Employee" in `PermissionGate perm="employees.manage"`.
- **Employee profile** uses `PageHeader`, four `KpiCard`s (salary, start date, bank, masked account) and the payroll history on `DataTable` (Paid/Draft badge, Payslip link). Still the latest 24 runs.
- **Add Employee** is in a `FormCard` and every input now has a visible `Field` label (it used placeholders only). Input names, the payload and the submit logic are unchanged; the grid stacks to one column on a phone.
- **Payroll run** (`payroll-run-view.tsx`): `Field` pay-period picker, ERP notice for example tax rates, `KpiCard`s for the period (gross, PAYE, employee pension, net, with "n of m calculated" and "n paid"; they total the employees calculated so far), a Paid/Draft badge per employee, amounts in the central format. The per-employee Calculate / Pay / Text employee actions stay as cards because each row has its own client actions, which `DataTable` columns (plain data) cannot carry.
- **Fix while here.** A failed payroll load used to look like "no runs yet" and let you press Calculate again; it now shows the error and says so.
- **Payslip** uses ERP tokens and the central money format (so "MWK 1,250.00" with two decimals, where it used to show whole numbers). Print layout is unchanged (`print:hidden` on the button).
- **Not done in this phase.** `SendNoticeButton` is shared with other pages and keeps its old styling. The payroll run page still has no allowances or other-deductions inputs (the Calculate call sends 0 for both, as before). No bulk "run for all employees".
- **Observation, not changed here.** The Employees list, Employee profile, Payroll and Payslip pages do not themselves check `employees.view` / `payroll.view`; they only require a business membership (the API routes do check). Because salaries are visible on those pages, consider adding `hasPermission` checks to them in a later module. This phase is presentation-only, so behaviour was left as it was.
- **Not verified in this sandbox.** `check:dates` passes (431 files, 0 violations). `prisma generate` is blocked here, so full `next build` cannot run; `tsc` filtered to employees and payroll files shows only errors that come from the missing Prisma types. Run `npm run build` and open Employees, a profile, Add Employee, Payroll (calculate then pay one employee) and a payslip in a browser, including a print preview.

## ERP UI redesign, Phase 13: fixed assets

No schema change, no new routes, no new API. Depreciation, acquisition and disposal posting, the register calculation and the API permission checks are unchanged.

- **Register** (`/fixed-assets`) uses `PageHeader`, four `KpiCard`s (total cost, accumulated depreciation, net book value, active count with the disposed count as a note) and `DataTable` for Active and for Disposed assets (search, sort, CSV, footer totals; Branch is hidden by default). Run Depreciation and + Add Asset show only with `fixedassets.manage`. The MRA capital-allowance warning is kept, in ERP tokens.
- **Asset detail** (`/fixed-assets/[assetId]`) uses `PageHeader` with an Active/Disposed badge, `KpiCard`s, `DetailList` (now also shows the asset Description, which was stored but never displayed), a Disposal panel for disposed assets, and the depreciation history on `DataTable` with a footer total.
- **Record a Fixed Asset** is in a `FormCard`, every input has a visible `Field` label (names, payload and submit logic unchanged; the grid stacks on a phone).
- **Dispose** and **Run Depreciation** forms use `Field` and ERP tokens; amounts in the run results use `formatMoney`.
- **Fix while here: page-level permission checks.** The detail page did not check `fixedassets.view` and the new-asset page did not check `fixedassets.manage` (only the API did), so a member without them could open the page by URL. Both now show a short "your role doesn't have access" message, the same wording as the register.
- **Fix while here: stuck buttons.** The three forms had no `try/catch`, so a network failure left "Saving..." or "Running..." on screen forever. They now show an error and re-enable.
- **Not done in this phase.** No asset edit or delete screen exists in the UI (the API has them); the register still shows the whole business even for a branch-restricted member on the page (the API list filters by branch, the page calls `getFixedAssetRegister` directly, as before). No fixed asset register report on the Reports tab.
- **Not verified in this sandbox.** `check:dates` passes (431 files, 0 violations). Dependencies are not installed here, so neither `prisma generate` nor `next build` could run. Run `npm run build` and open the register, an asset with depreciation, a disposed asset, Add Asset (try Land, which hides Useful life), Run Depreciation for a month, and Dispose with and without proceeds.

## ERP UI redesign, Phase 14: settings

No schema change, no new routes, no new API. Every API route, permission check, validation and save/fetch call is unchanged; presentation only. Tax Settings was already done in Phase 11.

- **Pages restyled** under the Settings menu: Business Settings (`/settings/general`: time zone, reopen limit, stale-transfer threshold, service-cost alert), Online Payments, Billing & Subscription, Branches (list, add, detail/edit), Team (list, invite) and Notifications. All use `PageHeader`; the "no access" message on each uses the same wording as before.
- **Branches list** is on `DataTable` (name links to the branch, Head Office and Active/Inactive badges, Sales and Expenses with footer totals, sales count hidden by default) with three `KpiCard`s. The branch detail page uses `KpiCard`s and a `FormCard` around the edit form. The old "Back to Dashboard" links are gone (the shell has the menu); the detail page keeps "Back to branches".
- **Forms and client components** (the four general-settings forms, online payments, billing, team manager, invite, branch forms, notification alerts and retry button) were moved to the ERP tokens by class only: `.erp-input`, `erp-*` colours for errors, notices and buttons, `rounded` instead of `rounded-md/lg`. No state, fetch or validation logic was touched, and they do not yet use `Field` (they keep their own inline labels, as in the Phase 11 forms).
- **Notifications**: the delivery log stays a plain table (not `DataTable`) because each row carries a Retry button and several computed lines (retry state, delivery report), which `DataTable` columns (plain data) cannot hold. Filter chips, status badges and the alerts section use the tokens.
- **Layout change.** Money on the Branches pages now uses the central format (MWK 1,250,000.00, two decimals); it used to show whole numbers.
- **Not done in this phase.** Team manager, billing client and notification alerts are still bespoke layouts (no `DataTable`). No Field-based labels in the settings forms. No page-level permission message on the Notifications alerts beyond the existing `notifications.view` check.
- **Not verified in this sandbox.** `check:dates` passes (431 files, 0 violations). Dependencies are not installed here, so `prisma generate` and `next build` could not run, and none of this has been opened in a browser. Run `npm run build`, then open each Settings menu page in light and dark mode, change and save one value on Business Settings, open Billing (check the plan cards, the monthly/annual toggle and the usage bars), add and edit a branch, invite a member, and filter and retry on Notifications.

## ERP UI redesign, Phase 15: audit trail

**New permission, so one re-seed is needed.** Until `npm run prisma:seed` has been run once on each database, the new page and menu entry are hidden from everyone (the page then says the role has no access; nothing else breaks). No schema change and no migration: the `AuditLog` table already existed; this phase only reads it.

- **New page `/audit-trail`** (menu: Settings, Audit Trail), read-only. Needs the new `audit.view` permission, granted by default to Owner and Accountant (Manager and Cashier do not have it). Filters on the server: From and To (business time zone, whole days), Area (built from the actions this business actually has) and Person (any member). Shows When, Who, Area, Action, Record (entity type plus the last 8 characters of its id) and a one-line summary of the stored metadata; the raw action code is a hidden column. Search, sort, paging (50) and CSV export come from `DataTable`.
- **Limits, stated plainly.** Newest 500 events per query; if more match, a notice says so and you narrow the filter (there is no next-page link). Only this business's rows are read, so sign-in and other rows with no business are not shown. Actions starting `ai.` are left out on purpose: their metadata is the question a member typed to Mobi Accountant. A bad date in the URL is ignored and a notice says so.
- **Not shown or not possible yet.** No before/after field diff (most actions store only a few fields, so the summary is whatever was logged), no link from a row to the record (the entity type is a model name, not a route), and IP address is never filled in by most actions, so it is not shown. Not every mutation in the app writes an audit row (see `src/lib/audit.ts`); an empty trail for an area means nothing was logged there, not necessarily that nothing happened.
- **Files:** `src/lib/audit-trail.ts` (query, labels, metadata summary), `src/app/(app)/audit-trail/page.tsx`, `permissions.ts` (`audit.view`), `nav-config.ts`.
- **Not verified in this sandbox.** `check:dates` passes (433 files, 0 violations). Dependencies are not installed here, so `prisma generate` and `next build` could not run. Run `npm run prisma:seed`, then `npm run build`; open the page as Owner and as Manager (Manager should see the no-access message), apply each filter, and check an area with many rows to see the 500 notice.

## ERP UI redesign, Phase 16: responsive and mobile

No schema change, no new routes, no new API, no new permission. This is the last phase of the 16-phase redesign. Presentation only: no save, fetch or validation logic was touched.

- **Forms stack on phones.** 14 files had two- or three-column form grids that never collapsed (sale, purchase, quotation, expense, tax payment, product, stock transfer, FX forms, tax settings, dashboard summary cards). They are now one column below 640px and keep the old layout from `sm` up. The PAYE band rows in Tax Settings become Min/Max then Rate/Remove on a phone.
- **Tables scroll sideways instead of overflowing the page.** 13 bare tables (team, billing, accounting hub, credit and debit note forms, stock transfer, stock take, bank reconciliation, branch reorder levels) are wrapped in an `overflow-x-auto` container. `DataTable` already did this.
- **Page padding.** Legacy `p-8` pages (new-document pages, refunds, stock take, FX adjustments, AI assistant, error page) now use `p-4 sm:p-6`, matching the redesigned pages. The sales receipt is a print layout and was left alone, as were the sign-in, register and invitation pages (they sit outside the shell).
- **Phone-only CSS in `globals.css`.** Form fields are 16px with a 40px minimum height under 640px (iOS Safari zooms the page when a focused field is smaller than 16px); desktop sizes are unchanged. The shell height uses `100dvh` where supported so the status bar is not pushed below the visible screen by the mobile address bar.
- **Shell.** Breadcrumbs scroll sideways instead of overflowing. The notification bell dropdown (320px wide, anchored to the bell, so it ran off the left edge of a 360px phone) is now a full-width sheet under the header on phones and the same popover as before from `sm` up; its colours moved to the ERP tokens.
- **Remaining mobile/UI follow-up.** Tables in the older workspaces scroll sideways on a phone rather than becoming card lists. The landing page stays light outside the signed-in shell. The 8/4 withholding-tax rows were left as they are.
- **Not verified in this sandbox.** `check:dates` passes (433 files, 0 violations) and every changed `.ts`/`.tsx` file parses. Dependencies are not installed here, so `prisma generate` and `next build` could not run, and nothing has been opened in a browser or on a phone. Run `npm run build`, then open these at about 360px wide and at desktop width: dashboard, a new sale, a new expense, Tax Settings (PAYE bands), Team, Billing, the bell dropdown, the Accounting hub, and a long DataTable. Check that nothing scrolls the whole page sideways and that tapping a field does not zoom the page.

## ERP UI redesign, follow-up: theme pass and dark mode

Not one of the brief's 16 phases: it clears the "still on old grey/white classes" items left by Phases 2 to 16 and exposes the dark theme. No schema change, no new routes, no new API, no new permission. Presentation only.

- **Remaining legacy screens moved to the ERP tokens (about 75 files):** the dashboard and notification bell, every "new" form (sale, purchase, quotation, credit and debit notes, refund, expense, product, stock transfer, FX, manual journal), the stock take, stock transfer, bank reconciliation and service cost clearing workspaces, the accounting hub, period close, the AI assistant, and the small void, apply-credit and pay-link forms. This was a class-name mapping (grey/white/brand/red/green/amber/blue/orange to `erp-*` tokens, `input` to `erp-input`), not a hand redesign: layouts, tables and logic are exactly as before, and none of these screens were converted to `DataTable` or `Field`.
- **Status colours:** solid status buttons now use `text-erp-primary-fg` instead of white, because in the dark theme the danger/success/warning colours are light and white text on them is hard to read.
- **Dashboard charts** use CSS variables for gridlines, axis text, tooltip and pie labels, so they follow the theme. Series colours are unchanged.
- **Dark mode switch:** user menu (top right), "Dark mode" / "Light mode". The choice is kept in a cookie named `mbm.theme` (one year) and read in `(app)/layout.tsx`, so the page renders dark from the first paint with no light flash. It applies inside the signed-in shell only (the `dark` class goes on the shell root); the landing page, sign-in, register and invitation pages stay light. Native controls (select lists, date pickers, scrollbars) follow through `color-scheme: dark`.
- **Left light on purpose:** the sales receipt (a printed document), and everything outside the shell.
- **Not verified in this sandbox.** `check:dates` passes (433 files, 0 violations) and every `.ts`/`.tsx` file parses. Dependencies are not installed here, so `prisma generate` and `next build` could not run, and nothing has been looked at in a browser. Because the mapping was mechanical, expect a few places where contrast or an old border/background combination looks off in dark mode. Run `npm run build`, switch to dark mode and open: dashboard (charts, summary cards, bell), a new sale, bank reconciliation workspace, stock take, the accounting hub, period close, a branch, and the audit trail. Report any screen that looks wrong and I will fix it by name.
- **Update to earlier README notes:** the Phase 16 "Not done" line saying the dark theme is not exposed and several workspaces are light-only no longer applies.

## Notes for whoever continues this

- **Serialize stateful workflows on the row that owns the invariant.** Stock transfer receive/cancel and bank reconciliation completion use conditional state transitions inside a transaction. Reconciliation line mutations lock their parent reconciliation, and open/reopen serialize on the cash account, preserving the one-open-statement rule. Account deactivation and journal posting lock the affected accounts in a consistent order. Updating a row to its existing state can serialize writes without excluding the waiter; after it acquires the row, the same status condition may still match.

- **A bulk action over independently locked rows is N ordinary actions plus a summary, and it carries the figure the person SAW.** (Module 80) Reuse the single-row path per item (own transaction, own lock, own audit row, own void), report every item as done or skipped with the reason, and have the server compare an `expectedBalance` inside each locked transaction so a balance that moved since the page loaded refuses instead of being settled unseen. A business-wide alert that stands for many rows should be ONE bell alert with counts and days, no amounts, and no amount snapshot (a re-surface-on-change rule would bring it back after every sale).

- **A balance that two kinds of event move in opposite directions is cleared by a deliberate, derived-direction settlement, never automatically.** (Module 79) `planSettlement()` takes the direction from the sign of the computed balance and refuses to overshoot zero; the entry is tagged `ServiceCostSettlement`, voided by reversal, and the balance is recomputed from documents plus RECORDED settlements. Show the ledger figure next to the per-item total and surface the difference instead of hiding it.

- **"Accepted" and "delivered" are two facts; store the second one beside the first, never over it.** (Module 76)
  `NotificationLog.status` still means "the provider accepted it"; `deliveryState` is what the network later said, set
  only by `processDeliveryReport()`, forward only, first final answer wins, matched on the stored message id AND the
  number. A future provider event (Resend bounces, a payment gateway's chargeback) should follow that shape: keep the id
  at send time, a pure parser that refuses the unknown, a pure decision function, a conditional write, and an
  unauthenticated endpoint that checks its secret before it reads anything. Never let the queue retry an accepted text.

- **A retry is a new attempt guarded by a claim, and only for failures the provider said did not deliver.** (Module 75)
  `classifyFailure()` separates TRANSIENT (provider's bad minute) from CONFIG, RECIPIENT and UNKNOWN; only TRANSIENT, and only
  for templates nobody is watching (`RETRY_POLICIES`), is queued. The row is taken over with a conditional write before the
  resend, and age and relevance are re-checked at run time. A new template that is sent without anyone watching should get a
  policy (with a relevance rule in `isStillRelevant`); one a person triggers by hand should not. Never retry an "accepted but
  unconfirmed" send.

- **Money is confirmed by asking the gateway, never by being told.** (Module 73) The webhook, the return URL and the browser
  all only NAME a reference; `settleGatewayPayment()` asks the gateway about it and compares reference, currency and amount
  before anything is applied, then claims the row with a conditional update in the same transaction as the effect. A future
  gateway use (customer invoice payment, a second provider) should reuse that shape: a pure parser that fails closed, a
  pure decision function, one idempotent settle that every entry point calls, and a state for "money arrived but the effect
  was refused" so a received payment is never lost.

- **When an outside service answers "accepted", find where it reports the real outcome and read that.** (Module 71)
  A 2xx from a provider usually means "request received", not "it worked". `parseAfricasTalkingResponse()` trusts the
  per-recipient code over the status word, treats a code it doesn't know as a failure, and gives an unreadable body its
  own "unconfirmed" state instead of forcing it into success or failure. A future provider (Resend's delivery events,
  a payment gateway) should keep that shape: a pure import-free parser, fail closed on the unknown, and never call
  something confirmed that wasn't.

- **When a problem is "the same fact appears in two records", flag it with a count-aware pure function and pass over
  rows an earlier check already claimed.** (Module 70) `flagRepeatsOfOtherStatements(rows, others, skip)` never flags a
  row twice and never lets a claimed row use up a count, so skip counts stay disjoint. A future cross-record check
  (a payment repeated across two bank accounts, say) should reuse that shape and keep its key identical to the existing
  one. When several skip options interact, take the "will import N" figure from the server's dry run rather than
  re-deriving it in the client.

- **When a heuristic exists only because a fact wasn't stored, store the fact and keep the heuristic as the fallback for
  rows that predate it.** (Module 69) `classifyLineDate()` prefers the recorded `periodStart` and falls back to the
  92-day guess when it is null; nothing is backfilled and nothing changes for old rows. Anything counted from lines
  (like `outOfPeriodLines`) is computed live with the same pure function, never stored.

- **A conversion that needs extra input from the person names each thing it needs and refuses the rest.** (Module 68)
  `resolveLineMapping()` never guesses a product, never re-points an already-linked line, and never drops a line; the
  link is written inside the same transaction as the Module 38 claim so a failed conversion leaves no trace. A future
  "fill in the blanks at convert time" step (a missing customer, a missing branch) should follow that shape: a pure
  resolver shared by the client form and the server, checked before the write, rolled back with the claim.

- **"Is this period paid?" is a question for `summarizeSettlement()`, never for "does a RECORDED row exist".** (Module 67)
  Since installments, a period can have payments and still be owed money. The Tax Calendar, the bell alert and the
  record form all ask the pure function in `src/lib/tax-installments.ts`; anything new that needs to know whether a tax
  period is done must do the same. Keep the answer computed live - a stored "paid" flag would go stale when an
  installment is voided.

- **Undoing a write-off is the mirror of posting it - same account pair, same cost, dated now.** (Module 66)
  `postJournalEntryForTransferRecovery()` reverses `postJournalEntryForTransferShortfall()` at the cost the write-off
  used, not the current cost. Anything else that reverses a stock write-off should do the same, and should guard
  concurrent writers by conditioning its update on the column it is about to change (`quantityRecovered` here) rather
  than by a separate lock-then-read.

- **A quantity that never arrived is already out of the quantity books; only the GL still carries it.** (Module 65)
  Transfers move `StockLevel` and `Product.quantity` at dispatch but never post to the GL, so a short receipt needs a
  write-off entry (`postJournalEntryForTransferShortfall()`), not another inventory movement. Anything that adds a new
  way for goods to be lost between two branches should reuse that split - and resolve the quantities with the pure
  `resolveReceipt()` (thousandths, not floats) before touching anything.

- **A figure that depends on the WHOLE PERIOD's mix (not a single document) belongs in the report layer, not the
  posting layer.** (Module 45) `computeLineVat()` still computes VAT per line at Sale/Purchase creation time – it
  can't know the period's eventual exempt/taxable sales ratio, so it doesn't try. `getVatReturn()` computes the
  ratio and apportions AFTER the fact, the same way Module 20's corporate tax estimate reads the P&L rather than
  taxing each sale as it happens. If a future module needs another period-mix-dependent figure, follow this
  split: post the raw transaction normally, compute the period adjustment in the report, and – if it changes what
  the books actually owe – write it off/accrue it by manual journal entry (`MANUAL_JOURNAL_TEMPLATES`), never by
  changing how the original document posts.
- **A read-only report figure that changes what's remitted must be threaded through explicitly, not assumed.**
  (Module 45) `getVatReturn().purchases.inputVat` deliberately kept its old meaning (gross, ledger-posted) so nothing
  reading it for DISPLAY broke; the new `partialExemption.recoverableInputVat` is a sibling field, and
  `src/lib/tax-payments.ts` had to be found and changed by name to read the new field instead of assuming the old
  one still meant "what gets cleared." When changing what a number means, grep every caller rather than trusting
  the return type to catch it – TypeScript happily let the old `inputVat` field keep compiling with the wrong
  semantics until this was done by hand.

- **A new place that dates a record into the past must respect the lock** (Module 42). If it posts to the ledger
  with an explicit `entryDate`, `postJournalEntry()` already refuses a closed day and you need do nothing. If a
  report reads the record's own row (like Sale, Purchase, Expense), call `assertRecordDateOpen()` from
  `src/lib/period-close.ts` first thing inside the transaction, and add `PeriodClosedError` to the route's catch.
  Never read `Business.booksClosedThrough` yourself. A void of a ledger-only record needs no guard.
- **A hand-booked adjusting entry goes through `createManualJournal()`** (Module 41,
  `src/lib/manual-journal.ts`), which posts via `postJournalEntry()` and tags
  `referenceType "ManualJournal"`. Never write a `JournalEntry` from a route. A module that needs the
  Accountant to "book X by manual journal" should add a template to `MANUAL_JOURNAL_TEMPLATES`, not a
  second screen. A **new both-direction or below-the-line account** must be classified in
  `src/lib/pnl-layout.ts`, and anything that reads "net income" for the Balance Sheet must read
  `profitAfterTax`. Adding an account that mirrors a sub-ledger? Add its `systemKey` to
  `CONTROLLED_ACCOUNTS` so manual lines can't reach it.
- **A foreign-currency payment goes through `settleForeignDocument()`** (Module 40,
  `src/lib/foreign-settlement.ts`) – never a hand-edited `Payment.fxGainLoss`. `Payment.amount`
  is always the kwacha applied to the document; the cash that moved is `amount ± fxGainLoss`
  (`cashAmountForPayment()`), and anything summing `Payment.amount` as cash must account for that.
  A future module adding unit prices in a foreign currency or period-end revaluation of open
  invoices should extend `fx-calc.ts` and this file, not add a second path.
- **Exchange differences go through `createForeignExchangeAdjustment()`** (Module 39,
  `src/lib/foreign-exchange.ts`) – never a hand-rolled journal entry against
  `FOREIGN_EXCHANGE_GAIN_LOSS`. It moves the cash account's carrying value in the cashbook
  and the GL together. A future multi-currency module should extend it (per-document
  currency and rate; receivables/payables) rather than add a second posting path, and
  should decide how a realised difference on settling an invoice reaches the same account.
- **Check types against a real client.** `PRISMA_QUERY_ENGINE_LIBRARY=/any/file
  PRISMA_SCHEMA_ENGINE_BINARY=/any/file npx prisma generate` works offline; `tsc
  --noEmit` is then meaningful (0 errors as of Module 39) instead of hundreds of
  stub-client errors. Keep it at 0.
- **A read-then-write status check is a race; claim with a conditional write.**
  (Module 38) When a record moves through states and a step has side effects
  (create a Sale, post to the ledger), don't `findUnique` → check status → act.
  Do `updateMany({ where: { id, businessId, status: { in: [...] } }, data: {
  status: NEXT } })` first, inside the same transaction as the side effects, and
  treat `count === 0` as "someone else got there" (then read the row to say why).
  A function that opens its own `prisma.$transaction` and is called by something
  that also needs atomicity should take an optional `tx` (see `createSale`) –
  never wrap it as two writes and document the gap.
- **A P&L consumer wanting the bottom line reads `profitBeforeTax`, not
  `operatingProfit`** (Module 37). Layout rules live in `src/lib/pnl-layout.ts`;
  a new both-direction account must be classified there (`NON_OPERATING_ACCOUNTS`
  or left operating) and `npm run verify:pnl` kept passing. Classify by
  `systemKey`, never `code`.
- **Never compute a calendar day, month or period boundary with the runtime's
  local zone.** (Module 35) `new Date(y, m, d)`, `d.getMonth()`, `d.getDate()`,
  `toLocaleDateString()` with no `timeZone`, `setHours(0,0,0,0)` – all wrong on
  a UTC host. Server: `const tz = await getBusinessTimeZone(businessId)` then
  the helpers in `src/lib/timezone.ts` / `tax-period.ts` / `date-range.ts`.
  Client: take a `timeZone` prop from the server page. Every helper takes `tz`
  with no default, so the compiler finds a forgotten one.
  `scripts/verify-timezone.ts` must keep passing under several `TZ=` values.
  **Displaying** a date is the same rule (Module 36): `formatDateIn(value, tz)` /
  `formatDateTimeIn(value, tz)` from `src/lib/timezone.ts`, never
  `toLocaleDateString()` or `toLocaleString()` on a date. A client component
  takes a `timeZone` prop from its server page; a server page uses
  `resolveTimeZone(membership.business.timezone)`. `npm run check:dates`
  fails if a bare call comes back.
- **Every report in `src/lib/reports.ts` now accepts an optional trailing
  `branchId`, as of Module 30 – a new report added to this file should
  take one too**, threaded through the same way: filter directly when the
  underlying model already carries `branchId` (`Sale`, `Expense`,
  `SaleItem`), or thread it into the lower-level function you're wrapping
  (the way `getCustomerDebtReport` threads into `getReceivablesAging`) if
  that function already supports it. Don't add an eighth report that's
  silently business-wide-only while the other seven aren't – the whole
  point of this module was ending that inconsistency.
- **`Product.quantity` is business-wide; `StockLevel` is per-branch – a
  report or feature needing per-branch stock reads from `StockLevel` (via
  `getBranchStockList()`/`getBranchStockForProduct()` in
  `src/lib/inventory.ts`), never by trying to filter `Product` by
  branchId, which doesn't exist on that model.** Module 30's Inventory
  Report is the reference example for branching a report's logic on
  whether a branchId was given.
- **A module that reconciles book records against a real-world count
  (Bank Reconciliation, Stock Take) follows one shape**: snapshot the
  book figure once at open time (never compare against a live figure that
  keeps moving while the count happens), generate/collect lines, require
  every line to reach a resolved state (matched/posted/ignored) before
  completion, post genuine differences through the normal
  `recordInventoryMovement`/`postJournalEntry` paths (never a bespoke one),
  and give every posted line a full undo path while still `IN_PROGRESS`.
  If a future module reconciles anything else (declared VAT vs. an MRA
  assessment, a fixed asset register vs. a physical asset check), reuse
  this shape rather than inventing a new one.
- Email/SMS sending goes through `src/lib/notifications.ts` (`sendEmail()`
  / `sendSms()`) as of Module 24 – never add an ad-hoc `fetch`/`console.log`
  call per route for a new notification. If a future module needs a new
  outbound message (a low-stock alert, a subscription-trial-ending
  reminder), add a new `TEMPLATE_KEYS` entry and call the existing
  functions rather than inventing a fifth send path.
- Bell alerts (low stock, tax due, trial ending, stale in-transit transfer) go through
  `syncInAppNotifications()` in `src/lib/in-app-notifications.ts` as of
  Module 25 (Module 57 added the stale-transfer case). If a future module
  needs a new alert condition (a stock
  take left `IN_PROGRESS` too long, a bank reconciliation with a large
  unexplained difference), add it as another case in that file with its
  own `dedupeKey` prefix and decide up front whether it's
  condition-based (auto-resolves) or never-auto-resolved (dismiss-only)
  – don't build a second sync/dedupe mechanism alongside it. If the
  alert needs a business-tunable threshold, follow Module 58's shape:
  a `Business` column with a real default, `MIN_`/`MAX_`/`DEFAULT_`
  bounds shared by the Prisma default, the validation schema and the
  settings-form input, and a `GET`/`PUT` route under
  `business.settings.manage` – the same shape Module 51 established for
  the reopen cap.
- **Never read `Subscription.status` directly for a gating decision** –
  as of Module 26, call `getEffectiveSubscriptionStatus()` in
  `src/lib/subscription.ts` instead. The raw column can be a stale
  `"TRIAL"` well past `trialEndsAt` (there's no background job to flip
  it), and a route/page that skips this and compares the raw status
  reintroduces the exact bug Module 26 fixed. Display code (the billing
  page, the dashboard header) needs the same discipline, not just
  enforcement code.
- `src/proxy.ts` only confirms "is logged in." It does NOT check
  business membership or permissions – every protected API route must call
  `requireApiContext()` (which wraps `requireBusinessMember()` /
  `requirePermission()` from `src/lib/tenant.ts`). This split is deliberate.
- Stock quantity must only ever change through
  `recordInventoryMovement()` in `src/lib/inventory.ts` – the Sales module
  does this already; keep following that pattern for Purchases too.
- Sale creation and voiding both go through `src/lib/sales.ts` – don't add a
  second code path that writes to the `Sale` table directly (e.g. from a
  future bulk-import feature) without routing through the same
  totals/stock/receipt logic, or the audit trail and inventory will drift
  apart.
- Customer financial figures (total purchases, amount paid, outstanding
  balance) are computed, never stored – don't add a `Customer.balance`
  column as a shortcut later; go through `src/lib/customers.ts` instead, or
  debt figures will drift the way the FIFO-allocation bugfix in Module 5
  had to correct for.
- A general (non-sale-specific) payment against a customer MUST go through
  `applyCustomerPayment()` – creating a bare `Payment` row with only a
  `customerId` and no sale allocation reduces nothing, since outstanding
  balance is computed from `Sale.balance`.
- The dashboard's cash/mobile-money/bank balances now come from the real
  Cashbook ledger (Module 9, `src/lib/cashbook.ts::getCashbookSummary`) –
  the earlier approximation (`getChannelBalances`) has been removed.
- `Payment` is bidirectional as of Module 8: a row with `saleId`/`customerId`
  is money coming IN, a row with `purchaseId`/`supplierId` is money going
  OUT. Any future code that aggregates `Payment.amount` (a new report, an
  analytics feature) must filter by direction explicitly – summing all
  rows together silently mixes income and expense, which is exactly the bug
  `getChannelBalances()` had to be fixed for before it was replaced
  entirely by Module 9. Purchase cost basis is "last-in cost" only (see
  Module 8's writeup) – the Accounting module should introduce proper
  costing rather than patching this function.
- Every place money moves must post to the Cashbook via
  `postCashTransactionForPayment()` / `postCashTransactionForExpense()` /
  `postCashTransactionForPayroll()` in `src/lib/cashbook.ts` – actually
  remitting collected VAT or withholding tax to the MRA (clearing
  `VAT_OUTPUT_PAYABLE` / `WITHHOLDING_TAX_PAYABLE`) is
  now handled by Module 33's Tax Payments (`src/lib/tax-payments.ts`) – never
  hand-roll a remittance as an Expense or manual journal entry. If a future module edits or deletes a record that
  already posted cash, call `reverseCashTransactionsForReference()` first –
  never delete a `CashTransaction` row directly, since that erases the
  audit trail instead of explaining a correction.
- Voiding a paid Sale or Purchase does not reverse cash (see Module 9's
  writeup) – a Refunds module should resolve this deliberately rather than
  `voidSale`/`voidPurchase` guessing at refund intent.
- **Never hard-code a tax rate or percentage anywhere in this codebase.**
  `src/lib/payroll.ts::computePAYE()` reads bands from `TaxConfiguration`,
  and `src/lib/vat.ts`/`src/lib/withholding-tax.ts` follow the exact same
  pattern for VAT (Module 18) and withholding tax (Module 19) – corporate
  tax estimates, whenever built, must follow it too: rates as configurable
  data, not code, with the same "example until reviewed" disclaimer
  treatment `TaxConfiguration.isExample` already establishes (shared by
  PAYE, VAT, AND withholding tax – one flag, not three).
- `requirePlanFeature()` in `src/lib/subscription.ts` is the only sanctioned
  way to gate a Professional/Enterprise feature – Payroll is the first to
  use it; don't re-derive a plan check by comparing `plan.key` strings
  directly at a new call site.
- Employee bank account numbers are masked (`••••1234`) in every UI display
  (`src/app/employees/[employeeId]/page.tsx`) – keep that pattern for any
  new screen that shows employee financial details.
- **Technical verification, 2026-10-04:** the configured PostgreSQL database
  matched the Prisma schema before the baseline migration was recorded;
  `prisma generate`, `prisma validate`, and `prisma migrate status` now pass.
  `tsc --noEmit` and the Next.js 16 production build pass. `npm audit` reports
  no vulnerabilities. The ESLint baseline has 168 warnings (mostly existing
  `any` types and unused values); browser-based visual review has not been
  performed in this pass.
- Any new printable/downloadable document (a payslip PDF, a future
  statement-of-account) should call `renderBusinessDocumentPdf()` in
  `src/lib/pdf.ts` rather than hand-rolling another pdfkit layout – that's
  the whole point of building it as a shared engine in Module 15.
- `Invoice` and `Receipt` are both lazy-created, one-per-Sale, number-on-
  first-request documents – follow that same pattern (re-check for a raced
  create inside the transaction before claiming a number) for any future
  per-Sale document, rather than creating it eagerly inside `createSale()`
  itself, which would force every sale through every document type whether
  requested or not.
- **Never write to `JournalEntry`/`JournalLine` directly.** Every posting
  goes through `postJournalEntry()` in `src/lib/accounting.ts`, and every
  transaction-specific shape lives in `src/lib/accounting-integrations.ts`
  – `postJournalEntryForSale`/`postJournalEntryForPurchase` (Module 18) and
  `postJournalEntryForExpense`'s withholding-tax split (Module 19) are the
  reference examples for adding a new tax-related posting; a future VAT or
  withholding-tax remittance should add its own function there the same
  way, not hand-roll a journal entry inline in a route handler.
- Look up accounts by `Account.systemKey`, never by `code` or `name` –
  both are user-editable, `systemKey` is not (see the schema comment on
  `Account`). `getSystemAccountId()` throws loudly if a key is missing
  rather than silently skipping a posting.
- If a future module adds a genuinely new kind of financial event, decide
  up front whether voiding/editing it should reverse the full entry or
  only part of it (like Sales/Purchases splitting inventory from payment)
  – don't default to "reverse everything" without checking whether that
  actually matches what the Cashbook and Inventory modules do for the same
  event, or the three ledgers will disagree with each other.
- Cash Flow's Investing/Financing sections are placeholders by design (see
  Module 11's write-up) – if you add asset-purchase or owner-contribution/
  loan transaction types, give them their own `CashTransaction.referenceType`
  and update `getCashFlowStatement()`'s categorization in
  `src/lib/financial-statements.ts` rather than lumping them into Operating.
- `prisma.aIAnalysis` (the client accessor for the `AIAnalysis` model) is
  verified against the generated Prisma client. Prisma generation and schema
  validation completed on the configured PostgreSQL database on 2026-10-04.
- Next.js is pinned to `16.3.8`; dynamic request params use Next 16's async API.
- **Never filter a Sale or Expense query by a raw `branchId` from the
  request.** Always resolve it through `resolveBranchScope()` in
  `src/lib/tenant.ts` first – see Module 13's write-up for why this exists
  and what it prevents. If a future module adds another branch-scoped
  model, give it the same treatment rather than trusting the request value
  directly.
- **Any future module that adds a countable per-plan resource (users,
  branches, or something new) must call `requirePlanCapacity()` in
  `src/lib/subscription.ts`, not just `requirePlanFeature()`.** Module 14
  found that `maxUsers`/`maxBranches` had existed unenforced since Module 1
  – a boolean feature flag being checked doesn't mean the numeric limit
  next to it is.
- **A new `TaxConfiguration` field doesn't always need a lazy-backfill
  branch in `getOrCreateTaxConfiguration()`.** `withholdingTaxRates`
  (Module 19) needed one because it was added `Json?` with no column
  default. `corporateTaxRate` (Module 20) didn't, because it was added
  `Decimal @default(30)` – a real Postgres default backfills every
  pre-existing row the moment the migration runs. Only reach for the lazy
  backfill pattern when the new column genuinely can't have a static
  column default (a `Json` shape, or something that needs per-business
  computation to fill in).
- **Tax filing/payment DUE DATES are code, not `TaxConfiguration` data –
  don't follow the "rates as configurable data" rule for them.**
  `src/lib/tax-calendar.ts`'s day-of-month constants are a deliberate
  exception to "never hard-code a tax number": a rate is something this
  app calculates with and an Owner might reasonably need to correct, but
  a filing deadline is a structural fact of the tax law with nothing for
  an Owner to configure differently. If a future module needs to react to
  MRA changing a deadline (as it did with a blanket extension in April
  2026), update the constant in code and note the date it changed, rather
  than adding a per-business override field nobody asked for.
- **A period-end estimate (like Module 20's corporate tax) doesn't need a
  system account just because VAT and withholding tax got one.** Those two
  exist because VAT/withholding tax are carved out of an individual
  transaction at the moment it's recorded – there's a natural posting
  point (`postJournalEntryForSale`/`postJournalEntryForExpense`). A future
  module computing a period-end figure from already-posted activity (the
  way `getCorporateTaxEstimate()` reads `getProfitAndLoss()`) should ask
  whether there's an actual transaction to carve tax out of before adding
  a new liability account – if there isn't, document it as a manual
  journal entry the Owner/Accountant makes once they've finalized a real
  number, the same choice Module 20 made.
- **A record that inherits its branch from a related record (rather than
  taking one directly on a request, like Sale/Purchase do) still deserves
  its own `branchId` column – don't rely on a live join.** Module 29 gave
  `Payroll` its own `branchId`, snapshotted from `Employee.branchId` at
  calculation time, specifically so a past run's branch attribution
  survives the employee later being reassigned. If a future module adds
  another record whose "branch" is really inherited from something else
  (a document generated for an existing Sale, say), snapshot it the same
  way rather than reading the parent's CURRENT value at render/report time.
- **Not every branch-scoped write needs `resolveBranchScope()`'s exact
  request-vs-membership shape.** That function fits when the caller is
  choosing a branch value directly (a new Sale/Purchase/Employee). When a
  record's branch is derived from something else the caller referenced
  (Module 29's Payroll from its Employee, Module 28's stock transfer from
  two Branch ids), write the access check against the actual referenced
  record's branch instead – `resolveBranchScope()` is the right building
  block for "resolve which branch a NEW attribution should use," not for
  every branch-adjacent access check.
- **When a documented gap talks about "Sale/Purchase" or "Sale or
  Purchase" as if they're symmetric, verify that before building a
  symmetric fix – they often aren't.** Module 32 traced what
  `voidSale`/`voidPurchase` and their reversal functions actually reverse
  before touching refund postings, and found Sale and Purchase are built
  asymmetrically on purpose (Sale splits into two independently-reversible
  entries; Purchase posts and reverses everything as one). The VAT
  apportionment fix only belonged on the Sale side – building the same
  change into the Purchase side too would have double-corrected an account
  void had already zeroed out. Read what a "mirrors the other side" gap
  actually mirrors before assuming the fix does too.
- **When a function takes "a cash account", check whether it wants the
  `CashAccount` id or the GL `Account` id – they're different tables.**
  Module 33 found `disposeFixedAsset` pushing a `CashAccount.id` into a
  `JournalLine`, which failed on every disposal with proceeds. The correct
  pattern (Refunds, Bank Reconciliation, Tax Payments): keep the real
  `CashAccount` for the cashbook leg and pass its `type` to the GL function,
  which resolves the shared GL bucket via `CASH_ACCOUNT_KEYS`.
- **Range queries with an inclusive `to` need end-of-day, not midnight.**
  Routes: parse with `readDateRangeOrResponse()`/`readDateParamOrResponse()`
  (Module 34); never `new Date(searchParams.get(...))`. Client date inputs:
  `todayYmd()`, never `toISOString().slice(0, 10)`. Internally use `endOfDay()`
  from `src/lib/tax-period.ts` when calling anything that
  compares timestamps (`getVatReturn`, `getProfitAndLoss`, …) for a period
  ending on a given calendar day.
- **A payment/remittance against a computed obligation should match it by a
  deterministic key, not store the other side's id.** Tax Payments and the
  Tax Calendar share `(taxType, periodKey)` from `src/lib/tax-period.ts`; a
  nullable `@unique` column (`activePeriodKey`) gives a DB-level "one active
  row" rule where Prisma can't express a partial unique index.
- **When a computed figure can legitimately flow either direction (owed vs
  owed-to-us), give it a `{ direction, magnitude }` shape rather than a
  signed number the caller has to `Math.abs()` and re-interpret at every
  use site.** Module 46 made `netPayable`'s sign explicit as
  `resolveVatDirection()`'s `isRefund` boolean, with `magnitude` always
  positive – the preview, the create path, and the UI all branch on
  `isRefund` once instead of each re-deriving ">0 means X" from a raw
  number. Worth reaching for any time "negative means the opposite kind of
  transaction," not just "negative means smaller."
- **A pure helper that a plain-Node verify script needs to import must live
  somewhere that doesn't transitively pull in `src/lib/prisma.ts`.**
  Module 46 first added `resolveVatDirection()` directly inside
  `tax-payments.ts`, which imports Prisma at module scope – the script ran
  its checks fine but then crashed on Node trying to load a query engine
  binary that doesn't exist in this sandbox, exiting non-zero regardless of
  whether the checks passed. Moving it to its own import-free file
  (`vat-payment-direction.ts`, the same split `vat-apportionment.ts` already
  used) fixed it. When writing a new verify script, trace what the function
  under test actually imports before assuming "it's a pure function" is
  enough.

## Landing page (public front door at `/`)

The placeholder home page was replaced with a full marketing landing page. No schema, API, auth or dashboard change; no new dependency, env var required, migration or re-seed.

- **Route:** `/` only (`src/app/page.tsx`, a Server Component). `/dashboard`, `/login`, `/register` and every authenticated route are untouched; "Start Free" goes to `/register`, "Log in" to `/login`.
- **Components:** `src/components/landing/` – `ui.tsx` (Button, Badge, Card, SectionHeading, FeatureIcon, Logo), `previews.tsx` (DashboardPreview, DashboardWidget, ChartPreview, ProductPreview), `sections-a.tsx` / `sections-b.tsx` (Hero, TrustBar, Problem, Solution, Feature, Dashboard showcase, Reporting, Multi-branch, Security, Why Malawi, Industry, WorkflowDiagram, Mobile, CTA, FAQ, Footer), `pricing.tsx`, `client.tsx` (navbar, scroll reveal, counters, billing toggle). Only these four are client components.
- **Design tokens:** `tailwind.config.mjs` has the full `brand` green scale (50/600/700 unchanged) and an `ink` neutral scale. Existing pages render as before.
- **Pricing is real:** it renders `PLAN_DEFINITIONS` from `src/lib/plans.ts` (Free, Business, Professional, Enterprise; annual = 15% off), so it cannot drift from billing.
- **Accuracy rule:** copy only claims what exists in the app. Not claimed: recurring invoices, approval workflows, purchase orders, sales orders, Excel export, a native mobile app, MRA filing/compliance, and the plan flags that nothing enforces (API access, automated backups, custom reports, advanced integrations).
- **Optional env:** `NEXT_PUBLIC_CONTACT_EMAIL` makes "Talk to Us" and "Contact" open a `mailto:`; without it they scroll to the FAQ.
- **SEO:** title, description, canonical, Open Graph, Twitter, plus SoftwareApplication and FAQPage JSON-LD. `metadataBase` comes from `NEXTAUTH_URL`.
- **Sample data:** every product preview is labelled sample data.
- **Public pages:** `/about`, `/contact`, `/help` (landing FAQ), `/docs`, `/guides`, `/privacy`, `/terms`, `/security`, plus `sitemap.xml` and `robots.txt`. All are public (the auth proxy matcher is an allowlist). Shared shell: `src/components/landing/info-page.tsx`. Privacy and Terms carry a visible "not yet reviewed by a lawyer" notice; have them reviewed before launch. Failed sign-in attempts and public payment endpoints have per-process throttles; production deployments still need host/CDN edge protections. See the production deployment runbook.
- **Still not built (each is a whole module, not a page):** recurring invoices, approval workflows, purchase orders, sales orders, Excel (.xlsx) export, MRA filing, a native mobile app, and enforcement of the plan flags API access, automated backups, custom reports and advanced integrations. Careers and Blog pages do not exist.

## Module 81: OFX/QFX Bank Statement Import

Closes the file-format gap left by Module 62: bank reconciliation now accepts OFX and QFX downloads alongside CSV, using the same preview and import safeguards.

- **Parsing:** reads OFX 1.x SGML and OFX 2.x XML transaction records (DTPOSTED, TRNAMT, NAME, MEMO); signed transaction amounts preserve the existing convention (positive in, negative out). Each import still has the same 500,000-character and 1,000-row limits.
- **Review and commit:** OFX/QFX files go through the existing dry-run preview, invalid-row handling, duplicate and cross-statement checks, statement-period warnings, and explicit import. They are never matched or posted automatically.
- **UI:** accepts .ofx and .qfx file extensions and detects the format from the extension. The CSV date-order selector is hidden for OFX/QFX because OFX dates are ISO-shaped.
- **Files:** src/lib/bank-statement-csv.ts, src/lib/bank-reconciliation.ts, src/lib/validation.ts, the bank reconciliation import route and workspace.

### Remaining limitations

- **No live bank feed or automatic download.** The user downloads the statement from the bank and uploads it.
- PDF and Excel statement files are not parsed; export them as CSV first.
- Format detection uses the .ofx or .qfx filename extension. OFX rows without a valid posted date, non-zero amount, or description are reported in preview and require the existing skip-invalid choice to continue.

## Module 83: Payroll Salary Editing and Transaction Date Filters

Closes two usability gaps reported during UI review and makes the existing invoice action easier to find.

- **Employee salary:** a member with `employees.manage` can edit an employee's monthly salary from the employee profile. The update uses the existing tenant-scoped employee API permission and is recorded in the audit trail with the previous and new monthly amounts.
- **Transaction date filters:** Sales, Purchases and Expenses now accept optional From and To dates. Filters are applied in the database and interpret date-only values in the business time zone, including the entire selected end date. Existing row caps still apply (200 sales/purchases, 100 expenses).
- **Invoice discovery:** the sale detail page now exposes the existing PDF invoice generation action directly to members with `documents.generate`. Invoice generation remains on demand and idempotent.
- **Already supported:** purchase creation posts the purchase and any initial payment to accounting in the same transaction. Expense creation posts to accounting when recorded. Custom accounts can be added from Accounting → Chart of Accounts. There is no separate draft-to-post step for these records.
- **Files:** employee profile and salary control, employee PATCH route, audit trail area labels, shared date-filter component/helper, Sales/Purchases/Expenses list pages and sale detail page.

### Remaining limitations

- Date filters are now on the Sales, Purchases and Expenses lists; other record lists may still need their own date filters.
- Invoice PDFs are generated on demand; the invoice document is not automatically emailed to the customer.
