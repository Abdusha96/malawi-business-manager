import { getServerSession } from "next-auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { getCustomerSummary } from "@/lib/customers";
import { getCustomerCreditSummary } from "@/lib/credits";
import { RecordPaymentForm } from "./record-payment-form";
import { SendReminderButton } from "./send-reminder-button";
import { PhoneHint } from "@/components/phone-hint";
import { ApplyCreditForm } from "./apply-credit-form";
import { formatDateIn, resolveTimeZone } from "@/lib/timezone";
import { PageHeader, KpiCard, AmountDisplay } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";
import { PermissionGate } from "@/components/erp/permission-gate";
import { formatMoney } from "@/lib/erp/format";

export default async function CustomerProfilePage(props: { params: Promise<{ customerId: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const businessId = memberships[0].businessId;
  const tz = resolveTimeZone(memberships[0].business.timezone);
  const customer = await prisma.customer.findUnique({ where: { id: params.customerId } });
  if (!customer || customer.businessId !== businessId) notFound();

  const [summary, sales, payments, creditSummary, cashAccounts] = await Promise.all([
    getCustomerSummary(businessId, customer.id),
    prisma.sale.findMany({ where: { businessId, customerId: customer.id }, orderBy: { saleDate: "desc" }, take: 50 }),
    prisma.payment.findMany({ where: { businessId, customerId: customer.id }, orderBy: { createdAt: "desc" }, take: 50 }),
    getCustomerCreditSummary(businessId, customer.id),
    prisma.cashAccount.findMany({
      where: { businessId, isActive: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }, { name: "asc" }],
      select: { id: true, name: true, type: true },
    }),
  ]);

  const limit = customer.creditLimit ? Number(customer.creditLimit) : 0;
  const overLimit = limit > 0 && summary.outstandingBalance > limit;

  const saleRows = sales.map((s) => ({
    id: s.id,
    href: `/sales/${s.id}`,
    number: s.saleNumber,
    date: formatDateIn(s.saleDate, tz),
    dateSort: s.saleDate.toISOString(),
    total: Number(s.total),
    balance: Number(s.balance),
    status: s.status,
    tone: s.status === "VOIDED" ? "danger" : Number(s.balance) > 0 ? "warning" : "success",
  }));
  const paymentRows = payments.map((p) => ({
    id: p.id,
    date: formatDateIn(p.createdAt, tz),
    dateSort: p.createdAt.toISOString(),
    method: p.method.replace("_", " "),
    amount: Number(p.amount),
    notes: p.notes ?? "",
  }));

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader
        title={customer.name}
        description={`${customer.customerType === "INDIVIDUAL" ? "Individual" : "Business"} · ${customer.phone ?? "No phone on file"}`}
        actions={
          <PermissionGate perm="customers.manage">
            <Link href={`/customers/${customer.id}/edit`} className="rounded border border-erp-border px-3 py-1.5 text-sm text-erp-text hover:bg-erp-subtle">Edit details</Link>
            {summary.outstandingBalance > 0 && <SendReminderButton businessId={businessId} customerId={customer.id} />}
            {creditSummary.totalAvailable > 0 && summary.outstandingBalance > 0 && (
              <ApplyCreditForm businessId={businessId} customerId={customer.id} totalAvailable={creditSummary.totalAvailable} />
            )}
            <RecordPaymentForm businessId={businessId} customerId={customer.id} cashAccounts={cashAccounts} />
          </PermissionGate>
        }
      />
      <div className="-mt-2 mb-4"><PhoneHint value={customer.phone} /></div>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Total Purchases" value={formatMoney(summary.totalPurchases)} />
        <KpiCard label="Amount Paid" value={formatMoney(summary.amountPaid)} />
        <KpiCard label="Outstanding" value={formatMoney(summary.outstandingBalance)} tone={summary.outstandingBalance > 0 ? "bad" : "good"} />
        <KpiCard
          label="Credit Limit"
          value={limit > 0 ? formatMoney(limit) : "None set"}
          tone={overLimit ? "bad" : undefined}
          note={overLimit ? "Over limit" : undefined}
        />
      </div>

      {creditSummary.totalAvailable > 0 && (
        <p className="mb-4 text-sm text-erp-muted">
          Standing credit: <AmountDisplay value={creditSummary.totalAvailable} className="font-medium text-erp-success" /> available from a past
          overpayment or refund credit note
          {summary.outstandingBalance <= 0 && " – nothing outstanding to apply it against yet."}
        </p>
      )}

      <h2 className="mb-2 text-sm font-semibold text-erp-text">Sales History</h2>
      <div className="mb-6">
        <DataTable
          exportName={`customer-${customer.name}-sales`}
          searchPlaceholder="Search sales…"
          rowHrefKey="href"
          pageSize={10}
          emptyMessage="No sales yet."
          columns={[
            { key: "number", header: "Sale #", hrefKey: "href" },
            { key: "date", header: "Date", sortKey: "dateSort" },
            { key: "total", header: "Total", type: "money", total: true },
            { key: "balance", header: "Balance", type: "money", total: true },
            { key: "status", header: "Status", type: "badge", toneKey: "tone" },
          ]}
          rows={saleRows}
        />
      </div>

      <h2 className="mb-2 text-sm font-semibold text-erp-text">Payment History</h2>
      <DataTable
        exportName={`customer-${customer.name}-payments`}
        searchPlaceholder="Search payments…"
        pageSize={10}
        emptyMessage="No payments recorded yet."
        columns={[
          { key: "date", header: "Date", sortKey: "dateSort" },
          { key: "method", header: "Method" },
          { key: "amount", header: "Amount", type: "money", total: true },
          { key: "notes", header: "Notes" },
        ]}
        rows={paymentRows}
      />
    </main>
  );
}
