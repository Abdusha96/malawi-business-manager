import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { fxAdjustmentSchema } from "@/lib/validation";
import { createForeignExchangeAdjustment, listForeignExchangeAdjustments, ForeignExchangeError } from "@/lib/foreign-exchange";
import { AccountingError } from "@/lib/accounting";

// Module 39 (Foreign Exchange Gains & Losses). Business-wide by design – no
// resolveBranchScope(): an exchange difference belongs to the business's holding
// of foreign currency, not to one branch (see the ForeignExchangeAdjustment model).
export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "forex.view");
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);
  const adjustments = await listForeignExchangeAdjustments(params.businessId, {
    kind: searchParams.get("kind") ?? undefined,
    status: searchParams.get("status") ?? undefined,
  });
  return NextResponse.json({ adjustments });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "forex.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = fxAdjustmentSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const adjustment = await createForeignExchangeAdjustment({ businessId: params.businessId, userId: ctx.userId, input: parsed.data });
    return NextResponse.json({ adjustment }, { status: 201 });
  } catch (err) {
    if (err instanceof ForeignExchangeError || err instanceof AccountingError) {
      return NextResponse.json({ error: "fx_adjustment_failed", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
