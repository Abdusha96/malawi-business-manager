import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { PageHeader, FormCard } from "@/components/erp/display";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { NewFixedAssetForm } from "./fixed-asset-form";
import { resolveTimeZone } from "@/lib/timezone";

export default async function NewFixedAssetPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const ctx = { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId };

  // Phase 13: the API already refuses without fixedassets.manage; the page now says so up front
  // instead of showing a form that can only fail on save.
  if (!(await hasPermission(ctx, "fixedassets.manage"))) {
    return (
      <main className="mx-auto max-w-2xl p-4 sm:p-6">
        <PageHeader title="Record a Fixed Asset" />
        <p className="text-sm text-erp-muted">Your role ({membership.role}) can&apos;t record fixed assets.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-6">
      <PageHeader title="Record a Fixed Asset" description="Posts the purchase to the books at the cost and payment method you choose." />
      <FormCard>
        <NewFixedAssetForm businessId={membership.businessId} timeZone={resolveTimeZone(membership.business.timezone)} />
      </FormCard>
    </main>
  );
}
