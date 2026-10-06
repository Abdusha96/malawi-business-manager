import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { PageHeader, KpiCard } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";
import { PermissionGate } from "@/components/erp/permission-gate";
import { formatMoney } from "@/lib/erp/format";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { listTaxPayments } from "@/lib/tax-payments";
import { TAX_PAYMENT_TYPE_LABELS, TaxPaymentTypeKey } from "@/lib/tax-period";
import { resolveTimeZone, formatDateIn } from "@/lib/timezone";

export default async function TaxPaymentsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const ctx = { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId };
  const canView = await hasPermission(ctx, "taxpayments.view");

  if (!canView) {
    return (
      <main className="mx-auto max-w-6xl p-4 sm:p-6">
        <PageHeader title="Tax Payments" />
        <p className="text-sm text-erp-muted">Your role ({membership.role}) doesn&apos;t have access to tax payments.</p>
      </main>
    );
  }

  const payments = await listTaxPayments(membership.businessId);
  const tz = resolveTimeZone(membership.business.timezone);
  const recorded = payments.filter((p) => p.status === "RECORDED");
  const totalTax = recorded.filter((p) => !p.isRefund).reduce((s, p) => s + Number(p.principalAmount), 0);
  const totalPenalties = recorded.reduce((s, p) => s + Number(p.penaltyAmount), 0);
  const totalRefunded = recorded.filter((p) => p.isRefund).reduce((s, p) => s + Number(p.principalAmount), 0);

  const rows = payments.map((p) => {
    const voided = p.status === "VOIDED";
    return {
      id: p.id,
      href: `/tax-payments/${p.id}`,
      paymentNumber: p.paymentNumber,
      date: formatDateIn(new Date(p.paymentDate), tz),
      dateSort: new Date(p.paymentDate).toISOString(),
      tax: TAX_PAYMENT_TYPE_LABELS[p.taxType as TaxPaymentTypeKey] ?? p.taxType,
      kind: p.isRefund ? "Refund" : "Payment",
      kindTone: p.isRefund ? "info" : "neutral",
      period: p.periodLabel,
      // Same wording as the old list: a later or part-payment installment is called out.
      installment: p.installmentNo > 1 || !p.settlesPeriod ? (p.settlesPeriod ? `Final · #${p.installmentNo}` : `Part · #${p.installmentNo}`) : "",
      amount: Number(p.principalAmount),
      penalty: Number(p.penaltyAmount),
      account: p.account.name,
      status: voided ? "Voided" : "Recorded",
      statusTone: voided ? "neutral" : "success",
    };
  });

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Tax Payments"
        description="Payments made to, and refunds received from, the MRA."
        actions={
          <>
            <Link href="/accounting" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">Tax Calendar</Link>
            <PermissionGate perm="taxpayments.manage">
              <Link href="/tax-payments/new" className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90">+ Record Payment</Link>
            </PermissionGate>
          </>
        }
      />

      <div className="mb-4 rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-xs text-erp-text">
        This is a record of payments you&apos;ve made to, and refunds received from, the MRA – it doesn&apos;t make a payment,
        file a return, or claim a refund, and has no connection to MRA systems. Enter the amounts and reference
        exactly as they appear on the MRA&apos;s receipt.
      </div>

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiCard label="Tax paid (all recorded payments)" value={formatMoney(totalTax)} />
        <KpiCard label="VAT refunds received" value={formatMoney(totalRefunded)} />
        <KpiCard label="Penalties & interest" value={formatMoney(totalPenalties)} />
      </div>

      <DataTable
        exportName="tax-payments"
        searchPlaceholder="Search tax payments…"
        rowHrefKey="href"
        emptyMessage="No tax payments recorded yet."
        columns={[
          { key: "paymentNumber", header: "Payment #", hrefKey: "href" },
          { key: "date", header: "Date", sortKey: "dateSort" },
          { key: "tax", header: "Tax" },
          { key: "kind", header: "Type", type: "badge", toneKey: "kindTone" },
          { key: "period", header: "Period" },
          { key: "installment", header: "Installment" },
          { key: "amount", header: "Amount", type: "money" },
          { key: "penalty", header: "Penalty", type: "money" },
          { key: "account", header: "Account", defaultHidden: true },
          { key: "status", header: "Status", type: "badge", toneKey: "statusTone" },
        ]}
        rows={rows}
      />
      <p className="mt-2 text-[11px] text-erp-muted">Refund amounts are shown as received money; voided payments stay listed as history and are not counted in the totals above.</p>
    </main>
  );
}
