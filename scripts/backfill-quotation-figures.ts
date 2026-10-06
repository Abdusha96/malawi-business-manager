/**
 * Module 78: brings quotations converted BEFORE Module 77 in line with the sale they created.
 *
 *   npx tsx scripts/backfill-quotation-figures.ts            # DRY RUN: prints the plan, changes nothing
 *   npx tsx scripts/backfill-quotation-figures.ts --apply    # writes the updates
 *   npm run quotations:backfill [-- --apply]
 *
 * For every CONVERTED quotation that has not been refreshed yet (quotedTax and quotedTotal both empty):
 *   - tax and total are set to the sale's tax and total, and the old figures are kept as quotedTax / quotedTotal
 *     when they differ, exactly as converting does from Module 77 on.
 *   - a line's VAT category and VAT amount are set from its sale line only when the match is unambiguous
 *     (same product, quantity, unit price, discount and total, one-to-one). Other lines are reported and left alone.
 *   - subtotal, discount, prices and descriptions are never touched.
 * A quotation whose figures already agree with its sale is left untouched. Safe to run more than once: a
 * refreshed quotation carries quotedTotal, so the second run skips it. Each quotation is updated in its own
 * transaction. The decisions live in src/lib/quotation-refresh.ts (verified by verify:service-products).
 */
import { PrismaClient } from "@prisma/client";
import { planConvertedQuotationBackfill } from "../src/lib/quotation-refresh";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();

async function main() {
  console.log(APPLY ? "APPLY mode: changes will be written.\n" : "DRY RUN: nothing will be written (add --apply).\n");

  const quotations = await prisma.quotation.findMany({
    where: { convertedSaleId: { not: null }, quotedTotal: null, quotedTax: null },
    include: { items: true },
    orderBy: { createdAt: "asc" },
  });

  const counts = { UPDATE: 0, SKIP_NO_DIFFERENCE: 0, SKIP_ALREADY_REFRESHED: 0, MISSING_SALE: 0 };
  let unmatchedLines = 0;

  for (const q of quotations) {
    const sale = await prisma.sale.findUnique({ where: { id: q.convertedSaleId! }, include: { items: true } });
    if (!sale || sale.businessId !== q.businessId) {
      counts.MISSING_SALE++;
      console.log(`  ${q.quotationNumber}: the sale it points at was not found in this business, skipped`);
      continue;
    }

    const plan = planConvertedQuotationBackfill({
      quotation: {
        tax: Number(q.tax),
        total: Number(q.total),
        quotedTax: q.quotedTax != null ? Number(q.quotedTax) : null,
        quotedTotal: q.quotedTotal != null ? Number(q.quotedTotal) : null,
        lines: q.items.map((i) => ({
          id: i.id,
          productId: i.productId,
          quantity: Number(i.quantity),
          unitPrice: Number(i.unitPrice),
          discount: Number(i.discount),
          total: Number(i.total),
          vatCategory: i.vatCategory,
          vatAmount: Number(i.vatAmount),
        })),
      },
      sale: {
        tax: Number(sale.tax),
        total: Number(sale.total),
        lines: sale.items.map((i) => ({
          productId: i.productId,
          quantity: Number(i.quantity),
          unitPrice: Number(i.unitPrice),
          discount: Number(i.discount),
          total: Number(i.total),
          vatCategory: i.vatCategory,
          vatAmount: Number(i.vatAmount),
        })),
      },
    });

    counts[plan.action]++;
    unmatchedLines += plan.unmatchedLineIds.length;
    if (plan.action !== "UPDATE") continue;

    console.log(
      `  ${q.quotationNumber}: total ${Number(q.total)} -> ${plan.total}, tax ${Number(q.tax)} -> ${plan.tax}, ` +
        `${plan.lineUpdates.length} line(s) updated` +
        (plan.unmatchedLineIds.length ? `, ${plan.unmatchedLineIds.length} line(s) not matched` : "")
    );
    if (!APPLY) continue;

    await prisma.$transaction(async (tx) => {
      for (const u of plan.lineUpdates) {
        await tx.quotationItem.update({ where: { id: u.id }, data: { vatCategory: u.vatCategory as any, vatAmount: u.vatAmount } });
      }
      await tx.quotation.update({
        where: { id: q.id },
        data: { tax: plan.tax, total: plan.total, quotedTax: plan.quotedTax, quotedTotal: plan.quotedTotal },
      });
    });
  }

  console.log(
    `\n${quotations.length} converted quotation(s) looked at: ${counts.UPDATE} ${APPLY ? "updated" : "would be updated"}, ` +
      `${counts.SKIP_NO_DIFFERENCE} already agree with their sale, ${counts.MISSING_SALE} skipped (sale not found), ` +
      `${unmatchedLines} line(s) could not be matched and were left as they were.`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
