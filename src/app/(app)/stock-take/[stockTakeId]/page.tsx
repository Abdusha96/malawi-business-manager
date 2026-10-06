import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { StockTakeWorkspace } from "./stock-take-workspace";
import { resolveTimeZone } from "@/lib/timezone";

export default async function StockTakeDetailPage(
  props: {
    params: Promise<{ stockTakeId: string }>;
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
    hasPermission(membershipCtx, "stocktake.view"),
    hasPermission(membershipCtx, "stocktake.manage"),
    hasPermission(membershipCtx, "business.settings.manage"),
  ]);

  if (!canView) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <h1 className="mb-2 text-2xl font-bold">Stock Take</h1>
        <p className="text-erp-muted">Your role ({membership.role}) doesn't have access to stock takes.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl p-6 sm:p-4 sm:p-6">
      <StockTakeWorkspace
        businessId={membership.businessId}
        stockTakeId={params.stockTakeId}
        canManage={canManage}
        canReopen={canReopen}
        timeZone={resolveTimeZone(membership.business.timezone)}
      />
    </main>
  );
}
