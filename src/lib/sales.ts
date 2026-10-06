import { prisma } from "./prisma";
import { recordInventoryMovement, StockError } from "./inventory";
import { postCashTransactionForPayment } from "./cashbook";
import { postJournalEntryForSale, postJournalEntryForPayment, reverseJournalEntryForVoidedSale } from "./accounting-integrations";
import { redeemCustomerCredit } from "./credits";
import { getVatConfig, computeVatForLines } from "./vat";
import { requirePlanCapacity, getSalesThisMonthCount } from "./subscription";
import { SaleInput } from "./validation";
import { assertRecordDateOpen } from "./period-close";
import { assertNoCreditNotes, CreditNoteError } from "./credit-notes";
import { assertForeignCurrencyAllowed, ForeignSettlementError } from "./foreign-settlement";
import { splitLineCosts } from "./product-kind";
import { Prisma, Product, SaleStatus, VatCategory } from "@prisma/client";

/**
 * MONEY RULE: totals are always recalculated server-side from the submitted
 * line items – never trust a client-supplied subtotal/total. This function
 * is the only place a Sale is created, so it's the only place that math can
 * go wrong; keep it that way rather than duplicating the calculation in a
 * route handler.
 *
 * Module 18 (VAT): `tax` is no longer a client-supplied number (see
 * validation.ts's saleSchema) – it's computed here, per line, from each
 * product's own vatCategory and the business's VAT registration/rate. This
 * needs each item's real Product row, which is why this function takes
 * `products` (already loaded, inside the transaction, by the caller) rather
 * than staying a pure function like it looked before this module.
 */
