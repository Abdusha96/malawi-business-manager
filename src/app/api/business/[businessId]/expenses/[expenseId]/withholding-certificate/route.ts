import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { prisma } from "@/lib/prisma";
import { renderBusinessDocumentPdf } from "@/lib/pdf";
import { getBusinessTimeZone } from "@/lib/business-timezone";
import { formatDateIn } from "@/lib/timezone";
import { WITHHOLDING_TAX_CATEGORY_LABELS } from "@/lib/validation";

/**
 * Module 19 (Withholding Tax) certificate – the document a business gives a
 * payee as proof that tax was withheld from their payment, so the payee can
 * claim credit for it on their own MRA return. Reuses
 * renderBusinessDocumentPdf() rather than hand-rolling a layout (see the
 * README note on Module 15's shared PDF engine), even though this document
 * doesn't naturally have "line items" the way a receipt/invoice does – the
 * single expense description becomes the one line, and the payee's TPIN
 * (which billTo has no field for) rides along as a metaLine instead.
 *
 * NOT an MRA-recognized certificate or a filing of any kind – see the
 * KNOWN LIMITATION in src/lib/withholding-tax.ts. It's a working document
 * for the payee's own records and their accountant's use.
 */
export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; expenseId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "documents.generate");
  if (ctx instanceof NextResponse) return ctx;

  const expense = await prisma.expense.findUnique({
    where: { id: params.expenseId },
    include: { business: true },
  });
  if (!expense || expense.businessId !== params.businessId || !expense.withholdingTaxCategory) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const netPaid = Number(expense.amount) - Number(expense.withholdingTaxAmount);
  // No dedicated numbering sequence exists for this document type (unlike
  // Invoice/Receipt/Quotation, which each have a Business.next*Number
  // counter) – a short, stable, non-sequential reference derived from the
  // Expense's own id is good enough for a payee's records.
  const certificateNumber = `WHT-${expense.id.slice(-8).toUpperCase()}`;

  const timeZone = await getBusinessTimeZone(params.businessId);
  const pdf = await renderBusinessDocumentPdf({
    timeZone,
    documentTitle: "WITHHOLDING TAX CERTIFICATE",
    documentNumber: certificateNumber,
    documentDate: expense.expenseDate,
    currency: expense.business.currency,
    business: {
      name: expense.business.name,
      phone: expense.business.phone,
      email: expense.business.email,
      physicalAddress: expense.business.physicalAddress,
      city: expense.business.city,
      district: expense.business.district,
      taxpayerId: expense.business.taxpayerId,
    },
    billTo: { name: expense.payee ?? "Payee not recorded" },
    metaLines: [
      { label: "Payee TPIN", value: expense.payeeTpin ?? "Not recorded" },
      { label: "Payment type", value: WITHHOLDING_TAX_CATEGORY_LABELS[expense.withholdingTaxCategory] },
      { label: "Withholding tax rate", value: `${Number(expense.withholdingTaxRate)}%` },
      { label: "Net amount paid to payee", value: netPaid.toLocaleString(undefined, { minimumFractionDigits: 2 }) },
    ],
    items: [
      {
        description: expense.description,
        quantity: 1,
        unitPrice: Number(expense.amount),
        discount: 0,
        total: Number(expense.amount),
      },
    ],
    subtotal: Number(expense.amount),
    discount: 0,
    tax: Number(expense.withholdingTaxAmount),
    taxLabel: "Withholding Tax",
    total: Number(expense.amount),
    footerNote: "This is a working record of tax withheld, not an official MRA filing or certificate.",
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${certificateNumber}.pdf"`,
    },
  });
}
