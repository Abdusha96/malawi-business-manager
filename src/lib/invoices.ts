import { prisma } from "./prisma";
import { logAudit } from "./audit";

/**
 * BUSINESS DOCUMENTS (Module 15) – Invoices.
 *
 * Mirrors the lazy-creation pattern `Receipt` already uses (Module 3): an
 * Invoice doesn't exist until someone asks for one, at which point its
 * number is claimed atomically from `Business.nextInvoiceNumber` (a field
 * that has existed, unused, since Module 1). Calling this twice for the
 * same sale returns the existing invoice rather than claiming a second
 * number – an invoice number, once issued, must never change underneath a
 * document a customer may already have a copy of.
 */

export class InvoiceValidationError extends Error {}

export async function getOrCreateInvoiceForSale(params: {
  businessId: string;
  saleId: string;
  userId: string;
  dueDate?: string | null;
  terms?: string | null;
}) {
  const { businessId, saleId, userId, dueDate, terms } = params;

  const existing = await prisma.invoice.findUnique({ where: { saleId } });
  if (existing) {
    if (existing.businessId !== businessId) {
      throw new InvoiceValidationError("Invoice not found in this business.");
    }
    return existing;
  }

  const sale = await prisma.sale.findUnique({ where: { id: saleId } });
  if (!sale || sale.businessId !== businessId) {
    throw new InvoiceValidationError("Sale not found in this business.");
  }
  if (sale.status === "VOIDED") {
    throw new InvoiceValidationError("Can't generate an invoice for a voided sale.");
  }

  return prisma.$transaction(async (tx) => {
    // Re-check inside the transaction – two concurrent requests for the
    // same sale's first invoice must not claim two numbers.
    const raced = await tx.invoice.findUnique({ where: { saleId } });
    if (raced) return raced;

    const business = await tx.business.update({
      where: { id: businessId },
      data: { nextInvoiceNumber: { increment: 1 } },
    });
    const invoiceNumber = `${business.invoicePrefix}-${String(business.nextInvoiceNumber - 1).padStart(6, "0")}`;

    const invoice = await tx.invoice.create({
      data: {
        businessId,
        saleId,
        invoiceNumber,
        dueDate: dueDate ? new Date(dueDate) : undefined,
        terms: terms ?? undefined,
      },
    });

    await logAudit({
      tx,
      businessId,
      userId,
      action: "invoice.generate",
      entityType: "Invoice",
      entityId: invoice.id,
      metadata: { saleId, invoiceNumber },
    });

    return invoice;
  });
}

export async function getInvoiceForSale(params: { businessId: string; saleId: string }) {
  const { businessId, saleId } = params;
  const invoice = await prisma.invoice.findUnique({
    where: { saleId },
    include: {
      sale: {
        include: { items: { include: { product: true } }, customer: true, business: true },
      },
    },
  });
  if (!invoice || invoice.businessId !== businessId) return null;
  return invoice;
}
