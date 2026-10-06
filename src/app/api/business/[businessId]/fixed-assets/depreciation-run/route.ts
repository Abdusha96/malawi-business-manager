import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { depreciationRunSchema } from "@/lib/validation";
import { postDepreciationForPeriod } from "@/lib/fixed-assets";
import { AccountingError } from "@/lib/accounting";

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "fixedassets.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = depreciationRunSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  // Module 42: a period that is closed can't take a depreciation entry. AccountingError also covers
  // PeriodClosedError. Before this the route had no catch at all.
  try {
    const results = await postDepreciationForPeriod({
      businessId: params.businessId,
      period: parsed.data.period,
      createdById: ctx.userId,
    });
    return NextResponse.json({ results });
  } catch (err) {
    if (err instanceof AccountingError) {
      return NextResponse.json({ error: "depreciation_failed", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
