import { prisma } from "./prisma";
import { createSale, SaleValidationError } from "./sales";
import { getVatConfig, computeVatForLines } from "./vat";
import { resolveLineMapping } from "./quotation-line-mapping";
import { planQuotationRefresh } from "./quotation-refresh";
import { QuotationInput, ConvertQuotationInput } from "./validation";
import { Product, QuotationStatus, VatCategory } from "@prisma/client";

/**
 * BUSINESS DOCUMENTS (Module 15) – Quotations.
 *
 * A quotation never touches stock, the Cashbook, or the GL – it's a
 * proposal, not a transaction (contrast with `src/lib/sales.ts`, which is
 * the only place real money/stock effects happen). The only place a
 * quotation has a financial effect is `convertQuotationToSale()` below,
 * which does so by calling the real `createSale()` rather than
 * duplicating its totals/stock/receipt/ledger logic.
 */

export class QuotationValidationError extends Error {}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Module 18 (VAT): computed here purely for accurate display on the
 * quotation and its PDF – a quotation never touches the GL (see the file
 * comment above), so this never posts anything. A free-text line (no
 * productId) has no real VatCategory to read and defaults to STANDARD, an
 * estimate that gets corrected automatically the moment the line is linked
 * to a real product and the quotation converts to a Sale (createSale
 * recomputes VAT fresh from the actual linked product, rather than trusting
 * this snapshot – see convertQuotationToSale below).
 */
function computeQuotationTotals(input: QuotationInput, products: Product[], vatConfig: { vatRegistered: boolean; vatRate: number }) {
  const lineTotals = input.items.map((item) => round2(item.quantity * item.unitPrice - item.discount));
  const subtotal = lineTotals.reduce((sum, t) => sum + t, 0);

  const categories: VatCategory[] = input.items.map((item) => {
    if (!item.productId) return "STANDARD";
    const product = products.find((p) => p.id === item.productId);
    return product?.vatCategory ?? "STANDARD";
  });
  const { vatAmounts, vatTotal } = computeVatForLines(
    lineTotals.map((total, i) => ({ total, category: categories[i] })),
    vatConfig
  );

  const total = round2(subtotal - input.discount + vatTotal);
  return { subtotal: round2(subtotal), total, lineTotals, categories, vatAmounts, vatTotal };
}

export async function createQuotation(params: {
  businessId: string;
  userId: string;
  input: QuotationInput;
}) {
  const { businessId, userId, input } = params;

  return prisma.$transaction(async (tx) => {
    if (input.customerId) {
      const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
      if (!customer || customer.businessId !== businessId) {
        throw new QuotationValidationError("Customer not found in this business.");
      }
    }
    if (input.branchId) {
      const branch = await tx.branch.findUnique({ where: { id: input.branchId } });
      if (!branch || branch.businessId !== businessId) {
        throw new QuotationValidationError("Branch not found in this business.");
      }
    }

    // Product lines are validated (and their names snapshotted into
    // `description` if the caller didn't supply one) – but unlike a Sale,
    // a line without a productId is allowed, since a quotation can propose
    // an item that isn't in inventory yet.
    const productIds = input.items.map((i) => i.productId).filter((id): id is string => !!id);
    const products = productIds.length
      ? await tx.product.findMany({ where: { id: { in: productIds } } })
      : [];
    for (const item of input.items) {
      if (!item.productId) continue;
      const product = products.find((p) => p.id === item.productId);
      if (!product || product.businessId !== businessId) {
        throw new QuotationValidationError(`Product ${item.productId} not found in this business.`);
      }
    }

    const vatConfig = await getVatConfig(businessId);
    const totals = computeQuotationTotals(input, products, vatConfig);

    const business = await tx.business.update({
      where: { id: businessId },
      data: { nextQuotationNumber: { increment: 1 } },
    });
    const quotationNumber = `${business.quotationPrefix}-${String(business.nextQuotationNumber - 1).padStart(6, "0")}`;

    return tx.quotation.create({
      data: {
        businessId,
        branchId: input.branchId ?? undefined,
        customerId: input.customerId ?? undefined,
        customerName: input.customerName ?? undefined,
        quotationNumber,
        expiryDate: input.expiryDate ? new Date(input.expiryDate) : undefined,
        subtotal: totals.subtotal,
        discount: input.discount,
        tax: totals.vatTotal,
        total: totals.total,
        notes: input.notes ?? undefined,
        terms: input.terms ?? undefined,
        createdById: userId,
        items: {
          create: input.items.map((item, i) => ({
            productId: item.productId ?? undefined,
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            discount: item.discount,
            total: totals.lineTotals[i],
            vatCategory: totals.categories[i],
            vatAmount: totals.vatAmounts[i],
          })),
        },
      },
      include: { items: { include: { product: true } }, customer: true },
    });
  });
}

