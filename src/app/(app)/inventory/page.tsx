import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, resolveBranchScope } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { getBranchStockList, getInTransitSummary } from "@/lib/inventory";
import { PageHeader } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";
import { PermissionGate } from "@/components/erp/permission-gate";
import { formatMoney } from "@/lib/erp/format";

// ERP list (Phase 7): DataTable over the products or the branch stock the
// page already loads. Barcode scan and a product image grid are not built.
export default async function InventoryPage(
  props: {
    searchParams: Promise<{ branch?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;
  const membershipCtx = {
    businessId,
    userId: session.user.id,
    role: membership.role,
    branchId: membership.branchId,
  };

  const branches = await prisma.branch.findMany({
    where: { businessId, isActive: true },
    orderBy: [{ isHeadOffice: "desc" }, { name: "asc" }],
    select: { id: true, name: true },
  });

  // Module 28: business-wide by default (unchanged, Product.quantity), or
  // a per-branch StockLevel breakdown when a branch is selected. A
  // branch-restricted member is always locked to their own branch's view,
  // same resolveBranchScope() pattern used for /purchases and /sales.
  const selectedBranchId = resolveBranchScope(membershipCtx, searchParams.branch ?? null);
  const branchView = selectedBranchId ? branches.find((b) => b.id === selectedBranchId) : null;

  const products = selectedBranchId
    ? []
    : await prisma.product.findMany({
        where: { businessId, isActive: true },
        include: { category: true },
        orderBy: { name: "asc" },
      });
  const branchStock = selectedBranchId ? await getBranchStockList(businessId, selectedBranchId) : [];
  // Module 56: business-wide summary only – an in-transit transfer spans two
  // branches, so it doesn't fit cleanly into either branch's own scoped view.
  const inTransit = selectedBranchId ? null : await getInTransitSummary(businessId);

  const branchRows = branchStock.map(({ product, quantity, effectiveReorderLevel, inTransitIn, inTransitOut }) => {
    const low = effectiveReorderLevel > 0 && quantity <= effectiveReorderLevel;
    const notes = [low ? "Low at this branch" : "", inTransitIn > 0 ? `+${inTransitIn} arriving` : "", inTransitOut > 0 ? `${inTransitOut} in transit out` : ""].filter(Boolean).join(" · ");
    return {
      id: product.id,
      href: `/inventory/${product.id}`,
      name: product.name,
      category: product.category?.name ?? "",
      quantity,
      unit: product.unit,
      notes,
      tone: low ? "warning" : "neutral",
    };
  });

  const productRows = products.map((p) => {
    const qty = Number(p.quantity);
    const reorder = Number(p.reorderLevel);
    // Module 77: a service has no stock, so it is never "out of stock" or "low".
    const status = !p.isStocked ? "Service" : qty <= 0 ? "Out of stock" : qty <= reorder ? "Low stock" : "In stock";
    const tone = !p.isStocked ? "neutral" : qty <= 0 ? "danger" : qty <= reorder ? "warning" : "success";
    return {
      id: p.id,
      href: `/inventory/${p.id}`,
      name: p.name,
      category: p.category?.name ?? "",
      quantity: p.isStocked ? qty : null,
      unit: p.isStocked ? p.unit : "",
      price: Number(p.sellingPrice),
      status,
      tone,
    };
  });

  const pill = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs ${active ? "bg-erp-primary text-erp-primary-fg" : "border border-erp-border hover:bg-erp-subtle"}`;

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Inventory"
        description={branchView ? `Stock at ${branchView.name}.` : "Products and business-wide stock on hand."}
        actions={
          <>
            <Link href="/stock-transfers" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">Stock Transfers</Link>
            <PermissionGate perm="inventory.manage">
              <Link href="/inventory/new" className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90">+ Add Product</Link>
            </PermissionGate>
          </>
        }
      />

      {!membership.branchId && branches.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-erp-muted">View:</span>
          <Link href="/inventory" className={pill(!selectedBranchId)}>Business-wide</Link>
          {branches.map((b) => (
            <Link key={b.id} href={`/inventory?branch=${b.id}`} className={pill(selectedBranchId === b.id)}>{b.name}</Link>
          ))}
        </div>
      )}

      {inTransit && inTransit.transferCount > 0 && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded border border-erp-info/30 bg-erp-info/10 p-3 text-sm text-erp-info">
          <span>
            {inTransit.transferCount} stock transfer{inTransit.transferCount === 1 ? "" : "s"} currently in transit –{" "}
            {inTransit.totalQuantity} units, an estimated {formatMoney(Math.round(inTransit.totalValue))}.
          </span>
          <Link href="/stock-transfers" className="whitespace-nowrap font-medium underline">View transfers</Link>
        </div>
      )}

      {selectedBranchId ? (
        <DataTable
          exportName={`stock-${branchView?.name ?? "branch"}`}
          searchPlaceholder="Search products…"
          rowHrefKey="href"
          emptyMessage={`No stock has been attributed to ${branchView?.name ?? "this branch"} yet – it only shows up here once a purchase, opening quantity, or stock transfer names this branch.`}
          columns={[
            { key: "name", header: "Product", hrefKey: "href", sticky: true },
            { key: "category", header: "Category" },
            { key: "quantity", header: `Qty at ${branchView?.name ?? "branch"}`, type: "number" },
            { key: "unit", header: "Unit" },
            { key: "notes", header: "Notes" },
          ]}
          rows={branchRows}
        />
      ) : (
        <DataTable
          exportName="inventory"
          searchPlaceholder="Search products…"
          rowHrefKey="href"
          selectable
          emptyMessage="No products yet. Add your first product to get started."
          columns={[
            { key: "name", header: "Product", hrefKey: "href", sticky: true },
            { key: "category", header: "Category" },
            { key: "quantity", header: "Qty", type: "number" },
            { key: "unit", header: "Unit", defaultHidden: true },
            { key: "price", header: "Selling Price", type: "money" },
            { key: "status", header: "Status", type: "badge", toneKey: "tone" },
          ]}
          rows={productRows}
        />
      )}
    </main>
  );
}
