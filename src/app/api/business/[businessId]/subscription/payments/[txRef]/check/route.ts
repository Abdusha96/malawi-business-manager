import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { isValidTxRef } from "@/lib/payment-gateway";
import { settleGatewayPayment } from "@/lib/gateway-payments";

// Module 73 – "has this been paid?", called by the Billing page when the customer returns from
// the gateway (?tx_ref=...) and by its "Check status" button. It is the same idempotent settle
// the webhook runs, so pressing it twice, or at the same moment the webhook lands, is safe.
// A payment belonging to another business reads as 404, like any tenant-scoped lookup.
export async function POST(
  _req: NextRequest,
  props: { params: Promise<{ businessId: string; txRef: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "business.subscription.manage");
  if (ctx instanceof NextResponse) return ctx;

  if (!isValidTxRef(params.txRef)) {
    return NextResponse.json({ error: "not_found", message: "No such payment." }, { status: 404 });
  }

  const result = await settleGatewayPayment({ txRef: params.txRef, businessId: params.businessId });
  if (result.outcome === "NOT_FOUND") {
    return NextResponse.json({ error: "not_found", message: result.message }, { status: 404 });
  }
  return NextResponse.json({
    outcome: result.outcome,
    message: result.message,
    status: result.payment?.status ?? null,
  });
}
