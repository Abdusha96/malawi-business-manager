import { NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { completeStockTake, StockTakeError } from "@/lib/stock-take";

export async function POST(
  _req: Request,
  props: { params: Promise<{ businessId: string; stockTakeId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "stocktake.manage");
  if (ctx instanceof NextResponse) return ctx;

  try {
    const result = await completeStockTake({
      businessId: params.businessId,
      stockTakeId: params.stockTakeId,
      completedById: ctx.userId,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof StockTakeError) {
      return NextResponse.json({ error: "stock_take_error", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
