import { NextRequest, NextResponse } from "next/server";
import { handleBusinessWebhook } from "@/lib/invoice-payments";

// Module 74 – PayChangu's notification for a BUSINESS's own account (customer invoice payments). Public,
// like the platform webhook, and for the same reason; signed with that business's webhook secret.
// The URL to paste into the business's PayChangu dashboard is shown on /settings/online-payments.
export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const rawBody = await req.text();
  const signature = req.headers.get("signature") ?? req.headers.get("x-signature");
  const { httpStatus, body } = await handleBusinessWebhook({ businessId: params.businessId, rawBody, signature });
  return NextResponse.json(body, { status: httpStatus });
}
