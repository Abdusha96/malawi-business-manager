import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { readDateParamOrResponse } from "@/lib/date-range-api";
import { getBalanceSheet } from "@/lib/financial-statements";
import { getBusinessTimeZone } from "@/lib/business-timezone";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "accounting.view");
  if (ctx instanceof NextResponse) return ctx;
  const tz = await getBusinessTimeZone(params.businessId);

  const { searchParams } = new URL(req.url);
  // Module 34: "as of 2026-03-31" includes everything posted on the 31st.
  const asOfParam = readDateParamOrResponse(searchParams, "asOf", "end", tz);
  if (asOfParam instanceof NextResponse) return asOfParam;
  const asOf = asOfParam ?? new Date();

  const report = await getBalanceSheet(params.businessId, asOf);
  return NextResponse.json(report);
}
