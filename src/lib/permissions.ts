import { BusinessRole } from "@prisma/client";

/**
 * Master list of permission keys. This is the single source of truth for
 * "what can be gated in this app". Later modules import from here instead of
 * inventing new ad-hoc strings, so a permission check always resolves to
 * something that exists in the Permission table (seeded from this file).
 *
 * Keep hard-coded role checks OUT of route handlers – always go through
 * requirePermission() / hasPermission() in auth-guards.ts so that Enterprise
 * per-member overrides (added later) work without touching call sites.
 */
export const PERMISSIONS = {
  // Sales
  "sales.create": "Create sales",
  "sales.view": "View sales",
  "sales.void": "Void or reverse a sale",

  // Inventory
  "inventory.manage": "Create/edit products and stock",
  "inventory.view": "View inventory",
  "inventory.adjust": "Make manual stock adjustments (damage, correction)",

  // Customers
  "customers.manage": "Create/edit customers, record debt payments",
  "customers.view": "View customers",
  "payments.record": "Record a payment against a sale or customer balance",

  // Expenses
  "expenses.manage": "Record and edit expenses",
  "expenses.view": "View expenses",

  // Financial reports & settings – deliberately excluded from MANAGER/CASHIER defaults
  "dashboard.view": "View the main business dashboard (financial summary, charts)",
  "reports.basic.view": "View basic reports: sales, expenses, inventory, debt, profitability",
  "reports.financial.view": "View P&L, balance sheet, cash flow",
  "settings.financial.manage": "Change tax settings, chart of accounts, payment accounts",

  // Accounting (Accountant + Owner)
  "accounting.manage": "Post/edit journal entries",
  "accounting.view": "View ledgers and trial balance",

  // Payroll & tax (Professional plan feature, gated separately by plan too)
  "employees.manage": "Create/edit employee records",
  "employees.view": "View employee records",
  "payroll.manage": "Run payroll, view payslips",
  "payroll.view": "View payroll history and payslips",
  "tax.manage": "Configure and compute tax",

  // Business administration
  "business.settings.manage": "Edit business profile, branding, numbering",
  "business.members.manage": "Invite/remove users, change roles",
  "business.subscription.manage": "Change subscription plan, billing – view/change plan, cancel, and billing history on the Billing page",

  // Branches
  "branches.manage": "Create/edit branches",

  // Suppliers & Purchases
  "suppliers.manage": "Create/edit suppliers, record supplier debt payments",
  "suppliers.view": "View suppliers",
  "purchases.create": "Record purchases (restocking)",
  "purchases.view": "View purchases",
  "purchases.void": "Void a purchase and reverse its stock",

  // AI Assistant & Analysis (Professional plan feature, gated separately by plan too)
  "ai.use": "Ask Mobi Accountant and run transaction analysis",

  // Cashbook
  "cashbook.view": "View cash account balances and transaction history",
  "cashbook.manage": "Create accounts and transfer money between them",

  // Business Documents – Quotations & Invoices
  "quotations.manage": "Create/edit quotations and convert them to sales",
  "quotations.view": "View quotations",
  "documents.generate": "Generate/download invoice and receipt PDFs",

  // Refunds – deciding what happens to cash on an already-voided sale/purchase
  "refunds.manage": "Process refunds for voided sales and purchases",
  "refunds.view": "View refund history",

  // Fixed Assets & Depreciation (Module 21)
  "fixedassets.manage": "Record, edit and dispose of fixed assets; run depreciation",
  "fixedassets.view": "View the fixed asset register",

  // Bank Reconciliation (Module 22)
  "bankrecon.manage": "Open, match, post adjustments for, and complete bank reconciliations (reopening a completed one also needs Business Settings)",
  "bankrecon.view": "View bank reconciliation history",

  // Stock Take (Module 23)
  "stocktake.manage": "Open stock takes, record physical counts, post inventory adjustments, and complete stock takes",
  "stocktake.view": "View stock take history",

  // Tax Payments (Module 33) – recording remittances to the MRA. Owner +
  // Accountant only, like bank reconciliation: it moves real money and
  // clears tax liabilities.
  "taxpayments.manage": "Record and void tax payments made to the MRA (VAT, PAYE, withholding tax, income tax)",
  "taxpayments.view": "View tax payment history",

  // Foreign Exchange Gains & Losses (Module 39) – Owner + Accountant only: it
  // writes to the ledgers and changes the carrying value of a cash account.
  "forex.manage": "Record and void foreign exchange gains and losses on foreign-currency cash accounts",
  "forex.view": "View foreign exchange gain and loss history",

  // Audit Trail (Module 82, Phase 15) – read-only view of the audit log. Owner + Accountant only:
  // it shows who changed what, including other members' actions. Needs a one-time re-seed.
  "audit.view": "View the audit trail: who created, changed, voided or deleted financial records, and when",

  // Notifications
  "notifications.view": "View the notification bell (low stock, tax due, trial ending) and the log of emails and SMS the system has sent (or attempted to send)",
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

/**
 * Default permission grants per role, per spec section 1:
 *  - OWNER: everything
 *  - MANAGER: sales, expenses, inventory, customers – NOT financial settings
 *  - CASHIER: record sales/payments only – NOT financial reports
 *  - ACCOUNTANT: accounting reports, tax, financial statements
 *
 * This seeds RolePermission. A business can layer per-member overrides on
 * top later without changing this baseline.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<BusinessRole, PermissionKey[]> = {
  OWNER: Object.keys(PERMISSIONS) as PermissionKey[],

  MANAGER: [
    "dashboard.view",
    "reports.basic.view",
    "sales.create",
    "sales.view",
    "sales.void",
    "inventory.manage",
    "inventory.view",
    "inventory.adjust",
    "customers.manage",
    "customers.view",
    "payments.record",
    "expenses.manage",
    "expenses.view",
    "branches.manage",
    "suppliers.manage",
    "suppliers.view",
    "purchases.create",
    "purchases.view",
    "purchases.void",
    "cashbook.view",
    "ai.use",
    "quotations.manage",
    "quotations.view",
    "documents.generate",
    "refunds.manage",
    "refunds.view",
    "fixedassets.view",
    "stocktake.manage",
    "stocktake.view",
    "notifications.view",
  ],

  CASHIER: [
    "sales.create",
    "sales.view",
    "customers.view",
    "inventory.view",
    "payments.record",
    "quotations.manage",
    "quotations.view",
    "documents.generate",
  ],

  ACCOUNTANT: [
    "dashboard.view",
    "reports.basic.view",
    "reports.financial.view",
    "accounting.manage",
    "accounting.view",
    "tax.manage",
    "employees.manage",
    "employees.view",
    "payroll.manage",
    "payroll.view",
    "expenses.view",
    "customers.view",
    "inventory.view",
    "suppliers.view",
    "purchases.view",
    "cashbook.view",
    "cashbook.manage",
    "ai.use",
    "quotations.view",
    "documents.generate",
    "refunds.view",
    "fixedassets.manage",
    "fixedassets.view",
    "bankrecon.manage",
    "bankrecon.view",
    "taxpayments.manage",
    "taxpayments.view",
    "forex.manage",
    "forex.view",
    "stocktake.view",
    "audit.view",
    "notifications.view",
  ],
};
