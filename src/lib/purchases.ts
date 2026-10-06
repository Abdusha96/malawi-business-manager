import { prisma } from "./prisma";
import { assertForeignCurrencyAllowed, ForeignSettlementError } from "./foreign-settlement";
import { recordInventoryMovement, StockError } from "./inventory";
import { postCashTransactionForPayment } from "./cashbook";
import { postJournalEntryForPurchase, postJournalEntryForPayment, reverseJournalEntryForVoidedPurchase } from "./accounting-integrations";
import { redeemSupplierCredit } from "./credits";
import { getVatConfig, computeVatForLines } from "./vat";
import { PurchaseInput } from "./validation";
import { assertRecordDateOpen } from "./period-close";
import { assertNoDebitNotes, DebitNoteError } from "./debit-notes";
import { splitNetByKind } from "./product-kind";
import { Product, PurchaseStatus, VatCategory } from "@prisma/client";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export class PurchaseValidationError extends Error {}

/**
 * Module 18 (VAT): input VAT, computed per line from each product's own
 * vatCategory – see src/lib/vat.ts's "Design choices" comment for why this
 * assumes the supplier actually charged VAT at that rate.
 */
function computePurchaseTotals(input: PurchaseInput, products: Product[], vatConfig: { vatRegistered: boolean; vatRate: number }) {
  const lineTotals = input.items.map((item) => round2(item.quantity * item.unitCost));
  const subtotal = lineTotals.reduce((sum, t) => sum + t, 0);

  const categories: VatCategory[] = input.items.map((item) => {
    const product = products.find((p) => p.id === item.productId)!;
    return product.vatCategory;
  });
  const { vatAmounts, vatTotal } = computeVatForLines(
    lineTotals.map((total, i) => ({ total, category: categories[i] })),
    vatConfig
  );

  const total = round2(subtotal + vatTotal);
  const amountPaid = round2(input.amountPaid);
  const balance = round2(total - amountPaid);

  let status: PurchaseStatus;
  if (balance <= 0.01) status = "PAID";
  else if (amountPaid > 0) status = "PARTIAL";
  else status = "CREDIT";

  return { subtotal: round2(subtotal), total, amountPaid, balance, status, lineTotals, categories, vatAmounts, vatTotal };
}

/**
 * Mirrors src/lib/sales.ts::createSale closely: server-side totals, one
 * transaction for the purchase + stock movement + numbering + payment
 * record. The key difference from a sale is direction – stock goes UP, and
 * COST (not price) is what's recorded.
 *
 * Design choice: each purchase item's unitCost becomes the product's new
 * `purchasePrice` (last-in cost). This is deliberately simple – a real
 * weighted-average or FIFO costing method is a further-out improvement;
 * last-in cost is transparent and matches what a small shop owner actually
 * thinks of as "what I paid for this batch."
 */
