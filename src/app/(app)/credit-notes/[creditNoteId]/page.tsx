import { getServerSession } from "next-auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { getCreditNote } from "@/lib/credit-notes";
import { formatDateIn, resolveTimeZone } from "@/lib/timezone";
import { PageHeader, DetailList, NoteLinesTable, TotalsPanel } from "@/components/erp/display";

const SETTLEMENT_LABEL: Record<string, string> = {
  NONE: "Applied to the balance owed on the sale – no cash moved.",
  CASH: "Refunded in cash.",
  CUSTOMER_CREDIT: "Kept as credit on the customer's account, for a future sale.",
};

export default async function CreditNoteDetailPage(props: { params: Promise<{ creditNoteId: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;
  const tz = resolveTimeZone(membership.business.timezone);

  const note = await getCreditNote({ businessId, creditNoteId: params.creditNoteId });
  if (!note) notFound();
  if (membership.branchId && note.branchId !== membership.branchId) notFound();

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <PageHeader
        title={note.creditNoteNumber}
        description={formatDateIn(note.issuedAt, tz)}
        actions={
          <a
            href={`/api/business/${businessId}/credit-notes/${note.id}/pdf`}
            target="_blank"
            rel="noreferrer"
            className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle"
          >
            PDF
          </a>
        }
      />

      <DetailList
        items={[
          { label: "Against sale", value: <Link href={`/sales/${note.sale.id}`} className="text-erp-primary hover:underline">{note.sale.saleNumber}</Link> },
          { label: "Customer", value: note.customer?.name ?? "Walk-in" },
          { label: "Reason", value: note.reason },
        ]}
      />

      <NoteLinesTable
        flagLabel="Restocked"
        lines={note.lines.map((line) => ({
          id: line.id,
          name: line.saleItem.product.name,
          quantity: Number(line.quantity),
          net: Number(line.net),
          vat: Number(line.vatAmount),
          flag: Boolean(line.restock),
        }))}
      />

      <TotalsPanel
        rows={[
          { label: "Net (after discount share)", value: Number(note.netAmount) },
          { label: "VAT", value: Number(note.vatAmount) },
          { label: "Total", value: Number(note.total), strong: true },
          { label: "Applied to balance owed", value: Number(note.appliedToBalance) },
          ...(Number(note.settledAmount) > 0 ? [{ label: "Settled amount", value: Number(note.settledAmount) }] : []),
        ]}
      />
      <p className="-mt-4 text-xs text-erp-muted">{SETTLEMENT_LABEL[note.settlement]}</p>
    </main>
  );
}
