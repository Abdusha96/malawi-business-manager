import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { changeSubscriptionPlanSchema } from "@/lib/validation";
import { SubscriptionChangeError } from "@/lib/subscription";
import { GatewayError, startSubscriptionCheckout } from "@/lib/gateway-payments";

// Module 73 – start paying for a plan. Same body as the `change_plan` action
// ({ planKey, billingCycle }) and the same permission: paying for a plan is exactly as
// sensitive as switching to it. Returns the gateway's hosted-checkout link; the page sends
// the person there. Nothing about the subscription changes until the payment is confirmed
// (see settleGatewayPayment in src/lib/gateway-payments.ts).
export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "business.subscription.manage");
  if (ctx instanceof NextResponse) return ctx;

  const body = await req.json().catch(() => ({}));
  const parsed = changeSubscriptionPlanSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await startSubscriptionCheckout({
      businessId: params.businessId,
      userId: ctx.userId,
      planKey: parsed.data.planKey,
      billingCycle: parsed.data.billingCycle,
    });
    // Module 74: unused time on the old plan can cover the whole new price, in which case there is
    // nothing to pay and the change was applied directly.
    if (result.kind === "COVERED_BY_CREDIT") {
      return NextResponse.json({ coveredByCredit: true, credit: result.credit });
    }
    return NextResponse.json({ txRef: result.payment.txRef, checkoutUrl: result.payment.checkoutUrl, reused: result.reused });
  } catch (err) {
    if (err instanceof SubscriptionChangeError) {
      return NextResponse.json({ error: "subscription_change_failed", message: err.message }, { status: 400 });
    }
    if (err instanceof GatewayError) {
      return NextResponse.json({ error: "gateway_error", message: err.message }, { status: err.status });
    }
    throw err;
  }
}
