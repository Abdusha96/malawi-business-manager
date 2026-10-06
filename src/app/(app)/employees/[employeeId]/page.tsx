import { getServerSession } from "next-auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { PageHeader, KpiCard } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";
import { PermissionGate } from "@/components/erp/permission-gate";
import { formatMoney } from "@/lib/erp/format";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { formatDateIn, resolveTimeZone } from "@/lib/timezone";
import { PhoneHint } from "@/components/phone-hint";
import { EditSalary } from "./edit-salary";

function maskAccountNumber(value: string | null): string {
  if (!value) return "–";
  if (value.length <= 4) return value;
  return `••••${value.slice(-4)}`;
}

export default async function EmployeeProfilePage(props: { params: Promise<{ employeeId: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const businessId = memberships[0].businessId;
  const tz = resolveTimeZone(memberships[0].business.timezone);
  const employee = await prisma.employee.findUnique({
    where: { id: params.employeeId },
    include: { branch: { select: { name: true } } },
  });
  if (!employee || employee.businessId !== businessId) notFound();

  const payrollHistory = await prisma.payroll.findMany({
    where: { businessId, employeeId: employee.id },
    orderBy: { payPeriod: "desc" },
    take: 24,
  });

  const rows = payrollHistory.map((p) => ({
    id: p.id,
    payslipHref: `/payroll/${p.id}/payslip`,
    period: p.payPeriod,
    gross: Number(p.grossSalary),
    paye: Number(p.paye),
    net: Number(p.netSalary),
    status: p.status === "PAID" ? "Paid" : "Draft",
    statusTone: p.status === "PAID" ? "success" : "warning",
    payslip: "Payslip",
  }));

  return (
    <main className="mx-auto max-w-4xl p-4 sm:p-6">
      <PageHeader
        title={employee.name}
        description={[
          employee.employeeCode,
          employee.position,
          employee.department,
          employee.branch?.name,
        ].filter(Boolean).join(" · ")}
        actions={
          <>
            <Link href="/employees" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">← Employees</Link>
            <PermissionGate perm="payroll.manage">
              <Link href="/payroll" className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90">Run Payroll</Link>
            </PermissionGate>
          </>
        }
      />
      <div className="mb-4 text-sm text-erp-muted">
        <p>{employee.phone ?? "No phone on file"}</p>
        <PhoneHint value={employee.phone} />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard
          label="Monthly Salary"
          value={<>{formatMoney(Number(employee.monthlySalary))}<PermissionGate perm="employees.manage"><EditSalary businessId={businessId} employeeId={employee.id} monthlySalary={Number(employee.monthlySalary)} /></PermissionGate></>}
        />
        <KpiCard label="Start Date" value={formatDateIn(employee.startDate, tz)} />
        <KpiCard label="Bank" value={employee.bankName ?? "–"} />
        <KpiCard label="Account" value={maskAccountNumber(employee.bankAccountNumber)} />
      </div>

      <h2 className="mb-2 text-sm font-semibold text-erp-text">Payroll History</h2>
      <DataTable
        exportName={`payroll-${employee.employeeCode}`}
        searchPlaceholder="Search payroll history…"
        pageSize={12}
        emptyMessage="No payroll runs yet."
        columns={[
          { key: "period", header: "Period" },
          { key: "gross", header: "Gross", type: "money" },
          { key: "paye", header: "PAYE", type: "money" },
          { key: "net", header: "Net", type: "money" },
          { key: "status", header: "Status", type: "badge", toneKey: "statusTone" },
          { key: "payslip", header: "", hrefKey: "payslipHref" },
        ]}
        rows={rows}
      />
      <p className="mt-2 text-[11px] text-erp-muted">Showing the latest 24 payroll runs.</p>
    </main>
  );
}
