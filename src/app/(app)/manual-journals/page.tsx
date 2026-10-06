import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { listManualJournals } from "@/lib/manual-journal";
import { resolveTimeZone, formatDateIn } from "@/lib/timezone";
import { PageHeader } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";

export default async function ManualJournalsPage(props: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const searchParams = await props.searchParams;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const ctx = { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId };
  const [canView, canManage] = await Promise.all([hasPermission(ctx, "accounting.view"), hasPermission(ctx, "accounting.manage")]);

  if (!canView) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <PageHeader title="Journal Entries" />
        <p className="text-erp-muted">Your role ({membership.role}) doesn't have access to journal entries.</p>
      </main>
    );
  }

  const tz = resolveTimeZone(membership.business.timezone);
  const status = searchParams.status === "RECORDED" || searchParams.status === "VOIDED" ? searchParams.status : undefined;
  const journals = await listManualJournals(membership.businessId, { status, q: searchParams.q });
  const filterLink = (label: string, value?: string) => (
    <Link
      href={value ? `/manual-journals?status=${value}` : "/manual-journals"}
      className={status === value ? "rounded-full bg-erp-primary px-3 py-1 text-xs text-erp-primary-fg" : "rounded-full border border-erp-border px-3 py-1 text-xs hover:bg-erp-subtle"}
    >
      {label}
    </Link>
  );

  const rows = journals.map((j) => ({
    id: j.id,
    href: `/manual-journals/${j.id}`,
    number: j.journalNumber,
    date: formatDateIn(j.entryDate, tz),
    dateSort: j.entryDate.toISOString(),
    narration: j.description,
    document: j.documentRef ?? "",
    amount: Number(j.totalAmount),
    status: j.status === "VOIDED" ? "Voided" : "Recorded",
    tone: j.status === "VOIDED" ? "neutral" : "success",
  }));

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Journal Entries"
        description="Adjusting entries posted by hand."
        actions={
          <>
            <Link href="/accounting" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">Accounting</Link>
            {canManage && !membership.branchId && (
              <Link href="/manual-journals/new" className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90">+ New Journal Entry</Link>
            )}
          </>
        }
      />

      <div className="mb-4 rounded border border-erp-warning/30 bg-erp-warning/10 p-3 text-xs text-erp-warning">
        These are adjusting entries an Accountant posts by hand, for things the app does not post on its own: booking the
        company income tax charge, correcting a mis-posted expense, recording a loan or owner's drawings. Cash, bank,
        receivables, payables and inventory can't be used here because the app computes them from their own records. An
        entry can't be edited. Void it and post a corrected one.
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {filterLink("All")}
        {filterLink("Recorded", "RECORDED")}
        {filterLink("Voided", "VOIDED")}
        <form action="/manual-journals" className="ml-auto flex gap-2">
          {status && <input type="hidden" name="status" value={status} />}
          <input name="q" aria-label="Search journals" defaultValue={searchParams.q ?? ""} placeholder="Search number, narration, document" className="erp-input w-64" />
          <button className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">Search</button>
        </form>
      </div>

      <DataTable
        exportName="journal-entries"
        searchPlaceholder="Filter these rows…"
        rowHrefKey="href"
        emptyMessage="No journal entries found."
        columns={[
          { key: "number", header: "Journal #", hrefKey: "href", sticky: true },
          { key: "date", header: "Date", sortKey: "dateSort" },
          { key: "narration", header: "Narration" },
          { key: "document", header: "Document" },
          { key: "amount", header: "Amount", type: "money", total: true },
          { key: "status", header: "Status", type: "badge", toneKey: "tone" },
        ]}
        rows={rows}
      />
    </main>
  );
}
