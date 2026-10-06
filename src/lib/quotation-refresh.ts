/**
 * Module 77 - A converted quotation shows what the sale actually charged.
 *
 * PURE and import-free (same split as `quotation-line-mapping.ts`).
 *
 * Background. A quotation prices a free-text line as STANDARD-rated, because it has no product to read a VAT
 * category from. Converting links the line to a real product and `createSale()` recomputes VAT from that
 * product and the business's VAT settings today. Until now the quotation kept its old tax and total, so a
 * converted quotation could show MWK 1,160 while the sale it created charged MWK 1,000 (zero-rated product) or
 * a different rate. Module 68 documented this as a limitation.
 *
 * What this decides. Given each quotation line's net total, the category it ended up with and the VAT amount
 * the sale computed for it, plus the document discount, it returns the new per-line VAT, the new tax and total,
 * and whether anything changed. When something changed, the old figures are kept as `quotedTax` and
 * `quotedTotal` so the page and PDF can say "quoted X, charged Y". When nothing changed, nothing is written.
 *
 * Subtotal, discount, prices and descriptions are never touched: they are what the customer was shown.
 */

export type RefreshLine = {
  id: string;
  /** The net line total, as quoted. */
  total: number;
  /** The VAT category now in force for the line. */
  category: string;
  /** The VAT amount now in force for the line. */
  vatAmount: number;
  /** What the quotation held for the line before conversion. */
  oldCategory: string;
  oldVatAmount: number;
};

export type RefreshInput = {
  lines: RefreshLine[];
  subtotal: number;
  discount: number;
  oldTax: number;
  oldTotal: number;
  /** Set when an earlier refresh already recorded the quoted figures. They are never overwritten. */
  existingQuotedTax: number | null;
  existingQuotedTotal: number | null;
};

export type RefreshPlan = {
  changed: boolean;
  tax: number;
  total: number;
  quotedTax: number | null;
  quotedTotal: number | null;
  /** Only the lines whose category or VAT amount changed. */
  lineUpdates: { id: string; vatCategory: string; vatAmount: number }[];
};

const MONEY_EPS = 0.005;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function planQuotationRefresh(input: RefreshInput): RefreshPlan {
  const tax = round2(input.lines.reduce((sum, l) => sum + l.vatAmount, 0));
  const total = round2(input.subtotal - input.discount + tax);

  const lineUpdates = input.lines
    .filter((l) => l.category !== l.oldCategory || Math.abs(l.vatAmount - l.oldVatAmount) > MONEY_EPS)
    .map((l) => ({ id: l.id, vatCategory: l.category, vatAmount: round2(l.vatAmount) }));

  const figuresChanged = Math.abs(tax - input.oldTax) > MONEY_EPS || Math.abs(total - input.oldTotal) > MONEY_EPS;
  const changed = figuresChanged || lineUpdates.length > 0;

  if (!changed) {
    return { changed: false, tax: input.oldTax, total: input.oldTotal, quotedTax: input.existingQuotedTax, quotedTotal: input.existingQuotedTotal, lineUpdates: [] };
  }

  // Keep the first quoted figures. A second refresh must not replace what the customer originally saw.
  const quotedTax = input.existingQuotedTax ?? (figuresChanged ? input.oldTax : null);
  const quotedTotal = input.existingQuotedTotal ?? (figuresChanged ? input.oldTotal : null);

  return { changed: true, tax, total, quotedTax, quotedTotal, lineUpdates };
}

