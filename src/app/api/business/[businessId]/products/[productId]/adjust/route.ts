import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { resolveBranchScope, TenantAccessError } from "@/lib/tenant";
import { stockAdjustmentSchema } from "@/lib/validation";
import { recordInventoryMovement, StockError } from "@/lib/inventory";

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; productId: string }> }
) {
  const params = await props.params;
  // Deliberately gated on inventory.adjust, not inventory.manage – a manager
  // who can edit product details doesn't necessarily need to write off stock
  // as damaged; this keeps that action attributable and separately grantable
  // once Enterprise per-member permission overrides land.
  const ctx = await requireApiContext(params.businessId, "inventory.adjust");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const product = await prisma.product.findUnique({ where: { id: params.productId } });
  if (!product || product.businessId !== params.businessId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const parsed = stockAdjustmentSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  // Module 28: same resolveBranchScope() lock every other branch-scoped
  // write goes through – a branch-restricted member can only adjust stock
  // attributed to their own branch.
  let branchId: string | null;
  try {
    branchId = resolveBranchScope(ctx.membership, parsed.data.branchId ?? null);
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: "forbidden" }, { status: err.status });
    throw err;
  }

  try {
    const newQuantity = await recordInventoryMovement({
      businessId: params.businessId,
      productId: params.productId,
      type: parsed.data.delta < 0 ? "DAMAGED" : "ADJUSTMENT",
      delta: parsed.data.delta,
      branchId,
      reason: parsed.data.reason,
      createdById: userId,
    });

    return NextResponse.json({ message: "Stock adjusted.", newQuantity });
  } catch (err) {
    if (err instanceof StockError) {
      return NextResponse.json({ error: "insufficient_stock", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
