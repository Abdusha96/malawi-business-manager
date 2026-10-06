import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { listCreditNotes } from "@/lib/credit-notes";
import { formatDateIn, resolveTimeZone } from "@/lib/timezone";
import { PageHeader } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";

const SETTLEMENT_LABEL: Record<string, string> = {
  NONE: "Applied to balance",
  CASH: "Refunded in cash",
  CUSTOMER_CREDIT: "Kept as customer credit",
};

export default async function CreditNotesPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;
  const tz = resolveTimeZone(membership.business.timezone);

  const creditNotes = await listCreditNotes(businessId, membership.branchId);

  const rows = creditNotes.map((n) => ({
    id: n.id,
    href: `/credit-notes/${n.id}`,
    saleHref: `/sales/${n.sale.id}`,
    number: n.creditNoteNumber,
    date: formatDateIn(n.issuedAt, tz),
    dateSort: n.issuedAt.toISOString(),
    sale: n.sale.saleNumber,
    customer: n.customer?.name ?? "Walk-in",
    settlement: SETTLEMENT_LABEL[n.settlement] ?? n.settlement,
    total: Number(n.total),
  }));

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Credit Notes"
        description="A credit note reverses part of a sale – a return, a price adjustment, or both – dated today. Issue one from the sale it credits."
      />
      <DataTable
        exportName="credit-notes"
        searchPlaceholder="Search credit notes…"
        rowHrefKey="href"
        emptyMessage="No credit notes issued yet."
        columns={[
          { key: "number", header: "Credit Note #", hrefKey: "href", sticky: true },
          { key: "date", header: "Date", sortKey: "dateSort" },
          { key: "sale", header: "Sale", hrefKey: "saleHref" },
          { key: "customer", header: "Customer" },
          { key: "settlement", header: "Settlement" },
          { key: "total", header: "Total", type: "money", total: true },
        ]}
        rows={rows}
      />
    </main>
  );
}
