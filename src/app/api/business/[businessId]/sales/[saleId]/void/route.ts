import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { voidSale, SaleValidationError } from "@/lib/sales";
import { PeriodClosedError } from "@/lib/accounting";
import { z } from "zod";

const voidSchema = z.object({ reason: z.string().min(1, "A reason is required to void a sale") });

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; saleId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "sales.void");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const parsed = voidSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const sale = await voidSale({
      businessId: params.businessId,
      saleId: params.saleId,
      userId,
      reason: parsed.data.reason,
    });
    return NextResponse.json({ sale, message: "Sale voided and stock restored." });
  } catch (err) {
    if (err instanceof SaleValidationError || err instanceof PeriodClosedError) {
      return NextResponse.json({ error: "void_failed", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
