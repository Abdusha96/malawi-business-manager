import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { taxPaymentSchema } from "@/lib/validation";
import { createTaxPayment, listTaxPayments, TaxPaymentError } from "@/lib/tax-payments";
import { AccountingError } from "@/lib/accounting";

// Module 33 (Tax Payments). Business-wide by design – no resolveBranchScope():
// an MRA tax is owed by the taxpayer, not a branch (see the TaxPayment model).
export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "taxpayments.view");
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);
  const payments = await listTaxPayments(params.businessId, {
    taxType: searchParams.get("taxType") ?? undefined,
    status: searchParams.get("status") ?? undefined,
  });
  return NextResponse.json({ payments });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "taxpayments.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = taxPaymentSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const payment = await createTaxPayment({ businessId: params.businessId, userId: ctx.userId, input: parsed.data });
    return NextResponse.json({ payment }, { status: 201 });
  } catch (err) {
    if (err instanceof TaxPaymentError || err instanceof AccountingError) {
      return NextResponse.json({ error: "tax_payment_failed", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
