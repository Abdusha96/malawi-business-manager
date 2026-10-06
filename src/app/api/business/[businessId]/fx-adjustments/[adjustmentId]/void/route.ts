import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { voidFxAdjustmentSchema } from "@/lib/validation";
import { voidForeignExchangeAdjustment, ForeignExchangeError } from "@/lib/foreign-exchange";
import { AccountingError } from "@/lib/accounting";

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; adjustmentId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "forex.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = voidFxAdjustmentSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const adjustment = await voidForeignExchangeAdjustment({
      businessId: params.businessId,
      adjustmentId: params.adjustmentId,
      userId: ctx.userId,
      reason: parsed.data.reason,
    });
    return NextResponse.json({ adjustment });
  } catch (err) {
    if (err instanceof ForeignExchangeError || err instanceof AccountingError) {
      return NextResponse.json({ error: "fx_adjustment_failed", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
