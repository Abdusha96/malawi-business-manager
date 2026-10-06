import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { listDebitNotes } from "@/lib/debit-notes";
import { formatDateIn, resolveTimeZone } from "@/lib/timezone";
import { PageHeader } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";

const SETTLEMENT_LABEL: Record<string, string> = {
  NONE: "Applied to balance",
  CASH: "Received in cash",
  SUPPLIER_CREDIT: "Kept as supplier credit",
};

export default async function DebitNotesPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;
  const tz = resolveTimeZone(membership.business.timezone);

  const debitNotes = await listDebitNotes(businessId, membership.branchId);

  const rows = debitNotes.map((n) => ({
    id: n.id,
    href: `/debit-notes/${n.id}`,
    purchaseHref: `/purchases/${n.purchase.id}`,
    number: n.debitNoteNumber,
    date: formatDateIn(n.issuedAt, tz),
    dateSort: n.issuedAt.toISOString(),
    purchase: n.purchase.purchaseNumber,
    supplier: n.supplier.name,
    settlement: SETTLEMENT_LABEL[n.settlement] ?? n.settlement,
    total: Number(n.total),
  }));

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Debit Notes"
        description="A debit note reverses part of a purchase – goods sent back to the supplier, a price adjustment, or both – dated today. Issue one from the purchase it debits."
      />
      <DataTable
        exportName="debit-notes"
        searchPlaceholder="Search debit notes…"
        rowHrefKey="href"
        emptyMessage="No debit notes issued yet."
        columns={[
          { key: "number", header: "Debit Note #", hrefKey: "href", sticky: true },
          { key: "date", header: "Date", sortKey: "dateSort" },
          { key: "purchase", header: "Purchase", hrefKey: "purchaseHref" },
          { key: "supplier", header: "Supplier" },
          { key: "settlement", header: "Settlement" },
          { key: "total", header: "Total", type: "money", total: true },
        ]}
        rows={rows}
      />
    </main>
  );
}