/** One line for the quotation page and PDF, or null when the quoted figures were never different. */
export function describeQuotedDifference(quotedTotal: number | null, total: number, currency = "MWK"): string | null {
  if (quotedTotal === null) return null;
  const diff = round2(total - quotedTotal);
  if (Math.abs(diff) <= MONEY_EPS) return null;
  const fmt = (n: number) => `${currency} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `Quoted at ${fmt(quotedTotal)}. The sale charged ${fmt(total)} (${diff > 0 ? "+" : "-"}${fmt(Math.abs(diff))}) because VAT was recalculated from the product sold.`;
}

// ---------------------------------------------------------------------------------------------------------
// Module 78 - backfill for quotations converted before Module 77.
//
// Those quotations kept the tax and total they were quoted at, even when the sale they created charged
// something else. The sale is the record of what was charged, so the quotation takes its tax and total from the
// sale. Lines are matched one-to-one on product, quantity, unit price and line discount; a line is only updated
// when its match is unambiguous, so a quotation with two identical lines never gets them swapped.
// ---------------------------------------------------------------------------------------------------------

export type BackfillQuotationLine = {
  id: string;
  productId: string | null;
  quantity: number;
  unitPrice: number;
  discount: number;
  total: number;
  vatCategory: string;
  vatAmount: number;
};

export type BackfillSaleLine = {
  productId: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  total: number;
  vatCategory: string;
  vatAmount: number;
};

export type BackfillInput = {
  quotation: {
    tax: number;
    total: number;
    quotedTax: number | null;
    quotedTotal: number | null;
    lines: BackfillQuotationLine[];
  };
  sale: { tax: number; total: number; lines: BackfillSaleLine[] };
};

export type BackfillPlan = {
  action: "UPDATE" | "SKIP_ALREADY_REFRESHED" | "SKIP_NO_DIFFERENCE";
  tax: number;
  total: number;
  quotedTax: number | null;
  quotedTotal: number | null;
  lineUpdates: { id: string; vatCategory: string; vatAmount: number }[];
  /** Quotation lines that could not be matched to exactly one sale line. Their VAT is left as it was. */
  unmatchedLineIds: string[];
};

function sameLine(q: BackfillQuotationLine, s: BackfillSaleLine): boolean {
  return (
    q.productId === s.productId &&
    Math.abs(q.quantity - s.quantity) < 0.0005 &&
    Math.abs(q.unitPrice - s.unitPrice) < MONEY_EPS &&
    Math.abs(q.discount - s.discount) < MONEY_EPS &&
    Math.abs(q.total - s.total) < MONEY_EPS
  );
}

export function planConvertedQuotationBackfill(input: BackfillInput): BackfillPlan {
  const { quotation: q, sale } = input;
  const unchanged = {
    tax: q.tax,
    total: q.total,
    quotedTax: q.quotedTax,
    quotedTotal: q.quotedTotal,
    lineUpdates: [] as BackfillPlan["lineUpdates"],
    unmatchedLineIds: [] as string[],
  };

  // Module 77 already refreshed it (or recorded the quoted figures): never touch it again.
  if (q.quotedTotal !== null || q.quotedTax !== null) return { action: "SKIP_ALREADY_REFRESHED", ...unchanged };

  // Match lines one-to-one. A quotation line counts as matched only when exactly one candidate sale line
  // fits it AND exactly one quotation line fits that sale line.
  const lineUpdates: BackfillPlan["lineUpdates"] = [];
  const unmatched: string[] = [];
  for (const ql of q.lines) {
    const candidates = sale.lines.filter((sl) => sameLine(ql, sl));
    const rivals = q.lines.filter((other) => candidates.length === 1 && sameLine(other, candidates[0]));
    if (candidates.length !== 1 || rivals.length !== 1) {
      unmatched.push(ql.id);
      continue;
    }
    const sl = candidates[0];
    if (sl.vatCategory !== ql.vatCategory || Math.abs(sl.vatAmount - ql.vatAmount) > MONEY_EPS) {
      lineUpdates.push({ id: ql.id, vatCategory: sl.vatCategory, vatAmount: round2(sl.vatAmount) });
    }
  }

  const figuresDiffer = Math.abs(sale.tax - q.tax) > MONEY_EPS || Math.abs(sale.total - q.total) > MONEY_EPS;
  if (!figuresDiffer && lineUpdates.length === 0) return { action: "SKIP_NO_DIFFERENCE", ...unchanged, unmatchedLineIds: unmatched };

  return {
    action: "UPDATE",
    tax: round2(sale.tax),
    total: round2(sale.total),
    quotedTax: figuresDiffer ? q.tax : null,
    quotedTotal: figuresDiffer ? q.total : null,
    lineUpdates,
    unmatchedLineIds: unmatched,
  };
}
