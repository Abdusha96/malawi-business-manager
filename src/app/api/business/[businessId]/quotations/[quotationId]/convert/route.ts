import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { convertQuotationSchema } from "@/lib/validation";
import { convertQuotationToSale, QuotationValidationError } from "@/lib/quotations";
import { PlanRestrictionError } from "@/lib/subscription";

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; quotationId: string }> }
) {
  const params = await props.params;
  // Converting a quotation ultimately creates a Sale, so it requires the
  // same permission a manually-entered sale does, not just quotations.manage
  // – a role that can draft quotations but not record sales shouldn't be
  // able to achieve the same effect by converting one.
  const ctx = await requireApiContext(params.businessId, "sales.create");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const parsed = convertQuotationSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const sale = await convertQuotationToSale({
      businessId: params.businessId,
      quotationId: params.quotationId,
      userId,
      input: parsed.data,
    });
    return NextResponse.json({ sale }, { status: 201 });
  } catch (err) {
    if (err instanceof QuotationValidationError) {
      return NextResponse.json({ error: "conversion_failed", message: err.message }, { status: 400 });
    }
    // Module 26: convertQuotationToSale() calls the real createSale(),
    // which now enforces the monthly sales cap – surface it the same way
    // the direct sales route does rather than letting it 500.
    if (err instanceof PlanRestrictionError) {
      return NextResponse.json({ error: "plan_restriction", message: err.message }, { status: err.status });
    }
    throw err;
  }
}
