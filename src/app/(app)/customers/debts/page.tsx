import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, resolveBranchScope } from "@/lib/tenant";
import { getReceivablesAging } from "@/lib/customers";
import { PageHeader, KpiCard } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";
import { formatMoney } from "@/lib/erp/format";
import Link from "next/link";

const BUCKET_LABELS: Record<string, string> = {
  current: "Current",
  days1to30: "1–30 days",
  days31to60: "31–60 days",
  days61to90: "61–90 days",
  days90plus: "90+ days",
};

export default async function DebtDashboardPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;
  // Module 27: a branch-restricted member only ever sees their own
  // branch's receivables here – mirrors the /sales page's pattern.
  const branchId = resolveBranchScope(
    { businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId },
    null
  );
  const aging = await getReceivablesAging(businessId, branchId);

  const rows = aging.customers.map((c) => ({
    id: c.customerId,
    href: `/customers/${c.customerId}`,
    name: c.customerName,
    phone: c.phone ?? "",
    ...c.buckets,
    outstanding: c.totalOutstanding,
  }));

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader
        title="Debtors Analysis"
        description="Receivables by age, and the customers who owe."
        actions={<Link href="/customers" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">← Customers</Link>}
      />

      <div className="mb-3">
        <KpiCard label="Total Receivables" value={formatMoney(aging.totalReceivables)} tone={aging.totalReceivables > 0 ? "bad" : "good"} />
      </div>
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {Object.keys(BUCKET_LABELS).map((bucket) => (
          <KpiCard
            key={bucket}
            label={BUCKET_LABELS[bucket]}
            value={formatMoney(aging.bucketTotals[bucket as keyof typeof aging.bucketTotals])}
          />
        ))}
      </div>

      <h2 className="mb-2 text-sm font-semibold text-erp-text">Customers with Outstanding Balances</h2>
      <DataTable
        exportName="customer-debts"
        searchPlaceholder="Search customers…"
        rowHrefKey="href"
        emptyMessage="No outstanding customer debt right now."
        columns={[
          { key: "name", header: "Customer", hrefKey: "href", sticky: true },
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
