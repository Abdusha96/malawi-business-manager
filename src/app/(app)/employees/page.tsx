import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";
import { PermissionGate } from "@/components/erp/permission-gate";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, resolveBranchScope } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";

export default async function EmployeesPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;
  // Module 29: a branch-restricted member only ever sees their own
  // branch's employees here – see resolveBranchScope() in tenant.ts.
  const branchId = resolveBranchScope(
    { businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId },
    null
  );
  const employees = await prisma.employee.findMany({
    where: { businessId, isActive: true, ...(branchId ? { branchId } : {}) },
    include: { branch: { select: { name: true } } },
    orderBy: { name: "asc" },
  });

  const rows = employees.map((e) => ({
    id: e.id,
    href: `/employees/${e.id}`,
    name: e.name,
    code: e.employeeCode,
    position: e.position,
    department: e.department ?? "",
    branch: e.branch?.name ?? "",
    salary: Number(e.monthlySalary),
  }));

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Employees"
        description="Active employees. Monthly salary is shown in MWK."
        actions={
          <>
            <PermissionGate perm="payroll.manage">
              <Link href="/payroll" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">Run Payroll</Link>
            </PermissionGate>
            <PermissionGate perm="employees.manage">
              <Link href="/employees/new" className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90">+ Add Employee</Link>
            </PermissionGate>
          </>
        }
      />
      <DataTable
        exportName="employees"
        searchPlaceholder="Search employees…"
        rowHrefKey="href"
        emptyMessage="No employees yet."
        columns={[
          { key: "name", header: "Employee", hrefKey: "href", sticky: true },
          { key: "code", header: "Code" },
          { key: "position", header: "Position" },
          { key: "department", header: "Department" },
          { key: "branch", header: "Branch" },
          { key: "salary", header: "Monthly Salary", type: "money", total: true },
        ]}
        rows={rows}
      />
    </main>
  );
}
