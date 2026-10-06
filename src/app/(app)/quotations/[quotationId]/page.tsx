import { describeQuotedDifference } from "@/lib/quotation-refresh";
import { getServerSession } from "next-auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { getQuotation } from "@/lib/quotations";
import { prisma } from "@/lib/prisma";
import { QuotationActions } from "./quotation-actions";
import { formatDateIn, resolveTimeZone } from "@/lib/timezone";
import { PageHeader, StatusBadge, DetailList, LineItemsTable, TotalsPanel } from "@/components/erp/display";

const TONE = {
  DRAFT: "neutral",
  SENT: "info",
  ACCEPTED: "success",
  DECLINED: "danger",
  EXPIRED: "neutral",
  CONVERTED: "info",
} as const;

export default async function QuotationDetailPage(props: { params: Promise<{ quotationId: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const tz = resolveTimeZone(membership.business.timezone);
  const quotation = await getQuotation({ businessId: membership.businessId, quotationId: params.quotationId });
  if (!quotation) notFound();

  const membershipCtx = {
    businessId: membership.businessId,
    userId: session.user.id,
    role: membership.role,
    branchId: membership.branchId,
  };
  const canManage = await hasPermission(membershipCtx, "quotations.manage");
  // Module 77: set only when converting changed the figures the customer was quoted.
  const quotedDifference = describeQuotedDifference(
    quotation.quotedTotal != null ? Number(quotation.quotedTotal) : null,
    Number(quotation.total)
  );
  const canConvert = await hasPermission(membershipCtx, "sales.create");

  // Module 68: a free-text line can be linked to a product right in the
  // convert form, so the picker needs the sellable catalog - fetched only
  // when there is actually something to link and the person can convert.
  const freeTextItems = quotation.items.filter((i) => !i.productId);
  const sellableProducts =
    canConvert && quotation.status !== "CONVERTED" && freeTextItems.length > 0
      ? await prisma.product.findMany({
          where: { businessId: membership.businessId, isActive: true },
          select: { id: true, name: true, sku: true, sellingPrice: true },
          orderBy: { name: "asc" },
          take: 1000,
        })
      : [];

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <PageHeader
        title={quotation.quotationNumber}
        actions={
          <>
            <StatusBadge tone={TONE[quotation.status as keyof typeof TONE] ?? "neutral"}>{quotation.status}</StatusBadge>
            <a
              href={`/api/business/${quotation.businessId}/quotations/${quotation.id}/pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle"
            >
              Download PDF
            </a>
          </>
        }
      />

      <DetailList
        items={[
          { label: "Customer", value: quotation.customer?.name ?? quotation.customerName ?? "–" },
          { label: "Date", value: formatDateIn(quotation.quotationDate, tz) },
          { label: "Valid until", value: quotation.expiryDate ? formatDateIn(quotation.expiryDate, tz) : null },
        ]}
      />

      <LineItemsTable
        lines={quotation.items.map((item) => ({
          id: item.id,
          name: (
            <>
              {item.product?.name ?? item.description}
              {!item.productId && <span className="ml-1 text-xs text-erp-warning">(not in inventory)</span>}
            </>
          ),
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice),
          total: Number(item.total),
        }))}
      />

      <TotalsPanel
        rows={[
          { label: "Subtotal", value: Number(quotation.subtotal) },
          { label: "Discount", value: -Number(quotation.discount) },
          { label: "VAT", value: Number(quotation.tax) },
          { label: "Total", value: Number(quotation.total), strong: true },
        ]}
      />
      {quotedDifference && <p className="-mt-4 mb-6 text-xs text-erp-muted">{quotedDifference}</p>}

      {quotation.status === "CONVERTED" && quotation.convertedSaleId && (
        <p className="mb-4 rounded border border-erp-info/30 bg-erp-info/10 p-3 text-sm text-erp-info">
          Converted to sale.{" "}
          <Link href={`/sales/${quotation.convertedSaleId}/receipt`} className="underline">
            View receipt
          </Link>
        </p>
      )}

      {quotation.status !== "CONVERTED" && (
        <QuotationActions
          businessId={quotation.businessId}
          quotationId={quotation.id}
          status={quotation.status}
          total={Number(quotation.total)}
          hasCustomer={!!quotation.customerId}
          freeTextItems={freeTextItems.map((i) => ({
            id: i.id,
            description: i.description,
            quantity: Number(i.quantity),
            unitPrice: Number(i.unitPrice),
          }))}
          products={sellableProducts.map((p) => ({
            id: p.id,
            name: p.name,
            sku: p.sku,
            sellingPrice: Number(p.sellingPrice),
          }))}
          canManage={canManage}
          canConvert={canConvert}
        />
      )}
    </main>
  );
}
