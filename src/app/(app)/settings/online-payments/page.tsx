import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/erp/display";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { OnlinePaymentsClient } from "./online-payments-client";

// Module 74 – Owner-level: where a business enters ITS OWN PayChangu keys so customers' invoice
// payments go to the business, not the platform.
export default async function OnlinePaymentsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");
  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");
  const m = memberships[0];
  const can = await hasPermission({ businessId: m.businessId, userId: session.user.id, role: m.role, branchId: m.branchId }, "business.settings.manage");
  if (!can) {
    return (
      <main className="mx-auto max-w-3xl p-4 sm:p-6">
        <PageHeader title="Online Payments" />
        <p className="text-sm text-erp-muted">Your role ({m.role}) can&apos;t change these settings.</p>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <PageHeader title="Online Payments" description="Let customers pay your invoices by Airtel Money, TNM Mpamba or card through a link. The money goes to your own PayChangu account." />
      <OnlinePaymentsClient businessId={m.businessId} />
    </main>
  );
}
