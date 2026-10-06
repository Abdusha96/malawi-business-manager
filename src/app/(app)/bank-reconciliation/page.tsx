import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { listBankReconciliations } from "@/lib/bank-reconciliation";
import { formatDateIn, resolveTimeZone } from "@/lib/timezone";
import { PageHeader, StatusBadge, AmountDisplay } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";

export default async function BankReconciliationPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const tz = resolveTimeZone(membership.business.timezone);
  const membershipCtx = { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId };

  const [canView, canManage] = await Promise.all([
    hasPermission(membershipCtx, "bankrecon.view"),
    hasPermission(membershipCtx, "bankrecon.manage"),
  ]);

  if (!canView) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <PageHeader title="Bank Reconciliation" />
        <p className="text-erp-muted">Your role ({membership.role}) doesn't have access to bank reconciliation.</p>
      </main>
    );
  }

  const reconciliations = await listBankReconciliations(membership.businessId);
  const inProgress = reconciliations.filter((r) => r.status === "IN_PROGRESS");
  const completed = reconciliations.filter((r) => r.status === "COMPLETED");

  const completedRows = completed.map((r) => ({
    id: r.id,
    href: `/bank-reconciliation/${r.id}`,
    account: r.account.name,
    statementDate: formatDateIn(r.statementDate, tz),
    statementSort: r.statementDate.toISOString(),
    endingBalance: r.statementEndingBalance,
    completed: r.completedAt ? formatDateIn(r.completedAt, tz) : "",
    completedSort: r.completedAt ? r.completedAt.toISOString() : "",
  }));

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader
        title="Bank Reconciliation"
        description="Match the books to the bank or mobile-money statement."
        actions={
          canManage && (
            <Link href="/bank-reconciliation/new" className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90">+ Start Reconciliation</Link>
          )
        }
      />

      <div className="mb-6 rounded border border-erp-warning/30 bg-erp-warning/10 p-3 text-xs text-erp-warning">
        Statement lines are entered by hand from the real bank/mobile-money statement – there's no automatic bank
        feed import yet. Reconciling regularly is what catches bank charges, fees, or errors that would otherwise
        go unrecorded.
      </div>

      <h2 className="mb-2 text-sm font-semibold text-erp-text">In Progress</h2>
      {inProgress.length === 0 ? (
        <p className="mb-6 text-sm text-erp-muted">No reconciliation in progress.</p>
      ) : (
        <div className="mb-6 space-y-2">
          {inProgress.map((r) => (
            <Link
              key={r.id}
              href={`/bank-reconciliation/${r.id}`}
              className="flex items-center justify-between gap-3 rounded border border-erp-border bg-erp-surface p-3 text-sm shadow-sm hover:bg-erp-subtle"
            >
              <div>
                <p className="font-medium text-erp-text">{r.account.name}</p>
                <p className="text-erp-muted">Statement date: {formatDateIn(r.statementDate, tz)}</p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <AmountDisplay value={r.statementEndingBalance} className="font-medium" />
                <StatusBadge tone="warning">{r.reopenedAt ? "Reopened" : "In progress"}</StatusBadge>
              </div>
            </Link>
          ))}
        </div>
      )}

      <h2 className="mb-2 text-sm font-semibold text-erp-text">Completed</h2>
      <DataTable
        exportName="bank-reconciliations"
        searchPlaceholder="Search reconciliations…"
        rowHrefKey="href"
        emptyMessage="No completed reconciliations yet."
        columns={[
          { key: "account", header: "Account", hrefKey: "href", sticky: true },
          { key: "statementDate", header: "Statement Date", sortKey: "statementSort" },
          { key: "endingBalance", header: "Ending Balance", type: "money" },
          { key: "completed", header: "Completed", sortKey: "completedSort" },
        ]}
        rows={completedRows}
      />
    </main>
  );
}