function computeSaleTotals(input: SaleInput, products: Product[], vatConfig: { vatRegistered: boolean; vatRate: number }) {
  const lineTotals = input.items.map((item) => round2(item.quantity * item.unitPrice - item.discount));
  const subtotal = lineTotals.reduce((sum, t) => sum + t, 0);

  const categories: VatCategory[] = input.items.map((item) => {
    const product = products.find((p) => p.id === item.productId)!;
    return product.vatCategory;
  });
  const { vatAmounts, vatTotal } = computeVatForLines(
    lineTotals.map((total, i) => ({ total, category: categories[i] })),
    vatConfig
  );

  const total = round2(subtotal - input.discount + vatTotal);
  const amountPaid = round2(input.amountPaid);
  const balance = round2(total - amountPaid);

  let status: SaleStatus;
  if (balance <= 0.01) status = "PAID";
  else if (amountPaid > 0) status = "PARTIAL";
  else status = "CREDIT";

  return { subtotal: round2(subtotal), total, amountPaid, balance, status, lineTotals, categories, vatAmounts, vatTotal };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export class SaleValidationError extends Error {}

/**
 * Module 38: createSale() can now run inside a caller-supplied transaction.
 *
 * Pass `tx` to make the whole sale (stock, receipt, payment, cashbook, GL,
 * credit sweep) part of the CALLER'S transaction – if anything later in that
 * transaction throws, none of it is committed. Omit `tx` and it opens its own
 * `prisma.$transaction`, exactly as before, so every existing caller is
 * unchanged. The only caller that passes `tx` today is
 * `convertQuotationToSale()`, which needs the sale and the quotation's
 * CONVERTED marker to commit or roll back together.
 *
 * Do NOT add a second sale-creation path: anything that needs "create a sale
 * and also do X atomically" should pass its `tx` here.
 */
export async function createSale(params: {
  businessId: string;
  userId: string;
  input: SaleInput;
  tx?: Prisma.TransactionClient;
}) {
  const { tx: outerTx, ...rest } = params;
  if (outerTx) return createSaleInTransaction(outerTx, rest);
  return prisma.$transaction((tx) => createSaleInTransaction(tx, rest));
}

async function createSaleInTransaction(
  tx: Prisma.TransactionClient,
  params: { businessId: string; userId: string; input: SaleInput }
) {
  const { businessId, userId, input } = params;

  // Module 26: re-checked here inside the transaction against the
  // current count, not at some earlier moment – same reasoning as the
  // re-check `acceptInvitation()` does for the "users" resource (Module
  // 14), so two concurrent sales near the monthly cap can't both slip
  // through. maxSalesPerMonth existed on PlanDefinition since Module 1
  // but nothing enforced it until now.
  const salesThisMonth = await getSalesThisMonthCount(businessId, tx);
  await requirePlanCapacity(businessId, "sales", salesThisMonth);

  // Lock in product data (price snapshot + stock check) inside the
  // transaction so concurrent sales can't both succeed against stock that
  // only exists once.
  const productIds = input.items.map((i) => i.productId);
  const products = await tx.product.findMany({ where: { id: { in: productIds } } });

  for (const item of input.items) {
    const product = products.find((p) => p.id === item.productId);
    if (!product || product.businessId !== businessId) {
      throw new SaleValidationError(`Product ${item.productId} not found in this business.`);
    }
    if (!product.isActive) {
      throw new SaleValidationError(`${product.name} is not active and cannot be sold.`);
    }
  }

  // Module 18 (VAT): read inside the transaction, same reasoning as the
  // product snapshot above – a business flipping vatRegistered mid-sale
  // is an edge case, but reading it once and reusing it for both the
  // totals and the per-item snapshots keeps the numbers internally
  // consistent within this one sale.
  const vatConfig = await getVatConfig(businessId);
  const totals = computeSaleTotals(input, products, vatConfig);

  if (input.customerId) {
    // Claim the active customer row inside the same transaction as the Sale.
    // This both rejects direct API attempts against inactive records and
    // serializes against a concurrent customer deactivation.
    const customer = await tx.customer.updateMany({
      where: { id: input.customerId, businessId, isActive: true },
      data: { isActive: true },
    });
    if (customer.count !== 1) {
      throw new SaleValidationError("Customer not found or inactive in this business.");
    }
    const customerDetails = await tx.customer.findUnique({
      where: { id: input.customerId },
      select: { creditLimit: true },
    });
    const creditLimit = Number(customerDetails?.creditLimit ?? 0);
    if (creditLimit > 0) {
      const currentDebt = await tx.sale.aggregate({
        where: {
          businessId,
          customerId: input.customerId,
          status: { in: ["PARTIAL", "CREDIT"] },
          balance: { gt: 0 },
        },
        _sum: { balance: true },
      });
      const outstanding = Number(currentDebt._sum.balance ?? 0);
      const newBalance = Math.max(0, round2(Number(totals.total) - input.amountPaid));
      if (outstanding + newBalance > creditLimit + 0.01) {
        throw new SaleValidationError(
          `This sale would exceed the customer's credit limit. Current balance: MWK ${outstanding.toFixed(2)}; sale balance: MWK ${newBalance.toFixed(2)}; limit: MWK ${creditLimit.toFixed(2)}. Collect more payment or adjust the limit first.`
        );
      }
    }
  }

  try {
    await assertForeignCurrencyAllowed(tx, businessId, input.currency); // Module 40
  } catch (err) {
    if (err instanceof ForeignSettlementError) throw new SaleValidationError(err.message);
    throw err;
  }

  if (input.branchId) {
    const branch = await tx.branch.findUnique({ where: { id: input.branchId } });
    if (!branch || branch.businessId !== businessId) {
      throw new SaleValidationError("Branch not found in this business.");
    }
  }

  // Atomically claim the next sale number and receipt number so two
  // concurrent sales never collide – increment-and-read in one update.
  const business = await tx.business.update({
    where: { id: businessId },
    data: {
      nextSaleNumber: { increment: 1 },
      nextReceiptNumber: { increment: 1 },
    },
  });
  const saleNumber = `${business.salePrefix}-${String(business.nextSaleNumber - 1).padStart(6, "0")}`;
  const receiptNumber = `${business.receiptPrefix}-${String(business.nextReceiptNumber - 1).padStart(6, "0")}`;

  const sale = await tx.sale.create({
    data: {
      businessId,
      branchId: input.branchId ?? undefined,
      customerId: input.customerId ?? undefined,
      saleNumber,
      subtotal: totals.subtotal,
      discount: input.discount,
      tax: totals.vatTotal,
      total: totals.total,
      amountPaid: totals.amountPaid,
      balance: totals.balance,
      paymentMethod: input.paymentMethod,
      status: totals.status,
      currency: input.currency ?? undefined, // Module 40 – null/undefined = kwacha document
      exchangeRate: input.exchangeRate ?? undefined,
      salespersonId: userId,
      items: {
        create: input.items.map((item, i) => {
          const product = products.find((p) => p.id === item.productId)!;
          return {
            productId: item.productId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            // snapshot now - this product's purchase price may change later. Module 78: for a service this is
            // what it costs to provide one unit, and the ledger recognises it against Service Cost Clearing.
            unitCost: product.purchasePrice,
            discount: item.discount,
            total: totals.lineTotals[i],
            vatCategory: totals.categories[i],
            vatAmount: totals.vatAmounts[i],
          };
        }),
      },
    },
    include: { items: true },
  });

  // Decrement stock for each line item – this is what
  // recordInventoryMovement's shared-transaction support (`tx`) exists for.
  for (const item of sale.items) {
    try {
      await recordInventoryMovement({
        tx,
        businessId,
        productId: item.productId,
        type: "SALE",
        delta: -Number(item.quantity),
        branchId: sale.branchId,
        referenceType: "Sale",
        referenceId: sale.id,
        createdById: userId,
      });
    } catch (err) {
      if (err instanceof StockError) {
        // Re-throw as a SaleValidationError so the route handler doesn't
        // need to know about inventory internals to report it well.
        throw new SaleValidationError(err.message);
      }
      throw err;
    }
  }

  await tx.receipt.create({
    data: { businessId, saleId: sale.id, receiptNumber },
  });

  const { goodsCost, serviceCost } = splitLineCosts(
    sale.items.map((item) => ({
      isStocked: products.find((p) => p.id === item.productId)!.isStocked,
      quantity: Number(item.quantity),
      unitCost: Number(item.unitCost),
    }))
  );
  await postJournalEntryForSale({
    tx,
    businessId,
    saleId: sale.id,
    saleNumber,
    total: totals.total,
    vatAmount: totals.vatTotal,
    cost: goodsCost,
    serviceCost,
    createdById: userId,
  });

  if (totals.amountPaid > 0) {
    const payment = await tx.payment.create({
      data: {
        businessId,
        saleId: sale.id,
        customerId: input.customerId ?? undefined,
        amount: totals.amountPaid,
        method: input.paymentMethod,
        recordedById: userId,
      },
    });
    await postCashTransactionForPayment({
      tx,
      businessId,
      paymentId: payment.id,
      createdById: userId,
      cashAccountId: input.cashAccountId,
    });
    await postJournalEntryForPayment({
      tx,
      businessId,
      paymentId: payment.id,
      amount: totals.amountPaid,
      method: input.paymentMethod,
      isCustomerSide: true,
      createdById: userId,
    });
  }

  // Module 17: if this customer is carrying any standing credit
  // (overpayment or an unredeemed CREDIT_NOTE refund), automatically
  // sweep as much of it as fits against their oldest open balance – which
  // may be this brand-new sale, an older one, or both. See
  // src/lib/credits.ts::redeemCustomerCredit for the FIFO/source-order
  // logic; omitting `amount` here means "spend as much as fits."
  if (input.customerId) {
    await redeemCustomerCredit({ tx, businessId, customerId: input.customerId, createdById: userId });
  }

  return tx.sale.findUniqueOrThrow({
    where: { id: sale.id },
    include: { items: { include: { product: true } }, customer: true, receipt: true },
  });
}

/**
 * Voiding restores stock and marks the sale VOIDED. It does NOT delete the
 * sale or its items – spec section 28 requires an audit trail, and a
 * deleted sale would silently break both the receipt history and, later,
 * the accounting ledger this sale will post to.
 *
 * KNOWN GAP: voiding does NOT reverse any cash already collected – if the
 * sale had a payment, that CashTransaction (Module 9) stays posted, so the
 * cash balance stays inflated relative to the now-voided sale. Voiding a
 * paid sale is really a refund, which is a distinct workflow (does the
 * customer get cash back, store credit, or nothing because it was a
 * data-entry error?) that this function deliberately doesn't guess at.
 * A Refunds module should handle this explicitly rather than this function
 * silently posting a cash reversal that might be wrong. The accounting
 * posting (Module 11) mirrors this exact split deliberately: only the
 * COGS/Inventory journal entry is reversed on void, while the Revenue/AR
 * entry and any payment entry stand – see
 * src/lib/accounting-integrations.ts::postJournalEntryForSale for why.
 */
export async function voidSale(params: { businessId: string; saleId: string; userId: string; reason: string }) {
  const { businessId, saleId, userId, reason } = params;

  return prisma.$transaction(async (tx) => {
    // Module 43: take the sale row lock FIRST, then read. A credit note being issued against this sale
    // at the same instant either commits before we look (and the check below refuses the void) or waits
    // for this void to commit (and is then refused because the sale is VOIDED). The lock order is
    // sale row, then Business row (assertRecordDateOpen), the same order payments use.
    const locked = await tx.sale.updateMany({ where: { id: saleId, businessId }, data: { updatedAt: new Date() } });
    if (locked.count === 0) {
      throw new SaleValidationError("Sale not found in this business.");
    }
    const sale = await tx.sale.findUniqueOrThrow({ where: { id: saleId }, include: { items: true } });
    if (sale.status === "VOIDED") {
      throw new SaleValidationError("This sale has already been voided.");
    }
    // Module 42: the VAT return and every report read this sale's own row, so voiding one that
    // sits in a closed period would change a period that is already filed. See period-close.ts.
    await assertRecordDateOpen({ tx, businessId, instant: sale.saleDate, what: `sale ${sale.saleNumber}`, mode: "change" });
    // Module 43: a sale with credit notes has already had part of it reversed (and restocked).
    try {
      await assertNoCreditNotes(tx, sale.id, sale.saleNumber);
    } catch (err) {
      if (err instanceof CreditNoteError) throw new SaleValidationError(err.message);
      throw err;
    }

    for (const item of sale.items) {
      await recordInventoryMovement({
        tx,
        businessId,
        productId: item.productId,
        type: "RETURN_IN",
        delta: Number(item.quantity), // restore the stock that was sold
        branchId: sale.branchId, // restore to the same branch it was sold from
        referenceType: "SaleVoid",
        referenceId: sale.id,
        reason: `Sale ${sale.saleNumber} voided: ${reason}`,
        createdById: userId,
      });
    }

    await reverseJournalEntryForVoidedSale({
      tx,
      businessId,
      saleId: sale.id,
      saleNumber: sale.saleNumber,
      createdById: userId,
    });

    return tx.sale.update({
      where: { id: saleId },
      data: { status: "VOIDED", voidedAt: new Date(), voidReason: reason },
    });
  });
}
