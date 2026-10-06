import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/erp/display";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { TaxSettingsForm } from "./tax-settings-form";

export default async function TaxSettingsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const canManage = await hasPermission(
    { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId },
    "tax.manage"
  );

  if (!canManage) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <PageHeader title="Tax Settings" />
        <p className="text-sm text-erp-muted">Your role ({membership.role}) doesn&apos;t have access to tax configuration.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-6">
      <PageHeader title="Tax Settings" description="Tax rates and registration used for VAT, PAYE, withholding, corporate tax and pension." />
      <TaxSettingsForm businessId={membership.businessId} />
    </main>
  );
}
