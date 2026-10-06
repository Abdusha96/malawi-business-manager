import { describeQuotedDifference } from "@/lib/quotation-refresh";
import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getQuotation } from "@/lib/quotations";
import { renderBusinessDocumentPdf } from "@/lib/pdf";
import { getBusinessTimeZone } from "@/lib/business-timezone";
import { formatDateIn } from "@/lib/timezone";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; quotationId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "documents.generate");
  if (ctx instanceof NextResponse) return ctx;

  const quotation = await getQuotation({ businessId: params.businessId, quotationId: params.quotationId });
  if (!quotation) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const timeZone = await getBusinessTimeZone(params.businessId);
  // Module 77: only present when converting changed the quoted figures.
  const quotedDifference = describeQuotedDifference(
    quotation.quotedTotal != null ? Number(quotation.quotedTotal) : null,
    Number(quotation.total)
  );
  const pdf = await renderBusinessDocumentPdf({
    timeZone,
    documentTitle: "QUOTATION",
    documentNumber: quotation.quotationNumber,
    documentDate: quotation.quotationDate,
    currency: quotation.business.currency,
    business: {
      name: quotation.business.name,
      phone: quotation.business.phone,
      email: quotation.business.email,
      physicalAddress: quotation.business.physicalAddress,
      city: quotation.business.city,
      district: quotation.business.district,
      taxpayerId: quotation.business.taxpayerId,
      vatNumber: quotation.business.vatRegistered ? quotation.business.vatNumber : null,
    },
    billTo: {
      name: quotation.customer?.name ?? quotation.customerName ?? "Prospective customer",
      phone: quotation.customer?.phone,
      address: quotation.customer?.address,
    },
    metaLines: quotation.expiryDate
      ? [{ label: "Valid until", value: formatDateIn(new Date(quotation.expiryDate), timeZone) }]
      : [],
    items: quotation.items.map((item) => ({
      description: item.product?.name ?? item.description,
      quantity: Number(item.quantity),
      unit: item.product?.unit,
      unitPrice: Number(item.unitPrice),
      discount: Number(item.discount),
      total: Number(item.total),
    })),
    subtotal: Number(quotation.subtotal),
    discount: Number(quotation.discount),
    tax: Number(quotation.tax),
    taxLabel: "VAT",
    total: Number(quotation.total),
    notes: [quotation.notes, quotedDifference].filter(Boolean).join("\n\n") || null,
    terms: quotation.terms,
    footerNote: "This quotation is valid until the date shown above. Prices subject to change thereafter.",
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${quotation.quotationNumber}.pdf"`,
    },
  });
}
