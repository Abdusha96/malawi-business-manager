import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission, resolveBranchScope } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { listStockTakes } from "@/lib/stock-take";
import { BranchSwitcher } from "@/app/(app)/dashboard/branch-switcher";
import { formatDateIn, resolveTimeZone } from "@/lib/timezone";
import { PageHeader, StatusBadge } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";

export default async function StockTakePage(
  props: {
    searchParams: Promise<{ branchId?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const tz = resolveTimeZone(membership.business.timezone);
  const membershipCtx = { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId };

  const [canView, canManage] = await Promise.all([
    hasPermission(membershipCtx, "stocktake.view"),
    hasPermission(membershipCtx, "stocktake.manage"),
  ]);

  if (!canView) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <PageHeader title="Stock Take" />
        <p className="text-erp-muted">Your role ({membership.role}) doesn't have access to stock takes.</p>
      </main>
    );
  }

  // Module 31: this list previously read membership.businessId with no
  // branch filtering at all – same class of gap Module 27/29 found and
  // fixed on other list pages. A branch-restricted member now only ever
  // sees their own branch's stock takes; an unrestricted member gets the
  // BranchSwitcher (same show/hide-if-locked pattern as the dashboard).
  let branchId: string | null;
  try {
    branchId = resolveBranchScope(membershipCtx, searchParams.branchId ?? null);
  } catch {
    branchId = membershipCtx.branchId;
  }
  const branches = membership.branchId
    ? []
    : await prisma.branch.findMany({
        where: { businessId: membership.businessId, isActive: true },
        orderBy: [{ isHeadOffice: "desc" }, { name: "asc" }],
        select: { id: true, name: true },
      });

  const stockTakes = await listStockTakes(membership.businessId, branchId);
  const inProgress = stockTakes.filter((s) => s.status === "IN_PROGRESS");
  const completed = stockTakes.filter((s) => s.status === "COMPLETED");

  const completedRows = completed.map((s) => ({
    id: s.id,
    href: `/stock-take/${s.id}`,
    scope: s.category ? s.category.name : "Whole catalog",
    branch: s.branch ? s.branch.name : "Whole business",
    products: s._count.lines,
    opened: formatDateIn(s.createdAt, tz),
    openedSort: s.createdAt.toISOString(),
    completed: s.completedAt ? formatDateIn(s.completedAt, tz) : "",
    completedSort: s.completedAt ? s.completedAt.toISOString() : "",
  }));

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Stock Take"
        description="Physical counts against the books."
        actions={
          canManage && (
            <Link href="/stock-take/new" className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90">+ Start Stock Take</Link>
          )
        }
      />

      {branches.length > 0 && <BranchSwitcher branches={branches} selectedBranchId={branchId} />}

      <div className="mb-6 rounded border border-erp-warning/30 bg-erp-warning/10 p-3 text-xs text-erp-warning">
        Counted quantities are entered by hand against a physical count – there's no barcode-scanner integration
        yet. Counting regularly is what catches shrinkage, theft, or data-entry errors before they distort the
        books.
      </div>

      <h2 className="mb-2 text-sm font-semibold text-erp-text">In Progress</h2>
      {inProgress.length === 0 ? (
        <p className="mb-6 text-sm text-erp-muted">No stock take in progress.</p>
      ) : (
        <div className="mb-6 space-y-2">
          {inProgress.map((s) => (
            <Link
              key={s.id}
              href={`/stock-take/${s.id}`}
              className="flex items-center justify-between gap-3 rounded border border-erp-border bg-erp-surface p-3 text-sm shadow-sm hover:bg-erp-subtle"
            >
              <div>
                <p className="font-medium text-erp-text">
                  {s.category ? s.category.name : "Whole catalog"}
                  {s.branch ? ` · ${s.branch.name}` : ""}
                </p>
                <p className="text-erp-muted">{s._count.lines} product{s._count.lines === 1 ? "" : "s"} · Opened {formatDateIn(s.createdAt, tz)}</p>
                {s.note && <p className="text-erp-muted">{s.note}</p>}
              </div>
              <StatusBadge tone="warning">{s.reopenedAt ? "Reopened" : "In progress"}</StatusBadge>
            </Link>
          ))}
        </div>
      )}

      <h2 className="mb-2 text-sm font-semibold text-erp-text">Completed</h2>
      <DataTable
        exportName="stock-takes"
        searchPlaceholder="Search stock takes…"
        rowHrefKey="href"
        emptyMessage="No completed stock takes yet."
        columns={[
          { key: "scope", header: "Scope", hrefKey: "href" },
          { key: "branch", header: "Branch" },
          { key: "products", header: "Products", type: "number" },
          { key: "opened", header: "Opened", sortKey: "openedSort" },
          { key: "completed", header: "Completed", sortKey: "completedSort" },
        ]}
        rows={completedRows}
      />
    </main>
  );
}
