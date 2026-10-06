import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { prisma } from "@/lib/prisma";
import { renderBusinessDocumentPdf } from "@/lib/pdf";
import { getBusinessTimeZone } from "@/lib/business-timezone";
import { formatDateIn } from "@/lib/timezone";

// Real PDF download for a receipt – replaces the "browser print / Save as
// PDF" workaround noted in src/app/sales/[saleId]/receipt/page.tsx (Module
// 3), now that the shared layout engine (src/lib/pdf.ts) this needed exists.
export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; saleId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "documents.generate");
  if (ctx instanceof NextResponse) return ctx;

  const sale = await prisma.sale.findUnique({
    where: { id: params.saleId },
    include: { items: { include: { product: true } }, customer: true, receipt: true, business: true },
  });
  if (!sale || sale.businessId !== params.businessId || !sale.receipt) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const timeZone = await getBusinessTimeZone(params.businessId);
  const pdf = await renderBusinessDocumentPdf({
    timeZone,
    documentTitle: "RECEIPT",
    documentNumber: sale.receipt.receiptNumber,
    documentDate: sale.saleDate,
    currency: sale.business.currency,
    business: {
      name: sale.business.name,
      phone: sale.business.phone,
      email: sale.business.email,
      physicalAddress: sale.business.physicalAddress,
      city: sale.business.city,
      district: sale.business.district,
      taxpayerId: sale.business.taxpayerId,
      vatNumber: sale.business.vatRegistered ? sale.business.vatNumber : null,
    },
    billTo: { name: sale.customer?.name ?? "Walk-in customer", phone: sale.customer?.phone, address: sale.customer?.address },
    metaLines: [{ label: "Payment method", value: sale.paymentMethod.replace("_", " ") }],
    items: sale.items.map((item) => ({
      description: item.product.name,
      quantity: Number(item.quantity),
      unit: item.product.unit,
      unitPrice: Number(item.unitPrice),
      discount: Number(item.discount),
      total: Number(item.total),
    })),
    subtotal: Number(sale.subtotal),
    discount: Number(sale.discount),
    tax: Number(sale.tax),
    taxLabel: "VAT",
    total: Number(sale.total),
    amountPaid: Number(sale.amountPaid),
    balance: Number(sale.balance),
    footerNote: "Thank you for your business.",
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${sale.receipt.receiptNumber}.pdf"`,
    },
  });
}
