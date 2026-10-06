import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission, resolveBranchScope } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { getDashboardData } from "@/lib/dashboard";
import { getTaxCalendar } from "@/lib/tax-calendar";
import { startOfDay } from "@/lib/date-range";
import { syncInAppNotifications } from "@/lib/in-app-notifications";
import { getEffectiveSubscriptionStatus } from "@/lib/subscription";
import { PageHeader } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";
import { formatMoney, formatPercent } from "@/lib/erp/format";
import { SalesByDayChart, ExpensesByCategoryChart, TopProductsChart, PaymentMethodChart } from "./charts";
import { BranchSwitcher } from "./branch-switcher";
import { resolveTimeZone, formatDateIn } from "@/lib/timezone";

// The "understand your business in 30 seconds" dashboard – spec section 5
// and section 39's core product principle. Pulls from Sales, Expenses, and
// Inventory, all of which now exist.
export default async function DashboardPage(
  props: {
    searchParams: Promise<{ branchId?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) {
    return (
      <main className="p-4 sm:p-6">
        <p>No business found for this account. Please contact support.</p>
      </main>
    );
  }

  const membership = memberships[0];
  const membershipCtx = {
    businessId: membership.businessId,
    userId: session.user.id,
    role: membership.role,
    branchId: membership.branchId,
  };
  // Navigation permissions moved to the ERP shell (src/app/(app)/layout.tsx);
  // the page keeps only the checks its own content depends on.
  const [canViewDashboard, canViewAccounting, canViewQuotations, canViewNotifications, canManageBilling] = await Promise.all([
    hasPermission(membershipCtx, "dashboard.view"),
    hasPermission(membershipCtx, "accounting.view"),
    hasPermission(membershipCtx, "quotations.view"),
    hasPermission(membershipCtx, "notifications.view"),
    hasPermission(membershipCtx, "business.subscription.manage"),
  ]);

  const subscription = await prisma.subscription.findUnique({
    where: { businessId: membership.businessId },
    include: { plan: true },
  });
  // Module 26: show the EFFECTIVE status (a TRIAL past its trialEndsAt now
  // reads as EXPIRED here too) rather than the raw DB column – see
  // getEffectiveSubscriptionStatus()'s comment in subscription.ts for why
  // that distinction matters and was previously silently wrong.
  const effectiveSubscriptionStatus = subscription ? getEffectiveSubscriptionStatus(subscription) : null;
  const daysLeftInTrial =
    subscription?.status === "TRIAL" && subscription.trialEndsAt
      ? Math.max(0, Math.ceil((subscription.trialEndsAt.getTime() - Date.now()) / 86_400_000))
      : null;

  // Cashiers can't see financial reports per spec section 1 – give them a
  // simple quick-actions landing instead of a 403 or an empty dashboard.
  if (!canViewDashboard) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <h1 className="text-2xl font-bold">{membership.business.name}</h1>
        <p className="text-erp-muted">Logged in as {session.user.name} – role: <strong>{membership.role}</strong></p>
        <div className="mt-8 space-y-3">
          <Link href="/sales/new" className="block rounded bg-erp-primary px-4 py-3 text-center text-erp-primary-fg hover:opacity-90">
            Record a Sale
          </Link>
          <Link href="/sales" className="block rounded border border-erp-border px-4 py-3 text-center hover:bg-erp-subtle">
            View Recent Sales
          </Link>
          <Link href="/customers" className="block rounded border border-erp-border px-4 py-3 text-center hover:bg-erp-subtle">
            Customers
          </Link>
          {canViewQuotations && (
            <Link href="/quotations" className="block rounded border border-erp-border px-4 py-3 text-center hover:bg-erp-subtle">
              Quotations
            </Link>
          )}
        </div>
      </main>
    );
  }

  // A branch-restricted member's dashboard is always locked to their own
  // branch; an unrestricted member (Owner/Manager) can filter to one branch
  // via ?branchId= or leave it unset to see the whole business. An invalid
  // request (e.g. a stale link to a branch they've lost access to) just
  // falls back to their allowed scope rather than erroring the page.
  let branchId: string | null;
  try {
    branchId = resolveBranchScope(membershipCtx, searchParams.branchId ?? null);
  } catch {
    branchId = membershipCtx.branchId;
  }

  // Module 20 (Tax Calendar) – a compact "what's coming up" widget, gated
  // by accounting.view the same way the Accounting nav link itself is
  // (dashboard.view alone doesn't imply a role should see tax obligations
  // – e.g. a Cashier never even reaches this branch of the page).
  const upcomingTaxDeadlinesWindow = { days: 30 };
  const [data, branches, upcomingTaxDeadlines] = await Promise.all([
    getDashboardData(membership.businessId, branchId),
    membershipCtx.branchId
      ? Promise.resolve([]) // restricted members don't get a switcher – nothing else to switch to
      : prisma.branch.findMany({
          where: { businessId: membership.businessId, isActive: true },
          orderBy: [{ isHeadOffice: "desc" }, { name: "asc" }],
          select: { id: true, name: true },
        }),
    canViewAccounting
      ? getTaxCalendar(
          membership.businessId,
          // Module 34: from the START of today, not "right now" – a deadline
          // due today sits at local midnight, so `new Date()` dropped it from
          // this widget from 00:01 on its own due day.
          startOfDay(new Date(), resolveTimeZone(membership.business.timezone)),
          new Date(Date.now() + upcomingTaxDeadlinesWindow.days * 86_400_000)
        )
      : Promise.resolve([]),
    // Module 25 – keep generating/refreshing the low-stock/tax-due/trial-ending
    // alerts on dashboard load. The bell itself now lives in the ERP header
    // (it shows the unread count and refetches the list when opened).
    canViewNotifications ? syncInAppNotifications(membership.businessId) : Promise.resolve(),
  ]);
  // Module 33: an entry with a recorded payment is done – not a deadline any more.
  const upcomingTaxDeadlinesUnpaid = upcomingTaxDeadlines.filter((e) => e.status !== "paid");
  // Outstanding invoices: open credit/partial sales, biggest balance first.
  // Scoped by business and (for a branch-restricted member or a chosen branch) branch.
  const openSales = await prisma.sale.findMany({
    where: {
      businessId: membership.businessId,
      status: { in: ["PARTIAL", "CREDIT"] },
      balance: { gt: 0 },
      ...(branchId ? { branchId } : {}),
    },
    include: { customer: { select: { name: true } } },
    orderBy: { balance: "desc" },
    take: 15,
  });
  const tz = resolveTimeZone(membership.business.timezone);
  const outstandingRows = openSales.map((x) => ({
    id: x.id,
    href: `/sales/${x.id}`,
    saleNumber: x.saleNumber,
    customer: x.customer?.name ?? "Walk-in",
    date: formatDateIn(x.saleDate, tz, { day: "2-digit", month: "short", year: "numeric" }),
    dateSort: x.saleDate.getTime(),
    total: Number(x.total),
    paid: Number(x.amountPaid),
    balance: Number(x.balance),
    status: x.status,
    tone: x.status === "PARTIAL" ? "warning" : "danger",
  }));
  const { financialSummary: fs, businessHealth: bh, charts, lists } = data;

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Dashboard"
        description={`${subscription?.plan.name ?? ""} plan – ${effectiveSubscriptionStatus ?? ""}${daysLeftInTrial !== null && effectiveSubscriptionStatus === "TRIAL" ? ` · ${daysLeftInTrial} day${daysLeftInTrial === 1 ? "" : "s"} left in trial` : ""}`}
        actions={
          <>
            {canManageBilling && (
              <Link href="/settings/billing" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">
                Manage billing
              </Link>
            )}
            <Link href="/sales/new" className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90">
              + New Sale
            </Link>
          </>
        }
      />

      {branches.length > 0 && <BranchSwitcher branches={branches} selectedBranchId={branchId} />}

      {/* Monthly overview – current month compared with the previous month. */}
      <section className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Monthly financial overview">
        <SummaryCard
          label="Revenue"
          value={fs.monthlySales}
          comparison={bh.salesGrowth}
          comparisonGoodWhen="up"
        />
        <SummaryCard
          label="Expenses"
          value={fs.monthlyExpenses}
          comparison={bh.expenseGrowth}
          comparisonGoodWhen="down"
        />
        <SummaryCard
          label="Net Profit"
          value={fs.monthlyProfit}
          comparison={percentChange(fs.monthlyProfit, charts.profitTrend.lastMonth)}
          comparisonGoodWhen="up"
        />
        <SummaryCard
          label="Cash Position"
          value={fs.cashPosition}
          note={`${fs.cashAccountCount} active account${fs.cashAccountCount === 1 ? "" : "s"}${branchId ? " · business-wide" : ""}`}
        />
        <SummaryCard
          label="Receivables"
          value={bh.outstandingCustomerDebt}
          note={`${formatMoney(fs.overdueReceivables)} past due on invoices`}
          noteTone={fs.overdueReceivables > 0 ? "bad" : undefined}
        />
        <SummaryCard
          label="Payables"
          value={bh.supplierDebt}
          note={`${fs.openPurchaseCount} open purchase${fs.openPurchaseCount === 1 ? "" : "s"} · due dates not tracked`}
        />
      </section>

      {/* Business Health – spec section 5 */}
      <section className="mb-8 rounded border bg-erp-surface p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-erp-muted">Business Health</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <HealthStat label="Gross Margin" value={formatPercent(bh.grossProfitMargin)} />
          <HealthStat label="Net Margin" value={formatPercent(bh.netProfitMargin)} />
          <HealthStat label="Inventory Value" value={formatMoney(bh.inventoryValue)} />
          <HealthStat label="Low / Out of Stock" value={`${bh.lowStockCount} / ${bh.outOfStockCount}`} tone={bh.outOfStockCount > 0 ? "bad" : undefined} />
          {bh.stockInTransitCount > 0 && (
            <HealthStat
              label="Stock In Transit"
              value={`${bh.stockInTransitCount} transfer${bh.stockInTransitCount === 1 ? "" : "s"} · ${formatMoney(bh.stockInTransitValue)}`}
            />
          )}
        </div>
      </section>

      {/* Module 82: accounting panels. Aging is by SALE date – a regular sale has no due date. */}
      <section className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-erp-muted">Accounts Receivable Aging (by sale date)</h2>
          <DataTable
            compact
            exportName="receivable-aging"
            emptyMessage="No outstanding customer balances."
            rowHrefKey="href"
            columns={[
              { key: "customerName", header: "Customer", hrefKey: "href", sticky: true },
              { key: "current", header: "Today", type: "money", total: true },
              { key: "days1to30", header: "1-30 days", type: "money", total: true },
              { key: "days31to60", header: "31-60", type: "money", total: true },
              { key: "days61to90", header: "61-90", type: "money", total: true },
              { key: "days90plus", header: "90+", type: "money", total: true },
              { key: "total", header: "Total", type: "money", total: true },
            ]}
            rows={lists.receivableCustomers.map((c) => ({ ...c, id: c.customerId, href: `/customers/${c.customerId}` }))}
          />
        </div>
        <div>
          <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-erp-muted">Outstanding Invoices (largest 15)</h2>
          <DataTable
            compact
            exportName="outstanding-invoices"
            emptyMessage="No outstanding invoices."
            rowHrefKey="href"
            columns={[
              { key: "saleNumber", header: "Invoice", hrefKey: "href", sticky: true },
              { key: "customer", header: "Customer" },
              { key: "date", header: "Date", sortKey: "dateSort" },
              { key: "total", header: "Amount", type: "money" },
              { key: "paid", header: "Paid", type: "money" },
              { key: "balance", header: "Balance", type: "money", total: true },
              { key: "status", header: "Status", type: "badge", toneKey: "tone" },
            ]}
            rows={outstandingRows}
          />
        </div>
        <div>
          <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-erp-muted">Low Stock (business-wide)</h2>
          <DataTable
            compact
            exportName="low-stock"
            emptyMessage="No products at or below their reorder level."
            rowHrefKey="href"
            columns={[
              { key: "name", header: "Product", hrefKey: "href", sticky: true },
              { key: "sku", header: "SKU" },
              { key: "quantity", header: "Available", type: "number" },
              { key: "reorderLevel", header: "Reorder level", type: "number" },
            ]}
            rows={lists.lowStock.map((p) => ({ ...p, href: `/inventory/${p.id}` }))}
          />
        </div>
      </section>

      {/* Module 20 (Tax Calendar) – next 30 days only; the full calendar (with a
          3/6/12-month picker) lives on the Accounting page's Tax Calendar tab. */}
      {canViewAccounting && upcomingTaxDeadlinesUnpaid.length > 0 && (
        <section className="mb-8 rounded border bg-erp-surface p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-erp-muted">Upcoming Tax Deadlines</h2>
            <Link href="/accounting" className="text-xs text-erp-primary underline">View full calendar</Link>
          </div>
          <div className="space-y-2">
            {upcomingTaxDeadlinesUnpaid.slice(0, 4).map((entry, i) => (
              <div
                key={i}
                className={`flex items-center justify-between rounded border p-2 text-sm ${entry.status === "overdue" ? "border-erp-danger/40 bg-erp-danger/10" : "border-erp-border"}`}
              >
                <span>
                  {entry.label} <span className="text-xs text-erp-muted">({entry.periodLabel})</span>
                </span>
                <span className={entry.status === "overdue" ? "font-semibold text-erp-danger" : "text-erp-muted"}>
                  Due {formatDateIn(entry.dueDate, resolveTimeZone(membership.business.timezone))}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Charts – spec section 5 */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ChartCard title="Sales – Last 14 Days">
          <SalesByDayChart data={charts.salesByDay} />
        </ChartCard>
        <ChartCard title="Expenses by Category (This Month)">
          <ExpensesByCategoryChart data={charts.expensesByCategory} />
        </ChartCard>
        <ChartCard title="Top-Selling Products (This Month)">
          <TopProductsChart data={charts.topProducts} />
        </ChartCard>
        <ChartCard title="Sales by Payment Method (This Month)">
          <PaymentMethodChart data={charts.paymentMethodBreakdown} />
        </ChartCard>
      </section>
    </main>
  );
}

function SummaryCard({
  label,
  value,
  comparison,
  comparisonGoodWhen = "up",
  note,
  noteTone,
}: {
  label: string;
  value: number;
  comparison?: number | null;
  comparisonGoodWhen?: "up" | "down";
  note?: string;
  noteTone?: "bad";
}) {
  const improving = comparison !== null && comparison !== undefined && (comparisonGoodWhen === "up" ? comparison >= 0 : comparison <= 0);
  const comparisonText = comparison === null || comparison === undefined
    ? "No previous-month baseline"
    : `${comparison >= 0 ? "▲" : "▼"} ${Math.abs(comparison).toFixed(1)}% vs last month`;
  return (
    <div className="min-h-[92px] rounded-lg border border-erp-border bg-erp-surface px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-erp-muted">{label}</p>
      <p className="mt-1 text-base font-semibold tabular text-erp-text">{formatMoney(value)}</p>
      {comparison !== undefined ? (
        <p className={`mt-0.5 text-[11px] ${comparison === null ? "text-erp-muted" : improving ? "text-erp-success" : "text-erp-danger"}`}>{comparisonText}</p>
      ) : note ? (
        <p className={`mt-0.5 text-[11px] ${noteTone === "bad" ? "text-erp-danger" : "text-erp-muted"}`}>{note}</p>
      ) : null}
    </div>
  );
}

function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

function HealthStat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div>
      <p className="text-xs text-erp-muted">{label}</p>
      <p className={`font-semibold ${tone === "bad" ? "text-erp-danger" : tone === "good" ? "text-erp-success" : ""}`}>
        {value}
      </p>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border bg-erp-surface p-4">
      <h3 className="mb-2 text-sm font-medium text-erp-text">{title}</h3>
      {children}
    </div>
  );
}
