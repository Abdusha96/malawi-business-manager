import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { ReportsHub } from "./reports-hub";
import { PageHeader } from "@/components/erp/display";
import { resolveTimeZone } from "@/lib/timezone";

export default async function ReportsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const canViewReports = await hasPermission(
    { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId },
    "reports.basic.view"
  );

  if (!canViewReports) {
    return (
      <main className="mx-auto max-w-6xl p-4 sm:p-6">
        <PageHeader title="Reports" />
        <p className="text-sm text-erp-muted">Your role ({membership.role}) doesn't have access to financial reports.</p>
      </main>
    );
  }

  // Module 30: same "restricted members don't get a switcher – nothing
  // else to switch to" choice the dashboard's BranchSwitcher made. Every
  // report route resolves branchId itself via resolveBranchScope(), so a
  // restricted member gets their own branch's figures automatically even
  // with no picker rendered and no branchId ever sent from the client.
  const branches = membership.branchId
    ? []
    : await prisma.branch.findMany({
        where: { businessId: membership.businessId, isActive: true },
        orderBy: [{ isHeadOffice: "desc" }, { name: "asc" }],
        select: { id: true, name: true },
      });

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <ReportsHub businessId={membership.businessId} timeZone={resolveTimeZone(membership.business.timezone)} branches={branches} />
    </main>
  );
}
