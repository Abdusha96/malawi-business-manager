import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { listForeignExchangeAdjustments, summariseAdjustments } from "@/lib/foreign-exchange";
import { getSettlementFxSummary } from "@/lib/foreign-settlement";
import { resolveTimeZone, formatDateIn } from "@/lib/timezone";
import { PageHeader, KpiCard } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";

function fmt(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function signed(n: number) {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmt(Math.abs(n))}`;
}

export default async function FxAdjustmentsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const ctx = { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId };
  const [canView, canManage] = await Promise.all([hasPermission(ctx, "forex.view"), hasPermission(ctx, "forex.manage")]);

  if (!canView) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <PageHeader title="Foreign Exchange" />
        <p className="text-erp-muted">Your role ({membership.role}) doesn't have access to foreign exchange gains and losses.</p>
      </main>
    );
  }

  const tz = resolveTimeZone(membership.business.timezone);
  const adjustments = await listForeignExchangeAdjustments(membership.businessId);
  const totals = summariseAdjustments(adjustments);
  const settlements = await getSettlementFxSummary(membership.businessId);

  const kpiTone = (n: number) => (n > 0 ? "good" : n < 0 ? "bad" : undefined);
  const tone = (n: number) => (n > 0 ? "text-erp-success" : n < 0 ? "text-erp-danger" : "");

  const rows = adjustments.map((a) => ({
    id: a.id,
    href: `/fx-adjustments/${a.id}`,
    number: a.adjustmentNumber,
    date: formatDateIn(a.adjustmentDate, tz),
    dateSort: a.adjustmentDate.toISOString(),
    type: a.kind === "REALISED" ? "Realised" : "Unrealised",
    currency: a.currencyCode,
    account: a.account.name,
    amount: Number(a.gainLossAmount),
    status: a.status === "VOIDED" ? "Voided" : "Recorded",
    tone: a.status === "VOIDED" ? "neutral" : "success",
  }));
  const cur = membership.business.currency;

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Foreign Exchange Gains & Losses"
        actions={
          <>
            <Link href="/accounting" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">Accounting</Link>
            {canManage && (
              <Link href="/fx-adjustments/new" className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90">+ Record Adjustment</Link>
            )}
          </>
        }
      />

      <p className="mb-4 text-sm text-erp-muted">
        Also booked automatically when foreign-currency invoices were paid ({settlements.count} payment{settlements.count === 1 ? "" : "s"}):{" "}
        <span className={`font-medium ${tone(settlements.net)}`}>{cur} {signed(settlements.net)}</span>
        {" "}net (gains {fmt(settlements.gains)}, losses {fmt(settlements.losses)}). These are already in the totals on the Profit &amp; Loss, not in the cards below.
      </p>

      <div className="mb-4 rounded border border-erp-warning/30 bg-erp-warning/10 p-3 text-xs text-erp-warning">
        Your books are kept in {cur}. This page records the {cur} difference
        when the exchange rate changes the value of foreign currency you hold in a cash, bank or mobile-money account. It
        does not hold foreign-currency balances or convert transactions, and a foreign-currency invoice is settled on the
        sale or purchase itself, not here. Rates are what you enter – nothing is fetched.
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiCard label="Realised (net, all recorded)" value={`${cur} ${signed(totals.realisedNet)}`} tone={kpiTone(totals.realisedNet)} />
        <KpiCard label="Unrealised (net, all recorded)" value={`${cur} ${signed(totals.unrealisedNet)}`} tone={kpiTone(totals.unrealisedNet)} />
        <KpiCard label="Total gain / (loss)" value={`${cur} ${signed(totals.net)}`} tone={kpiTone(totals.net)} />
      </div>

      <DataTable
        exportName="fx-adjustments"
        searchPlaceholder="Search adjustments…"
        rowHrefKey="href"
        emptyMessage="No exchange adjustments recorded yet."
        columns={[
          { key: "number", header: "Adjustment #", hrefKey: "href", sticky: true },
          { key: "date", header: "Date", sortKey: "dateSort" },
          { key: "type", header: "Type" },
          { key: "currency", header: "Currency" },
          { key: "account", header: "Account" },
          { key: "amount", header: "Gain / (loss)", type: "money", total: true },
          { key: "status", header: "Status", type: "badge", toneKey: "tone" },
        ]}
        rows={rows}
      />
    </main>
  );
}
