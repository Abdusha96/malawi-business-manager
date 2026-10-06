import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { voidServiceCostSettlementSchema } from "@/lib/validation";
import { voidServiceCostSettlement, ServiceCostClearingError } from "@/lib/service-cost-clearing-run";
import { AccountingError } from "@/lib/accounting";

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; settlementId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "accounting.manage");
  if (ctx instanceof NextResponse) return ctx;

  if (ctx.membership.branchId) {
    return NextResponse.json(
      { error: "forbidden", message: "A branch-restricted member can't void a settlement; it changes the whole business's books." },
      { status: 403 }
    );
  }

  const parsed = voidServiceCostSettlementSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await voidServiceCostSettlement({
      businessId: params.businessId,
      userId: ctx.userId,
      settlementId: params.settlementId,
      reason: parsed.data.reason,
    });
    return NextResponse.json({ settlement: result });
  } catch (err) {
    if (err instanceof ServiceCostClearingError || err instanceof AccountingError) {
      return NextResponse.json({ error: "settlement_failed", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
