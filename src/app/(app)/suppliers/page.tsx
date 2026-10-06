import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";
import { PermissionGate } from "@/components/erp/permission-gate";

export default async function SuppliersPage(props: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await props.searchParams;
  const showInactive = status === "inactive";
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const businessId = memberships[0].businessId;

  const [suppliers, purchasesBySupplier] = await Promise.all([
    prisma.supplier.findMany({ where: { businessId, isActive: !showInactive }, orderBy: { name: "asc" } }),
    prisma.purchase.groupBy({
      by: ["supplierId"],
      where: { businessId, status: { not: "VOIDED" } },
      _sum: { balance: true },
    }),
  ]);

  const outstandingBySupplierId = new Map(
    purchasesBySupplier.map((p) => [p.supplierId, Number(p._sum.balance ?? 0)])
  );

  const rows = suppliers.map((s) => ({
    id: s.id,
    href: `/suppliers/${s.id}`,
    name: s.name,
    phone: s.phone ?? "",
    outstanding: outstandingBySupplierId.get(s.id) ?? 0,
    status: s.isActive ? "Active" : "Inactive",
    tone: s.isActive ? "success" as const : "neutral" as const,
  }));

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader
        title={showInactive ? "Inactive Suppliers" : "Suppliers"}
        description={showInactive ? "Inactive records stay available for history and can be reactivated." : "Supplier accounts and what we currently owe each one."}
        actions={
          <>
            <Link href={showInactive ? "/suppliers" : "/suppliers?status=inactive"} className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">{showInactive ? "Active suppliers" : "Inactive suppliers"}</Link>
            <Link href="/purchases" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">Purchases</Link>
            {!showInactive && <Link href="/suppliers/debts" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">Debt Dashboard</Link>}
            {!showInactive && <PermissionGate perm="suppliers.manage">
              <Link href="/suppliers/new" className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90">+ Add Supplier</Link>
            </PermissionGate>}
          </>
        }
      />
      <DataTable
        exportName="suppliers"
        searchPlaceholder="Search suppliers…"
        rowHrefKey="href"
        selectable
        emptyMessage="No suppliers yet."
        columns={[
          { key: "name", header: "Supplier", hrefKey: "href", sticky: true },
          { key: "phone", header: "Phone" },
          { key: "status", header: "Status", type: "badge", toneKey: "tone" },
          { key: "outstanding", header: "We Owe", type: "money", total: true },
        ]}
        rows={rows}
      />
    </main>
  );
}
