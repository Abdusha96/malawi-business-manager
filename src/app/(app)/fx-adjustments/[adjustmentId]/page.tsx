import { getServerSession } from "next-auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { PageHeader, StatusBadge, DetailList, AmountDisplay } from "@/components/erp/display";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { getForeignExchangeAdjustment } from "@/lib/foreign-exchange";
import { VoidFxAdjustmentForm } from "./void-form";
import { resolveTimeZone, formatDateIn, formatDateTimeIn } from "@/lib/timezone";

function fmt(n: number, dp = 2) {
  return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export default async function FxAdjustmentDetailPage(props: { params: Promise<{ adjustmentId: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const tz = resolveTimeZone(membership.business.timezone);
  const ctx = { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId };
  const [canView, canManage] = await Promise.all([hasPermission(ctx, "forex.view"), hasPermission(ctx, "forex.manage")]);
  if (!canView) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <p className="text-sm text-erp-danger">Your role does not have access to foreign exchange adjustments.</p>
      </main>
    );
  }

  const a = await getForeignExchangeAdjustment({ businessId: membership.businessId, adjustmentId: params.adjustmentId });
  if (!a) notFound();

  const currency = membership.business.currency;
  const amount = Number(a.gainLossAmount);
  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-6">
      <PageHeader
        title={a.adjustmentNumber}
        description={`${a.kind === "REALISED" ? "Realised" : "Unrealised"} exchange ${amount > 0 ? "gain" : "loss"} on ${a.currencyCode}`}
        actions={
          <>
            {a.status === "VOIDED" && <StatusBadge tone="neutral">Voided</StatusBadge>}
            <Link href="/fx-adjustments" className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">← Foreign Exchange</Link>
          </>
        }
      />

      <DetailList
        items={[
          { label: "Date", value: formatDateIn(a.adjustmentDate, tz) },
          { label: "Account adjusted", value: a.account.name },
          { label: `${a.currencyCode} amount`, value: a.foreignAmount !== null ? fmt(Number(a.foreignAmount)) : null },
          { label: "Rate carried", value: a.bookRate !== null ? fmt(Number(a.bookRate), 4) : null },
          { label: "New rate", value: a.newRate !== null ? fmt(Number(a.newRate), 4) : null },
          {
            label: amount > 0 ? "Gain" : "Loss",
            value: <span className={`font-semibold ${amount > 0 ? "text-erp-success" : "text-erp-danger"}`}><AmountDisplay value={Math.abs(amount)} currency={currency} /></span>,
          },
          { label: "Reference", value: a.reference },
          { label: "Notes", value: a.notes },
          { label: "Voided", value: a.status === "VOIDED" ? (a.voidedAt ? formatDateTimeIn(a.voidedAt, tz) : "–") : null },
          { label: "Reason", value: a.status === "VOIDED" ? (a.voidReason ?? "–") : null },
        ]}
      />

      {a.status === "RECORDED" && canManage && <VoidFxAdjustmentForm businessId={membership.businessId} adjustmentId={a.id} />}
    </main>
  );
}
