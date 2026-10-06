import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";
import { PermissionGate } from "@/components/erp/permission-gate";

export default async function CustomersPage(props: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await props.searchParams;
  const showInactive = status === "inactive";
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const businessId = memberships[0].businessId;

  const [customers, salesByCustomer] = await Promise.all([
    prisma.customer.findMany({ where: { businessId, isActive: !showInactive }, orderBy: { name: "asc" } }),
    prisma.sale.groupBy({
      by: ["customerId"],
      where: { businessId, customerId: { not: null }, status: { not: "VOIDED" } },
      _sum: { balance: true },
    }),
  ]);

  const outstandingByCustomerId = new Map(
    salesByCustomer.map((s) => [s.customerId as string, Number(s._sum.balance ?? 0)])
  );

  const rows = customers.map((c) => ({
    id: c.id,
    href: `/customers/${c.id}`,
    name: c.name,
    phone: c.phone ?? "",
    type: c.customerType,
    outstanding: outstandingByCustomerId.get(c.id) ?? 0,
    status: c.isActive ? "Active" : "Inactive",
    tone: c.isActive ? "success" as const : "neutral" as const,
  }));

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader
        title={showInactive ? "Inactive Customers" : "Customers"}
        description={showInactive ? "Inactive records stay available for history and can be reactivated." : "Customer accounts and what each one currently owes."}
        actions={
          <>
            <Link href={showInactive ? "/customers" : "/customers?status=inactive"} className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">{showInactive ? "Active customers" : "Inactive customers"}</Link>
            <Link href="/customers/debts" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">Debt Dashboard</Link>
            {!showInactive && <PermissionGate perm="customers.manage">
              <Link href="/customers/new" className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90">+ Add Customer</Link>
            </PermissionGate>}
          </>
        }
      />
      <DataTable
        exportName="customers"
        searchPlaceholder="Search customers…"
        rowHrefKey="href"
        selectable
        emptyMessage="No customers yet."
        columns={[
          { key: "name", header: "Customer", hrefKey: "href", sticky: true },
          { key: "phone", header: "Phone" },
          { key: "type", header: "Type" },
          { key: "status", header: "Status", type: "badge", toneKey: "tone" },
          { key: "outstanding", header: "Outstanding", type: "money", total: true },
        ]}
        rows={rows}
      />
    </main>
  );
}
