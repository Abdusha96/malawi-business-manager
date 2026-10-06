import { getServerSession } from "next-auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { getDebitNote } from "@/lib/debit-notes";
import { formatDateIn, resolveTimeZone } from "@/lib/timezone";
import { PageHeader, DetailList, NoteLinesTable, TotalsPanel } from "@/components/erp/display";

const SETTLEMENT_LABEL: Record<string, string> = {
  NONE: "Applied to the balance owed on the purchase – no cash moved.",
  CASH: "Received back in cash.",
  SUPPLIER_CREDIT: "Kept as credit on the supplier's account, for a future purchase.",
};

export default async function DebitNoteDetailPage(props: { params: Promise<{ debitNoteId: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;
  const tz = resolveTimeZone(membership.business.timezone);

  const note = await getDebitNote({ businessId, debitNoteId: params.debitNoteId });
  if (!note) notFound();
  if (membership.branchId && note.branchId !== membership.branchId) notFound();

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <PageHeader
        title={note.debitNoteNumber}
        description={formatDateIn(note.issuedAt, tz)}
        actions={
          <a
            href={`/api/business/${businessId}/debit-notes/${note.id}/pdf`}
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
          { label: "Against purchase", value: <Link href={`/purchases/${note.purchase.id}`} className="text-erp-primary hover:underline">{note.purchase.purchaseNumber}</Link> },
          { label: "Supplier", value: note.supplier.name },
          { label: "Reason", value: note.reason },
        ]}
      />

      <NoteLinesTable
        flagLabel="Sent back"
        lines={note.lines.map((line) => ({
          id: line.id,
          name: line.purchaseItem.product.name,
          quantity: Number(line.quantity),
          net: Number(line.net),
          vat: Number(line.vatAmount),
          flag: Boolean(line.stockOut),
        }))}
      />

      <TotalsPanel
        rows={[
          { label: "Net", value: Number(note.netAmount) },
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
