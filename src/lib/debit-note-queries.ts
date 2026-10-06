import { prisma } from "./prisma";
import { round2, DebitVatCategory } from "./debit-note-calc";

/**
 * Read-side supplier debit note helpers, Module 44. Kept apart from src/lib/debit-notes.ts (which
 * posts to the ledger and moves stock) so that vat.ts can net debit notes off its input-VAT figures
 * without importing the whole posting path – mirrors src/lib/credit-note-queries.ts exactly.
 *
 * THE ONE RULE: a debit note counts in the period of its `issuedAt`, never in the period of the
 * purchase it debits – same reasoning as credit notes (see that file's comment).
 */

export interface DebitNoteRange {
  from: Date;
  to: Date;
  /** true: issuedAt <= to (report style). false: issuedAt < to (dashboard style, next-day boundary). */
  toInclusive?: boolean;
  branchId?: string | null;
}

export interface DebitNoteReadRow {
  id: string;
  issuedAt: Date;
  branchId: string | null;
  netAmount: number;
  vatAmount: number;
  total: number;
  lines: {
    net: number;
    vatAmount: number;
    vatCategory: DebitVatCategory;
    quantity: number;
    stockOut: boolean;
    unitCost: number;
    productId: string;
    productName: string;
  }[];
}

export async function getDebitNotesInRange(businessId: string, range: DebitNoteRange): Promise<DebitNoteReadRow[]> {
  const notes = await prisma.supplierDebitNote.findMany({
    where: {
      businessId,
      issuedAt: { gte: range.from, ...(range.toInclusive === false ? { lt: range.to } : { lte: range.to }) },
      ...(range.branchId ? { branchId: range.branchId } : {}),
    },
    include: {
      lines: { include: { purchaseItem: { include: { product: { select: { id: true, name: true } } } } } },
    },
    orderBy: { issuedAt: "asc" },
  });

  return notes.map((n) => ({
    id: n.id,
    issuedAt: n.issuedAt,
    branchId: n.branchId,
    netAmount: Number(n.netAmount),
    vatAmount: Number(n.vatAmount),
    total: Number(n.total),
    lines: n.lines.map((l) => ({
      net: Number(l.net),
      vatAmount: Number(l.vatAmount),
      vatCategory: l.vatCategory as DebitVatCategory,
      quantity: Number(l.quantity),
      stockOut: l.stockOut,
      unitCost: Number(l.unitCost),
      productId: l.purchaseItem.product.id,
      productName: l.purchaseItem.product.name,
    })),
  }));
}