export async function updateQuotation(params: {
  businessId: string;
  quotationId: string;
  input: QuotationInput;
}) {
  const { businessId, quotationId, input } = params;

  return prisma.$transaction(async (tx) => {
    // Module 38: the DRAFT check used to happen BEFORE this transaction, so a
    // conversion that committed in between could have its items deleted and
    // replaced out from under the Sale it had just created. Claiming the row
    // here (a no-op write that only matches a DRAFT) takes the row lock and
    // makes "still DRAFT" and "edit it" one atomic step; a concurrent
    // conversion either finishes first (count 0 → refused) or waits for us.
    const claimed = await tx.quotation.updateMany({
      where: { id: quotationId, businessId, status: "DRAFT" },
      data: { updatedAt: new Date() },
    });
    if (claimed.count === 0) {
      const existing = await tx.quotation.findUnique({ where: { id: quotationId } });
      if (!existing || existing.businessId !== businessId) {
        throw new QuotationValidationError("Quotation not found in this business.");
      }
      throw new QuotationValidationError("Only a DRAFT quotation can be edited – change its status back to DRAFT first, or create a new one.");
    }

    const productIds = input.items.map((i) => i.productId).filter((id): id is string => !!id);
    const products = productIds.length
      ? await tx.product.findMany({ where: { id: { in: productIds } } })
      : [];

    const vatConfig = await getVatConfig(businessId);
    const totals = computeQuotationTotals(input, products, vatConfig);

    await tx.quotationItem.deleteMany({ where: { quotationId } });
    return tx.quotation.update({
      where: { id: quotationId },
      data: {
        branchId: input.branchId ?? undefined,
        customerId: input.customerId ?? undefined,
        customerName: input.customerName ?? undefined,
        expiryDate: input.expiryDate ? new Date(input.expiryDate) : undefined,
        subtotal: totals.subtotal,
        discount: input.discount,
        tax: totals.vatTotal,
        total: totals.total,
        notes: input.notes ?? undefined,
        terms: input.terms ?? undefined,
        items: {
          create: input.items.map((item, i) => ({
            productId: item.productId ?? undefined,
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            discount: item.discount,
            total: totals.lineTotals[i],
            vatCategory: totals.categories[i],
            vatAmount: totals.vatAmounts[i],
          })),
        },
      },
      include: { items: { include: { product: true } }, customer: true },
    });
  });
}

const TERMINAL_STATUSES: QuotationStatus[] = ["CONVERTED"];

export async function setQuotationStatus(params: {
  businessId: string;
  quotationId: string;
  status: Exclude<QuotationStatus, "CONVERTED">;
}) {
  const { businessId, quotationId, status } = params;

  // Module 38: one conditional write instead of read-then-write. The old
  // shape could overwrite CONVERTED with SENT/DECLINED if a conversion
  // committed between the read and the update, leaving a Sale whose
  // quotation no longer said it had been converted.
  const updated = await prisma.quotation.updateMany({
    where: { id: quotationId, businessId, status: { notIn: TERMINAL_STATUSES } },
    data: { status },
  });
  if (updated.count === 0) {
    const existing = await prisma.quotation.findUnique({ where: { id: quotationId } });
    if (!existing || existing.businessId !== businessId) {
      throw new QuotationValidationError("Quotation not found in this business.");
    }
    throw new QuotationValidationError("A converted quotation's status can't be changed – see the sale it created instead.");
  }
  return prisma.quotation.findUniqueOrThrow({ where: { id: quotationId } });
}

/**
 * Statuses a quotation can be converted FROM. DECLINED/EXPIRED need their
 * status changed first (a deliberate second step, so a mis-click on a dead
 * quote can't create a sale); CONVERTED is terminal.
 */
const CONVERTIBLE_STATUSES: QuotationStatus[] = ["DRAFT", "SENT", "ACCEPTED"];

