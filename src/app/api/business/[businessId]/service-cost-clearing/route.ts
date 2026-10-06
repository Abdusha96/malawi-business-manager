import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getServiceCostClearing } from "@/lib/service-cost-clearing-run";

// Module 79 (Service Cost Clearing). Business-wide by design: the GL has no branch dimension, so there is no
// resolveBranchScope(). Viewing needs accounting.view, settling needs accounting.manage (Owner + Accountant);
// no new permission, so no re-seed.
export async function GET(_req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "accounting.view");
  if (ctx instanceof NextResponse) return ctx;
  const data = await getServiceCostClearing(params.businessId);
  return NextResponse.json(data);
}
