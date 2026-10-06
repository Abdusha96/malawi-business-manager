import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { resolveBranchScope, TenantAccessError } from "@/lib/tenant";
import { saleSchema } from "@/lib/validation";
import { createSale, SaleValidationError } from "@/lib/sales";
import { CashAccountSelectionError } from "@/lib/cashbook";
import { PlanRestrictionError } from "@/lib/subscription";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "sales.view");
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status"); // PAID | PARTIAL | CREDIT | VOIDED
  const customerId = searchParams.get("customerId");
  const limit = Math.min(Number(searchParams.get("limit") ?? 50), 200);

  let branchId: string | null;
  try {
    branchId = resolveBranchScope(ctx.membership, searchParams.get("branchId"));
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: "forbidden" }, { status: err.status });
    throw err;
  }

  const sales = await prisma.sale.findMany({
    where: {
      businessId: params.businessId,
      ...(branchId ? { branchId } : {}),
      ...(status ? { status: status as any } : {}),
      ...(customerId ? { customerId } : {}),
    },
    include: { customer: true, items: { include: { product: true } }, branch: { select: { name: true } } },
    orderBy: { saleDate: "desc" },
    take: limit,
  });

  return NextResponse.json({ sales });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "sales.create");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const parsed = saleSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  let branchId: string | null;
  try {
    branchId = resolveBranchScope(ctx.membership, parsed.data.branchId ?? null);
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: "forbidden" }, { status: err.status });
    throw err;
  }

  try {
    const sale = await createSale({
      businessId: params.businessId,
      userId,
      input: { ...parsed.data, branchId },
    });
    return NextResponse.json({ sale }, { status: 201 });
  } catch (err) {
    if (err instanceof CashAccountSelectionError) {
      return NextResponse.json({ error: "invalid_cash_account", message: err.message }, { status: 400 });
    }
    if (err instanceof SaleValidationError) {
      return NextResponse.json({ error: "sale_invalid", message: err.message }, { status: 400 });
    }
    // Module 26: the monthly sales cap (requirePlanCapacity "sales") is
    // now enforced inside createSale() – same status/shape every other
    // plan-restriction route returns.
    if (err instanceof PlanRestrictionError) {
      return NextResponse.json({ error: "plan_restriction", message: err.message }, { status: err.status });
    }
    throw err;
  }
}
