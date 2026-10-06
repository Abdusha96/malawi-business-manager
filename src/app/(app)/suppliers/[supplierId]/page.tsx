import { getServerSession } from "next-auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { getSupplierSummary } from "@/lib/suppliers";
import { getSupplierCreditSummary } from "@/lib/credits";
import { RecordSupplierPaymentForm } from "./record-payment-form";
import { ApplySupplierCreditForm } from "./apply-credit-form";
import { formatDateIn, resolveTimeZone } from "@/lib/timezone";
import { PhoneHint } from "@/components/phone-hint";
import { SendNoticeButton } from "@/components/send-notice-button";
import { PageHeader, KpiCard, AmountDisplay } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";
import { PermissionGate } from "@/components/erp/permission-gate";
import { formatMoney } from "@/lib/erp/format";

export default async function SupplierProfilePage(props: { params: Promise<{ supplierId: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const businessId = memberships[0].businessId;
  const tz = resolveTimeZone(memberships[0].business.timezone);
  const supplier = await prisma.supplier.findUnique({ where: { id: params.supplierId } });
  if (!supplier || supplier.businessId !== businessId) notFound();

  const [summary, purchases, payments, creditSummary] = await Promise.all([
    getSupplierSummary(businessId, supplier.id),
    prisma.purchase.findMany({ where: { businessId, supplierId: supplier.id }, orderBy: { purchaseDate: "desc" }, take: 50 }),
    prisma.payment.findMany({ where: { businessId, supplierId: supplier.id }, orderBy: { createdAt: "desc" }, take: 50 }),
    getSupplierCreditSummary(businessId, supplier.id),
  ]);

  const purchaseRows = purchases.map((p) => ({
    id: p.id,
    href: `/purchases/${p.id}`,
    number: p.purchaseNumber,
    date: formatDateIn(p.purchaseDate, tz),
    dateSort: p.purchaseDate.toISOString(),
    total: Number(p.total),
    balance: Number(p.balance),
    status: p.status,
    tone: p.status === "VOIDED" ? "danger" : Number(p.balance) > 0 ? "warning" : "success",
  }));
  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader
        title={supplier.name}
        description={supplier.phone ?? "No phone on file"}
        actions={
          <PermissionGate perm="suppliers.manage">
            <Link href={`/suppliers/${supplier.id}/edit`} className="rounded border border-erp-border px-3 py-1.5 text-sm text-erp-text hover:bg-erp-subtle">Edit details</Link>
            {creditSummary.totalAvailable > 0 && summary.outstandingBalance > 0 && (
              <ApplySupplierCreditForm businessId={businessId} supplierId={supplier.id} totalAvailable={creditSummary.totalAvailable} />
            )}
            <RecordSupplierPaymentForm businessId={businessId} supplierId={supplier.id} />
          </PermissionGate>
        }
      />
      <div className="-mt-2 mb-4"><PhoneHint value={supplier.phone} /></div>

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiCard label="Total Purchases" value={formatMoney(summary.totalPurchases)} />
        <KpiCard label="Amount Paid" value={formatMoney(summary.amountPaid)} />
        <KpiCard label="We Owe" value={formatMoney(summary.outstandingBalance)} tone={summary.outstandingBalance > 0 ? "bad" : "good"} />
      </div>

      {creditSummary.totalAvailable > 0 && (
        <p className="mb-4 text-sm text-erp-muted">
          Standing credit: <AmountDisplay value={creditSummary.totalAvailable} className="font-medium text-erp-success" /> available from a past
          overpayment or refund credit note
          {summary.outstandingBalance <= 0 && " – nothing outstanding to apply it against yet."}
        </p>
      )}

      <h2 className="mb-2 text-sm font-semibold text-erp-text">Purchase History</h2>
      <div className="mb-6">
        <DataTable
          exportName={`supplier-${supplier.name}-purchases`}
          searchPlaceholder="Search purchases…"
          rowHrefKey="href"
          pageSize={10}
          emptyMessage="No purchases yet."
          columns={[
            { key: "number", header: "Purchase #", hrefKey: "href" },
            { key: "date", header: "Date", sortKey: "dateSort" },
            { key: "total", header: "Total", type: "money", total: true },
            { key: "balance", header: "Balance", type: "money", total: true },
            { key: "status", header: "Status", type: "badge", toneKey: "tone" },
          ]}
          rows={purchaseRows}
        />
      </div>

      <h2 className="mb-2 text-sm font-semibold text-erp-text">Payment History</h2>
      {payments.length === 0 ? (
        <p className="text-sm text-erp-muted">No payments recorded yet.</p>
      ) : (
        <div className="overflow-auto rounded border border-erp-border bg-erp-surface shadow-sm">
          <table className="w-full border-separate border-spacing-0 text-[13px]">
            <thead className="bg-erp-subtle">
              <tr>
                <th scope="col" className="border-b border-erp-border px-2.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-erp-muted">Date</th>
                <th scope="col" className="border-b border-erp-border px-2.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-erp-muted">Method</th>
                <th scope="col" className="border-b border-erp-border px-2.5 py-1.5 text-right text-[11px] font-semibold uppercase tracking-wide text-erp-muted">Amount (MWK)</th>
                <th scope="col" className="border-b border-erp-border px-2.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-erp-muted">Notes</th>
                <th scope="col" className="border-b border-erp-border px-2.5 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="hover:bg-erp-subtle/60">
                  <td className="whitespace-nowrap border-b border-erp-border px-2.5 py-1">{formatDateIn(p.createdAt, tz)}</td>
                  <td className="border-b border-erp-border px-2.5 py-1">{p.method.replace("_", " ")}</td>
                  <td className="border-b border-erp-border px-2.5 py-1 text-right"><AmountDisplay value={Number(p.amount)} bare /></td>
                  <td className="border-b border-erp-border px-2.5 py-1 text-erp-muted">{p.notes ?? "–"}</td>
                  <td className="border-b border-erp-border px-2.5 py-1 text-right">
                    <PermissionGate perm="suppliers.manage">
                      <SendNoticeButton
                        url={`/api/business/${businessId}/suppliers/${supplier.id}/payment-notice`}
                        body={{ paymentId: p.id }}
                        label="Text supplier"
                      />
                    </PermissionGate>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
