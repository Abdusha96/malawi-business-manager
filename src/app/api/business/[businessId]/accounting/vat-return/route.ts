import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { readDateRangeOrResponse } from "@/lib/date-range-api";
import { monthToDate } from "@/lib/date-range";
import { getVatReturn } from "@/lib/vat";
import { getBusinessTimeZone } from "@/lib/business-timezone";

// Module 18 (VAT) – same URL/permission shape as the other accounting
// reports (see cash-flow/route.ts): a `from`/`to` date range, gated by
// accounting.view (Owner + Accountant already have it, no new permission
// needed – same reasoning Module 17 used).
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

  const report = await getVatReturn(params.businessId, from, to);
  return NextResponse.json(report);
}
