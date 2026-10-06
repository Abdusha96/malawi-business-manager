import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/erp/display";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { BillingClient } from "./billing-client";
import { resolveTimeZone } from "@/lib/timezone";

// Module 26 – picks up the forward pointer left twice in Module 25's
// README ("business.subscription.manage has been an unused permission
// since plans were first modeled") and closes the "no dedicated
// billing/subscription-management page yet" known limitation.
export default async function BillingPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const canManage = await hasPermission(
    { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId },
    "business.subscription.manage"
  );

  if (!canManage) {
    return (
      <main className="mx-auto max-w-4xl p-4 sm:p-6">
        <PageHeader title="Billing" />
        <p className="text-sm text-erp-muted">Your role ({membership.role}) doesn&apos;t have access to billing and subscription management.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl p-4 sm:p-6">
      <PageHeader title="Billing & Subscription" />
      <BillingClient businessId={membership.businessId} timeZone={resolveTimeZone(membership.business.timezone)} />
    </main>
  );
}
