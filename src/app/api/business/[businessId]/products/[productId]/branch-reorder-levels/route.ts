import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { resolveBranchScope, TenantAccessError } from "@/lib/tenant";
import { branchReorderLevelSchema } from "@/lib/validation";
import { getBranchStockForProduct, setBranchReorderLevel, StockError } from "@/lib/inventory";

// Module 53 – per-branch reorder-level overrides. Reuses inventory.view/
// inventory.manage (the same permissions that already gate the product
// itself) rather than a new permission, same call the reopen-cap route
// (Module 51) made for reusing an existing permission.

async function loadOwnedProduct(businessId: string, productId: string) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || product.businessId !== businessId) return null;
  return product;
}

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; productId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "inventory.view");
  if (ctx instanceof NextResponse) return ctx;

  const product = await loadOwnedProduct(params.businessId, params.productId);
  if (!product) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const branches = await getBranchStockForProduct(params.businessId, params.productId);

  // A branch-restricted member only sees their own branch's row – the same
  // narrowing resolveBranchScope() applies to every other branch-scoped
  // list, just done here in-process since this list is already small
  // (one row per branch, not a paginated query).
  const scoped = ctx.membership.branchId
    ? branches.filter((b) => b.branch.id === ctx.membership.branchId)
    : branches;

  return NextResponse.json({
    productReorderLevel: Number(product.reorderLevel),
    branches: scoped.map((b) => ({
      branchId: b.branch.id,
      branchName: b.branch.name,
      quantity: b.quantity,
      reorderLevelOverride: b.reorderLevelOverride,
      effectiveReorderLevel: b.effectiveReorderLevel,
      inTransitIn: b.inTransitIn,
      inTransitOut: b.inTransitOut,
    })),
  });
}

export async function PUT(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; productId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "inventory.manage");
  if (ctx instanceof NextResponse) return ctx;

  const product = await loadOwnedProduct(params.businessId, params.productId);
  if (!product) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = branchReorderLevelSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  let branchId: string;
  try {
    branchId = resolveBranchScope(ctx.membership, parsed.data.branchId) as string;
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: "forbidden" }, { status: err.status });
    throw err;
  }
  // resolveBranchScope() returns null only when neither the member nor the
  // request named a branch – not possible here since branchId is required
  // by the schema, but guard anyway rather than trust that invariant blindly.
  if (!branchId) return NextResponse.json({ error: "branch_required" }, { status: 400 });

  try {
    await setBranchReorderLevel(params.businessId, params.productId, branchId, parsed.data.reorderLevel);
  } catch (err) {
    if (err instanceof StockError) return NextResponse.json({ error: "invalid", message: err.message }, { status: 400 });
    throw err;
  }

  return NextResponse.json({ message: "Reorder level updated." });
}
