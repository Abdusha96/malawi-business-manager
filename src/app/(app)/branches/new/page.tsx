import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { PageHeader, FormCard } from "@/components/erp/display";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { NewBranchForm } from "./branch-form";

export default async function NewBranchPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const canManageBranches = await hasPermission(
    { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId },
    "branches.manage"
  );
  if (!canManageBranches) redirect("/branches");

  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-6">
      <PageHeader title="Add Branch" />
      <FormCard>
        <NewBranchForm businessId={membership.businessId} />
      </FormCard>
    </main>
  );
}
