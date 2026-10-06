import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { readDateRangeOrResponse } from "@/lib/date-range-api";
import { endOfDay } from "@/lib/date-range";
import { startOfMonthIn } from "@/lib/timezone";
import { getTaxCalendar } from "@/lib/tax-calendar";
import { getBusinessTimeZone } from "@/lib/business-timezone";

// Module 20 (Tax Calendar) – gated by accounting.view like the other
// accounting-hub report routes. Unlike VAT Return/Withholding Tax Return
// (which default to "this month so far", a backward-looking report), this
// defaults to a forward-looking window: the current month through the end
// of the third month out, since the whole point of a calendar is upcoming
// deadlines, not just past ones. Module 34: the accounting hub's tab passes an
// explicit `from` further back (its "Look back" selector) so overdue,
// unpaid obligations older than the current month can be surfaced too.
export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "accounting.view");
  if (ctx instanceof NextResponse) return ctx;
  const tz = await getBusinessTimeZone(params.businessId);

  const { searchParams } = new URL(req.url);
  const now = new Date();
  const defaultFrom = startOfMonthIn(now, tz);
  const defaultTo = endOfDay(new Date(startOfMonthIn(now, tz, 3).getTime() - 1), tz);
  // Module 34: date-only bounds mean start/end of that day in the business's time zone (see src/lib/date-range.ts).
  const range = readDateRangeOrResponse(searchParams, { from: defaultFrom, to: defaultTo }, tz);
  if (range instanceof NextResponse) return range;
  const { from, to } = range;

  const entries = await getTaxCalendar(params.businessId, from, to);
  return NextResponse.json({ entries });
}
