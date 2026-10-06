import { NextResponse } from "next/server";
import { DateEdge, DateParamError, readDateParam, readDateRange } from "./date-range";

/**
 * Module 34 – route-side wrappers over src/lib/date-range.ts, shaped like
 * `requireApiContext()` so a route reads the same way for both:
 *
 *   const tz = await getBusinessTimeZone(params.businessId);
 *   const range = readDateRangeOrResponse(searchParams, monthToDate(tz), tz);
 *   if (range instanceof NextResponse) return range;
 *   const { from, to } = range;
 *
 * Module 35: `tz` is the business's time zone (src/lib/business-timezone.ts).
 * A date-only value means that day IN THAT ZONE, not in the server's.
 *
 * An unparseable date used to become `Invalid Date`, which Prisma rejected
 * with an unhandled 500; it is now a 400 naming the offending parameter.
 * Kept out of date-range.ts itself so that file stays free of `next/server`
 * and can be imported by client components.
 */

function badDate(err: DateParamError): NextResponse {
  return NextResponse.json({ error: "validation_error", message: err.message, param: err.param }, { status: 400 });
}

/** `from`/`to` with start-of-day / end-of-day semantics, falling back to `defaults`. */
export function readDateRangeOrResponse(
  searchParams: URLSearchParams,
  defaults: { from: Date; to: Date },
  tz: string
): { from: Date; to: Date } | NextResponse {
  try {
    return readDateRange(searchParams, defaults, tz);
  } catch (err) {
    if (err instanceof DateParamError) return badDate(err);
    throw err;
  }
}

/**
 * One optional date parameter. Use edge "end" for an "as of" date (so the
 * whole named day is included) and "start" for a lower bound.
 */
export function readDateParamOrResponse(
  searchParams: URLSearchParams,
  name: string,
  edge: DateEdge,
  tz: string
): Date | undefined | NextResponse {
  try {
    return readDateParam(searchParams, name, edge, tz);
  } catch (err) {
    if (err instanceof DateParamError) return badDate(err);
    throw err;
  }
}
