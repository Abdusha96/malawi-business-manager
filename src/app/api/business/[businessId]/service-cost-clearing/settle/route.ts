import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { settleServiceCostSchema } from "@/lib/validation";
import { settleServiceCost, ServiceCostClearingError } from "@/lib/service-cost-clearing-run";
import { AccountingError } from "@/lib/accounting";

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "accounting.manage");
  if (ctx instanceof NextResponse) return ctx;

  if (ctx.membership.branchId) {
    return NextResponse.json(
      { error: "forbidden", message: "Settling service cost posts to the whole business's books. A branch-restricted member can view it but not settle." },
      { status: 403 }
    );
  }

  const parsed = settleServiceCostSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await settleServiceCost({
      businessId: params.businessId,
      userId: ctx.userId,
      productId: parsed.data.productId,
      amount: parsed.data.amount ?? null,
      expectedBalance: parsed.data.expectedBalance ?? null,
      reason: parsed.data.reason,
    });
    return NextResponse.json(
      { settlement: result.settlement, balanceAfter: result.balanceAfter / 100 },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof ServiceCostClearingError || err instanceof AccountingError) {
      return NextResponse.json({ error: "settlement_failed", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
