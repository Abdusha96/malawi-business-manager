import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { OpenReconciliationForm } from "./open-reconciliation-form";
import { resolveTimeZone } from "@/lib/timezone";
import { PageHeader } from "@/components/erp/display";

export default async function NewBankReconciliationPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  return (
    <main className="mx-auto max-w-lg p-4 sm:p-6">
      <PageHeader title="Start a Bank Reconciliation" />
      <OpenReconciliationForm businessId={memberships[0].businessId} timeZone={resolveTimeZone(memberships[0].business.timezone)} />
    </main>
  );
}
