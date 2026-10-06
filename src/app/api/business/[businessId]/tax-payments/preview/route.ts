import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getTaxPaymentPreview, TaxPaymentError } from "@/lib/tax-payments";
import { TAX_PAYMENT_TYPES, TaxPaymentTypeKey } from "@/lib/tax-period";

// Module 33 – what the record form shows for one obligation. Gated by
// taxpayments.manage (not .view): it computes the VAT return / corporate tax
// estimate on demand, which only someone about to record a payment needs.
export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "taxpayments.manage");
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);
  const taxType = searchParams.get("taxType") as TaxPaymentTypeKey | null;
  const periodKey = searchParams.get("periodKey");
  if (!taxType || !TAX_PAYMENT_TYPES.includes(taxType) || !periodKey) {
    return NextResponse.json({ error: "validation_error", message: "taxType and periodKey are required." }, { status: 400 });
  }

  try {
    const preview = await getTaxPaymentPreview({ businessId: params.businessId, taxType, periodKey });
    return NextResponse.json({ preview });
  } catch (err) {
    if (err instanceof TaxPaymentError) {
      return NextResponse.json({ error: "tax_payment_failed", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
