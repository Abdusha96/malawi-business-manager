import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { getWithholdingTaxConfig } from "@/lib/withholding-tax";
import { NewExpenseForm } from "./expense-form";

export default async function NewExpensePage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const [branches, whtConfig] = await Promise.all([
    membership.branchId
      ? Promise.resolve([])
      : prisma.branch.findMany({
          where: { businessId: membership.businessId, isActive: true },
          orderBy: [{ isHeadOffice: "desc" }, { name: "asc" }],
          select: { id: true, name: true },
        }),
    getWithholdingTaxConfig(membership.businessId),
  ]);

  return (
    <main className="mx-auto max-w-lg p-4 sm:p-6">
      <h1 className="mb-6 text-2xl font-bold">Add Expense</h1>
      <NewExpenseForm
        businessId={membership.businessId}
        branches={branches.length > 1 ? branches : []}
        withholdingTaxRates={Object.entries(whtConfig.rates).map(([category, rate]) => ({ category: category as any, rate }))}
      />
    </main>
  );
}
