import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/erp/display";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { listTeam } from "@/lib/team";
import { prisma } from "@/lib/prisma";
import { TeamManager } from "./team-manager";
import { resolveTimeZone } from "@/lib/timezone";

export default async function TeamPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;
  const canManageTeam = await hasPermission(
    { businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId },
    "business.members.manage"
  );

  if (!canManageTeam) {
    return (
      <main className="mx-auto max-w-5xl p-4 sm:p-6">
        <PageHeader title="Team" />
        <p className="text-sm text-erp-muted">Your role ({membership.role}) doesn&apos;t have access to manage the team.</p>
      </main>
    );
  }

  const [{ members, invitations }, branches] = await Promise.all([
    listTeam(businessId),
    prisma.branch.findMany({
      where: { businessId, isActive: true },
      orderBy: [{ isHeadOffice: "desc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
  ]);

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader
        title="Team"
        description="Members, roles, branch assignments and pending invitations."
        actions={
          <Link href="/team/invite" className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90">
            + Invite Team Member
          </Link>
        }
      />

      <TeamManager
        businessId={businessId}
        currentUserId={session.user.id}
        members={members.map((m) => ({
          id: m.id,
          role: m.role,
          isActive: m.isActive,
          user: m.user,
          branch: m.branch,
        }))}
        invitations={invitations.map((i) => ({
          id: i.id,
          email: i.email,
          role: i.role,
          branch: i.branch,
          expiresAt: i.expiresAt.toISOString(),
        }))}
        branches={branches}
        timeZone={resolveTimeZone(membership.business.timezone)}
      />
    </main>
  );
}
