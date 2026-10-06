import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getCashbookSummary } from "@/lib/cashbook";

// Module 27: deliberately NOT branch-filtered, unlike most other summary
// endpoints in this app – a CashAccount's balance is a whole-account fact
// (see the model comment on CashAccount) that doesn't change based on which
// branch is asking. Branch-attributable activity is available one level
// down, at GET .../accounts/[accountId]/transactions?branchId=.
export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "cashbook.view");
  if (ctx instanceof NextResponse) return ctx;

  const summary = await getCashbookSummary(params.businessId);
  return NextResponse.json(summary);
}
