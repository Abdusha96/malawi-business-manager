import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { quotationSchema, quotationStatusSchema } from "@/lib/validation";
import { getQuotation, updateQuotation, setQuotationStatus, QuotationValidationError } from "@/lib/quotations";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; quotationId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "quotations.view");
  if (ctx instanceof NextResponse) return ctx;

  const quotation = await getQuotation({ businessId: params.businessId, quotationId: params.quotationId });
  if (!quotation) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({ quotation });
}

// PATCH accepts EITHER a full quotation edit (items/customer/etc, only while
// DRAFT) OR just a status change ({ status }) – two different shapes with
// two different validators, disambiguated by whether "items" is present.
export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; quotationId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "quotations.manage");
  if (ctx instanceof NextResponse) return ctx;

  const body = await req.json();

  try {
    if ("items" in body) {
      const parsed = quotationSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
      }
      const quotation = await updateQuotation({
        businessId: params.businessId,
        quotationId: params.quotationId,
        input: parsed.data,
      });
      return NextResponse.json({ quotation });
    }

    const parsed = quotationStatusSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
    }
    const quotation = await setQuotationStatus({
      businessId: params.businessId,
      quotationId: params.quotationId,
      status: parsed.data.status,
    });
    return NextResponse.json({ quotation });
  } catch (err) {
    if (err instanceof QuotationValidationError) {
      return NextResponse.json({ error: "quotation_invalid", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
