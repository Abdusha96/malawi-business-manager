import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/erp/display";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, resolveBranchScope } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { getOrCreateTaxConfiguration } from "@/lib/payroll";
import { PayrollRunView } from "./payroll-run-view";
import { resolveTimeZone } from "@/lib/timezone";

export default async function PayrollPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;
  // Module 29: a branch-restricted member can only run payroll for
  // employees at their own branch – filtering the picker here (rather than
  // only enforcing it in the API route) keeps them from ever seeing an
  // employee they'd be blocked from paying anyway.
  const branchId = resolveBranchScope(
    { businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId },
    null
  );

  const [employees, taxConfig] = await Promise.all([
    prisma.employee.findMany({
      where: { businessId, isActive: true, ...(branchId ? { branchId } : {}) },
      orderBy: { name: "asc" },
    }),
    getOrCreateTaxConfiguration(businessId),
  ]);

  return (
    <main className="mx-auto max-w-4xl p-4 sm:p-6">
      <PageHeader title="Payroll" description="Calculate and pay each employee's salary for a month." />
      {employees.length === 0 ? (
        <p className="text-sm text-erp-muted">
          No employees yet. <a href="/employees/new" className="text-erp-primary underline">Add one first.</a>
        </p>
      ) : (
        <PayrollRunView
          businessId={businessId}
          employees={employees.map((e) => ({
            id: e.id,
            name: e.name,
            employeeCode: e.employeeCode,
            monthlySalary: Number(e.monthlySalary),
          }))}
          isExampleTaxConfig={taxConfig.isExample}
          timeZone={resolveTimeZone(membership.business.timezone)}
        />
      )}
    </main>
  );
}
