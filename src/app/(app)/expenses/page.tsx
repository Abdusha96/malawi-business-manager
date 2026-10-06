import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";
import { PermissionGate } from "@/components/erp/permission-gate";
import { formatMoney } from "@/lib/erp/format";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, resolveBranchScope } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { EXPENSE_CATEGORY_LABELS } from "@/lib/validation";
import { resolveTimeZone, startOfMonthIn, formatDateIn } from "@/lib/timezone";
import { DateFilter } from "@/components/erp/date-filter";
import { parseOptionalDateFilter } from "@/lib/date-filter";

export default async function ExpensesPage(props: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;
  const branchId = resolveBranchScope(
    { businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId },
    null
  );

  const now = new Date();
  const tz = resolveTimeZone(membership.business.timezone);
  const params = await props.searchParams;
  const dateFilter = parseOptionalDateFilter(params.from, params.to, tz);
  const startOfMonth = startOfMonthIn(now, tz);

  const [expenses, monthAgg] = await Promise.all([
    prisma.expense.findMany({
      where: {
        businessId,
        ...(branchId ? { branchId } : {}),
        ...(!dateFilter.error && (dateFilter.from || dateFilter.to) ? { expenseDate: { ...(dateFilter.from ? { gte: dateFilter.from } : {}), ...(dateFilter.to ? { lte: dateFilter.to } : {}) } } : {}),
      },
      include: { branch: { select: { name: true } } },
      orderBy: { expenseDate: "desc" },
      take: 100,
    }),
    prisma.expense.aggregate({
      where: { businessId, expenseDate: { gte: startOfMonth }, ...(branchId ? { branchId } : {}) },
      _sum: { amount: true },
    }),
  ]);

  const rows = expenses.map((e) => ({
    id: e.id,
    date: formatDateIn(new Date(e.expenseDate), tz),
    dateSort: new Date(e.expenseDate).toISOString(),
    category: EXPENSE_CATEGORY_LABELS[e.category],
    description: e.description,
    branch: e.branch?.name ?? "",
    payee: e.payee ?? "",
    amount: Number(e.amount),
    withheld: Number(e.withholdingTaxAmount),
    certificate: e.withholdingTaxCategory ? "Certificate" : "",
    certificateHref: `/api/business/${businessId}/expenses/${e.id}/withholding-certificate`,
  }));

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Expenses"
        description={`This month: ${formatMoney(Number(monthAgg._sum.amount ?? 0))}. The list shows up to 100 matching expenses.`}
        actions={
          <PermissionGate perm="expenses.manage">
            <Link href="/expenses/new" className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90">+ Add Expense</Link>
          </PermissionGate>
        }
      />
      <DateFilter from={params.from} to={params.to} error={dateFilter.error ?? undefined} />
      <DataTable
        exportName="expenses"
        searchPlaceholder="Search expenses…"
        selectable
        emptyMessage="No expenses recorded yet."
        columns={[
          { key: "date", header: "Date", sortKey: "dateSort" },
          { key: "category", header: "Category" },
          { key: "description", header: "Description" },
          { key: "branch", header: "Branch", defaultHidden: true },
          { key: "payee", header: "Payee" },
          { key: "amount", header: "Amount", type: "money", total: true },
          { key: "withheld", header: "Withheld", type: "money", total: true },
          { key: "certificate", header: "", hrefKey: "certificateHref" },
        ]}
        rows={rows}
      />
    </main>
  );
}
