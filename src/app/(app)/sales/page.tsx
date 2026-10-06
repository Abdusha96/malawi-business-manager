import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, resolveBranchScope } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { formatDateIn, resolveTimeZone } from "@/lib/timezone";
import { PageHeader } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";
import { PermissionGate } from "@/components/erp/permission-gate";
import { DateFilter } from "@/components/erp/date-filter";
import { parseOptionalDateFilter } from "@/lib/date-filter";

const TONE: Record<string, string> = { PAID: "success", PARTIAL: "warning", CREDIT: "danger", VOIDED: "neutral" };
// The list loads the latest sales only; search and sort run over these rows.
const LIST_LIMIT = 200;

export default async function SalesPage(props: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;
  const tz = resolveTimeZone(membership.business.timezone);
  const params = await props.searchParams;
  const dateFilter = parseOptionalDateFilter(params.from, params.to, tz);
  // A branch-restricted member only ever sees their own branch's sales here
  // – see resolveBranchScope() in tenant.ts.
  const branchId = resolveBranchScope(
    { businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId },
    null
  );
  const sales = await prisma.sale.findMany({
    where: {
      businessId,
      ...(branchId ? { branchId } : {}),
      ...(!dateFilter.error && (dateFilter.from || dateFilter.to) ? { saleDate: { ...(dateFilter.from ? { gte: dateFilter.from } : {}), ...(dateFilter.to ? { lte: dateFilter.to } : {}) } } : {}),
    },
    include: { customer: true, branch: { select: { name: true } } },
    orderBy: { saleDate: "desc" },
    take: LIST_LIMIT,
  });

  const rows = sales.map((s) => ({
    id: s.id,
    href: `/sales/${s.id}`,
    receiptHref: `/sales/${s.id}/receipt`,
    number: s.saleNumber,
    date: formatDateIn(s.saleDate, tz),
    dateSort: s.saleDate.toISOString(),
    customer: s.customer?.name ?? "Walk-in",
    branch: s.branch?.name ?? "",
    total: Number(s.total),
    balance: Number(s.balance),
    status: s.status,
    tone: TONE[s.status] ?? "neutral",
    receipt: "Receipt",
  }));

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Sales"
        description={dateFilter.from || dateFilter.to ? `Matching sales, newest first (up to ${LIST_LIMIT}).` : sales.length === LIST_LIMIT ? `Showing the latest ${LIST_LIMIT} sales.` : "Every sale, newest first."}
        actions={
          <PermissionGate perm="sales.create">
            <Link href="/sales/new" className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90">+ New Sale</Link>
          </PermissionGate>
        }
      />
      <DateFilter from={params.from} to={params.to} error={dateFilter.error ?? undefined} />
      <DataTable
        exportName="sales"
        searchPlaceholder="Search sales…"
        rowHrefKey="href"
        selectable
        emptyMessage="No sales recorded yet."
        columns={[
          { key: "number", header: "Sale #", hrefKey: "href", sticky: true },
          { key: "date", header: "Date", sortKey: "dateSort" },
          { key: "customer", header: "Customer" },
          { key: "branch", header: "Branch", defaultHidden: true },
          { key: "total", header: "Total", type: "money", total: true },
          { key: "balance", header: "Balance", type: "money", total: true },
          { key: "status", header: "Status", type: "badge", toneKey: "tone" },
          { key: "receipt", header: "", hrefKey: "receiptHref" },
        ]}
        rows={rows}
      />
    </main>
  );
}
