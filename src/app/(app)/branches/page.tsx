import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { PageHeader, KpiCard } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";
import { formatMoney, formatNumber } from "@/lib/erp/format";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { listBranchesWithStats } from "@/lib/branches";

export default async function BranchesPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const membershipCtx = {
    businessId: membership.businessId,
    userId: session.user.id,
    role: membership.role,
    branchId: membership.branchId,
  };
  const canManageBranches = await hasPermission(membershipCtx, "branches.manage");

  if (!canManageBranches) {
    return (
      <main className="mx-auto max-w-5xl p-4 sm:p-6">
        <PageHeader title="Branches" />
        <p className="text-sm text-erp-muted">Your role ({membership.role}) doesn&apos;t have access to manage branches.</p>
      </main>
    );
  }

  const branches = await listBranchesWithStats(membership.businessId);
  const activeCount = branches.filter((b) => b.isActive).length;
  const totalSales = branches.reduce((s, b) => s + b.totalSales, 0);
  const totalExpenses = branches.reduce((s, b) => s + b.totalExpenses, 0);

  const rows = branches.map((b) => ({
    id: b.id,
    href: `/branches/${b.id}`,
    name: b.name,
    kind: b.isHeadOffice ? "Head Office" : "",
    location: [b.city, b.district].filter(Boolean).join(", ") || "–",
    sales: b.totalSales,
    saleCount: b.saleCount,
    expenses: b.totalExpenses,
    status: b.isActive ? "Active" : "Inactive",
    statusTone: b.isActive ? "success" : "neutral",
  }));

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader
        title="Branches"
        description="Locations the business trades from."
        actions={
          <Link href="/branches/new" className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90">
            + Add Branch
          </Link>
        }
      />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiCard label="Active branches" value={formatNumber(activeCount)} note={`${formatNumber(branches.length)} in total`} />
        <KpiCard label="Sales (all branches)" value={formatMoney(totalSales)} />
        <KpiCard label="Expenses (all branches)" value={formatMoney(totalExpenses)} />
      </div>

      <DataTable
        exportName="branches"
        searchPlaceholder="Search branches…"
        rowHrefKey="href"
        emptyMessage="No branches yet."
        columns={[
          { key: "name", header: "Name", hrefKey: "href" },
          { key: "kind", header: "Type", type: "badge" },
          { key: "location", header: "Location" },
          { key: "sales", header: "Sales (MWK)", type: "money", total: true },
          { key: "saleCount", header: "Sales count", type: "number", defaultHidden: true, total: true },
          { key: "expenses", header: "Expenses (MWK)", type: "money", total: true },
          { key: "status", header: "Status", type: "badge", toneKey: "statusTone" },
        ]}
        rows={rows}
      />

      <p className="mt-2 text-[11px] text-erp-muted">
        Sales and expenses can be attributed to a branch. Inventory, cashbook, and other financial figures are
        currently business-wide rather than per-branch.
      </p>
    </main>
  );
}
