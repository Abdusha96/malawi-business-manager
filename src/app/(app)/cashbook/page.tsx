import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { CashbookView } from "./cashbook-view";
import { resolveTimeZone } from "@/lib/timezone";
import { PageHeader } from "@/components/erp/display";

export default async function CashbookPage() {
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

  const [canView, canManage] = await Promise.all([
    hasPermission(membershipCtx, "cashbook.view"),
    hasPermission(membershipCtx, "cashbook.manage"),
  ]);

  if (!canView) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <PageHeader title="Cashbook" />
        <p className="text-erp-muted">Your role ({membership.role}) doesn't have access to the cashbook.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader title="Cashbook" description="Cash, bank and mobile-money accounts. Open an account to see its transactions." />
      <CashbookView businessId={membership.businessId} canManage={canManage} timeZone={resolveTimeZone(membership.business.timezone)} />
    </main>
  );
}
