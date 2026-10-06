import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getTaxPayment } from "@/lib/tax-payments";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; paymentId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "taxpayments.view");
  if (ctx instanceof NextResponse) return ctx;

  const payment = await getTaxPayment({ businessId: params.businessId, paymentId: params.paymentId });
  if (!payment) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ payment });
}
