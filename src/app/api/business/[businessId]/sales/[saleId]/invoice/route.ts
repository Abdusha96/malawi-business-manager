import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { generateInvoiceSchema } from "@/lib/validation";
import { getOrCreateInvoiceForSale, getInvoiceForSale, InvoiceValidationError } from "@/lib/invoices";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; saleId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "documents.generate");
  if (ctx instanceof NextResponse) return ctx;

  const invoice = await getInvoiceForSale({ businessId: params.businessId, saleId: params.saleId });
  if (!invoice) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({ invoice });
}

// Generates the invoice the first time it's requested for a sale (claiming
// its number), or simply returns the existing one on subsequent calls – see
// the lazy-creation comment in src/lib/invoices.ts.
export async function POST(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; saleId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "documents.generate");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const parsed = generateInvoiceSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const invoice = await getOrCreateInvoiceForSale({
      businessId: params.businessId,
      saleId: params.saleId,
      userId,
      dueDate: parsed.data.dueDate,
      terms: parsed.data.terms,
    });
    return NextResponse.json({ invoice }, { status: 201 });
  } catch (err) {
    if (err instanceof InvoiceValidationError) {
      return NextResponse.json({ error: "invoice_invalid", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
