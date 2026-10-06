import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { getServiceCostClearing } from "@/lib/service-cost-clearing-run";
import { describeClearingState, fromTambala } from "@/lib/service-cost-clearing";
import { resolveTimeZone, formatDateTimeIn } from "@/lib/timezone";
import { ClearingWorkspace, type ClearingRowView, type SettlementView } from "./clearing-workspace";

// Module 79. Business-wide: the GL has no branch dimension, so a branch-restricted member can look but not settle.
export default async function ServiceCostClearingPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const ctx = { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId };
  const [canView, canManage] = await Promise.all([hasPermission(ctx, "accounting.view"), hasPermission(ctx, "accounting.manage")]);

  if (!canView) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <h1 className="mb-2 text-2xl font-bold">Service Cost Clearing</h1>
        <p className="text-erp-muted">Your role ({membership.role}) doesn't have access to accounting records.</p>
      </main>
    );
  }

  const tz = resolveTimeZone(membership.business.timezone);
  const { report, settlements, alertDays } = await getServiceCostClearing(membership.businessId);

  const rows: ClearingRowView[] = report.rows.map((r) => ({
    productId: r.productId,
    name: r.name,
    sku: r.sku ?? null,
    billed: fromTambala(r.billed - r.debited),
    recognised: fromTambala(r.recognised),
    settled: fromTambala(r.costUp - r.costDown),
    balance: fromTambala(r.balance),
    ageDays: r.ageDays,
    aged: r.aged,
    state: r.state,
    stateLabel: describeClearingState(r.state),
  }));
  const settlementViews: SettlementView[] = settlements.map((s) => ({
    id: s.id,
    productName: s.productName,
    summary: s.summary,
    amount: s.amount,
    reason: s.reason,
    status: s.status,
    createdAt: formatDateTimeIn(s.createdAt, tz),
    voidedAt: s.voidedAt ? formatDateTimeIn(s.voidedAt, tz) : null,
    voidReason: s.voidReason,
  }));

  return (
    <main className="mx-auto max-w-5xl p-6 sm:p-4 sm:p-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Service Cost Clearing</h1>
        <div className="flex gap-3">
          <Link href="/accounting" className="rounded border border-erp-border px-4 py-2 hover:bg-erp-subtle">Accounting</Link>
          <Link href="/manual-journals" className="rounded border border-erp-border px-4 py-2 hover:bg-erp-subtle">Journal Entries</Link>
        </div>
      </div>

      <ClearingWorkspace
        businessId={membership.businessId}
        rows={rows}
        settlements={settlementViews}
        ledgerBalance={fromTambala(report.ledgerBalance)}
        unattributed={fromTambala(report.unattributed)}
        unattributedKind={report.unattributedKind}
        unattributedNote={report.unattributedNote}
        openCount={report.openCount}
        agedCount={report.agedCount}
        alertDays={alertDays}
        canSettle={canManage && !membership.branchId}
      />
    </main>
  );
}
