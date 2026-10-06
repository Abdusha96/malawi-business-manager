import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { PageHeader, KpiCard, Field } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";
import { formatNumber } from "@/lib/erp/format";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { resolveTimeZone, formatDateTimeIn } from "@/lib/timezone";
import { parseDateInput } from "@/lib/date-range";
import {
  AUDIT_TRAIL_LIMIT,
  auditArea,
  auditAreaLabel,
  auditVerbLabel,
  listAuditAreas,
  listAuditTrail,
  summariseMetadata,
} from "@/lib/audit-trail";

export default async function AuditTrailPage(
  props: {
    searchParams: Promise<{ from?: string; to?: string; area?: string; user?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;
  const ctx = { businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId };

  if (!(await hasPermission(ctx, "audit.view"))) {
    return (
      <main className="mx-auto max-w-6xl p-4 sm:p-6">
        <PageHeader title="Audit Trail" />
        <p className="text-sm text-erp-muted">Your role ({membership.role}) doesn&apos;t have access to the audit trail.</p>
      </main>
    );
  }

  const tz = resolveTimeZone(membership.business.timezone);

  // A bad date in the URL is ignored (no filter) and said so, rather than silently returning nothing.
  const fromRaw = searchParams.from?.trim() ?? "";
  const toRaw = searchParams.to?.trim() ?? "";
  const from = fromRaw ? parseDateInput(fromRaw, "start", tz) : null;
  const to = toRaw ? parseDateInput(toRaw, "end", tz) : null;
  const badDate = (fromRaw && !from) || (toRaw && !to);

  const [areas, members] = await Promise.all([
    listAuditAreas(businessId),
    prisma.businessMember.findMany({
      where: { businessId },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { invitedAt: "asc" },
    }),
  ]);

  const area = areas.some((a) => a.value === searchParams.area) ? searchParams.area : undefined;
  const userId = members.some((m) => m.user.id === searchParams.user) ? searchParams.user : undefined;

  const { rows: logs, capped } = await listAuditTrail(businessId, {
    from: from ?? undefined,
    to: to ?? undefined,
    area,
    userId,
  });

  const people = new Set(logs.map((l) => l.userId).filter(Boolean)).size;

  const rows = logs.map((l) => ({
    id: l.id,
    when: formatDateTimeIn(l.createdAt, tz),
    whenSort: l.createdAt.toISOString(),
    who: l.user?.name ?? "System",
    area: auditAreaLabel(auditArea(l.action)),
    action: auditVerbLabel(l.action),
    record: l.entityType ? `${l.entityType}${l.entityId ? ` · ${l.entityId.slice(-8)}` : ""}` : "",
    details: summariseMetadata(l.metadata),
    code: l.action,
  }));

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader title="Audit Trail" description="Who created, changed, voided or deleted financial records, and when. Read-only." />

      <form action="/audit-trail" className="mb-4 grid grid-cols-1 gap-3 rounded border border-erp-border bg-erp-surface p-3 shadow-sm sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
        <Field label="From" htmlFor="at-from">
          <input id="at-from" name="from" type="date" defaultValue={fromRaw} className="erp-input" />
        </Field>
        <Field label="To" htmlFor="at-to">
          <input id="at-to" name="to" type="date" defaultValue={toRaw} className="erp-input" />
        </Field>
        <Field label="Area" htmlFor="at-area">
          <select id="at-area" name="area" defaultValue={area ?? ""} className="erp-input">
            <option value="">All areas</option>
            {areas.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Person" htmlFor="at-user">
          <select id="at-user" name="user" defaultValue={userId ?? ""} className="erp-input">
            <option value="">Everyone</option>
            {members.map((m) => (
              <option key={m.user.id} value={m.user.id}>{m.user.name}</option>
            ))}
          </select>
        </Field>
        <div className="flex gap-2">
          <button className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90">Apply</button>
          <a href="/audit-trail" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">Clear</a>
        </div>
      </form>

      {badDate && (
        <p role="alert" className="mb-4 rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-sm text-erp-text">
          A date in the filter wasn&apos;t a valid date, so it was ignored.
        </p>
      )}

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiCard label="Events shown" value={formatNumber(logs.length)} note={capped ? `Newest ${formatNumber(AUDIT_TRAIL_LIMIT)} only` : undefined} />
        <KpiCard label="People involved" value={formatNumber(people)} />
        <KpiCard label="Latest event" value={logs[0] ? formatDateTimeIn(logs[0].createdAt, tz) : "–"} />
      </div>

      {capped && (
        <p className="mb-4 rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-xs text-erp-text">
          More than {formatNumber(AUDIT_TRAIL_LIMIT)} events match, so only the newest {formatNumber(AUDIT_TRAIL_LIMIT)} are listed. Narrow the dates, area or person to see older activity.
        </p>
      )}

      <DataTable
        exportName="audit-trail"
        searchPlaceholder="Search the events shown…"
        pageSize={50}
        emptyMessage="No audit events match this filter."
        columns={[
          { key: "when", header: "When", sortKey: "whenSort", sticky: true },
          { key: "who", header: "Who" },
          { key: "area", header: "Area" },
          { key: "action", header: "Action" },
          { key: "record", header: "Record" },
          { key: "details", header: "Details" },
          { key: "code", header: "Action code", defaultHidden: true },
        ]}
        rows={rows}
      />
      <p className="mt-2 text-[11px] text-erp-muted">
        Times are shown in the business time zone. Only this business&apos;s events appear. Questions typed to Mobi Accountant are not listed here, and the Record column shows the last 8 characters of the record&apos;s id.
      </p>
    </main>
  );
}
