import { NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getStockTake, deleteStockTake, StockTakeError } from "@/lib/stock-take";

export async function GET(
  _req: Request,
  props: { params: Promise<{ businessId: string; stockTakeId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "stocktake.view");
  if (ctx instanceof NextResponse) return ctx;

  const stockTake = await getStockTake(params.businessId, params.stockTakeId);
  if (!stockTake) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({ stockTake });
}

export async function DELETE(
  _req: Request,
  props: { params: Promise<{ businessId: string; stockTakeId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "stocktake.manage");
  if (ctx instanceof NextResponse) return ctx;

  try {
    await deleteStockTake({
      businessId: params.businessId,
      stockTakeId: params.stockTakeId,
      deletedById: ctx.userId,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof StockTakeError) {
      return NextResponse.json({ error: "stock_take_error", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
