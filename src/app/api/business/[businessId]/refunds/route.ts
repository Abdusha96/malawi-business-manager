import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { refundSchema } from "@/lib/validation";
import { createRefund, listRefunds, RefundError } from "@/lib/refunds";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "refunds.view");
  if (ctx instanceof NextResponse) return ctx;

  const refunds = await listRefunds(params.businessId);
  return NextResponse.json({ refunds });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "refunds.manage");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const parsed = refundSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const refund = await createRefund({ businessId: params.businessId, userId, input: parsed.data });
    return NextResponse.json({ refund }, { status: 201 });
  } catch (err) {
    if (err instanceof RefundError) {
      return NextResponse.json({ error: "refund_failed", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