/**
 * Converts an accepted quotation into a real Sale by calling the same
 * `createSale()` every manually-entered sale goes through – so stock
 * deduction, receipt numbering, Cashbook posting, and GL posting all happen
 * exactly the same way, with no second code path to keep in sync.
 *
 * Module 38 – ATOMIC. The whole conversion is ONE transaction:
 *   1. CLAIM the quotation with a conditional write
 *      (`status IN (DRAFT, SENT, ACCEPTED)` → CONVERTED). Postgres row-locks
 *      it, so two people pressing Convert at once can't both proceed: the
 *      second waits, then sees CONVERTED and matches zero rows. Before this
 *      module both passed the read-only "already converted?" check and BOTH
 *      created a Sale (stock, cash and revenue posted twice).
 *   2. Validate the lines and create the Sale via
 *      `createSale({ tx })` inside the same transaction.
 *   3. Record `convertedSaleId`.
 * If anything after step 1 throws – a free-text line, not enough stock, the
 * monthly sales cap, a ledger error – the claim rolls back with everything
 * else and the quotation is exactly as it was. There is no longer a state
 * where the sale exists but the quotation says otherwise.
 *
 * Module 68 – FREE-TEXT LINES. A line with no product (an item not yet
 * stocked) is converted by naming the product it should be sold as in
 * `input.lineProducts`; see `quotation-line-mapping.ts` for the rules. The
 * link is written back to the quotation inside the same transaction, so a
 * failed conversion leaves the line free-text again. A free-text line with no
 * product chosen is still refused - the caller is told which line, never
 * silently dropped, and no product is guessed.
 */
