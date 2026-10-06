import { getServerSession } from "next-auth";
import { redirect, notFound } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { PrintButton } from "@/app/(app)/sales/[saleId]/receipt/print-button";
import { formatMoney } from "@/lib/erp/format";
import { formatDateIn, resolveTimeZone } from "@/lib/timezone";

export default async function PayslipPage(props: { params: Promise<{ payrollId: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const run = await prisma.payroll.findUnique({
    where: { id: params.payrollId },
    include: { employee: true, business: true },
  });

  const allowedBusinessIds = memberships.map((m) => m.businessId);
  if (!run || !allowedBusinessIds.includes(run.businessId)) notFound();
  const tz = resolveTimeZone(run.business.timezone);

  return (
    <main className="mx-auto max-w-md p-4 sm:p-6">
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton />
      </div>

      <div className="rounded border border-erp-border bg-erp-surface p-6 text-sm shadow-sm">
        <div className="mb-4 text-center">
          <h1 className="text-lg font-bold">{run.business.name}</h1>
          <p className="text-erp-muted">Payslip – {run.payPeriod}</p>
        </div>

        <div className="mb-3 border-y border-erp-border py-2 text-xs text-erp-muted">
          <p>{run.employee.name} ({run.employee.employeeCode})</p>
          <p>{run.employee.position}{run.employee.department ? ` · ${run.employee.department}` : ""}</p>
        </div>

        <div className="space-y-1">
          <Row label="Gross Salary" value={run.grossSalary} />
          <Row label="Allowances" value={run.allowances} prefix="+" />
          {run.allowanceNotes && <p className="text-xs text-erp-muted">{run.allowanceNotes}</p>}
          <div className="my-1 border-t border-erp-border" />
          <Row label="PAYE" value={run.paye} prefix="-" tone="deduct" />
          <Row label="Pension (Employee)" value={run.pensionEmployee} prefix="-" tone="deduct" />
          <Row label="Other Deductions" value={run.otherDeductions} prefix="-" tone="deduct" />
          {run.otherDeductionNotes && <p className="text-xs text-erp-muted">{run.otherDeductionNotes}</p>}
          <div className="my-1 border-t border-erp-border" />
          <Row label="Net Salary" value={run.netSalary} bold />
        </div>

        <p className="mt-4 text-xs text-erp-muted">
          Employer pension contribution (not deducted from employee): {formatMoney(Number(run.pensionEmployer))}
        </p>

        {run.status === "PAID" && run.paidAt && (
          <p className="mt-2 text-xs text-erp-success">
            Paid via {run.paymentMethod?.replace("_", " ")} on {formatDateIn(run.paidAt, tz)}
          </p>
        )}

        <p className="mt-4 border-t border-erp-border pt-3 text-center text-xs text-erp-muted">
          This payslip reflects tax calculations based on rates configured in this system. Verify tax and pension
          figures with the relevant authority – this is not certified tax or accounting advice.
        </p>
      </div>
    </main>
  );
}

function Row({
  label,
  value,
  prefix = "",
  bold = false,
  tone,
}: {
  label: string;
  value: unknown;
  prefix?: string;
  bold?: boolean;
  tone?: "deduct";
}) {
  return (
    <div className={`flex justify-between ${bold ? "font-semibold" : ""} ${tone === "deduct" ? "text-erp-danger" : ""}`}>
      <span>{label}</span>
      <span className="tabular">{prefix}{formatMoney(Number(value))}</span>
    </div>
  );
}
