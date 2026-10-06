/**
 * Module 68 – Linking free-text quotation lines to products at convert time.
 *
 * PURE and import-free on purpose (same split as `tax-installments.ts`,
 * `stock-transfer-receipt.ts`): the "use client" convert form and the
 * server-side `convertQuotationToSale()` share ONE definition of what is a
 * valid mapping, so the form can never enable a button the server will refuse
 * for a reason the form could have seen.
 *
 * Background. A quotation may propose an item that isn't in inventory yet
 * (a line with no `productId`). A Sale can't be created for such a line - it
 * has to decrement real stock - so until this module, converting a quotation
 * with a free-text line was refused and the user had to leave, edit the
 * quotation, link the line, and come back. That is the only thing standing
 * between "customer accepted" and "sale recorded", and it is the common case
 * for a shop that quotes before it has stocked.
 *
 * What this decides, given the quotation's lines and the caller's choices:
 *   - a choice may only name a line that EXISTS on this quotation;
 *   - a choice may only name a line that is STILL free-text. An already-linked
 *     line is never re-pointed here - silently swapping the product on a line
 *     someone deliberately linked is exactly the sort of quiet change a
 *     conversion must not make. Edit the quotation to change it;
 *   - a line can be chosen once;
 *   - after applying the choices, EVERY line must be linked. Nothing is
 *     dropped and no product is guessed.
 *
 * It does not check that a product exists, belongs to the business or is
 * active - that needs the database and is done by the caller (and again by
 * `createSale()`), which is why this file has no imports.
 */

export type MappableLine = {
  id: string;
  productId: string | null;
  description: string;
};

export type LineProductChoice = {
  itemId: string;
  productId: string;
};

export type LineMappingResult =
  | {
      ok: true;
      /** The product every line will be sold as, in the quotation's own line order. */
      productIdByItem: { itemId: string; productId: string }[];
      /** Only the lines this call newly links (what must be written back). */
      newLinks: LineProductChoice[];
    }
  | { ok: false; message: string; code: LineMappingErrorCode; itemIds: string[] };

export type LineMappingErrorCode =
  | "NO_LINES"
  | "BLANK_CHOICE"
  | "DUPLICATE_LINE"
  | "UNKNOWN_LINE"
  | "ALREADY_LINKED"
  | "STILL_UNLINKED";

/** How many unlinked line names to spell out before saying "and N more". */
const NAMES_SHOWN = 3;

function quote(s: string): string {
  return `"${s.trim() || "(no description)"}"`;
}

/** The lines that still have no product - what the convert form must ask about. */
export function freeTextLines<T extends MappableLine>(lines: T[]): T[] {
  return lines.filter((l) => !l.productId);
}

export function resolveLineMapping(
  lines: MappableLine[],
  choices: LineProductChoice[] | undefined | null
): LineMappingResult {
  if (lines.length === 0) {
    return { ok: false, code: "NO_LINES", message: "This quotation has no items.", itemIds: [] };
  }

  const byId = new Map(lines.map((l) => [l.id, l]));
  const chosen = new Map<string, string>();

  for (const c of choices ?? []) {
    const itemId = (c.itemId ?? "").trim();
    const productId = (c.productId ?? "").trim();
    if (!itemId || !productId) {
      return {
        ok: false,
        code: "BLANK_CHOICE",
        message: "Every product choice needs both a quotation line and a product.",
        itemIds: itemId ? [itemId] : [],
      };
    }
    const line = byId.get(itemId);
    if (!line) {
      return {
        ok: false,
        code: "UNKNOWN_LINE",
        message: "One of the chosen lines isn't on this quotation - reload the page and try again.",
        itemIds: [itemId],
      };
    }
    if (chosen.has(itemId)) {
      return {
        ok: false,
        code: "DUPLICATE_LINE",
        message: `${quote(line.description)} was given more than one product - choose one.`,
        itemIds: [itemId],
      };
    }
    if (line.productId) {
      return {
        ok: false,
        code: "ALREADY_LINKED",
        message: `${quote(line.description)} is already linked to a product - edit the quotation if it should be a different one.`,
        itemIds: [itemId],
      };
    }
    chosen.set(itemId, productId);
  }

  const stillFree = lines.filter((l) => !l.productId && !chosen.has(l.id));
  if (stillFree.length > 0) {
    const shown = stillFree.slice(0, NAMES_SHOWN).map((l) => quote(l.description)).join(", ");
    const more = stillFree.length > NAMES_SHOWN ? ` and ${stillFree.length - NAMES_SHOWN} more` : "";
    return {
      ok: false,
      code: "STILL_UNLINKED",
      message:
        stillFree.length === 1
          ? `${shown} isn't linked to a real product - choose the product it should be sold as, or edit the quotation.`
          : `${shown}${more} aren't linked to real products - choose the product each should be sold as, or edit the quotation.`,
      itemIds: stillFree.map((l) => l.id),
    };
  }

  return {
    ok: true,
    productIdByItem: lines.map((l) => ({ itemId: l.id, productId: (l.productId ?? chosen.get(l.id)) as string })),
    newLinks: lines.filter((l) => !l.productId).map((l) => ({ itemId: l.id, productId: chosen.get(l.id) as string })),
  };
}