export async function convertQuotationToSale(params: {
  businessId: string;
  quotationId: string;
  userId: string;
  input: ConvertQuotationInput;
}) {
  const { businessId, quotationId, userId, input } = params;

  try {
    return await prisma.$transaction(async (tx) => {
      const claimed = await tx.quotation.updateMany({
        where: { id: quotationId, businessId, status: { in: CONVERTIBLE_STATUSES } },
        data: { status: "CONVERTED" },
      });
      if (claimed.count === 0) {
        // Nothing was claimed – say why. Read inside the same transaction so
        // the explanation matches what the claim actually saw.
        const existing = await tx.quotation.findUnique({ where: { id: quotationId } });
        if (!existing || existing.businessId !== businessId) {
          throw new QuotationValidationError("Quotation not found in this business.");
        }
        if (existing.status === "CONVERTED") {
          throw new QuotationValidationError("This quotation has already been converted to a sale.");
        }
        throw new QuotationValidationError(
          `A ${existing.status.toLowerCase()} quotation can't be converted – change its status first if this was a mistake.`
        );
      }

      const quotation = await tx.quotation.findUniqueOrThrow({
        where: { id: quotationId },
        include: { items: true },
      });

      // Module 68: free-text lines no longer block conversion. The caller may
      // name the product each one should be sold as (`input.lineProducts`);
      // the pure resolver refuses an unknown/duplicate/already-linked line and
      // any line still left without a product, so nothing is dropped and no
      // product is guessed. Everything from here on is inside the claim's
      // transaction, so a refusal below rolls the whole conversion back.
      const mapping = resolveLineMapping(
        quotation.items.map((i) => ({ id: i.id, productId: i.productId, description: i.description })),
        input.lineProducts
      );
      if (!mapping.ok) {
        throw new QuotationValidationError(mapping.message);
      }

      if (mapping.newLinks.length > 0) {
        const wantedIds = Array.from(new Set(mapping.newLinks.map((l) => l.productId)));
        const products = await tx.product.findMany({ where: { id: { in: wantedIds } } });
        for (const link of mapping.newLinks) {
          const product = products.find((p) => p.id === link.productId);
          const line = quotation.items.find((i) => i.id === link.itemId);
          if (!product || product.businessId !== businessId) {
            throw new QuotationValidationError(`The product chosen for "${line?.description ?? "a line"}" wasn't found in this business.`);
          }
          if (!product.isActive) {
            throw new QuotationValidationError(`${product.name} is not active and cannot be sold - choose a different product for "${line?.description ?? "a line"}".`);
          }
        }
        // Record the link on the quotation itself so the converted quotation
        // shows what each line was sold as. Only `productId` is written: the
        // quoted description, price and totals are what the customer was
        // shown and stay as quoted (the Sale recomputes VAT from the product).
        for (const link of mapping.newLinks) {
          await tx.quotationItem.update({ where: { id: link.itemId }, data: { productId: link.productId } });
        }
      }
      const productByItem = new Map(mapping.productIdByItem.map((m) => [m.itemId, m.productId]));

      if (!quotation.customerId && input.amountPaid < Number(quotation.total) - 0.01) {
        throw new QuotationValidationError("A customer must be attached to this quotation for a partial or credit sale – edit it first.");
      }

      const sale = await createSale({
        tx,
        businessId,
        userId,
        input: {
          customerId: quotation.customerId ?? null,
          branchId: quotation.branchId ?? null,
          items: quotation.items.map((item) => ({
            productId: productByItem.get(item.id) as string,
            quantity: Number(item.quantity),
            unitPrice: Number(item.unitPrice),
            discount: Number(item.discount),
          })),
          // Module 18: no `tax` field here – createSale computes VAT itself,
          // fresh, from each linked product's current vatCategory and the
          // business's current VAT registration/rate. This is deliberately
          // NOT the quotation's own snapshotted tax total: a quotation may
          // sit as a DRAFT for weeks, during which the VAT rate, a product's
          // category, or the business's registration status could all have
          // changed – the resulting Sale should reflect reality at the
          // moment it's actually made, not whatever was true when quoted.
          discount: Number(quotation.discount),
          paymentMethod: input.paymentMethod,
          amountPaid: input.amountPaid,
        },
      });

      // Module 77: bring the quotation's VAT and total in line with what the sale just charged, keeping the
      // quoted figures when they differ. VAT is recomputed here with the same function and inputs createSale()
      // used (each linked product's category, the business's current VAT settings), so the two agree.
      const linkedIds = Array.from(new Set(mapping.productIdByItem.map((m) => m.productId)));
      const linkedProducts = await tx.product.findMany({ where: { id: { in: linkedIds } } });
      const vatConfig = await getVatConfig(businessId);
      const categories: VatCategory[] = quotation.items.map(
        (item) => linkedProducts.find((p) => p.id === productByItem.get(item.id))?.vatCategory ?? "STANDARD"
      );
      const lineNets = quotation.items.map((item) => Number(item.total));
      const { vatAmounts } = computeVatForLines(
        lineNets.map((total, i) => ({ total, category: categories[i] })),
        vatConfig
      );
      const plan = planQuotationRefresh({
        lines: quotation.items.map((item, i) => ({
          id: item.id,
          total: lineNets[i],
          category: categories[i],
          vatAmount: vatAmounts[i],
          oldCategory: item.vatCategory,
          oldVatAmount: Number(item.vatAmount),
        })),
        subtotal: Number(quotation.subtotal),
        discount: Number(quotation.discount),
        oldTax: Number(quotation.tax),
        oldTotal: Number(quotation.total),
        existingQuotedTax: quotation.quotedTax != null ? Number(quotation.quotedTax) : null,
        existingQuotedTotal: quotation.quotedTotal != null ? Number(quotation.quotedTotal) : null,
      });
      if (plan.changed) {
        for (const u of plan.lineUpdates) {
          await tx.quotationItem.update({ where: { id: u.id }, data: { vatCategory: u.vatCategory as VatCategory, vatAmount: u.vatAmount } });
        }
      }

      await tx.quotation.update({
        where: { id: quotationId },
        data: {
          convertedSaleId: sale.id,
          ...(plan.changed ? { tax: plan.tax, total: plan.total, quotedTax: plan.quotedTax, quotedTotal: plan.quotedTotal } : {}),
        },
      });

      return sale;
    });
  } catch (err) {
    if (err instanceof SaleValidationError) {
      throw new QuotationValidationError(err.message);
    }
    throw err;
  }
}

export async function listQuotations(params: {
  businessId: string;
  branchId?: string | null;
  status?: QuotationStatus;
}) {
  const { businessId, branchId, status } = params;
  return prisma.quotation.findMany({
    where: {
      businessId,
      ...(branchId ? { branchId } : {}),
      ...(status ? { status } : {}),
    },
    include: { customer: true, items: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function getQuotation(params: { businessId: string; quotationId: string }) {
  const { businessId, quotationId } = params;
  const quotation = await prisma.quotation.findUnique({
    where: { id: quotationId },
    include: {
      items: { include: { product: true } },
      customer: true,
      branch: true,
      business: true,
      convertedSale: true,
    },
  });
  if (!quotation || quotation.businessId !== businessId) return null;
  return quotation;
}
