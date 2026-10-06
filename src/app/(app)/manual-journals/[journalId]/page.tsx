import { getServerSession } from "next-auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { getManualJournal } from "@/lib/manual-journal";
import { VoidManualJournalForm } from "./void-form";
import { resolveTimeZone, formatDateIn, formatDateTimeIn } from "@/lib/timezone";
import { PageHeader, StatusBadge, DetailList, AmountDisplay } from "@/components/erp/display";

type EntryView = NonNullable<Awaited<ReturnType<typeof getManualJournal>>>["entry"];

function LinesTable({ title, entry, tz }: { title: string; entry: EntryView; tz: string }) {
  if (!entry) return null;
  const totalDebit = entry.lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = entry.lines.reduce((s, l) => s + l.credit, 0);
  const th = "border-b border-erp-border px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-erp-muted";
  const td = "border-b border-erp-border px-2.5 py-1";
  return (
    <div className="mb-6">
      <h2 className="mb-2 text-sm font-semibold text-erp-text">
        {title} <span className="font-normal text-erp-muted">({entry.entryNumber}, {formatDateIn(entry.entryDate, tz)})</span>
      </h2>
      <div className="overflow-auto rounded border border-erp-border bg-erp-surface shadow-sm">
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead className="bg-erp-subtle">
            <tr>
              <th scope="col" className={`${th} text-left`}>Account</th>
              <th scope="col" className={`${th} text-left`}>Note</th>
              <th scope="col" className={`${th} text-right`}>Debit</th>
              <th scope="col" className={`${th} text-right`}>Credit</th>
            </tr>
          </thead>
          <tbody>
            {entry.lines.map((l, i) => (
              <tr key={i} className="hover:bg-erp-subtle/60">
                <td className={td}>{l.accountCode} {l.accountName}</td>
                <td className={`${td} text-erp-muted`}>{l.memo ?? ""}</td>
                <td className={`${td} text-right`}>{l.debit > 0 ? <AmountDisplay value={l.debit} bare /> : ""}</td>
                <td className={`${td} text-right`}>{l.credit > 0 ? <AmountDisplay value={l.credit} bare /> : ""}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-erp-subtle font-semibold">
              <td className="px-2.5 py-1.5" colSpan={2}>Total</td>
              <td className="px-2.5 py-1.5 text-right"><AmountDisplay value={totalDebit} bare /></td>
              <td className="px-2.5 py-1.5 text-right"><AmountDisplay value={totalCredit} bare /></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

export default async function ManualJournalDetailPage(props: { params: Promise<{ journalId: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const tz = resolveTimeZone(membership.business.timezone);
  const ctx = { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId };
  const [canView, canManage] = await Promise.all([hasPermission(ctx, "accounting.view"), hasPermission(ctx, "accounting.manage")]);
  if (!canView) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <p className="text-sm text-erp-danger">Your role does not have access to journal entries.</p>
      </main>
    );
  }

  const result = await getManualJournal({ businessId: membership.businessId, journalId: params.journalId });
  if (!result) notFound();
  const { journal, entry, reversal } = result;

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <PageHeader
        title={journal.journalNumber}
        description={journal.description}
        actions={
          <>
            {journal.status === "VOIDED" && <StatusBadge tone="neutral">Voided</StatusBadge>}
            <Link href="/manual-journals" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">← Journal Entries</Link>
          </>
        }
      />

      <DetailList
        items={[
          { label: "Date", value: formatDateIn(journal.entryDate, tz) },
          { label: "Total", value: <AmountDisplay value={Number(journal.totalAmount)} currency={membership.business.currency} /> },
          { label: "Supporting document", value: journal.documentRef },
          { label: "Notes", value: journal.notes },
          { label: "Posted", value: formatDateTimeIn(journal.createdAt, tz) },
          { label: "Voided", value: journal.status === "VOIDED" ? (journal.voidedAt ? formatDateTimeIn(journal.voidedAt, tz) : "–") : null },
          { label: "Reason", value: journal.status === "VOIDED" ? (journal.voidReason ?? "–") : null },
        ]}
      />

      <LinesTable title="Ledger entry" entry={entry} tz={tz} />
      <LinesTable title="Reversal" entry={reversal} tz={tz} />

      {journal.status === "RECORDED" && canManage && !membership.branchId && (
        <VoidManualJournalForm businessId={membership.businessId} journalId={journal.id} />
      )}
    </main>
  );
}
