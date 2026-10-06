import { getServerSession } from "next-auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { PageHeader, StatusBadge, DetailList, Panel, TotalsPanel, AmountDisplay } from "@/components/erp/display";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { getTaxPayment, listPeriodInstallments } from "@/lib/tax-payments";
import { TAX_PAYMENT_TYPE_LABELS, TaxPaymentTypeKey } from "@/lib/tax-period";
import { VoidTaxPaymentForm } from "./void-form";
import { resolveTimeZone, formatDateIn, formatDateTimeIn } from "@/lib/timezone";

export default async function TaxPaymentDetailPage(props: { params: Promise<{ paymentId: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const tz = resolveTimeZone(membership.business.timezone);
  const ctx = { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId };
  const [canView, canManage] = await Promise.all([hasPermission(ctx, "taxpayments.view"), hasPermission(ctx, "taxpayments.manage")]);
  if (!canView) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <p className="text-sm text-erp-danger">Your role does not have access to tax payments.</p>
      </main>
    );
  }

  const p = await getTaxPayment({ businessId: membership.businessId, paymentId: params.paymentId });
  if (!p) notFound();

  const periodPayments = await listPeriodInstallments({ businessId: membership.businessId, taxType: p.taxType, periodKey: p.periodKey });
  const hasInstallments = periodPayments.length > 1 || p.installmentNo > 1 || !p.settlesPeriod;
  const principal = Number(p.principalAmount);
  const penalty = Number(p.penaltyAmount);
  const carry = p.carryForwardApplied !== null ? Number(p.carryForwardApplied) : 0;
  const money = (n: number) => <AmountDisplay value={n} />;

  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-6">
      <PageHeader
        title={p.paymentNumber}
        description={`${TAX_PAYMENT_TYPE_LABELS[p.taxType as TaxPaymentTypeKey] ?? p.taxType} – ${p.periodLabel}`}
        actions={
          <>
            {p.isRefund && <StatusBadge tone="info">Refund</StatusBadge>}
            {p.status === "VOIDED" && <StatusBadge tone="neutral">Voided</StatusBadge>}
            <Link href="/tax-payments" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">← Tax Payments</Link>
          </>
        }
      />

      <DetailList
        items={[
          hasInstallments ? { label: "Installment", value: `#${p.installmentNo} ${p.settlesPeriod ? "(closes the period)" : "(part-payment)"}` } : { label: "Installment", value: null },
          { label: p.isRefund ? "Refund date" : "Payment date", value: formatDateIn(p.paymentDate, tz) },
          { label: p.isRefund ? "Received into" : "Paid from", value: p.account.name },
          { label: "Output VAT cleared", value: p.vatOutputCleared !== null ? money(Number(p.vatOutputCleared)) : null },
          {
            label: p.isRefund ? "Input VAT cleared" : "Input VAT netted off",
            value: p.vatInputCleared !== null && Number(p.vatInputCleared) > 0 ? money(Number(p.vatInputCleared)) : null,
          },
          {
            label: `Carried forward (${p.carryForwardPeriods ?? "earlier periods"})`,
            value: carry !== 0 ? <>{money(Math.abs(carry))} {carry >= 0 ? "owed to MRA" : "credit"}</> : null,
          },
          { label: "MRA reference", value: p.reference },
          { label: "Notes", value: p.notes },
          { label: "Voided", value: p.status === "VOIDED" ? (p.voidedAt ? formatDateTimeIn(p.voidedAt, tz) : "–") : null },
          { label: "Reason", value: p.status === "VOIDED" ? (p.voidReason ?? "–") : null },
        ]}
      />

      <TotalsPanel
        rows={[
          { label: p.isRefund ? "Refund received" : "Tax paid", value: principal },
          ...(!p.isRefund ? [{ label: "Penalty / interest", value: penalty }] : []),
          { label: p.isRefund ? "Total received" : "Total paid", value: principal + penalty, strong: true },
        ]}
      />

      {hasInstallments && periodPayments.length > 0 && (
        <Panel title={`Payments recorded for ${p.periodLabel}`}>
          {periodPayments.map((q) => (
            <div key={q.id} className="flex justify-between border-t border-erp-border py-1.5">
              <span>
                {q.id === p.id ? <strong>{q.paymentNumber}</strong> : <Link href={`/tax-payments/${q.id}`} className="text-erp-primary underline">{q.paymentNumber}</Link>}
                <span className="ml-2 text-xs text-erp-muted">#{q.installmentNo} · {formatDateIn(q.paymentDate, tz)}</span>
              </span>
              <AmountDisplay value={q.principalAmount} />
            </div>
          ))}
          <div className="flex justify-between border-t border-erp-border py-1.5 font-semibold">
            <span>Total tax paid</span>
            <AmountDisplay value={periodPayments.reduce((sum, q) => sum + q.principalAmount, 0)} />
          </div>
        </Panel>
      )}

      {p.status === "RECORDED" && canManage && <VoidTaxPaymentForm businessId={membership.businessId} paymentId={p.id} />}
    </main>
  );
}
