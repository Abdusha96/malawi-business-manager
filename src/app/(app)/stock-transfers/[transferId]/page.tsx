import { getServerSession } from "next-auth";
import { redirect, notFound } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { getStockTransfer } from "@/lib/stock-transfers";
import { resolveTimeZone } from "@/lib/timezone";
import { StockTransferWorkspace } from "./stock-transfer-workspace";

// Module 55: this page used to render everything itself (no action needed
// once a transfer was immediate/final by design). Now that a transfer can
// sit IN_TRANSIT awaiting receipt or cancellation, the interactive parts
// live in a client workspace component – same split every other
// action-bearing detail page in this app (Bank Reconciliation, Stock Take)
// already uses.
export default async function StockTransferDetailPage(props: { params: Promise<{ transferId: string }> }) {
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

  const [canView, canManage] = await Promise.all([
    hasPermission(membershipCtx, "inventory.view"),
    hasPermission(membershipCtx, "inventory.manage"),
  ]);

  if (!canView) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <h1 className="mb-2 text-2xl font-bold">Stock Transfer</h1>
        <p className="text-erp-muted">Your role ({membership.role}) doesn't have access to stock transfers.</p>
      </main>
    );
  }

  const transfer = await getStockTransfer(businessId, params.transferId);
  if (!transfer) notFound();

  // A branch-restricted member can only view a transfer touching their own
  // branch – same check the GET route enforces server-side.
  if (
    membership.branchId &&
    transfer.fromBranchId !== membership.branchId &&
    transfer.toBranchId !== membership.branchId
  ) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <h1 className="mb-2 text-2xl font-bold">Stock Transfer</h1>
        <p className="text-erp-muted">This transfer doesn't touch your branch.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-6">
      <StockTransferWorkspace
        businessId={businessId}
        transferId={params.transferId}
        canManage={canManage}
        ownBranchId={membership.branchId}
        timeZone={resolveTimeZone(membership.business.timezone)}
        staleTransferAlertDays={membership.business.staleTransferAlertDays}
      />
    </main>
  );
}
