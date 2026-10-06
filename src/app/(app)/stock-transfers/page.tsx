import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, resolveBranchScope } from "@/lib/tenant";
import { getStockTransfers } from "@/lib/stock-transfers";
import { formatDateIn, resolveTimeZone } from "@/lib/timezone";
import { isStaleTransfer } from "@/lib/stale-transfer";
import { transferHasShortfall } from "@/lib/stock-transfer-receipt";
import { transferHasOutstandingShortfall } from "@/lib/stock-transfer-recovery";
import { PageHeader } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";

// Module 55/57/65/66: a transfer's status is shown as one badge. IN_TRANSIT is
// amber, with "· Stale" appended when it is overdue for a look (stale-transfer.ts).
// RECEIVED is green; "· Short" means stock is STILL missing (Module 65/66) and
// turns it amber; "· Recovered" means it arrived short but every missing unit
// has since been recovered. CANCELLED is terminal and quiet.
function statusLabel(status: "IN_TRANSIT" | "RECEIVED" | "CANCELLED", stale: boolean, short: boolean, recovered: boolean) {
  if (status === "IN_TRANSIT") return { label: stale ? "In transit · Stale" : "In transit", tone: stale ? "danger" : "warning" };
  if (status === "CANCELLED") return { label: "Cancelled", tone: "neutral" };
  if (short) return { label: "Received · Short", tone: "warning" };
  if (recovered) return { label: "Received · Recovered", tone: "success" };
  return { label: "Received", tone: "success" };
}

// Module 28: lists stock moved between branches. Follows the same shape as
// /purchases – a plain proving-out list, no search/filter UI yet (see that
// page's own comment about the POS/UI-design pass landing that later).
export default async function StockTransfersPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;
  const tz = resolveTimeZone(membership.business.timezone);
  const branchId = resolveBranchScope(
    { businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId },
    null
  );

  const transfers = await getStockTransfers(businessId, { branchId, limit: 50 });
  // Module 58: was a shared STALE_TRANSFER_ALERT_DAYS constant, now the
  // business's own configured value.
  const staleTransferAlertDays = membership.business.staleTransferAlertDays;

  const rows = transfers.map((t) => {
    const lines = t.lines.map((l) => ({
      quantity: Number(l.quantity),
      quantityReceived: l.quantityReceived == null ? null : Number(l.quantityReceived),
      quantityRecovered: l.quantityRecovered == null ? null : Number(l.quantityRecovered),
    }));
    const stale = isStaleTransfer(t.status, t.createdAt, staleTransferAlertDays);
    const outstanding = t.status === "RECEIVED" && transferHasOutstandingShortfall(lines);
    const recovered = t.status === "RECEIVED" && transferHasShortfall(lines) && !transferHasOutstandingShortfall(lines);
    const st = statusLabel(t.status, stale, outstanding, recovered);
    return {
      id: t.id,
      href: `/stock-transfers/${t.id}`,
      number: t.transferNumber,
      from: t.fromBranch.name,
      to: t.toBranch.name,
      items: t.lines.length,
      status: st.label,
      tone: st.tone,
      date: formatDateIn(t.createdAt, tz),
      dateSort: t.createdAt.toISOString(),
    };
  });

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Stock Transfers"
        description="Stock moved between branches. The latest 50 transfers are shown."
        actions={
          <Link href="/stock-transfers/new" className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90">+ New Transfer</Link>
        }
      />
      <DataTable
        exportName="stock-transfers"
        searchPlaceholder="Search transfers…"
        rowHrefKey="href"
        emptyMessage="No stock transfers yet. Use this to move stock between branches once it's been attributed to one – see the Inventory page for what's currently attributed where."
        columns={[
          { key: "number", header: "Transfer #", hrefKey: "href", sticky: true },
          { key: "from", header: "From" },
          { key: "to", header: "To" },
          { key: "items", header: "Items", type: "number" },
          { key: "status", header: "Status", type: "badge", toneKey: "tone" },
          { key: "date", header: "Date", sortKey: "dateSort" },
        ]}
        rows={rows}
      />
    </main>
  );
}
