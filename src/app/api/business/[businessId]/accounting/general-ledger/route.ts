import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { readDateParamOrResponse } from "@/lib/date-range-api";
import { getGeneralLedger } from "@/lib/financial-statements";
import { getBusinessTimeZone } from "@/lib/business-timezone";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "accounting.view");
  if (ctx instanceof NextResponse) return ctx;
  const tz = await getBusinessTimeZone(params.businessId);

  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId");
  if (!accountId) {
    return NextResponse.json({ error: "validation_error", message: "accountId is required" }, { status: 400 });
  }

  // Module 34: date-only bounds mean start/end of that local day (see src/lib/date-range.ts).
  const from = readDateParamOrResponse(searchParams, "from", "start", tz);
  if (from instanceof NextResponse) return from;
  const to = readDateParamOrResponse(searchParams, "to", "end", tz);
  if (to instanceof NextResponse) return to;

  const ledger = await getGeneralLedger(params.businessId, accountId, from, to);
  return NextResponse.json(ledger);
}
