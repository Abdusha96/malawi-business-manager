import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { OpenStockTakeForm } from "./open-stock-take-form";

export default async function NewStockTakePage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];

  // Module 31: same "only show the picker to an unrestricted member"
  // pattern as /purchases/new and /employees/new – see those pages.
  const branches = membership.branchId
    ? []
    : await prisma.branch.findMany({
        where: { businessId: membership.businessId, isActive: true },
        orderBy: [{ isHeadOffice: "desc" }, { name: "asc" }],
        select: { id: true, name: true },
      });

  return (
    <main className="mx-auto max-w-lg p-4 sm:p-6">
      <h1 className="mb-6 text-2xl font-bold">Start a Stock Take</h1>
      <OpenStockTakeForm businessId={membership.businessId} branches={branches.length > 1 ? branches : []} />
    </main>
  );
}
