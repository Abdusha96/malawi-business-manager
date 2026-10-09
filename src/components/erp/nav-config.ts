import { PERMISSIONS, type PermissionKey } from "@/lib/permissions";

/**
 * ERP navigation tree (Module 82). Only routes that really exist are listed:
 * the Sage-style wish list in the UI brief (Bank Rules, Recurring Invoices,
 * Purchase Orders, ...) has no pages yet, and a dead link in an accounting
 * menu is worse than a missing one. Add a module here when its page ships.
 *
 * `perm` is "any of": the link shows when the member holds at least one key.
 * No `perm` = visible to every member (the page itself still enforces access;
 * the menu is a convenience, never the security boundary).
 */
export type NavItem = { label: string; href: string; perm?: PermissionKey[] };
export type NavGroup = { id: string; label: string; icon: string; href?: string; items: NavItem[]; perm?: PermissionKey[] };

export const NAV: NavGroup[] = [
  { id: "dashboard", label: "Dashboard", icon: "▦", href: "/dashboard", items: [] },
  {
    id: "sales", label: "Sales", icon: "↗", items: [
      { label: "Sales & Invoices", href: "/sales", perm: ["sales.view"] },
      { label: "New Sale", href: "/sales/new", perm: ["sales.create"] },
      { label: "Quotations", href: "/quotations", perm: ["quotations.view"] },
      { label: "Credit Notes", href: "/credit-notes", perm: ["refunds.view"] },
      { label: "Refunds", href: "/refunds", perm: ["refunds.view"] },
    ],
  },
  {
    id: "purchases", label: "Purchases", icon: "↙", items: [
      { label: "Purchases", href: "/purchases", perm: ["purchases.view"] },
      { label: "Expenses", href: "/expenses", perm: ["expenses.view"] },
      { label: "Debit Notes", href: "/debit-notes", perm: ["refunds.view"] },
    ],
  },
  {
    id: "customers", label: "Customers", icon: "☺", items: [
      { label: "Customers", href: "/customers", perm: ["customers.view"] },
      { label: "Debtors Analysis", href: "/customers/debts", perm: ["customers.view"] },
    ],
  },
  {
    id: "suppliers", label: "Suppliers", icon: "♧", items: [
      { label: "Suppliers", href: "/suppliers", perm: ["suppliers.view"] },
      { label: "Creditors Analysis", href: "/suppliers/debts", perm: ["suppliers.view"] },
    ],
  },
  {
    id: "inventory", label: "Inventory", icon: "▤", items: [
      { label: "Products", href: "/inventory", perm: ["inventory.view"] },
      { label: "Stock Transfers", href: "/stock-transfers", perm: ["inventory.view"] },
      { label: "Stock Take", href: "/stock-take", perm: ["stocktake.view"] },
      { label: "Service Cost Clearing", href: "/service-cost-clearing", perm: ["accounting.view"] },
    ],
  },
  {
    id: "banking", label: "Banking", icon: "▥", items: [
      { label: "Cashbook", href: "/cashbook", perm: ["cashbook.view"] },
      { label: "Bank Reconciliation", href: "/bank-reconciliation", perm: ["bankrecon.view"] },
    ],
  },
  {
    id: "accounting", label: "Accounting", icon: "≡", items: [
      { label: "Ledger, Accounts & Tax Calendar", href: "/accounting", perm: ["accounting.view"] },
      { label: "Journal Entries", href: "/manual-journals", perm: ["accounting.view"] },
      { label: "Foreign Exchange", href: "/fx-adjustments", perm: ["forex.view"] },
      { label: "Period Close", href: "/period-close", perm: ["accounting.view"] },
    ],
  },
  { id: "assets", label: "Fixed Assets", icon: "▣", href: "/fixed-assets", perm: ["fixedassets.view"], items: [] },
  {
    id: "payroll", label: "Payroll", icon: "₩", items: [
      { label: "Employees", href: "/employees", perm: ["employees.view"] },
      { label: "Payroll Runs", href: "/payroll", perm: ["payroll.view"] },
    ],
  },
  {
    id: "tax", label: "Tax", icon: "%", items: [
      { label: "Tax Payments", href: "/tax-payments", perm: ["taxpayments.view"] },
      { label: "Tax Settings", href: "/settings/tax", perm: ["settings.financial.manage", "business.settings.manage"] },
    ],
  },
  { id: "reports", label: "Reports", icon: "◧", href: "/reports", perm: ["reports.basic.view", "reports.financial.view"], items: [] },
  { id: "ai", label: "Mobi Accountant", icon: "✦", href: "/ai-assistant", perm: ["ai.use"], items: [] },
  {
    id: "admin", label: "Settings", icon: "⚙", items: [
      { label: "Business Settings", href: "/settings/general", perm: ["business.settings.manage"] },
      { label: "Data Migration", href: "/data-migration", perm: ["inventory.manage", "fixedassets.manage"] },
      { label: "Online Payments", href: "/settings/online-payments", perm: ["business.settings.manage"] },
      { label: "Billing", href: "/settings/billing", perm: ["business.subscription.manage"] },
      { label: "Branches", href: "/branches", perm: ["branches.manage"] },
      { label: "Team", href: "/team", perm: ["business.members.manage"] },
      { label: "Audit Trail", href: "/audit-trail", perm: ["audit.view"] },
      { label: "Notifications", href: "/notifications", perm: ["notifications.view"] },
    ],
  },
];

/** Every permission key the menu depends on – the server layout resolves exactly these. */
export function navPermissionKeys(): PermissionKey[] {
  const keys = new Set<PermissionKey>();
  for (const g of NAV) {
    g.perm?.forEach((k) => keys.add(k));
    for (const i of g.items) i.perm?.forEach((k) => keys.add(k));
  }
  return [...keys];
}

/** All permissions used by client-side controls, not just those used by links. */
export function uiPermissionKeys(): PermissionKey[] {
  return Object.keys(PERMISSIONS) as PermissionKey[];
}

export function allows(granted: ReadonlySet<string>, perm?: PermissionKey[]): boolean {
  return !perm || perm.length === 0 || perm.some((k) => granted.has(k));
}

/** Menu filtered to what this member may see; empty groups disappear. */
export function visibleNav(granted: ReadonlySet<string>): NavGroup[] {
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => allows(granted, i.perm)) })).filter((g) =>
    g.href ? allows(granted, g.perm) : g.items.length > 0
  );
}

/** Longest-prefix match so /sales/abc highlights "Sales & Invoices", not "New Sale". */
export function findActive(pathname: string): { group?: NavGroup; item?: NavItem } {
  let best: { group?: NavGroup; item?: NavItem; len: number } = { len: -1 };
  const test = (href: string, group: NavGroup, item?: NavItem) => {
    if ((pathname === href || pathname.startsWith(href + "/")) && href.length > best.len) best = { group, item, len: href.length };
  };
  for (const g of NAV) {
    if (g.href) test(g.href, g);
    for (const i of g.items) test(i.href, g, i);
  }
  return best;
}
