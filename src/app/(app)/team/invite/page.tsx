import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { PageHeader, FormCard } from "@/components/erp/display";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { InviteMemberForm } from "./invite-form";

export default async function InviteMemberPage() {
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
  if (!canManageTeam) redirect("/team");

  const branches = await prisma.branch.findMany({
    where: { businessId, isActive: true },
    orderBy: [{ isHeadOffice: "desc" }, { name: "asc" }],
    select: { id: true, name: true },
  });

  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-6">
      <PageHeader title="Invite Team Member" description="They get an email with a link to join this business." />
      <FormCard>
        <InviteMemberForm businessId={businessId} branches={branches} />
      </FormCard>
    </main>
  );
}