export async function createPurchase(params: { businessId: string; userId: string; input: PurchaseInput }) {
  const { businessId, userId, input } = params;

  return prisma.$transaction(async (tx) => {
    // Lock/validate the active supplier in this transaction so a concurrent
    // deactivation cannot slip through while a Purchase is being created.
    const supplier = await tx.supplier.updateMany({
      where: { id: input.supplierId, businessId, isActive: true },
      data: { isActive: true },
    });
    if (supplier.count !== 1) {
      throw new PurchaseValidationError("Supplier not found or inactive in this business.");
    }

    const productIds = input.items.map((i) => i.productId);
    const products = await tx.product.findMany({ where: { id: { in: productIds } } });
    for (const item of input.items) {
      const product = products.find((p) => p.id === item.productId);
      if (!product || product.businessId !== businessId) {
        throw new PurchaseValidationError(`Product ${item.productId} not found in this business.`);
      }
    }

    const vatConfig = await getVatConfig(businessId);
    const totals = computePurchaseTotals(input, products, vatConfig);

    // Module 27: same branch-membership check createSale() does for
    // Sale.branchId – a request-supplied branch that isn't actually this
    // business's is rejected here rather than trusted.
    if (input.branchId) {
      const branch = await tx.branch.findUnique({ where: { id: input.branchId } });
      if (!branch || branch.businessId !== businessId) {
        throw new PurchaseValidationError("Branch not found in this business.");
      }
    }

    try {
      await assertForeignCurrencyAllowed(tx, businessId, input.currency); // Module 40
    } catch (err) {
      if (err instanceof ForeignSettlementError) throw new PurchaseValidationError(err.message);
      throw err;
    }

    const business = await tx.business.update({
      where: { id: businessId },
      data: { nextPurchaseNumber: { increment: 1 } },
    });
    const purchaseNumber = `${business.purchasePrefix}-${String(business.nextPurchaseNumber - 1).padStart(6, "0")}`;

    const purchase = await tx.purchase.create({
      data: {
        businessId,
        branchId: input.branchId ?? undefined,
        supplierId: input.supplierId,
        purchaseNumber,
        subtotal: totals.subtotal,
        tax: totals.vatTotal,
        total: totals.total,
        amountPaid: totals.amountPaid,
        balance: totals.balance,
        paymentMethod: input.paymentMethod,
        status: totals.status,
        currency: input.currency ?? undefined, // Module 40 – null/undefined = kwacha document
        exchangeRate: input.exchangeRate ?? undefined,
        recordedById: userId,
        items: {
          create: input.items.map((item, i) => ({
            productId: item.productId,
            quantity: item.quantity,
            unitCost: item.unitCost,
            total: totals.lineTotals[i],
            vatCategory: totals.categories[i],
            vatAmount: totals.vatAmounts[i],
          })),
        },
      },
      include: { items: true },
    });

    // Increase stock and update each product's cost basis to this
    // purchase's price (see the "last-in cost" note above).
    // Module 78: a service has no stock to add. Its cost basis still moves (what it costs to provide one unit),
    // and the ledger debits Service Cost Clearing instead of Inventory (see below).
    for (const item of purchase.items) {
      const isService = !products.find((p) => p.id === item.productId)!.isStocked;
      if (!isService) {
        await recordInventoryMovement({
          tx,
          businessId,
          productId: item.productId,
          type: "PURCHASE",
          delta: Number(item.quantity),
          branchId: purchase.branchId,
          referenceType: "Purchase",
          referenceId: purchase.id,
          createdById: userId,
        }).catch((err) => {
          if (err instanceof StockError) throw new PurchaseValidationError(err.message);
          throw err;
        });
      }

      await tx.product.update({
        where: { id: item.productId },
        data: { purchasePrice: item.unitCost },
      });
    }

    const { serviceNet } = splitNetByKind(
      input.items.map((item, i) => ({
        isStocked: products.find((p) => p.id === item.productId)!.isStocked,
        net: totals.lineTotals[i],
      }))
    );
    await postJournalEntryForPurchase({
      tx,
      businessId,
      purchaseId: purchase.id,
      purchaseNumber,
      total: totals.total,
      vatAmount: totals.vatTotal,
      serviceNet,
      createdById: userId,
    });

    if (totals.amountPaid > 0) {
      const payment = await tx.payment.create({
        data: {
          businessId,
          purchaseId: purchase.id,
          supplierId: input.supplierId,
          amount: totals.amountPaid,
          method: input.paymentMethod,
          recordedById: userId,
        },
      });
      await postCashTransactionForPayment({ tx, businessId, paymentId: payment.id, createdById: userId });
      await postJournalEntryForPayment({
        tx,
        businessId,
        paymentId: payment.id,
        amount: totals.amountPaid,
        method: input.paymentMethod,
        isCustomerSide: false,
        createdById: userId,
      });
    }

    // Module 17: mirrors the same automatic sweep in src/lib/sales.ts::createSale
    // – see src/lib/credits.ts::redeemSupplierCredit for the logic. Purchase
    // always has a supplierId (unlike Sale.customerId), so no null-guard needed.
    await redeemSupplierCredit({ tx, businessId, supplierId: input.supplierId, createdById: userId });

    return tx.purchase.findUniqueOrThrow({
      where: { id: purchase.id },
      include: { items: { include: { product: true } }, supplier: true },
    });
  });
}

