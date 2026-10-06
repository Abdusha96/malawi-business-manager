import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { InvoicePaymentError, createOrGetPayLink, getPayLinkStatus, revokePayLink } from "@/lib/invoice-payments";

// Module 74 – the pay link for one sale. `payments.record`: the same trust as recording a payment by hand.
export async function GET(
  _req: NextRequest,
  props: { params: Promise<{ businessId: string; saleId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "payments.record");
  if (ctx instanceof NextResponse) return ctx;
  return NextResponse.json(await getPayLinkStatus(params.businessId, params.saleId));
}

export async function POST(
  _req: NextRequest,
  props: { params: Promise<{ businessId: string; saleId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "payments.record");
  if (ctx instanceof NextResponse) return ctx;
  try {
    const link = await createOrGetPayLink({ businessId: params.businessId, saleId: params.saleId, userId: ctx.userId });
    return NextResponse.json(link);
  } catch (err) {
    if (err instanceof InvoicePaymentError) return NextResponse.json({ error: "pay_link_error", message: err.message }, { status: err.status });
    throw err;
  }
}

export async function DELETE(
  _req: NextRequest,
  props: { params: Promise<{ businessId: string; saleId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "payments.record");
  if (ctx instanceof NextResponse) return ctx;
  await revokePayLink({ businessId: params.businessId, saleId: params.saleId });
  return NextResponse.json({ revoked: true });
}
