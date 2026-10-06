import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { voidPurchase, PurchaseValidationError } from "@/lib/purchases";
import { PeriodClosedError } from "@/lib/accounting";
import { z } from "zod";

const voidSchema = z.object({ reason: z.string().min(1, "A reason is required to void a purchase") });

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; purchaseId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "purchases.void");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const parsed = voidSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const purchase = await voidPurchase({
      businessId: params.businessId,
      purchaseId: params.purchaseId,
      userId,
      reason: parsed.data.reason,
    });
    return NextResponse.json({ purchase, message: "Purchase voided and stock reversed." });
  } catch (err) {
    if (err instanceof PurchaseValidationError || err instanceof PeriodClosedError) {
      return NextResponse.json({ error: "void_failed", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
