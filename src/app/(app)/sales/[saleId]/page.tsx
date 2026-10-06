import { getServerSession } from "next-auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { getRefundableAmount } from "@/lib/refunds";
import { listCreditNotesForSale } from "@/lib/credit-notes";
import { VoidSaleForm } from "./void-sale-form";
import { PayLinkPanel } from "./pay-link-panel";
import { SettleForeignForm } from "../../fx-shared/settle-foreign-form";
import { foreignBalance } from "@/lib/fx-calc";
import { formatDateIn, resolveTimeZone } from "@/lib/timezone";
import { PageHeader, StatusBadge, DetailList, LineItemsTable, TotalsPanel, Panel, AmountDisplay } from "@/components/erp/display";
import { formatMoney } from "@/lib/erp/format";
import { InvoiceButton } from "./receipt/invoice-button";

const TONE = { PAID: "success", PARTIAL: "warning", CREDIT: "danger", VOIDED: "neutral" } as const;

export default async function SaleDetailPage(props: { params: Promise<{ saleId: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;
  const tz = resolveTimeZone(membership.business.timezone);

  const sale = await prisma.sale.findUnique({
    where: { id: params.saleId },
    include: {
      items: { include: { product: true } },
      customer: true,
      payments: true,
      receipt: true,
      invoice: true,
      refunds: true,
    },
  });
  if (!sale || sale.businessId !== businessId) notFound();

  const membershipCtx = {
    businessId,
    userId: session.user.id,
    role: membership.role,
    branchId: membership.branchId,
  };
  const [canVoid, canRefund, canSettle, canGenerateDocument] = await Promise.all([
    hasPermission(membershipCtx, "sales.void"),
    hasPermission(membershipCtx, "refunds.manage"),
    hasPermission(membershipCtx, "payments.record"),
    hasPermission(membershipCtx, "documents.generate"),
  ]);
  const bookRate = sale.exchangeRate != null ? Number(sale.exchangeRate) : null;
  const isForeign = !!sale.currency && bookRate != null;
  const cashAccounts = isForeign
    ? await prisma.cashAccount.findMany({
        where: { businessId, isActive: true },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }, { name: "asc" }],
        select: { id: true, name: true, type: true },
      })
    : [];

  const { refundable } = await getRefundableAmount({ businessId, saleId: sale.id });
  const creditNotes = sale.status !== "VOIDED" ? await listCreditNotesForSale(businessId, sale.id) : [];
  const creditedTotal = creditNotes.reduce((sum, n) => sum + Number(n.total), 0);
  const stillCreditable = sale.status !== "VOIDED" && Number(sale.total) - creditedTotal > 0.01;

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <PageHeader
        title={sale.saleNumber}
        description={undefined}
        actions={
          <>
            <StatusBadge tone={TONE[sale.status as keyof typeof TONE] ?? "neutral"}>{sale.status}</StatusBadge>
            <Link href={`/sales/${sale.id}/receipt`} className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">
              Receipt
            </Link>
            {canGenerateDocument && sale.status !== "VOIDED" && <InvoiceButton businessId={businessId} saleId={sale.id} />}
          </>
        }
      />

      <DetailList
        items={[
          { label: "Customer", value: sale.customer?.name ?? "Walk-in" },
          { label: "Date", value: formatDateIn(sale.saleDate, tz) },
          { label: "Payment method", value: sale.paymentMethod.replace("_", " ") },
          {
            label: "Currency",
            value: isForeign ? `${sale.currency} at MWK ${bookRate} – total ${sale.currency} ${foreignBalance(Number(sale.total), bookRate!).toLocaleString()}` : null,
          },
          {
            label: "Voided",
            value: sale.status === "VOIDED" ? (
              <span className="text-erp-danger">{sale.voidedAt ? formatDateIn(sale.voidedAt, tz) : ""} – {sale.voidReason}</span>
            ) : null,
          },
        ]}
      />

      <LineItemsTable
        lines={sale.items.map((item) => ({
          id: item.id,
          name: item.product.name,
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice),
          total: Number(item.total),
        }))}
      />

      <TotalsPanel
        rows={[
          { label: "Subtotal", value: Number(sale.subtotal) },
          { label: "Discount", value: -Number(sale.discount) },
          { label: "VAT", value: Number(sale.tax) },
          { label: "Total", value: Number(sale.total), strong: true },
          { label: "Paid", value: Number(sale.amountPaid) },
          { label: "Balance", value: Number(sale.balance), strong: true },
        ]}
      />

      {!isForeign && sale.status !== "VOIDED" && Number(sale.balance) >= 1 && canSettle && (
        <div className="mb-4">
          <PayLinkPanel businessId={businessId} saleId={sale.id} timeZone={tz} />
        </div>
      )}

      {isForeign && sale.status !== "VOIDED" && Number(sale.balance) > 0.01 && canSettle && (
        <div className="mb-4">
          <SettleForeignForm
            businessId={businessId}
            kind="SALE"
            documentId={sale.id}
            currency={sale.currency!}
            bookRate={bookRate!}
            balance={Number(sale.balance)}
            foreignBalance={foreignBalance(Number(sale.balance), bookRate!)}
            cashAccounts={cashAccounts}
          />
        </div>
      )}

      {sale.payments.some((p) => p.currency) && (
        <Panel title="Foreign-currency payments">
          <ul className="space-y-1 text-erp-muted">
            {sale.payments.filter((p) => p.currency).map((p) => (
              <li key={p.id} className="flex justify-between">
                <span>{p.currency} {Number(p.foreignAmount).toLocaleString()} at {Number(p.settlementRate)}</span>
                <span className={Number(p.fxGainLoss) < 0 ? "text-erp-danger" : "text-erp-success"}>
                  {Number(p.fxGainLoss) < 0 ? "loss" : "gain"} MWK {Math.abs(Number(p.fxGainLoss)).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {sale.status !== "VOIDED" && (creditNotes.length > 0 || (canRefund && stillCreditable)) && (
        <Panel
          title="Credit Notes"
          actions={
            canRefund && stillCreditable ? (
              <Link
                href={`/credit-notes/new?saleId=${sale.id}`}
                className="rounded bg-erp-primary px-3 py-1.5 text-xs font-medium text-erp-primary-fg hover:opacity-90"
              >
                Issue Credit Note
              </Link>
            ) : undefined
          }
        >
          {creditNotes.length === 0 ? (
            <p className="text-erp-muted">None issued yet – a return or price adjustment stays open even in a closed period.</p>
          ) : (
            <ul className="space-y-1 text-erp-muted">
              {creditNotes.map((n) => (
                <li key={n.id} className="flex justify-between">
                  <Link href={`/credit-notes/${n.id}`} className="text-erp-primary hover:underline">{n.creditNoteNumber}</Link>
                  <AmountDisplay value={Number(n.total)} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {sale.status !== "VOIDED" && canVoid && creditNotes.length === 0 && (
        <VoidSaleForm businessId={businessId} saleId={sale.id} />
      )}
      {sale.status !== "VOIDED" && canVoid && creditNotes.length > 0 && (
        <p className="mb-4 rounded border border-erp-border bg-erp-subtle p-3 text-xs text-erp-muted">
          This sale has credit notes against it, so it can no longer be voided – the credit notes already reverse
          the part that was returned.
        </p>
      )}

      {sale.status === "VOIDED" && Number(sale.amountPaid) > 0 && (
        <Panel title="Refund">
          {refundable > 0.01 ? (
            <>
              <p className="mb-3 text-erp-muted">
                {formatMoney(refundable)} of the {formatMoney(Number(sale.amountPaid))} collected on this
                voided sale hasn&apos;t had a refund decision made yet.
              </p>
              {canRefund && (
                <Link
                  href={`/refunds/new?saleId=${sale.id}`}
                  className="inline-block rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90"
                >
                  Process Refund
                </Link>
              )}
            </>
          ) : (
            <p className="text-erp-success">Fully resolved – no refund decision outstanding.</p>
          )}
          {sale.refunds.length > 0 && (
            <ul className="mt-3 space-y-1 border-t border-erp-border pt-3 text-erp-muted">
              {sale.refunds.map((r) => (
                <li key={r.id} className="flex justify-between">
                  <span>{r.method.replace("_", " ")} – {r.reason}</span>
                  <AmountDisplay value={Number(r.amount)} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </main>
  );
}
