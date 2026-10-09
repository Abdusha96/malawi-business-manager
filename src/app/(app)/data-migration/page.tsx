import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/erp/display";
import { DataMigrationClient } from "./migration-client";

export default async function DataMigrationPage(props: { searchParams: Promise<{ kind?: string }> }) {
  const { kind } = await props.searchParams;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");
  const memberships = await listUserBusinesses(session.user.id);
  if (!memberships.length) redirect("/dashboard");
  const membership = memberships[0];
  const memberCtx = { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId };
  const [canProducts, canAssets, history] = await Promise.all([
    hasPermission(memberCtx, "inventory.manage"),
    hasPermission(memberCtx, "fixedassets.manage"),
    prisma.importBatch.findMany({ where: { businessId: membership.businessId }, include: { user: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 25 }),
  ]);
  return <main className="mx-auto max-w-6xl p-4 sm:p-6">
    <PageHeader title="Data Migration" description="Bring products and opening balances into this business." />
    <DataMigrationClient businessId={membership.businessId} canProducts={canProducts} canAssets={canAssets} initialKind={kind === "FIXED_ASSETS" ? "FIXED_ASSETS" : "PRODUCTS"} history={history.map((b) => ({ id: b.id, kind: b.importType, filename: b.filename, createdAt: b.createdAt.toISOString(), migrationDate: b.migrationDate.toISOString(), totalRows: b.totalRows, importedRows: b.importedRows, rejectedRows: b.rejectedRows, status: b.status, user: b.user.name }))} />
  </main>;
}
