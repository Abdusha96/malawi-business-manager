import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { resolveBranchScope, TenantAccessError } from "@/lib/tenant";
import { purchaseSchema } from "@/lib/validation";
import { createPurchase, PurchaseValidationError } from "@/lib/purchases";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "purchases.view");
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const supplierId = searchParams.get("supplierId");
  const limit = Math.min(Number(searchParams.get("limit") ?? 50), 200);

  // Module 27: same branch-lock pattern as /sales and /expenses – a
  // branch-restricted member only ever sees their own branch's purchases.
  let branchId: string | null;
  try {
    branchId = resolveBranchScope(ctx.membership, searchParams.get("branchId"));
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: "forbidden" }, { status: err.status });
    throw err;
  }

  const purchases = await prisma.purchase.findMany({
    where: {
      businessId: params.businessId,
      ...(branchId ? { branchId } : {}),
      ...(status ? { status: status as any } : {}),
      ...(supplierId ? { supplierId } : {}),
    },
    include: { supplier: true, items: { include: { product: true } }, branch: { select: { name: true } } },
    orderBy: { purchaseDate: "desc" },
    take: limit,
  });

  return NextResponse.json({ purchases });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "purchases.create");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const parsed = purchaseSchema.safeParse(await req.json());
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
    const purchase = await createPurchase({
      businessId: params.businessId,
      userId,
      input: { ...parsed.data, branchId },
    });
    return NextResponse.json({ purchase }, { status: 201 });
  } catch (err) {
    if (err instanceof PurchaseValidationError) {
      return NextResponse.json({ error: "purchase_invalid", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
