import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { AccountingHub } from "./accounting-hub";
import { resolveTimeZone } from "@/lib/timezone";
import Link from "next/link";
import { PageHeader } from "@/components/erp/display";

export default async function AccountingPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const membershipCtx = { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId };
  const [canView, canRecordTaxPayments, canManageAccounts] = await Promise.all([
    hasPermission(membershipCtx, "accounting.view"),
    hasPermission(membershipCtx, "taxpayments.manage"),
    hasPermission(membershipCtx, "accounting.manage"),
  ]);

  if (!canView) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <PageHeader title="Accounting" />
        <p className="text-erp-muted">Your role ({membership.role}) doesn't have access to accounting records.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Accounting"
        description="Ledger, chart of accounts and tax calendar."
        actions={
          <>
            <Link href="/period-close" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">Period Close</Link>
            <Link href="/manual-journals" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">Journal Entries</Link>
            <Link href="/service-cost-clearing" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">Service Cost Clearing</Link>
          </>
        }
      />
      <AccountingHub
        businessId={membership.businessId}
        timeZone={resolveTimeZone(membership.business.timezone)}
        canRecordTaxPayments={canRecordTaxPayments}
        canManageAccounts={canManageAccounts && (membership.role === "OWNER" || !membership.branchId)}
      />
    </main>
  );
}
