import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { readDateRangeOrResponse } from "@/lib/date-range-api";
import { monthToDate } from "@/lib/date-range";
import { getCorporateTaxEstimate } from "@/lib/corporate-tax";
import { getBusinessTimeZone } from "@/lib/business-timezone";

// Module 20 (Corporate Tax) – same URL/permission shape as vat-return and
// withholding-tax-return (see those routes' comments): a `from`/`to` date
// range, gated by accounting.view. Defaults to month-to-date like the
// other two, even though a real provisional/annual estimate is more
// naturally quarterly/annual – the accounting-hub tab lets the user pick
// any range, including a full fiscal year.
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

  const estimate = await getCorporateTaxEstimate(params.businessId, from, to);
  return NextResponse.json(estimate);
}
