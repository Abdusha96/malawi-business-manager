import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { preparePhoneForSave } from "@/lib/phone";
import { employeeUpdateSchema } from "@/lib/validation";
import { resolveBranchScope, TenantAccessError } from "@/lib/tenant";
import { logAudit } from "@/lib/audit";

async function loadOwnedEmployee(businessId: string, employeeId: string) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee || employee.businessId !== businessId) return null;
  return employee;
}

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; employeeId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "employees.view");
  if (ctx instanceof NextResponse) return ctx;

  const employee = await loadOwnedEmployee(params.businessId, params.employeeId);
  if (!employee) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Module 29: a single record is reachable by anyone in the business who
  // can view employees at all, same as /purchases/[purchaseId] – the
  // branch lock governs what shows up in the LIST (see the GET on the
  // collection route), not whether a direct link to one record 404s.

  const payrollHistory = await prisma.payroll.findMany({
    where: { businessId: params.businessId, employeeId: params.employeeId },
    orderBy: { payPeriod: "desc" },
    take: 24,
  });

  return NextResponse.json({ employee, payrollHistory });
}

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; employeeId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "employees.manage");
  if (ctx instanceof NextResponse) return ctx;

  const existing = await loadOwnedEmployee(params.businessId, params.employeeId);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = employeeUpdateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  const phone = data.phone !== undefined ? preparePhoneForSave(data.phone, existing.phone) : null;
  if (phone && !phone.ok) {
    return NextResponse.json({ error: "invalid_phone", message: phone.reason }, { status: 400 });
  }

  // Module 29: branchId is the one field where a branch-restricted member
  // needs the usual lock – they may reassign an employee only to their own
  // branch, never to (or away to) a branch they don't belong to. Every
  // other field is unrestricted here, same as before this module.
  let branchId: string | null | undefined = undefined;
  if (data.branchId !== undefined) {
    try {
      branchId = resolveBranchScope(ctx.membership, data.branchId);
    } catch (err) {
      if (err instanceof TenantAccessError) return NextResponse.json({ error: "forbidden" }, { status: err.status });
      throw err;
    }
  }

  const employee = await prisma.$transaction(async (tx) => {
    const updated = await tx.employee.update({
      where: { id: params.employeeId },
      data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(phone && phone.ok ? { phone: phone.value } : {}),
      ...(data.email !== undefined ? { email: data.email || null } : {}),
      ...(data.position !== undefined ? { position: data.position } : {}),
      ...(data.department !== undefined ? { department: data.department } : {}),
      ...(data.monthlySalary !== undefined ? { monthlySalary: data.monthlySalary } : {}),
      ...(data.startDate !== undefined ? { startDate: new Date(data.startDate!) } : {}),
      ...(data.bankName !== undefined ? { bankName: data.bankName } : {}),
      ...(data.bankAccountNumber !== undefined ? { bankAccountNumber: data.bankAccountNumber } : {}),
      ...(data.taxpayerId !== undefined ? { taxpayerId: data.taxpayerId } : {}),
      ...(branchId !== undefined ? { branchId } : {}),
      },
    });
    if (data.monthlySalary !== undefined && Number(existing.monthlySalary) !== data.monthlySalary) {
      await logAudit({
        tx,
        businessId: params.businessId,
        userId: ctx.userId,
        action: "employee.salary_update",
        entityType: "Employee",
        entityId: params.employeeId,
        metadata: { previousMonthlySalary: Number(existing.monthlySalary), monthlySalary: data.monthlySalary },
      });
    }
    return updated;
  });

  return NextResponse.json({ employee });
}

// Soft delete – payroll history references this employee and must survive.
export async function DELETE(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; employeeId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "employees.manage");
  if (ctx instanceof NextResponse) return ctx;

  const existing = await loadOwnedEmployee(params.businessId, params.employeeId);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await prisma.employee.update({ where: { id: params.employeeId }, data: { isActive: false } });
  return NextResponse.json({ message: "Employee deactivated." });
}
