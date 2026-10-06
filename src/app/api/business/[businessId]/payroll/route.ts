import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { resolveBranchScope, TenantAccessError } from "@/lib/tenant";
import { payrollRunSchema } from "@/lib/validation";
import { upsertPayrollRun, PayrollError } from "@/lib/payroll";
import { requirePlanFeature, PlanRestrictionError } from "@/lib/subscription";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "payroll.view");
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);
  const payPeriod = searchParams.get("payPeriod");

  // Module 29: same branch-lock pattern as every other list route – a
  // branch-restricted member only sees payroll runs for their own branch
  // (Payroll.branchId, snapshotted from the employee at run time – see
  // src/lib/payroll.ts). A run with no branch attributed (employee never
  // assigned one) is excluded for a restricted member, same as an
  // unattributed Sale/Purchase would be.
  let branchId: string | null;
  try {
    branchId = resolveBranchScope(ctx.membership, searchParams.get("branchId"));
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: "forbidden" }, { status: err.status });
    throw err;
  }

  const runs = await prisma.payroll.findMany({
    where: {
      businessId: params.businessId,
      ...(payPeriod ? { payPeriod } : {}),
      ...(branchId ? { branchId } : {}),
    },
    include: { employee: true },
    orderBy: [{ payPeriod: "desc" }, { createdAt: "desc" }],
    take: 200,
  });

  return NextResponse.json({ runs });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "payroll.manage");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  try {
    await requirePlanFeature(params.businessId, "payroll");
  } catch (err) {
    if (err instanceof PlanRestrictionError) {
      return NextResponse.json({ error: "plan_restricted", message: err.message }, { status: err.status });
    }
    throw err;
  }

  const parsed = payrollRunSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  // Module 29: unlike Sale/Purchase, Payroll doesn't take a branchId
  // directly from the request – it's derived from the employee (see
  // upsertPayrollRun). So the access check here is "does this employee
  // belong to my branch" rather than resolveBranchScope's usual
  // request-vs-membership comparison – same reasoning as the stock-transfer
  // "touches my branch" check, applied to a single branchId instead of two.
  if (ctx.membership.branchId) {
    const employee = await prisma.employee.findUnique({ where: { id: parsed.data.employeeId } });
    if (!employee || employee.businessId !== params.businessId || employee.branchId !== ctx.membership.branchId) {
      return NextResponse.json(
        { error: "forbidden", message: "You can only run payroll for employees at your own branch." },
        { status: 403 }
      );
    }
  }

  try {
    const run = await upsertPayrollRun({
      businessId: params.businessId,
      employeeId: parsed.data.employeeId,
      payPeriod: parsed.data.payPeriod,
      allowances: parsed.data.allowances,
      allowanceNotes: parsed.data.allowanceNotes ?? undefined,
      otherDeductions: parsed.data.otherDeductions,
      otherDeductionNotes: parsed.data.otherDeductionNotes ?? undefined,
      createdById: userId,
    });
    return NextResponse.json({ run }, { status: 201 });
  } catch (err) {
    if (err instanceof PayrollError) {
      return NextResponse.json({ error: "payroll_invalid", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
