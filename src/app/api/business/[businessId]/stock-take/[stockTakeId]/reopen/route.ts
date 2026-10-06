import { NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { hasPermission } from "@/lib/tenant";
import { reopenStockTakeSchema } from "@/lib/validation";
import { reopenStockTake, StockTakeError } from "@/lib/stock-take";

// Module 49. Same permission split Bank Reconciliation (Module 48) and Period
// Close (Module 42) use for their own close/reopen: completing needs
// "stocktake.manage" (Owner + Accountant, already required to reach this
// stock take at all), reopening a COMPLETED one also needs
// "business.settings.manage" (Owner only). No new permission, so no re-seed.
export async function POST(
  req: Request,
  props: { params: Promise<{ businessId: string; stockTakeId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "stocktake.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = reopenStockTakeSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  const canReopen = await hasPermission(ctx.membership, "business.settings.manage");

  try {
    const stockTake = await reopenStockTake({
      businessId: params.businessId,
      stockTakeId: params.stockTakeId,
      reason: parsed.data.reason,
      lineId: parsed.data.lineId,
      reopenedById: ctx.userId,
      canReopen,
    });
    return NextResponse.json({ stockTake });
  } catch (err) {
    if (err instanceof StockTakeError) {
      return NextResponse.json({ error: "stock_take_error", message: err.message }, { status: err.status });
    }
    throw err;
  }
}
