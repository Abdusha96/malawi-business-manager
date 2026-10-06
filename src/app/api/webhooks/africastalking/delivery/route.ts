import { NextRequest, NextResponse } from "next/server";
import { handleDeliveryReport } from "@/lib/sms-delivery-report-run";
import { allowRequest, clientKey } from "@/lib/rate-limit";

// Module 76 – Africa's Talking's SMS delivery report callback. PUBLIC on purpose: the gateway has no
// session, so this sits outside src/proxy.ts's matcher (which only covers /api/business/...).
// Africa's Talking does NOT sign this callback, so the protection is a long random secret in the URL
// you give it (Africa's Talking dashboard -> SMS -> Delivery Reports):
//   https://your.domain/api/webhooks/africastalking/delivery?token=<AT_DELIVERY_REPORT_SECRET>
// The route answers 503 until AT_DELIVERY_REPORT_SECRET is set, and 401 for a wrong token BEFORE it
// reads anything else. A report can only ever change the one log row whose stored message id it names
// and only when the number on the report matches the number we dialled (see sms-delivery-report.ts).
//
// The body is form-encoded (JSON is accepted too, in case a proxy rewrites it). It is read as text with
// a small cap: this is an unauthenticated-until-checked endpoint, so it never buffers a large body.
const MAX_BODY_CHARS = 8_000;

export async function POST(req: NextRequest) {
  // A wrong token is cheap to try, so repeated attempts from one address are slowed down. Per-process
  // only (see rate-limit.ts), which is the right size for stopping one script, not for a real attack.
  const forwarded = req.headers.get("x-forwarded-for");
  if (!allowRequest(clientKey(forwarded, "at-delivery"), 600, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const token = req.nextUrl.searchParams.get("token") ?? req.headers.get("x-delivery-secret");

  const raw = (await req.text()).slice(0, MAX_BODY_CHARS);
  const fields: Record<string, string> = {};
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string" || typeof v === "number") fields[k] = String(v);
        }
      }
    } catch {
      // fall through: no fields -> "bad_report"
    }
  } else {
    new URLSearchParams(raw).forEach((v, k) => {
      fields[k] = v;
    });
  }

  // A thrown error (database down) is deliberately left to become a 500.
  const { httpStatus, body } = await handleDeliveryReport({ token, fields });
  return NextResponse.json(body, { status: httpStatus });
}
