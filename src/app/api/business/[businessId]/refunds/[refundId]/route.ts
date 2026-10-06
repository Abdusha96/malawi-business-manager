import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getRefund } from "@/lib/refunds";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; refundId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "refunds.view");
  if (ctx instanceof NextResponse) return ctx;

  const refund = await getRefund({ businessId: params.businessId, refundId: params.refundId });
  if (!refund) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ refund });
}
