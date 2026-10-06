import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { resolveBranchScope, TenantAccessError } from "@/lib/tenant";
import { getCustomerDebtReport } from "@/lib/reports";
import { csvResponse } from "@/lib/csv";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "reports.basic.view");
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);

  let branchId: string | null;
  try {
    branchId = resolveBranchScope(ctx.membership, searchParams.get("branchId"));
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: "forbidden" }, { status: err.status });
    throw err;
  }

  const report = await getCustomerDebtReport(params.businessId, branchId);

  if (searchParams.get("format") === "csv") {
    return csvResponse("customer-debt-report.csv", report.rows);
  }

  return NextResponse.json(report);
}
