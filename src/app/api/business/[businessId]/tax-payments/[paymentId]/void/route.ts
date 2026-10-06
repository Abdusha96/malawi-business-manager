import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { voidTaxPaymentSchema } from "@/lib/validation";
import { voidTaxPayment, TaxPaymentError } from "@/lib/tax-payments";
import { AccountingError } from "@/lib/accounting";

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; paymentId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "taxpayments.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = voidTaxPaymentSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const payment = await voidTaxPayment({
      businessId: params.businessId,
      paymentId: params.paymentId,
      userId: ctx.userId,
      reason: parsed.data.reason,
    });
    return NextResponse.json({ payment });
  } catch (err) {
    if (err instanceof TaxPaymentError || err instanceof AccountingError) {
      return NextResponse.json({ error: "tax_payment_failed", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
