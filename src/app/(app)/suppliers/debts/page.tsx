import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, resolveBranchScope } from "@/lib/tenant";
import { getPayablesAging } from "@/lib/suppliers";
import { PageHeader, KpiCard } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";
import { formatMoney } from "@/lib/erp/format";

const BUCKET_LABELS = {
  current: "Current",
  days1to30: "1–30 days",
  days31to60: "31–60 days",
  days61to90: "61–90 days",
  days90plus: "90+ days",
} as const;

export default async function SupplierDebtDashboardPage() {
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
  const aging = await getPayablesAging(businessId, branchId);
  const rows = aging.suppliers.map((supplier) => ({
    id: supplier.supplierId,
    href: `/suppliers/${supplier.supplierId}`,
    name: supplier.supplierName,
    phone: supplier.phone ?? "",
    ...supplier.buckets,
    outstanding: supplier.totalOutstanding,
  }));

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Creditors Analysis"
        description="What you owe suppliers, grouped by purchase age. Purchases are aged from their purchase date."
        actions={<Link href="/suppliers" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">← Suppliers</Link>}
      />
      <div className="mb-3">
        <KpiCard label="Total Payables" value={formatMoney(aging.totalPayables)} tone={aging.totalPayables > 0 ? "bad" : "good"} />
      </div>
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {Object.entries(BUCKET_LABELS).map(([bucket, label]) => (
          <KpiCard key={bucket} label={label} value={formatMoney(aging.bucketTotals[bucket as keyof typeof aging.bucketTotals])} />
        ))}
      </div>
      <h2 className="mb-2 text-sm font-semibold text-erp-text">Suppliers with Outstanding Balances</h2>
      <DataTable
        exportName="supplier-payables-aging"
        searchPlaceholder="Search suppliers…"
        rowHrefKey="href"
        emptyMessage="No outstanding supplier balances right now."
        columns={[
          { key: "name", header: "Supplier", hrefKey: "href", sticky: true },
          { key: "phone", header: "Phone" },
          { key: "current", header: "Current", type: "money", total: true },
          { key: "days1to30", header: "1–30 days", type: "money", total: true },
          { key: "days31to60", header: "31–60 days", type: "money", total: true },
          { key: "days61to90", header: "61–90 days", type: "money", total: true },
          { key: "days90plus", header: "90+ days", type: "money", total: true },
          { key: "outstanding", header: "Outstanding", type: "money", total: true },
        ]}
        rows={rows}
      />
    </main>
  );
}
