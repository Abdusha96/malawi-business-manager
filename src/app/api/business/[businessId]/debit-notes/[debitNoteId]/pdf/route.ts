import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getDebitNote } from "@/lib/debit-notes";
import { renderBusinessDocumentPdf } from "@/lib/pdf";
import { getBusinessTimeZone } from "@/lib/business-timezone";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; debitNoteId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "documents.generate");
  if (ctx instanceof NextResponse) return ctx;

  const note = await getDebitNote({ businessId: params.businessId, debitNoteId: params.debitNoteId });
  if (!note) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (ctx.membership.branchId && note.branchId !== ctx.membership.branchId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const timeZone = await getBusinessTimeZone(params.businessId);
  const pdf = await renderBusinessDocumentPdf({
    timeZone,
    documentTitle: "DEBIT NOTE",
    documentNumber: note.debitNoteNumber,
    documentDate: note.issuedAt,
    currency: note.business.currency,
    business: {
      name: note.business.name,
      phone: note.business.phone,
      email: note.business.email,
      physicalAddress: note.business.physicalAddress,
      city: note.business.city,
      district: note.business.district,
      taxpayerId: note.business.taxpayerId,
      vatNumber: note.business.vatRegistered ? note.business.vatNumber : null,
    },
    billTo: {
      name: note.supplier.name,
      phone: note.supplier.phone,
      address: note.supplier.address,
    },
    metaLines: [
      { label: "Against purchase", value: note.purchase.purchaseNumber },
      { label: "Reason", value: note.reason },
      ...(Number(note.appliedToBalance) > 0
        ? [{ label: "Applied to balance owed", value: `${note.business.currency} ${Number(note.appliedToBalance).toLocaleString()}` }]
        : []),
      ...(Number(note.settledAmount) > 0
        ? [
            {
              label: note.settlement === "CASH" ? "Received back in cash" : "Kept as supplier credit",
              value: `${note.business.currency} ${Number(note.settledAmount).toLocaleString()}`,
            },
          ]
        : []),
    ],
    items: note.lines.map((line) => {
      const qty = Number(line.quantity);
      const net = Number(line.net);
      return {
        description: line.purchaseItem.product.name + (line.stockOut ? " (returned to supplier)" : " (price adjustment)"),
        quantity: qty > 0 ? qty : 1,
        unit: line.purchaseItem.product.unit,
        unitPrice: qty > 0 ? net / qty : net,
        discount: 0,
        total: net,
      };
    }),
    subtotal: Number(note.netAmount),
    discount: 0,
    tax: Number(note.vatAmount),
    taxLabel: "VAT",
    total: Number(note.total),
    footerNote:
      note.settlement === "NONE"
        ? "This debit has been applied to the balance owed on the purchase above."
        : note.settlement === "CASH"
        ? "The settled amount above has been received back in cash from the supplier."
        : "The settled amount above has been kept as credit on the supplier's account.",
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${note.debitNoteNumber}.pdf"`,
    },
  });
}
