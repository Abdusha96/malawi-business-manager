import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { resolveBranchScope, TenantAccessError } from "@/lib/tenant";
import { quotationSchema } from "@/lib/validation";
import { createQuotation, listQuotations, QuotationValidationError } from "@/lib/quotations";
import { QuotationStatus } from "@prisma/client";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "quotations.view");
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");

  let branchId: string | null;
  try {
    branchId = resolveBranchScope(ctx.membership, searchParams.get("branchId"));
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: "forbidden" }, { status: err.status });
    throw err;
  }

  const quotations = await listQuotations({
    businessId: params.businessId,
    branchId,
    status: status ? (status as QuotationStatus) : undefined,
  });

  return NextResponse.json({ quotations });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "quotations.manage");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const parsed = quotationSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  let branchId: string | null;
  try {
    branchId = resolveBranchScope(ctx.membership, parsed.data.branchId ?? null);
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: "forbidden" }, { status: err.status });
    throw err;
  }

  try {
    const quotation = await createQuotation({
      businessId: params.businessId,
      userId,
      input: { ...parsed.data, branchId },
    });
    return NextResponse.json({ quotation }, { status: 201 });
  } catch (err) {
    if (err instanceof QuotationValidationError) {
      return NextResponse.json({ error: "quotation_invalid", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
