import { getServerSession } from "next-auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { getBranchStockForProduct } from "@/lib/inventory";
import { BranchReorderLevelsForm } from "./branch-reorder-levels-form";
import { ProductKindForm } from "./product-kind-form";
import { PageHeader, KpiCard, Panel } from "@/components/erp/display";
import { formatMoney } from "@/lib/erp/format";

// Module 53 – product detail page. Didn't exist before this module (the
// inventory list was plain enough that nothing needed its own detail view);
// added now because per-branch reorder-level overrides need somewhere to
// live that isn't the business-wide product form.
export default async function ProductDetailPage(props: { params: Promise<{ productId: string }> }) {
  const params = await props.params;
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

  const product = await prisma.product.findUnique({ where: { id: params.productId } });
  if (!product || product.businessId !== businessId) notFound();

  const canManage = await hasPermission(membershipCtx, "inventory.manage");
  const branches = product.isStocked ? await getBranchStockForProduct(businessId, params.productId) : [];
  // A branch-restricted member only sees their own row here too – mirrors
  // the API route's own narrowing.
  const visibleBranches = membership.branchId
    ? branches.filter((b) => b.branch.id === membership.branchId)
    : branches;

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <PageHeader
        title={product.name}
        description={product.isStocked ? undefined : "Service – no stock"}
        actions={<Link href="/inventory" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">← Inventory</Link>}
      />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Selling Price" value={formatMoney(Number(product.sellingPrice))} />
        {product.isStocked && <KpiCard label="Quantity (business-wide)" value={`${Number(product.quantity)} ${product.unit}`} />}
        {product.isStocked && <KpiCard label="Reorder Level" value={`${Number(product.reorderLevel)} ${product.unit}`} />}
      </div>

      <ProductKindForm businessId={businessId} productId={product.id} isStocked={product.isStocked} canManage={canManage} />

      {!product.isStocked ? (
        <p className="text-sm text-erp-muted">A service has no stock, so there are no quantities or reorder levels to manage.</p>
      ) : visibleBranches.length === 0 ? (
        <p className="text-sm text-erp-muted">This business has no branches configured.</p>
      ) : (
        <Panel title="Per-branch reorder levels">
          <p className="mb-4 text-erp-muted">
            By default every branch is watched against the business-wide reorder level above. Set a number here to
            watch a specific branch against its own threshold instead – useful when one branch normally carries much
            less stock than the business as a whole. Leave it blank to go back to the business-wide level.
          </p>
          <BranchReorderLevelsForm
            businessId={businessId}
            productId={product.id}
            unit={product.unit}
            productReorderLevel={Number(product.reorderLevel)}
            canManage={canManage}
            canApplyToAll={canManage && !membership.branchId}
            branches={visibleBranches.map((b) => ({
              branchId: b.branch.id,
              branchName: b.branch.name,
              quantity: b.quantity,
              reorderLevelOverride: b.reorderLevelOverride,
              inTransitIn: b.inTransitIn,
              inTransitOut: b.inTransitOut,
            }))}
          />
        </Panel>
      )}
    </main>
  );
}
