import { getServerSession } from "next-auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { PageHeader, KpiCard, StatusBadge, FormCard } from "@/components/erp/display";
import { formatMoney, formatNumber } from "@/lib/erp/format";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { getBranch, getBranchStats } from "@/lib/branches";
import { EditBranchForm } from "./edit-branch-form";

export default async function BranchDetailPage(props: { params: Promise<{ branchId: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;
  const canManageBranches = await hasPermission(
    { businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId },
    "branches.manage"
  );
  if (!canManageBranches) redirect("/branches");

  const branch = await getBranch(businessId, params.branchId);
  if (!branch) notFound();

  const stats = await getBranchStats(businessId, branch.id);

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <PageHeader
        title={branch.name}
        actions={
          <>
            {branch.isHeadOffice && <StatusBadge tone="info">Head Office</StatusBadge>}
            <Link href="/branches" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">
              Back to branches
            </Link>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiCard label="Sales" value={formatMoney(stats.totalSales)} note={`${formatNumber(stats.saleCount)} sale${stats.saleCount === 1 ? "" : "s"}`} />
        <KpiCard label="Expenses" value={formatMoney(stats.totalExpenses)} />
        <KpiCard label="Staff assigned" value={formatNumber(stats.assignedMemberCount)} />
      </div>

      <FormCard>
        <EditBranchForm businessId={businessId} branch={branch} />
      </FormCard>
    </main>
  );
}
