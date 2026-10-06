import { NextRequest, NextResponse } from "next/server";
import { handleGatewayWebhook } from "@/lib/gateway-payments";

// Module 73 – PayChangu's payment notification. PUBLIC on purpose: the gateway has no session,
// so this sits outside src/proxy.ts's matcher (which only covers /api/business/...).
// Its protection is layered: an HMAC signature check when PAYCHANGU_WEBHOOK_SECRET is set, and,
// regardless, the payment is confirmed by asking the gateway directly, never by believing the
// body. The RAW body is read as text because the signature is computed over the exact bytes.
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("signature") ?? req.headers.get("x-signature");

  // A thrown error (database down mid-settle) is deliberately left to become a 500, so the
  // gateway retries; every settle write is conditional on PENDING, so a retry is safe.
  const { httpStatus, body } = await handleGatewayWebhook({ rawBody, signature });
  return NextResponse.json(body, { status: httpStatus });
}
