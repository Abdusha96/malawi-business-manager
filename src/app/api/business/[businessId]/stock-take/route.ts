import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { resolveBranchScope, TenantAccessError } from "@/lib/tenant";
import { openStockTakeSchema } from "@/lib/validation";
import { openStockTake, listStockTakes, StockTakeError } from "@/lib/stock-take";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "stocktake.view");
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);

  // Module 31: same branch-lock pattern as /purchases – this list had no
  // branch filtering at all before (a real pre-existing gap, same class
  // Module 27/29 found and fixed elsewhere), so a branch-restricted member
  // saw every stock take business-wide.
  let branchId: string | null;
  try {
    branchId = resolveBranchScope(ctx.membership, searchParams.get("branchId"));
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: "forbidden" }, { status: err.status });
    throw err;
  }

  const stockTakes = await listStockTakes(params.businessId, branchId);
  return NextResponse.json({ stockTakes });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "stocktake.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = openStockTakeSchema.safeParse(await req.json());
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
    const stockTake = await openStockTake({
      businessId: params.businessId,
      createdById: ctx.userId,
      branchId,
      data: parsed.data,
    });
    return NextResponse.json({ stockTake }, { status: 201 });
  } catch (err) {
    if (err instanceof StockTakeError) {
      return NextResponse.json({ error: "stock_take_error", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
