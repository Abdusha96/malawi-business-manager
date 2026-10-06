import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { PageHeader, KpiCard } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";
import { formatMoney, formatNumber } from "@/lib/erp/format";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { getFixedAssetRegister } from "@/lib/fixed-assets";
import { FIXED_ASSET_CATEGORY_LABELS } from "@/lib/validation";
import { DepreciationRunButton } from "./depreciation-run-button";
import { resolveTimeZone, formatDateIn } from "@/lib/timezone";

export default async function FixedAssetsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const tz = resolveTimeZone(membership.business.timezone);
  const membershipCtx = { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId };

  const [canView, canManage] = await Promise.all([
    hasPermission(membershipCtx, "fixedassets.view"),
    hasPermission(membershipCtx, "fixedassets.manage"),
  ]);

  if (!canView) {
    return (
      <main className="mx-auto max-w-6xl p-4 sm:p-6">
        <PageHeader title="Fixed Assets" />
        <p className="text-sm text-erp-muted">Your role ({membership.role}) doesn&apos;t have access to the fixed asset register.</p>
      </main>
    );
  }

  const register = await getFixedAssetRegister(membership.businessId);
  const active = register.filter((a) => a.status === "ACTIVE");
  const disposed = register.filter((a) => a.status === "DISPOSED");

  const totalCost = active.reduce((s, a) => s + a.cost, 0);
  const totalAccumulatedDepreciation = active.reduce((s, a) => s + a.accumulatedDepreciation, 0);
  const totalNetBookValue = active.reduce((s, a) => s + a.netBookValue, 0);

  const activeRows = active.map((a) => ({
    id: a.id,
    href: `/fixed-assets/${a.id}`,
    name: a.name,
    category: FIXED_ASSET_CATEGORY_LABELS[a.category],
    acquired: formatDateIn(a.acquisitionDate, tz),
    acquiredSort: new Date(a.acquisitionDate).toISOString(),
    branch: a.branch?.name ?? "",
    cost: a.cost,
    accumulated: a.accumulatedDepreciation,
    nbv: a.netBookValue,
  }));

  const disposedRows = disposed.map((a) => ({
    id: a.id,
    href: `/fixed-assets/${a.id}`,
    name: a.name,
    category: FIXED_ASSET_CATEGORY_LABELS[a.category],
    cost: a.cost,
    disposed: a.disposalDate ? formatDateIn(a.disposalDate, tz) : "–",
    disposedSort: a.disposalDate ? new Date(a.disposalDate).toISOString() : "",
    proceeds: a.disposalProceeds !== null ? Number(a.disposalProceeds) : null,
  }));

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Fixed Assets"
        description="The register of assets the business owns, with straight-line depreciation."
        actions={
          canManage ? (
            <>
              <DepreciationRunButton businessId={membership.businessId} timeZone={tz} />
              <Link href="/fixed-assets/new" className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90">
                + Add Asset
              </Link>
            </>
          ) : undefined
        }
      />

      <div className="mb-4 rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-xs text-erp-text">
        Depreciation here is a straight-line accounting estimate from the books as recorded – it isn&apos;t a
        capital-allowance computation for MRA filing purposes (this app has no concept of disallowed expenses
        or capital allowances). An Accountant should still do the real tax adjustment schedule by hand.
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Total cost (active)" value={formatMoney(totalCost)} />
        <KpiCard label="Accumulated depreciation" value={formatMoney(totalAccumulatedDepreciation)} />
        <KpiCard label="Net book value" value={formatMoney(totalNetBookValue)} />
        <KpiCard label="Active assets" value={formatNumber(active.length)} note={`${formatNumber(disposed.length)} disposed`} />
      </div>

      <h2 className="mb-2 text-sm font-semibold text-erp-text">Active assets</h2>
      <div className="mb-6">
        <DataTable
          exportName="fixed-assets-active"
          searchPlaceholder="Search assets…"
          rowHrefKey="href"
          emptyMessage="No fixed assets recorded yet."
          columns={[
            { key: "name", header: "Asset", hrefKey: "href", sticky: true },
            { key: "category", header: "Category" },
            { key: "acquired", header: "Acquired", sortKey: "acquiredSort" },
            { key: "branch", header: "Branch", defaultHidden: true },
            { key: "cost", header: "Cost (MWK)", type: "money", total: true },
            { key: "accumulated", header: "Accum. Depreciation (MWK)", type: "money", total: true },
            { key: "nbv", header: "Net Book Value (MWK)", type: "money", total: true },
          ]}
          rows={activeRows}
        />
      </div>

      {disposed.length > 0 && (
        <>
          <h2 className="mb-2 text-sm font-semibold text-erp-text">Disposed assets</h2>
          <DataTable
            exportName="fixed-assets-disposed"
            searchPlaceholder="Search disposed assets…"
            rowHrefKey="href"
            columns={[
              { key: "name", header: "Asset", hrefKey: "href" },
              { key: "category", header: "Category" },
              { key: "cost", header: "Cost (MWK)", type: "money", total: true },
              { key: "disposed", header: "Disposed", sortKey: "disposedSort" },
              { key: "proceeds", header: "Proceeds (MWK)", type: "money", total: true },
            ]}
            rows={disposedRows}
          />
        </>
      )}
    </main>
  );
}
