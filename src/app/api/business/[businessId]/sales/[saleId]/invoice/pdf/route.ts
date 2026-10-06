import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getInvoiceForSale } from "@/lib/invoices";
import { renderBusinessDocumentPdf } from "@/lib/pdf";
import { getBusinessTimeZone } from "@/lib/business-timezone";
import { formatDateIn } from "@/lib/timezone";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; saleId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "documents.generate");
  if (ctx instanceof NextResponse) return ctx;

  const invoice = await getInvoiceForSale({ businessId: params.businessId, saleId: params.saleId });
  if (!invoice) {
    return NextResponse.json(
      { error: "not_found", message: "No invoice has been generated for this sale yet." },
      { status: 404 }
    );
  }

  const { sale } = invoice;

  const timeZone = await getBusinessTimeZone(params.businessId);
  const pdf = await renderBusinessDocumentPdf({
    timeZone,
    documentTitle: "TAX INVOICE",
    documentNumber: invoice.invoiceNumber,
    documentDate: invoice.generatedAt,
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
    billTo: {
      name: sale.customer?.name ?? "Walk-in customer",
      phone: sale.customer?.phone,
      address: sale.customer?.address,
    },
    metaLines: [
      ...(invoice.dueDate ? [{ label: "Due date", value: formatDateIn(new Date(invoice.dueDate), timeZone) }] : []),
      { label: "Payment method", value: sale.paymentMethod.replace("_", " ") },
    ],
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
    terms: invoice.terms,
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${invoice.invoiceNumber}.pdf"`,
    },
  });
}