/**
 * Voiding reverses stock (mirroring src/lib/sales.ts::voidSale) but does
 * NOT roll back the product's purchasePrice to its prior value – cost basis
 * history isn't tracked per-change, only per-sale (via SaleItem.unitCost).
 * This is an acceptable gap for now: voiding a purchase is rare, and the
 * Accounting module's proper costing will supersede this approach anyway.
 *
 * KNOWN GAP (mirrors voidSale): any cash already paid to the supplier stays
 * posted in the Cashbook – voiding a paid purchase is really "get a refund
 * from the supplier," a distinct workflow this function doesn't guess at.
 * The accounting posting (Module 11) mirrors this split deliberately: only
 * the Inventory/Accounts Payable journal entry is reversed on void, while
 * any payment entry stands.
 *
 * Module 44: takes the purchase row lock FIRST, then reads – same reasoning voidSale adopted in
 * Module 43. A debit note being issued against this purchase at the same instant either commits
 * before we look (and the check below refuses the void) or waits for this void to commit (and is
 * then refused because the purchase is VOIDED). A purchase with debit notes against it can no
 * longer be voided – see assertNoDebitNotes in src/lib/debit-notes.ts.
 */
export async function voidPurchase(params: {
  businessId: string;
  purchaseId: string;
  userId: string;
  reason: string;
}) {
  const { businessId, purchaseId, userId, reason } = params;

  return prisma.$transaction(async (tx) => {
    const locked = await tx.purchase.updateMany({ where: { id: purchaseId, businessId }, data: { updatedAt: new Date() } });
    if (locked.count === 0) {
      throw new PurchaseValidationError("Purchase not found in this business.");
    }
    const purchase = await tx.purchase.findUniqueOrThrow({ where: { id: purchaseId }, include: { items: true } });
    if (purchase.status === "VOIDED") {
      throw new PurchaseValidationError("This purchase has already been voided.");
    }
    // Module 42: same reasoning as voidSale. The VAT return reads this purchase's own row.
    await assertRecordDateOpen({ tx, businessId, instant: purchase.purchaseDate, what: `purchase ${purchase.purchaseNumber}`, mode: "change" });
    try {
      await assertNoDebitNotes(tx, purchase.id, purchase.purchaseNumber);
    } catch (err) {
      if (err instanceof DebitNoteError) throw new PurchaseValidationError(err.message);
      throw err;
    }

    for (const item of purchase.items) {
      const product = await tx.product.findUniqueOrThrow({ where: { id: item.productId } });
      // Module 78: a service added no stock, so there is none to take back. The ledger entry is reversed below.
      if (!product.isStocked) continue;
      if (Number(product.quantity) < Number(item.quantity)) {
        throw new PurchaseValidationError(
          `Cannot void: ${product.name} only has ${product.quantity} in stock, but this purchase added ${item.quantity}. Some of this stock has already been sold.`
        );
      }

      await recordInventoryMovement({
        tx,
        businessId,
        productId: item.productId,
        type: "RETURN_OUT",
        delta: -Number(item.quantity),
        branchId: purchase.branchId,
        referenceType: "PurchaseVoid",
        referenceId: purchase.id,
        reason: `Purchase ${purchase.purchaseNumber} voided: ${reason}`,
        createdById: userId,
      });
    }

    await reverseJournalEntryForVoidedPurchase({
      tx,
      businessId,
      purchaseId: purchase.id,
      purchaseNumber: purchase.purchaseNumber,
      createdById: userId,
    });

    return tx.purchase.update({
      where: { id: purchaseId },
      data: { status: "VOIDED", voidedAt: new Date(), voidReason: reason },
    });
  });
}
