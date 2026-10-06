import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { preparePhoneForSave } from "@/lib/phone";
import { resolveBranchScope, TenantAccessError } from "@/lib/tenant";
import { employeeSchema } from "@/lib/validation";
import { requirePlanFeature, PlanRestrictionError } from "@/lib/subscription";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "employees.view");
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);

  // Module 29: same branch-lock pattern as /purchases and /sales – a
  // branch-restricted member only ever sees their own branch's employees.
  // An employee with no branch attributed is excluded from a restricted
  // member's list, the same way an unattributed Sale/Purchase would be –
  // "not yet attributed to a branch" is a business-wide-visibility fact,
  // not something a branch-locked member can claim as their own.
  let branchId: string | null;
  try {
    branchId = resolveBranchScope(ctx.membership, searchParams.get("branchId"));
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: "forbidden" }, { status: err.status });
    throw err;
  }

  const employees = await prisma.employee.findMany({
    where: {
      businessId: params.businessId,
      isActive: true,
      ...(branchId ? { branchId } : {}),
    },
    include: { branch: { select: { name: true } } },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({ employees });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "employees.manage");
  if (ctx instanceof NextResponse) return ctx;

  try {
    await requirePlanFeature(params.businessId, "payroll");
  } catch (err) {
    if (err instanceof PlanRestrictionError) {
      return NextResponse.json({ error: "plan_restricted", message: err.message }, { status: err.status });
    }
    throw err;
  }

  const parsed = employeeSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  // Checked before the employee number is taken so a refused phone does not burn one.
  const phone = preparePhoneForSave(data.phone);
  if (!phone.ok) {
    return NextResponse.json({ error: "invalid_phone", message: phone.reason }, { status: 400 });
  }

  // Module 29: same "a branch-restricted member's new record is always
  // attributed to their own branch" lock Purchase/Sale POST use.
  let branchId: string | null;
  try {
    branchId = resolveBranchScope(ctx.membership, data.branchId ?? null);
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: "forbidden" }, { status: err.status });
    throw err;
  }

  const business = await prisma.business.update({
    where: { id: params.businessId },
    data: { nextEmployeeNumber: { increment: 1 } },
  });
  const employeeCode = `${business.employeeCodePrefix}-${String(business.nextEmployeeNumber - 1).padStart(6, "0")}`;

  const employee = await prisma.employee.create({
    data: {
      businessId: params.businessId,
      branchId,
      employeeCode,
      name: data.name,
      phone: phone.value ?? undefined,
      email: data.email ?? undefined,
      position: data.position,
      department: data.department ?? undefined,
      monthlySalary: data.monthlySalary,
      startDate: new Date(data.startDate),
      bankName: data.bankName ?? undefined,
      bankAccountNumber: data.bankAccountNumber ?? undefined,
      taxpayerId: data.taxpayerId ?? undefined,
    },
  });

  return NextResponse.json({ employee }, { status: 201 });
}
