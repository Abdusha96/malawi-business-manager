import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { readDateRangeOrResponse } from "@/lib/date-range-api";
import { monthToDate } from "@/lib/date-range";
import { getWithholdingTaxReturn } from "@/lib/withholding-tax";
import { getBusinessTimeZone } from "@/lib/business-timezone";

// Module 19 (Withholding Tax) – same URL/permission shape as vat-return
// (see that route's comment): a `from`/`to` date range, gated by
// accounting.view.
export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "accounting.view");
  if (ctx instanceof NextResponse) return ctx;
  const tz = await getBusinessTimeZone(params.businessId);

  const { searchParams } = new URL(req.url);
  // Module 34: date-only `from`/`to` mean start/end of that local day (see src/lib/date-range.ts).
  const range = readDateRangeOrResponse(searchParams, monthToDate(tz), tz);
  if (range instanceof NextResponse) return range;
  const { from, to } = range;

  const report = await getWithholdingTaxReturn(params.businessId, from, to);
  return NextResponse.json(report);
}
