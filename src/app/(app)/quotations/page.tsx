import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, resolveBranchScope, hasPermission } from "@/lib/tenant";
import { listQuotations } from "@/lib/quotations";
import { formatDateIn, resolveTimeZone } from "@/lib/timezone";
import { PageHeader } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";

const TONE: Record<string, string> = {
  DRAFT: "neutral",
  SENT: "info",
  ACCEPTED: "success",
  DECLINED: "danger",
  EXPIRED: "neutral",
  CONVERTED: "info",
};

export default async function QuotationsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const tz = resolveTimeZone(membership.business.timezone);
  const membershipCtx = {
    businessId: membership.businessId,
    userId: session.user.id,
    role: membership.role,
    branchId: membership.branchId,
  };
  const canManage = await hasPermission(membershipCtx, "quotations.manage");
  const branchId = resolveBranchScope(membershipCtx, null);

  const quotations = await listQuotations({ businessId: membership.businessId, branchId });

  const rows = quotations.map((q) => ({
    id: q.id,
    href: `/quotations/${q.id}`,
    number: q.quotationNumber,
    customer: q.customer?.name ?? q.customerName ?? "",
    total: Number(q.total),
    expires: q.expiryDate ? formatDateIn(q.expiryDate, tz) : "",
    expiresSort: q.expiryDate ? q.expiryDate.toISOString() : "",
    status: q.status,
    tone: TONE[q.status] ?? "neutral",
  }));

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Quotations"
        description="Quotes sent to customers, and which have become sales."
        actions={
          canManage && (
            <Link href="/quotations/new" className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90">+ New Quotation</Link>
          )
        }
      />
      <DataTable
        exportName="quotations"
        searchPlaceholder="Search quotations…"
        rowHrefKey="href"
        emptyMessage="No quotations yet."
        columns={[
          { key: "number", header: "Quote #", hrefKey: "href", sticky: true },
          { key: "customer", header: "Customer" },
          { key: "total", header: "Total", type: "money", total: true },
          { key: "expires", header: "Expires", sortKey: "expiresSort" },
          { key: "status", header: "Status", type: "badge", toneKey: "tone" },
        ]}
        rows={rows}
      />
    </main>
  );
}
