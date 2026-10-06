import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { bulkBranchReorderLevelSchema } from "@/lib/validation";
import { applyReorderLevelToAllBranches, StockError } from "@/lib/inventory";

// Module 60 – closes the KNOWN LIMITATION Module 53 documented from the
// start: no way to set (or clear) a reorder-level override across every
// branch in one action. Separate route rather than a flag on the existing
// PUT (same reasoning as receive/cancel getting their own POST routes on
// Stock Transfers) – this touches every branch's StockLevel row, not one,
// so it deserves its own explicit endpoint and its own audit action name.
//
// Unlike the single-branch PUT, a branch-restricted member can't call this
// at all (not narrowed to "their own branch" the way resolveBranchScope()
// narrows other routes – there's no sensible narrowing for an inherently
// all-branches action), so it's blocked outright rather than silently
// scoped down to one branch.
export async function POST(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; productId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "inventory.manage");
  if (ctx instanceof NextResponse) return ctx;

  if (ctx.membership.branchId) {
    return NextResponse.json(
      { error: "forbidden", message: "Only an unrestricted Owner or Manager can apply a reorder level to every branch." },
      { status: 403 }
    );
  }

  const product = await prisma.product.findUnique({ where: { id: params.productId } });
  if (!product || product.businessId !== params.businessId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const parsed = bulkBranchReorderLevelSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const branchCount = await applyReorderLevelToAllBranches({
      businessId: params.businessId,
      userId: ctx.userId,
      productId: params.productId,
      reorderLevel: parsed.data.reorderLevel,
    });
    return NextResponse.json({
      message:
        parsed.data.reorderLevel === null
          ? `Cleared the override on all ${branchCount} branches.`
          : `Applied to all ${branchCount} branches.`,
      branchCount,
    });
  } catch (err) {
    if (err instanceof StockError) return NextResponse.json({ error: "invalid", message: err.message }, { status: 400 });
    throw err;
  }
}
