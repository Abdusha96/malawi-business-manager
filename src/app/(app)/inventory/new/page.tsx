import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { NewProductForm } from "./product-form";
import { PageHeader } from "@/components/erp/display";

export default async function NewProductPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;
  const [categories, branches] = await Promise.all([
    prisma.category.findMany({
      where: { businessId },
      orderBy: { name: "asc" },
    }),
    // Module 28: same "only show the picker to an unrestricted member"
    // pattern as /sales/new and /purchases/new – a branch-restricted
    // member's opening stock is attributed to their own branch
    // automatically server-side, no picker needed.
    membership.branchId
      ? Promise.resolve([])
      : prisma.branch.findMany({
          where: { businessId, isActive: true },
          orderBy: [{ isHeadOffice: "desc" }, { name: "asc" }],
          select: { id: true, name: true },
        }),
  ]);

  return (
    <main className="mx-auto max-w-lg p-4 sm:p-6">
      <PageHeader title="Add Product" />
      <NewProductForm businessId={businessId} categories={categories} branches={branches.length > 1 ? branches : []} />
    </main>
  );
}
