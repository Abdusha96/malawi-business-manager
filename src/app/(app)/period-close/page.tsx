import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/erp/display";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { getPeriodCloseOverview } from "@/lib/period-close";
import { resolveTimeZone } from "@/lib/timezone";
import { PeriodCloseClient } from "./period-close-client";

export default async function PeriodClosePage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const ctx = { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId };
  const [canView, canManage, canReopen] = await Promise.all([
    hasPermission(ctx, "accounting.view"),
    hasPermission(ctx, "accounting.manage"),
    hasPermission(ctx, "business.settings.manage"),
  ]);

  if (!canView) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <PageHeader title="Period Close" />
        <p className="text-erp-muted">Your role ({membership.role}) doesn't have access to the books.</p>
      </main>
    );
  }

  const overview = await getPeriodCloseOverview(membership.businessId);
  const tz = resolveTimeZone(membership.business.timezone);

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <PageHeader
        title="Period Close"
        actions={<Link href="/accounting" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">Accounting</Link>}
      />
      <PeriodCloseClient
        businessId={membership.businessId}
        timeZone={tz}
        canManage={canManage && !membership.branchId}
        canReopen={canReopen && !membership.branchId}
        initial={JSON.parse(JSON.stringify(overview))}
      />
    </main>
  );
}
