import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { logAudit } from "@/lib/audit";
import { sendSms, TEMPLATE_KEYS } from "@/lib/notifications";
import { PHONE_CHECK_PROVIDER } from "@/lib/phone";
import { buildEmployeePayMessage } from "@/lib/party-messages";

/**
 * Module 72: text an employee that their pay for a period has been paid. Manual
 * only (the "Text employee" button on a PAID payroll row) and only for a run that
 * is actually PAID, so nobody is told they were paid before they were. Needs
 * payroll.manage, like paying the run; a branch-restricted member can only do it
 * for employees of their own branch, the same rule as running payroll.
 */
export async function POST(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; payrollId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "payroll.manage");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const [run, business] = await Promise.all([
    prisma.payroll.findUnique({ where: { id: params.payrollId }, include: { employee: true } }),
    prisma.business.findUnique({ where: { id: params.businessId } }),
  ]);
  if (!run || run.businessId !== params.businessId || !business) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (ctx.membership.branchId && run.employee.branchId !== ctx.membership.branchId) {
    return NextResponse.json(
      { error: "forbidden", message: "You can only notify employees at your own branch." },
      { status: 403 }
    );
  }

  if (run.status !== "PAID") {
    return NextResponse.json(
      { error: "not_paid", message: "This payroll run has not been paid yet, so there is nothing to notify." },
      { status: 400 }
    );
  }

  if (!run.employee.phone) {
    return NextResponse.json({
      message: null,
      sentTo: null,
      note: "This employee has no phone number on file – the notice was not sendable.",
    });
  }

  const message = buildEmployeePayMessage({
    employeeName: run.employee.name,
    businessName: business.name,
    payPeriod: run.payPeriod,
    netSalary: Number(run.netSalary),
    method: run.paymentMethod,
  });

  const result = await sendSms({
    businessId: params.businessId,
    to: run.employee.phone,
    body: message,
    templateKey: TEMPLATE_KEYS.EMPLOYEE_PAY_NOTICE,
    relatedEntityType: "Payroll",
    relatedEntityId: run.id,
  });

  const note =
    result.providerName === PHONE_CHECK_PROVIDER
      ? `Notice not sent: ${result.errorMessage} Fix the number on the employee record.`
      : result.status === "SENT"
        ? result.errorMessage
          ? "Notice handed to the SMS provider, but delivery could not be confirmed – see Notifications."
          : "Notice sent."
        : result.status === "FAILED"
          ? "Notice logged, but the SMS was not delivered – see Notifications for the reason."
          : "Notice logged (no SMS provider configured yet – see Notifications).";

  await logAudit({
    businessId: params.businessId,
    userId,
    action: "payroll.pay_notice_sent",
    entityType: "Payroll",
    entityId: run.id,
    metadata: { employeeId: run.employeeId, payPeriod: run.payPeriod, message },
  });

  return NextResponse.json({ message, sentTo: result.dialedTo, note });
}
