import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { changeSubscriptionPlanSchema, cancelSubscriptionSchema } from "@/lib/validation";
import {
  getSubscriptionOverview,
  getSubscriptionHistory,
  changeSubscriptionPlan,
  cancelSubscription,
  resumeSubscription,
  SubscriptionChangeError,
} from "@/lib/subscription";
import { getGatewayPayments, getGatewayStatus, reconcilePendingSubscriptionPayments } from "@/lib/gateway-payments";

// GET returns everything the billing page needs in one call – current
// plan/status/usage plus recent history – same "one call per page" shape
// Module 20's tax-configuration route and Module 25's bell route use.
export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "business.subscription.manage");
  if (ctx instanceof NextResponse) return ctx;

  // Module 74: opening Billing is itself a reconciliation point. Any of this business's recent
  // pending payments not looked at in the last minute is asked about first (bounded, and a gateway
  // that is down just leaves them pending), so a missed webhook heals without anyone pressing a button.
  if (getGatewayStatus().configured) {
    await reconcilePendingSubscriptionPayments({ businessId: params.businessId, limit: 3, minSecondsBetweenChecks: 60 }).catch(() => undefined);
  }

  const [overview, history, payments] = await Promise.all([
    getSubscriptionOverview(params.businessId),
    getSubscriptionHistory(params.businessId),
    getGatewayPayments(params.businessId),
  ]);

  // Module 73: `gateway` tells the page whether paid plans go through checkout; `payments` is the
  // attempt list (PENDING / SUCCEEDED / FAILED). No key or secret ever leaves the server.
  return NextResponse.json({ overview, history, payments, gateway: getGatewayStatus() });
}

// A dispatch body ("change_plan" | "cancel") rather than two sub-routes –
// the same choice Module 25's in-app notifications POST made for its one
// bulk action, kept here because a second billing action (cancel) makes
// it worth the shared shape from the start.
export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "business.subscription.manage");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const body = await req.json().catch(() => ({}));

  try {
    if (body?.action === "change_plan") {
      const parsed = changeSubscriptionPlanSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
      }
      const subscription = await changeSubscriptionPlan({
        businessId: params.businessId,
        initiatedById: userId,
        newPlanKey: parsed.data.planKey,
        billingCycle: parsed.data.billingCycle,
      });
      return NextResponse.json({ subscription });
    }

    if (body?.action === "cancel") {
      const parsed = cancelSubscriptionSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
      }
      const subscription = await cancelSubscription({
        businessId: params.businessId,
        initiatedById: userId,
        reason: parsed.data.reason,
        immediate: body?.immediate === true,
      });
      return NextResponse.json({ subscription, scheduled: subscription.scheduled });
    }

    if (body?.action === "resume") {
      const subscription = await resumeSubscription({ businessId: params.businessId, initiatedById: userId });
      return NextResponse.json({ subscription });
    }

    return NextResponse.json({ error: "validation_error", message: "action must be 'change_plan', 'cancel' or 'resume'" }, { status: 400 });
  } catch (err) {
    if (err instanceof SubscriptionChangeError) {
      return NextResponse.json({ error: "subscription_change_failed", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
