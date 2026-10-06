import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getForeignExchangeAdjustment } from "@/lib/foreign-exchange";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; adjustmentId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "forex.view");
  if (ctx instanceof NextResponse) return ctx;

  const adjustment = await getForeignExchangeAdjustment({ businessId: params.businessId, adjustmentId: params.adjustmentId });
  if (!adjustment) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ adjustment });
}
