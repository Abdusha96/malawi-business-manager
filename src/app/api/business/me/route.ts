import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { getEffectiveSubscriptionStatus } from "@/lib/subscription";

export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const memberships = await listUserBusinesses(session.user.id);

  const businesses = await Promise.all(
    memberships.map(async (m) => {
      const subscription = await prisma.subscription.findUnique({
        where: { businessId: m.businessId },
        include: { plan: true },
      });

      return {
        businessId: m.businessId,
        name: m.business.name,
        role: m.role,
        subscription: subscription
          ? {
              plan: subscription.plan.key,
              status: subscription.status,
              // Module 26: also expose the effective status (a TRIAL past
              // trialEndsAt reads as EXPIRED) – see subscription.ts.
              effectiveStatus: getEffectiveSubscriptionStatus(subscription),
              trialEndsAt: subscription.trialEndsAt,
            }
          : null,
      };
    })
  );

  return NextResponse.json({ businesses });
}
