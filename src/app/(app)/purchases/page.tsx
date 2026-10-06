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
// The list loads the latest purchases only; search and sort run over these rows.
const LIST_LIMIT = 200;

export default async function PurchasesPage(props: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;
  const tz = resolveTimeZone(membership.business.timezone);
  const params = await props.searchParams;
  const dateFilter = parseOptionalDateFilter(params.from, params.to, tz);
  // Module 27: same branch-lock pattern as /sales – see that page's comment.
  const branchId = resolveBranchScope(
    { businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId },
    null
  );
  const purchases = await prisma.purchase.findMany({
    where: {
      businessId,
      ...(branchId ? { branchId } : {}),
      ...(!dateFilter.error && (dateFilter.from || dateFilter.to) ? { purchaseDate: { ...(dateFilter.from ? { gte: dateFilter.from } : {}), ...(dateFilter.to ? { lte: dateFilter.to } : {}) } } : {}),
    },
    include: { supplier: true, branch: { select: { name: true } } },
    orderBy: { purchaseDate: "desc" },
    take: LIST_LIMIT,
  });

  const rows = purchases.map((p) => ({
    id: p.id,
    href: `/purchases/${p.id}`,
    number: p.purchaseNumber,
    date: formatDateIn(p.purchaseDate, tz),
    dateSort: p.purchaseDate.toISOString(),
    supplier: p.supplier.name,
    branch: p.branch?.name ?? "",
    total: Number(p.total),
    balance: Number(p.balance),
    status: p.status,
    tone: TONE[p.status] ?? "neutral",
  }));

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Purchases"
        description={dateFilter.from || dateFilter.to ? `Matching purchases, newest first (up to ${LIST_LIMIT}).` : purchases.length === LIST_LIMIT ? `Showing the latest ${LIST_LIMIT} purchases.` : "Every purchase, newest first."}
        actions={
          <PermissionGate perm="purchases.create">
            <Link href="/purchases/new" className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90">+ New Purchase</Link>
          </PermissionGate>
        }
      />
      <DateFilter from={params.from} to={params.to} error={dateFilter.error ?? undefined} />
      <DataTable
        exportName="purchases"
        searchPlaceholder="Search purchases…"
        rowHrefKey="href"
        selectable
        emptyMessage="No purchases recorded yet."
        columns={[
          { key: "number", header: "Purchase #", hrefKey: "href", sticky: true },
          { key: "date", header: "Date", sortKey: "dateSort" },
          { key: "supplier", header: "Supplier" },
          { key: "branch", header: "Branch", defaultHidden: true },
          { key: "total", header: "Total", type: "money", total: true },
          { key: "balance", header: "Balance", type: "money", total: true },
          { key: "status", header: "Status", type: "badge", toneKey: "tone" },
        ]}
        rows={rows}
      />
    </main>
  );
}
