import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { hasPermission } from "@/lib/tenant";
import { periodCloseSchema } from "@/lib/validation";
import { getPeriodCloseOverview, getCloseReadiness, setBooksClosedThrough, PeriodCloseError } from "@/lib/period-close";
import { isRealYmd } from "@/lib/period-lock";

// Module 42 (Period Close). Business-wide by design: the books have no branch dimension, so a
// branch-locked member may VIEW the state but not change it. Viewing needs accounting.view,
// closing needs accounting.manage (Owner + Accountant), and reopening also needs
// business.settings.manage (Owner). No new permission, so no re-seed.
//
// GET ?through=YYYY-MM-DD also returns what is still unfinished inside the days that a close
// through that date would cover (draft payroll, open bank reconciliations).
export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "accounting.view");
  if (ctx instanceof NextResponse) return ctx;

  const overview = await getPeriodCloseOverview(params.businessId);

  const through = new URL(req.url).searchParams.get("through");
  if (through === null || through === "") return NextResponse.json({ overview });

  if (!isRealYmd(through)) {
    return NextResponse.json({ error: "invalid_date", message: "\"through\" must be a real date such as 2026-03-31." }, { status: 400 });
  }
  const readiness = await getCloseReadiness(params.businessId, through, overview.timeZone);
  return NextResponse.json({ overview, readiness });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "accounting.manage");
  if (ctx instanceof NextResponse) return ctx;

  if (ctx.membership.branchId) {
    return NextResponse.json(
      { error: "forbidden", message: "Closing the books applies to the whole business. A branch-restricted member can view the state but not change it." },
      { status: 403 }
    );
  }

  const parsed = periodCloseSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  const canReopen = await hasPermission(ctx.membership, "business.settings.manage");

  try {
    const result = await setBooksClosedThrough({
      businessId: params.businessId,
      userId: ctx.userId,
      requested: parsed.data.closedThrough,
      reason: parsed.data.reason,
      canReopen,
    });
    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof PeriodCloseError) {
      return NextResponse.json(
        { error: err.status === 403 ? "forbidden" : "period_close_failed", message: err.message },
        { status: err.status }
      );
    }
    throw err;
  }
}
