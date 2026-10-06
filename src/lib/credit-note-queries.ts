import { prisma } from "./prisma";
import { round2, CreditVatCategory } from "./credit-note-calc";

/**
 * Read-side credit note helpers, Module 43. Kept apart from src/lib/credit-notes.ts (which posts to the
 * ledger, moves stock and touches the cashbook) so that vat.ts, reports.ts, dashboard.ts, branches.ts
 * and ai-analysis.ts can net credit notes off their figures without importing the whole posting path.
 *
 * THE ONE RULE THEY SHARE: a credit note counts in the period of its `issuedAt`, never in the period of
 * the sale it credits. A March sale credited in April lowers April's numbers and leaves March's alone.
 * That is what lets a closed period stay closed (Module 42) and matches the ledger entry, which is
 * dated when the credit note was issued.
 *
 * There is no "voided" credit note in this module, so every row counts. If a later module adds one,
 * every function here is the single place to exclude it.
 */

export interface CreditNoteRange {
  from: Date;
  to: Date;
  /** true: issuedAt <= to (report style). false: issuedAt < to (dashboard style, next-day boundary). */
  toInclusive?: boolean;
  branchId?: string | null;
}

export interface CreditNoteReadRow {
  id: string;
  issuedAt: Date;
  branchId: string | null;
  salespersonId: string;
  netAmount: number;
  vatAmount: number;
  total: number;
  costRestored: number;
  lines: {
    net: number;
    vatAmount: number;
    vatCategory: CreditVatCategory;
    quantity: number;
    restock: boolean;
    unitCost: number;
    productId: string;
    productName: string;
  }[];
}

export async function getCreditNotesInRange(businessId: string, range: CreditNoteRange): Promise<CreditNoteReadRow[]> {
  const notes = await prisma.creditNote.findMany({
    where: {
      businessId,
      issuedAt: { gte: range.from, ...(range.toInclusive === false ? { lt: range.to } : { lte: range.to }) },
      ...(range.branchId ? { branchId: range.branchId } : {}),
    },
    include: {
      sale: { select: { salespersonId: true } },
      lines: { include: { saleItem: { include: { product: { select: { id: true, name: true } } } } } },
    },
    orderBy: { issuedAt: "asc" },
  });

  return notes.map((n) => ({
    id: n.id,
    issuedAt: n.issuedAt,
    branchId: n.branchId,
    salespersonId: n.sale.salespersonId,
    netAmount: Number(n.netAmount),
    vatAmount: Number(n.vatAmount),
    total: Number(n.total),
    costRestored: Number(n.costRestored),
    lines: n.lines.map((l) => ({
      net: Number(l.net),
      vatAmount: Number(l.vatAmount),
      vatCategory: l.vatCategory as CreditVatCategory,
      quantity: Number(l.quantity),
      restock: l.restock,
      unitCost: Number(l.unitCost),
      productId: l.saleItem.product.id,
      productName: l.saleItem.product.name,
    })),
  }));
}

/** Sum of credit note totals (VAT included) in a range, for the plain "sales total" figures. */
export async function sumCreditNoteTotal(businessId: string, range: CreditNoteRange): Promise<number> {
  const agg = await prisma.creditNote.aggregate({
    where: {
      businessId,
      issuedAt: { gte: range.from, ...(range.toInclusive === false ? { lt: range.to } : { lte: range.to }) },
      ...(range.branchId ? { branchId: range.branchId } : {}),
    },
    _sum: { total: true },
  });
  return round2(Number(agg._sum.total ?? 0));
}

/** Credit note totals per branch, for the branches screen. Credit notes with no branch are left out, like sales are. */
export async function sumCreditNoteTotalByBranch(businessId: string): Promise<Map<string, number>> {
  const grouped = await prisma.creditNote.groupBy({
    by: ["branchId"],
    where: { businessId },
    _sum: { total: true },
  });
  return new Map(grouped.filter((g) => g.branchId).map((g) => [g.branchId as string, round2(Number(g._sum.total ?? 0))]));
}
