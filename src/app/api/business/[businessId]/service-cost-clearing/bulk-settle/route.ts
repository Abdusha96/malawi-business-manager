import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { bulkSettleServiceCostSchema } from "@/lib/validation";
import { settleManyServiceCosts, ServiceCostClearingError } from "@/lib/service-cost-clearing-run";
import { AccountingError } from "@/lib/accounting";

// Module 80. Same permission and branch rule as the single settle route: accounting.manage, whole-business books,
// so a branch-restricted member is refused. 200 even when some services were skipped: the body lists each one.
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

  const parsed = bulkSettleServiceCostSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await settleManyServiceCosts({
      businessId: params.businessId,
      userId: ctx.userId,
      items: parsed.data.items,
      reason: parsed.data.reason,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof ServiceCostClearingError || err instanceof AccountingError) {
      return NextResponse.json({ error: "settlement_failed", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
