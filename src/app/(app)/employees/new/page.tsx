import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { PageHeader, FormCard } from "@/components/erp/display";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { NewEmployeeForm } from "./employee-form";

export default async function NewEmployeePage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;

  // Module 29: same "only show the picker to an unrestricted member"
  // pattern as /purchases/new – a branch-restricted member's new employee
  // is always attributed to their own branch automatically (see the API
  // route's resolveBranchScope() call), so there's nothing for them to pick.
  const branches = membership.branchId
    ? []
    : await prisma.branch.findMany({
        where: { businessId, isActive: true },
        orderBy: [{ isHeadOffice: "desc" }, { name: "asc" }],
        select: { id: true, name: true },
      });

  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-6">
      <PageHeader title="Add Employee" />
      <FormCard>
        <NewEmployeeForm businessId={businessId} branches={branches.length > 1 ? branches : []} />
      </FormCard>
    </main>
  );
}
