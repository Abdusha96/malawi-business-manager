import PDFDocument from "pdfkit";
import { formatDateIn } from "./timezone";

/**
 * BUSINESS DOCUMENTS (Module 15) – shared PDF layout engine.
 *
 * Every printable document (receipt, invoice, quotation, and later payslip)
 * shares one visual layout, built once here rather than duplicated per
 * document type – see the comment on `src/app/sales/[saleId]/receipt/page.tsx`
 * (Module 3), which deferred "Download PDF" specifically until this existed.
 * Uses pdfkit's standard 14 fonts only (Helvetica/Helvetica-Bold), so no
 * external font files need to ship with the app.
 */

export interface DocumentLineItem {
  description: string;
  quantity: number;
  unit?: string;
  unitPrice: number;
  discount: number;
  total: number;
}

export interface DocumentMetaLine {
  label: string;
  value: string;
}

export interface BusinessDocumentInput {
  documentTitle: string; // e.g. "RECEIPT", "TAX INVOICE", "QUOTATION"
  documentNumber: string;
  documentDate: Date;
  /** Module 35: the business's IANA zone (getBusinessTimeZone) – dates on the document are that zone's calendar days, not the server's. */
  timeZone: string;
  currency?: string;
  business: {
    name: string;
    phone?: string | null;
    email?: string | null;
    physicalAddress?: string | null;
    city?: string | null;
    district?: string | null;
    taxpayerId?: string | null;
    vatNumber?: string | null; // Module 18 – shown separately from taxpayerId (TIN); only businesses with vatRegistered=true pass this
  };
  billTo?: {
    name: string;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
  };
  metaLines?: DocumentMetaLine[];
  items: DocumentLineItem[];
  subtotal: number;
  discount: number;
  tax: number;
  taxLabel?: string; // Module 18 – "VAT" for a VAT-registered business's documents, defaults to the original generic "Tax" label so a non-VAT business's PDFs (where this is always 0 and the row doesn't render anyway) are unaffected
  total: number;
  amountPaid?: number;
  balance?: number;
  notes?: string | null;
  terms?: string | null;
  footerNote?: string;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Renders a business document to a PDF buffer. Returns a Promise since
 * pdfkit is stream-based – every route calling this should `await` it and
 * respond with the resulting Buffer as `application/pdf`.
 */
export function renderBusinessDocumentPdf(input: BusinessDocumentInput): Promise<Buffer> {
  const currency = input.currency ?? "MWK";

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // --- Header: business identity + document title/number -----------------
    doc.font("Helvetica-Bold").fontSize(16).text(input.business.name, { continued: false });
    doc.font("Helvetica").fontSize(9).fillColor("#444444");
    const addressLine =
      input.business.physicalAddress ??
      [input.business.city, input.business.district].filter(Boolean).join(", ");
    if (addressLine) doc.text(addressLine);
    if (input.business.phone) doc.text(`Tel: ${input.business.phone}`);
    if (input.business.email) doc.text(input.business.email);
    if (input.business.taxpayerId) doc.text(`TIN: ${input.business.taxpayerId}`);
    if (input.business.vatNumber) doc.text(`VAT Reg. No: ${input.business.vatNumber}`);
    doc.fillColor("#000000");

    const headerBottom = doc.y;
    doc
      .font("Helvetica-Bold")
      .fontSize(18)
      .text(input.documentTitle, 300, 50, { width: 245, align: "right" });
    doc
      .font("Helvetica")
      .fontSize(10)
      .text(`No: ${input.documentNumber}`, 300, 75, { width: 245, align: "right" })
      .text(`Date: ${formatDateIn(input.documentDate, input.timeZone)}`, 300, 90, { width: 245, align: "right" });

    let y = Math.max(headerBottom, 105) + 15;
    doc.moveTo(50, y).lineTo(545, y).strokeColor("#dddddd").stroke();
    y += 15;

    // --- Bill-to + meta lines ------------------------------------------------
    if (input.billTo) {
      doc.font("Helvetica-Bold").fontSize(9).text("Bill To", 50, y);
      doc.font("Helvetica").fontSize(9);
      let billY = y + 13;
      doc.text(input.billTo.name, 50, billY);
      billY += 12;
      if (input.billTo.phone) {
        doc.text(input.billTo.phone, 50, billY);
        billY += 12;
      }
      if (input.billTo.address) {
        doc.text(input.billTo.address, 50, billY);
        billY += 12;
      }
    }

    if (input.metaLines?.length) {
      let metaY = y;
      for (const line of input.metaLines) {
        doc
          .font("Helvetica-Bold")
          .fontSize(9)
          .text(`${line.label}:`, 350, metaY, { width: 90, continued: true })
          .font("Helvetica")
          .text(` ${line.value}`, { width: 105 });
        metaY += 13;
      }
    }

    y += 70;

    // --- Line items table ------------------------------------------------------
    const tableTop = y;
    const colX = { desc: 50, qty: 300, price: 360, disc: 430, total: 490 };
    doc.font("Helvetica-Bold").fontSize(9);
    doc.text("Description", colX.desc, tableTop);
    doc.text("Qty", colX.qty, tableTop, { width: 50, align: "right" });
    doc.text("Price", colX.price, tableTop, { width: 60, align: "right" });
    doc.text("Disc.", colX.disc, tableTop, { width: 50, align: "right" });
    doc.text("Total", colX.total, tableTop, { width: 55, align: "right" });
    y = tableTop + 14;
    doc.moveTo(50, y).lineTo(545, y).strokeColor("#000000").stroke();
    y += 6;

    doc.font("Helvetica").fontSize(9);
    for (const item of input.items) {
      if (y > 700) {
        doc.addPage();
        y = 50;
      }
      const qtyLabel = item.unit ? `${item.quantity} ${item.unit}` : `${item.quantity}`;
      doc.text(item.description, colX.desc, y, { width: 240 });
      doc.text(qtyLabel, colX.qty, y, { width: 50, align: "right" });
      doc.text(fmt(item.unitPrice), colX.price, y, { width: 60, align: "right" });
      doc.text(fmt(item.discount), colX.disc, y, { width: 50, align: "right" });
      doc.text(fmt(item.total), colX.total, y, { width: 55, align: "right" });
      y += 16;
    }

    y += 4;
    doc.moveTo(350, y).lineTo(545, y).strokeColor("#dddddd").stroke();
    y += 8;

    // --- Totals ------------------------------------------------------------
    const totalsRow = (label: string, value: string, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
      doc.text(label, 350, y, { width: 100 });
      doc.text(value, 450, y, { width: 95, align: "right" });
      y += 14;
    };

    totalsRow("Subtotal", `${currency} ${fmt(input.subtotal)}`);
    if (input.discount) totalsRow("Discount", `-${currency} ${fmt(input.discount)}`);
    if (input.tax) totalsRow(input.taxLabel ?? "Tax", `+${currency} ${fmt(input.tax)}`);
    totalsRow("Total", `${currency} ${fmt(input.total)}`, true);
    if (input.amountPaid !== undefined) totalsRow("Amount Paid", `${currency} ${fmt(input.amountPaid)}`);
    if (input.balance !== undefined && input.balance > 0.009) {
      totalsRow("Balance Due", `${currency} ${fmt(input.balance)}`, true);
    }

    // --- Notes / terms / footer ---------------------------------------------
    y += 15;
    if (input.notes) {
      doc.font("Helvetica-Bold").fontSize(9).text("Notes", 50, y);
      doc.font("Helvetica").fontSize(9).text(input.notes, 50, y + 13, { width: 495 });
      y = doc.y + 10;
    }
    if (input.terms) {
      doc.font("Helvetica-Bold").fontSize(9).text("Terms", 50, y);
      doc.font("Helvetica").fontSize(9).text(input.terms, 50, y + 13, { width: 495 });
      y = doc.y + 10;
    }

    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#888888")
      .text(input.footerNote ?? "Generated by Malawi Business Manager", 50, 780, {
        width: 495,
        align: "center",
      });

    doc.end();
  });
}
