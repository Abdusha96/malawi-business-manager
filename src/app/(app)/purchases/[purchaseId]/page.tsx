import { getServerSession } from "next-auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { getRefundableAmount } from "@/lib/refunds";
import { listDebitNotesForPurchase } from "@/lib/debit-notes";
import { VoidPurchaseForm } from "./void-purchase-form";
import { SettleForeignForm } from "../../fx-shared/settle-foreign-form";
import { foreignBalance } from "@/lib/fx-calc";
import { formatDateIn, resolveTimeZone } from "@/lib/timezone";
import { PageHeader, StatusBadge, DetailList, LineItemsTable, TotalsPanel, Panel, AmountDisplay } from "@/components/erp/display";
import { formatMoney } from "@/lib/erp/format";

const TONE = { PAID: "success", PARTIAL: "warning", CREDIT: "danger", VOIDED: "neutral" } as const;

export default async function PurchaseDetailPage(props: { params: Promise<{ purchaseId: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;
  const tz = resolveTimeZone(membership.business.timezone);

  const purchase = await prisma.purchase.findUnique({
    where: { id: params.purchaseId },
    include: { items: { include: { product: true } }, supplier: true, payments: true, refunds: true },
  });
  if (!purchase || purchase.businessId !== businessId) notFound();

  const membershipCtx = {
    businessId,
    userId: session.user.id,
    role: membership.role,
    branchId: membership.branchId,
  };
  const [canVoid, canRefund, canSettle] = await Promise.all([
    hasPermission(membershipCtx, "purchases.void"),
    hasPermission(membershipCtx, "refunds.manage"),
    hasPermission(membershipCtx, "suppliers.manage"),
  ]);
  const bookRate = purchase.exchangeRate != null ? Number(purchase.exchangeRate) : null;
  const isForeign = !!purchase.currency && bookRate != null;

  const { refundable } = await getRefundableAmount({ businessId, purchaseId: purchase.id });
  const debitNotes = purchase.status !== "VOIDED" ? await listDebitNotesForPurchase(businessId, purchase.id) : [];
  const debitedTotal = debitNotes.reduce((sum, n) => sum + Number(n.total), 0);
  const stillDebitable = purchase.status !== "VOIDED" && Number(purchase.total) - debitedTotal > 0.01;

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <PageHeader
        title={purchase.purchaseNumber}
        actions={
          <>
            <StatusBadge tone={TONE[purchase.status as keyof typeof TONE] ?? "neutral"}>{purchase.status}</StatusBadge>
            <Link href="/purchases" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">
              Back to Purchases
            </Link>
          </>
        }
      />

      <DetailList
        items={[
          { label: "Supplier", value: purchase.supplier.name },
          { label: "Date", value: formatDateIn(purchase.purchaseDate, tz) },
          { label: "Payment method", value: purchase.paymentMethod.replace("_", " ") },
          {
            label: "Currency",
            value: isForeign ? `${purchase.currency} at MWK ${bookRate} – total ${purchase.currency} ${foreignBalance(Number(purchase.total), bookRate!).toLocaleString()}` : null,
          },
          {
            label: "Voided",
            value: purchase.status === "VOIDED" ? (
              <span className="text-erp-danger">{purchase.voidedAt ? formatDateIn(purchase.voidedAt, tz) : ""} – {purchase.voidReason}</span>
            ) : null,
          },
        ]}
      />

      <LineItemsTable
        priceLabel="Unit Cost"
        lines={purchase.items.map((item) => ({
          id: item.id,
          name: item.product.name,
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitCost),
          total: Number(item.total),
        }))}
      />

      <TotalsPanel
        rows={[
          { label: "Subtotal", value: Number(purchase.subtotal) },
          { label: "Input VAT", value: Number(purchase.tax) },
          { label: "Total", value: Number(purchase.total), strong: true },
          { label: "Paid", value: Number(purchase.amountPaid) },
          { label: "Balance", value: Number(purchase.balance), strong: true },
        ]}
      />

      {isForeign && purchase.status !== "VOIDED" && Number(purchase.balance) > 0.01 && canSettle && (
        <div className="mb-4">
          <SettleForeignForm
            businessId={businessId}
            kind="PURCHASE"
            documentId={purchase.id}
            currency={purchase.currency!}
            bookRate={bookRate!}
            balance={Number(purchase.balance)}
            foreignBalance={foreignBalance(Number(purchase.balance), bookRate!)}
          />
        </div>
      )}

      {purchase.payments.some((p) => p.currency) && (
        <Panel title="Foreign-currency payments">
          <ul className="space-y-1 text-erp-muted">
            {purchase.payments.filter((p) => p.currency).map((p) => (
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

      {purchase.status !== "VOIDED" && (debitNotes.length > 0 || (canRefund && stillDebitable)) && (
        <Panel
          title="Debit Notes"
          actions={
            canRefund && stillDebitable ? (
              <Link
                href={`/debit-notes/new?purchaseId=${purchase.id}`}
                className="rounded bg-erp-primary px-3 py-1.5 text-xs font-medium text-erp-primary-fg hover:opacity-90"
              >
                Issue Debit Note
              </Link>
            ) : undefined
          }
        >
          {debitNotes.length === 0 ? (
            <p className="text-erp-muted">None issued yet – a return or price adjustment stays open even in a closed period.</p>
          ) : (
            <ul className="space-y-1 text-erp-muted">
              {debitNotes.map((n) => (
                <li key={n.id} className="flex justify-between">
                  <Link href={`/debit-notes/${n.id}`} className="text-erp-primary hover:underline">{n.debitNoteNumber}</Link>
                  <AmountDisplay value={Number(n.total)} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {purchase.status !== "VOIDED" && canVoid && debitNotes.length === 0 && (
        <VoidPurchaseForm businessId={businessId} purchaseId={purchase.id} />
      )}
      {purchase.status !== "VOIDED" && canVoid && debitNotes.length > 0 && (
        <p className="mb-4 rounded border border-erp-border bg-erp-subtle p-3 text-xs text-erp-muted">
          This purchase has debit notes against it, so it can no longer be voided – the debit notes already reverse
          the part that was returned.
        </p>
      )}

      {purchase.status === "VOIDED" && Number(purchase.amountPaid) > 0 && (
        <Panel title="Refund">
          {refundable > 0.01 ? (
            <>
              <p className="mb-3 text-erp-muted">
                {formatMoney(refundable)} of the {formatMoney(Number(purchase.amountPaid))} paid on
                this voided purchase hasn&apos;t had a refund decision made yet.
              </p>
              {canRefund && (
                <Link
                  href={`/refunds/new?purchaseId=${purchase.id}`}
                  className="inline-block rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90"
                >
                  Process Refund
                </Link>
              )}
            </>
          ) : (
            <p className="text-erp-success">Fully resolved – no refund decision outstanding.</p>
          )}
          {purchase.refunds.length > 0 && (
            <ul className="mt-3 space-y-1 border-t border-erp-border pt-3 text-erp-muted">
              {purchase.refunds.map((r) => (
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
