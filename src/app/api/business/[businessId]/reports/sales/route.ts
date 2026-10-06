import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { resolveBranchScope, TenantAccessError } from "@/lib/tenant";
import { getSalesReport, ReportPeriod } from "@/lib/reports";
import { readDateRangeOrResponse } from "@/lib/date-range-api";
import { monthToDate } from "@/lib/date-range";
import { csvResponse } from "@/lib/csv";
import { getBusinessTimeZone } from "@/lib/business-timezone";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "reports.basic.view");
  if (ctx instanceof NextResponse) return ctx;
  const tz = await getBusinessTimeZone(params.businessId);

  const { searchParams } = new URL(req.url);
  // Module 34: shared with the accounting-hub routes – a date-only `to` includes that whole day.
  const range = readDateRangeOrResponse(searchParams, monthToDate(tz), tz);
  if (range instanceof NextResponse) return range;
  const { from, to } = range;
  const period = (searchParams.get("period") as ReportPeriod) ?? "daily";

  let branchId: string | null;
  try {
    branchId = resolveBranchScope(ctx.membership, searchParams.get("branchId"));
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: "forbidden" }, { status: err.status });
    throw err;
  }

  const report = await getSalesReport(params.businessId, from, to, period, branchId);

  if (searchParams.get("format") === "csv") {
    return csvResponse("sales-report.csv", report.rows);
  }

  return NextResponse.json(report);
}
