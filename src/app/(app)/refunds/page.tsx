import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { getPendingRefunds, listRefunds } from "@/lib/refunds";
import { PageHeader } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";

const METHOD_LABEL: Record<string, string> = {
  CASH: "Cash",
  CREDIT_NOTE: "Credit Note",
  WRITE_OFF: "Write-off",
};

export default async function RefundsPage() {
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
  const canRefund = await hasPermission(membershipCtx, "refunds.manage");

  const [{ pendingSales, pendingPurchases }, refunds] = await Promise.all([
    getPendingRefunds(businessId),
    listRefunds(businessId),
  ]);

  const pendingRows = [
    ...pendingSales.map(({ sale, refundable }) => ({
      id: `s-${sale.id}`,
      docHref: `/sales/${sale.id}`,
      actionHref: canRefund ? `/refunds/new?saleId=${sale.id}` : `/sales/${sale.id}`,
      document: `${sale.saleNumber} (sale)`,
      party: sale.customer?.name ?? "Walk-in",
      unresolved: refundable,
      action: canRefund ? "Process Refund" : "View",
    })),
    ...pendingPurchases.map(({ purchase, refundable }) => ({
      id: `p-${purchase.id}`,
      docHref: `/purchases/${purchase.id}`,
      actionHref: canRefund ? `/refunds/new?purchaseId=${purchase.id}` : `/purchases/${purchase.id}`,
      document: `${purchase.purchaseNumber} (purchase)`,
      party: purchase.supplier.name,
      unresolved: refundable,
      action: canRefund ? "Process Refund" : "View",
    })),
  ];

  const historyRows = refunds.map((r) => ({
    id: r.id,
    docHref: r.sale ? `/sales/${r.sale.id}` : r.purchase ? `/purchases/${r.purchase.id}` : "",
    number: r.refundNumber,
    document: r.sale?.saleNumber ?? r.purchase?.purchaseNumber ?? "",
    party: r.sale?.customer?.name ?? r.purchase?.supplier.name ?? "",
    method: METHOD_LABEL[r.method] ?? r.method,
    amount: Number(r.amount),
    reason: r.reason ?? "",
  }));

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Refunds"
        description="Voiding never guesses whether collected money should come back as cash, become credit, or be written off. Decide it here."
      />

      <h2 className="mb-2 text-sm font-semibold text-erp-text">Awaiting a Decision</h2>
      <div className="mb-6">
        <DataTable
          exportName="refunds-awaiting-decision"
          searchPlaceholder="Search documents…"
          rowHrefKey="actionHref"
          emptyMessage="Nothing is awaiting a refund decision."
          columns={[
            { key: "document", header: "Document", hrefKey: "docHref" },
            { key: "party", header: "Party" },
            { key: "unresolved", header: "Unresolved", type: "money", total: true },
            { key: "action", header: "", hrefKey: "actionHref" },
          ]}
          rows={pendingRows}
        />
      </div>

      <h2 className="mb-2 text-sm font-semibold text-erp-text">Refund History</h2>
      <DataTable
        exportName="refund-history"
        searchPlaceholder="Search refunds…"
        emptyMessage="No refunds processed yet."
        columns={[
          { key: "number", header: "Refund #" },
          { key: "document", header: "Document", hrefKey: "docHref" },
          { key: "party", header: "Party" },
          { key: "method", header: "Method" },
          { key: "amount", header: "Amount", type: "money", total: true },
          { key: "reason", header: "Reason" },
        ]}
        rows={historyRows}
      />
    </main>
  );
}
