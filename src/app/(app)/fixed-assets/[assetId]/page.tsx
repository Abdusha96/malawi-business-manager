import { getServerSession } from "next-auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { PageHeader, KpiCard, DetailList, Panel, StatusBadge } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";
import { formatMoney } from "@/lib/erp/format";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { getAccumulatedDepreciation, computeAnnualDepreciation, computeMonthlyDepreciation } from "@/lib/fixed-assets";
import { FIXED_ASSET_CATEGORY_LABELS } from "@/lib/validation";
import { DisposeAssetForm } from "./dispose-form";
import { resolveTimeZone, formatDateIn } from "@/lib/timezone";

export default async function FixedAssetDetailPage(props: { params: Promise<{ assetId: string }> }) {
  const params = await props.params;
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

  // Phase 13: the register list already required fixedassets.view; the detail page did not
  // (only the API did), so a member without it could open an asset by URL. Same check now.
  if (!canView) {
    return (
      <main className="mx-auto max-w-4xl p-4 sm:p-6">
        <PageHeader title="Fixed Asset" />
        <p className="text-sm text-erp-muted">Your role ({membership.role}) doesn&apos;t have access to the fixed asset register.</p>
      </main>
    );
  }

  const asset = await prisma.fixedAsset.findUnique({
    where: { id: params.assetId },
    include: { branch: { select: { name: true } }, supplier: { select: { name: true } } },
  });
  if (!asset || asset.businessId !== membership.businessId) notFound();

  const accumulatedDepreciation = await getAccumulatedDepreciation(membership.businessId, asset.id);
  const netBookValue = Math.round((Number(asset.cost) - accumulatedDepreciation) * 100) / 100;

  const depreciationHistory = await prisma.journalEntry.findMany({
    where: { businessId: membership.businessId, referenceType: "Depreciation", referenceId: { startsWith: `${asset.id}:` } },
    include: { lines: true },
    orderBy: { entryDate: "asc" },
  });

  const historyRows = depreciationHistory.map((e) => ({
    id: e.id,
    period: e.referenceId?.split(":")[1] ?? "",
    entry: e.entryNumber,
    amount: Number(e.lines.find((l) => Number(l.debit) > 0)?.debit ?? 0),
  }));

  const isActive = asset.status === "ACTIVE";

  return (
    <main className="mx-auto max-w-4xl p-4 sm:p-6">
      <PageHeader
        title={asset.name}
        description={FIXED_ASSET_CATEGORY_LABELS[asset.category]}
        actions={
          <>
            <StatusBadge tone={isActive ? "success" : "neutral"}>{isActive ? "Active" : "Disposed"}</StatusBadge>
            <Link href="/fixed-assets" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">
              Back to register
            </Link>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiCard label="Cost" value={formatMoney(Number(asset.cost))} />
        <KpiCard label="Accumulated depreciation" value={formatMoney(accumulatedDepreciation)} />
        <KpiCard label="Net book value" value={formatMoney(netBookValue)} />
      </div>

      <DetailList
        items={[
          { label: "Acquired", value: formatDateIn(asset.acquisitionDate, tz) },
          { label: "Residual value", value: formatMoney(Number(asset.residualValue)) },
          { label: "Useful life", value: asset.usefulLifeYears ? `${asset.usefulLifeYears} years` : "Not depreciated" },
          { label: "Annual depreciation", value: formatMoney(computeAnnualDepreciation(asset)) },
          { label: "Monthly depreciation", value: formatMoney(computeMonthlyDepreciation(asset)) },
          { label: "Paid via", value: asset.paymentMethod.replace("_", " ") },
          { label: "Branch", value: asset.branch?.name },
          { label: "Supplier", value: asset.supplier?.name },
          { label: "Description", value: asset.description },
          { label: "Notes", value: asset.notes },
        ]}
      />

      {!isActive && (
        <Panel title="Disposal">
          <DetailListInline
            items={[
              { label: "Disposed on", value: asset.disposalDate ? formatDateIn(asset.disposalDate, tz) : "–" },
              { label: "Proceeds", value: formatMoney(asset.disposalProceeds !== null ? Number(asset.disposalProceeds) : 0) },
              { label: "Notes", value: asset.disposalNotes },
            ]}
          />
        </Panel>
      )}

      <h2 className="mb-2 text-sm font-semibold text-erp-text">Depreciation history</h2>
      <div className="mb-4">
        <DataTable
          exportName={`depreciation-${asset.id}`}
          searchPlaceholder="Search periods…"
          pageSize={12}
          emptyMessage="No depreciation posted yet."
          columns={[
            { key: "period", header: "Period" },
            { key: "entry", header: "Journal entry" },
            { key: "amount", header: "Amount (MWK)", type: "money", total: true },
          ]}
          rows={historyRows}
        />
      </div>

      {canManage && isActive && <DisposeAssetForm businessId={membership.businessId} assetId={asset.id} timeZone={tz} />}
    </main>
  );
}

/** Label/value rows inside a Panel (DetailList brings its own border, which would double up here). */
function DetailListInline({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      {items
        .filter((i) => i.value !== null && i.value !== undefined && i.value !== false && i.value !== "")
        .map((i) => (
          <div key={i.label} className="flex gap-2">
            <dt className="w-32 shrink-0 text-erp-muted">{i.label}</dt>
            <dd className="min-w-0 break-words text-erp-text">{i.value}</dd>
          </div>
        ))}
    </dl>
  );
}
