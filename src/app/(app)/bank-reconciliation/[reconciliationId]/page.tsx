import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { ReconciliationWorkspace } from "./reconciliation-workspace";
import { resolveTimeZone } from "@/lib/timezone";
import { PageHeader } from "@/components/erp/display";

export default async function BankReconciliationDetailPage(
  props: {
    params: Promise<{ reconciliationId: string }>;
  }
) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const membershipCtx = { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId };

  const [canView, canManage, canReopen] = await Promise.all([
    hasPermission(membershipCtx, "bankrecon.view"),
    hasPermission(membershipCtx, "bankrecon.manage"),
    hasPermission(membershipCtx, "business.settings.manage"),
  ]);

  if (!canView) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <PageHeader title="Bank Reconciliation" />
        <p className="text-erp-muted">Your role ({membership.role}) doesn't have access to bank reconciliation.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <ReconciliationWorkspace
        businessId={membership.businessId}
        reconciliationId={params.reconciliationId}
        canManage={canManage}
        canReopen={canReopen}
        timeZone={resolveTimeZone(membership.business.timezone)}
      />
    </main>
  );
}
