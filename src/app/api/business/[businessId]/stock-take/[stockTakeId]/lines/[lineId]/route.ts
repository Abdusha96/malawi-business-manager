import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { recordStockCountSchema, ignoreStockTakeLineSchema } from "@/lib/validation";
import {
  recordStockCount,
  uncountStockTakeLine,
  postStockTakeLineAdjustment,
  unpostStockTakeLineAdjustment,
  ignoreStockTakeLine,
  unignoreStockTakeLine,
  StockTakeError,
} from "@/lib/stock-take";

// One dispatch endpoint for every action a line can take, rather than six
// near-identical route files – mirrors Bank Reconciliation's statement
// line dispatch (src/app/api/business/[businessId]/bank-reconciliation/
// [reconciliationId]/lines/[lineId]/route.ts) exactly.
const ACTIONS = ["count", "uncount", "post", "unpost", "ignore", "unignore"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; stockTakeId: string; lineId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "stocktake.manage");
  if (ctx instanceof NextResponse) return ctx;

  const body = await req.json();
  const action = body?.action as Action | undefined;
  if (!action || !ACTIONS.includes(action)) {
    return NextResponse.json({ error: "validation_error", message: `action must be one of: ${ACTIONS.join(", ")}` }, { status: 400 });
  }

  try {
    switch (action) {
      case "count": {
        const parsed = recordStockCountSchema.safeParse(body);
        if (!parsed.success) return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
        const line = await recordStockCount({
          businessId: params.businessId,
          stockTakeId: params.stockTakeId,
          lineId: params.lineId,
          countedQuantity: parsed.data.countedQuantity,
          countedById: ctx.userId,
        });
        return NextResponse.json({ line });
      }
      case "uncount": {
        const line = await uncountStockTakeLine({ businessId: params.businessId, lineId: params.lineId, unsetById: ctx.userId });
        return NextResponse.json({ line });
      }
      case "post": {
        const line = await postStockTakeLineAdjustment({ businessId: params.businessId, lineId: params.lineId, postedById: ctx.userId });
        return NextResponse.json({ line });
      }
      case "unpost": {
        const line = await unpostStockTakeLineAdjustment({ businessId: params.businessId, lineId: params.lineId, unpostedById: ctx.userId });
        return NextResponse.json({ line });
      }
      case "ignore": {
        const parsed = ignoreStockTakeLineSchema.safeParse(body);
        if (!parsed.success) return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
        const line = await ignoreStockTakeLine({
          businessId: params.businessId,
          lineId: params.lineId,
          reason: parsed.data.reason,
          ignoredById: ctx.userId,
        });
        return NextResponse.json({ line });
      }
      case "unignore": {
        const line = await unignoreStockTakeLine({ businessId: params.businessId, lineId: params.lineId, unignoredById: ctx.userId });
        return NextResponse.json({ line });
      }
    }
  } catch (err) {
    if (err instanceof StockTakeError) {
      return NextResponse.json({ error: "stock_take_error", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
