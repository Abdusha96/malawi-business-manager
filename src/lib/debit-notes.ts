import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { recordInventoryMovement, StockError } from "./inventory";
import { postCashTransactionForDebitNote } from "./cashbook";
import { postJournalEntryForDebitNote } from "./accounting-integrations";
import { splitNetByKind } from "./product-kind";
import { logAudit } from "./audit";
import { DebitNoteInput } from "./validation";
import {
  computeDebitNote,
  computePools,
  planSettlement,
  statusAfterBalance,
  round2,
  DebitNoteCalcError,
  DebitVatCategory,
  ItemPool,
  PriorDebitLine,
  PurchaseItemForDebit,
} from "./debit-note-calc";

/**
 * SUPPLIER DEBIT NOTES, Module 44. The purchase-side mirror of Module 43's Sales Credit Notes –
 * closes the same class of gap Module 43 closed for sales: goods sent back to a supplier, or a
 * price adjustment the supplier agreed to, used to have no path except voiding the whole purchase
 * (which needs an Owner reopen once the period is closed, per Module 42) or a Refund (which only
 * applies to an already-voided purchase). See src/lib/credit-notes.ts's doc comment for the shared
 * reasoning; src/lib/debit-note-calc.ts's doc comment for exactly where the two calculations differ.
 *
 * DESIGN CHOICES THAT MIRROR CREDIT NOTES EXACTLY:
 *
 * 1. DATED NOW, ALWAYS – never touches a closed period (Module 42).
 * 2. THE PURCHASE ROW IS THE LOCK – createDebitNote() writes to the purchase row first so Postgres
 *    serialises it against another debit note on the same purchase, a supplier payment, a foreign
 *    settlement and a void.
 * 3. voidPurchase() REFUSES A PURCHASE THAT HAS DEBIT NOTES (assertNoDebitNotes) – same reasoning
 *    as assertNoCreditNotes: a void restocks (returns) every unit and reverses the whole entry; a
 *    debit note has already done part of that.
 * 4. NO EDIT, NO VOID – the correction path is a new purchase from the supplier.
 * 5. NO NEW PERMISSION – `refunds.manage` issues, `refunds.view` reads, same authority as Refunds
 *    and Credit Notes (Owner and Manager issue, Accountant reads). A branch-locked member may debit
 *    only purchases received at their own branch.
 * 6. KWACHA ONLY, AT THE PURCHASE'S OWN FIGURES – a debit note on a foreign-currency purchase
 *    (Module 40) debits the kwacha the purchase booked, at the purchase's book rate. No exchange
 *    difference is created.
 */

export class DebitNoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DebitNoteError";
  }
}

type Db = Prisma.TransactionClient | typeof prisma;

async function loadDebitBasis(db: Db, purchaseId: string) {
  const [lines, agg] = await Promise.all([
    db.supplierDebitNoteLine.findMany({
      where: { debitNote: { purchaseId } },
      select: { purchaseItemId: true, quantity: true, net: true, vatAmount: true },
    }),
    db.supplierDebitNote.aggregate({ where: { purchaseId }, _sum: { total: true } }),
  ]);
  const priors: PriorDebitLine[] = lines.map((l) => ({
    purchaseItemId: l.purchaseItemId,
    quantity: Number(l.quantity),
    net: Number(l.net),
    vatAmount: Number(l.vatAmount),
  }));
  return {
    priors,
    priorTotal: round2(Number(agg._sum.total ?? 0)),
  };
}

type PurchaseWithItems = Prisma.PurchaseGetPayload<{ include: { items: { include: { product: true } } } }>;

function itemsForCalc(purchase: PurchaseWithItems): PurchaseItemForDebit[] {
  return purchase.items.map((i) => ({
    id: i.id,
    productName: i.product.name,
    quantity: Number(i.quantity),
    total: Number(i.total),
    vatAmount: Number(i.vatAmount),
    vatCategory: i.vatCategory as DebitVatCategory,
    unitCost: Number(i.unitCost),
    isStocked: i.product.isStocked,
  }));
}

/**
 * What the debit note form needs: the purchase, each item with what is still debitable, and what
 * has been debited so far. Returns null when the purchase is not in this business. `blocked` mirrors
 * getCreditableSale's blocked reasons.
 */
export async function getDebitablePurchase(params: { businessId: string; purchaseId: string; branchLock?: string | null }) {
  const purchase = await prisma.purchase.findUnique({
    where: { id: params.purchaseId },
    include: { items: { include: { product: true } }, supplier: true },
  });
  if (!purchase || purchase.businessId !== params.businessId) return null;

  const basis = await loadDebitBasis(prisma, purchase.id);
  const items = itemsForCalc(purchase);
  const pools = computePools(items, basis.priors);
  const anythingLeft = pools.some((p) => p.quantity > 0.0005 || p.net > 0.005);

  let blocked: string | null = null;
  if (purchase.status === "VOIDED") blocked = "This purchase has been voided, so it can't be debited.";
  else if (params.branchLock && purchase.branchId !== params.branchLock) blocked = "This purchase was received at another branch.";
  else if (!anythingLeft || round2(Number(purchase.total) - basis.priorTotal) <= 0.01) blocked = "This purchase has already been debited in full.";

  return {
    purchase,
    items: items.map((item) => ({ ...item, pool: pools.find((p) => p.purchaseItemId === item.id) as ItemPool })),
    debitedTotal: basis.priorTotal,
    blocked,
  };
}

export async function createDebitNote(params: {
  businessId: string;
  userId: string;
  /** The member's own branch when they are branch-locked, else null. */
  branchLock: string | null;
  input: DebitNoteInput;
}) {
  const { businessId, userId, branchLock, input } = params;

  return prisma.$transaction(async (tx) => {
    // Take the purchase row lock first, THEN read. Everything below sees what committed before us.
    const locked = await tx.purchase.updateMany({ where: { id: input.purchaseId, businessId }, data: { updatedAt: new Date() } });
    if (locked.count === 0) throw new DebitNoteError("Purchase not found in this business.");

    const purchase = await tx.purchase.findUniqueOrThrow({
      where: { id: input.purchaseId },
      include: { items: { include: { product: true } } },
    });
    if (purchase.status === "VOIDED") throw new DebitNoteError("This purchase has been voided, so it can't be debited.");
    if (branchLock && purchase.branchId !== branchLock) {
      throw new DebitNoteError("This purchase was received at another branch, so your role can't debit it.");
    }

    const basis = await loadDebitBasis(tx, purchase.id);

    let calc;
    try {
      calc = computeDebitNote({
        purchase: { total: Number(purchase.total), balance: Number(purchase.balance) },
        items: itemsForCalc(purchase),
        priors: basis.priors,
        priorTotal: basis.priorTotal,
        lines: input.lines.map((l) => ({
          purchaseItemId: l.purchaseItemId,
          quantity: l.quantity ?? 0,
          netAmount: l.netAmount ?? null,
          stockOut: !!l.stockOut,
        })),
      });
    } catch (err) {
      if (err instanceof DebitNoteCalcError) throw new DebitNoteError(err.message);
      throw err;
    }

    let plan;
    try {
      plan = planSettlement({
        settledAmount: calc.settledAmount,
        method: input.settlementMethod ?? null,
        cashAccountId: input.cashAccountId ?? null,
      });
    } catch (err) {
      if (err instanceof DebitNoteCalcError) throw new DebitNoteError(err.message);
      throw err;
    }

    let cashAccountType: string | undefined;
    if (plan.settlement === "CASH") {
      const account = await tx.cashAccount.findUnique({ where: { id: plan.cashAccountId! } });
      if (!account || account.businessId !== businessId || !account.isActive) {
        throw new DebitNoteError("Cash account not found in this business.");
      }
      // Money is coming IN from the supplier – unlike a credit note's cash refund, there's no
      // "does the account hold enough" check to make (that only matters when money leaves).
      cashAccountType = account.type;
    }

    const business = await tx.business.update({
      where: { id: businessId },
      data: { nextDebitNoteNumber: { increment: 1 } },
    });
    const debitNoteNumber = `${business.debitNotePrefix}-${String(business.nextDebitNoteNumber - 1).padStart(6, "0")}`;

    const note = await tx.supplierDebitNote.create({
      data: {
        businessId,
        branchId: purchase.branchId ?? undefined,
        debitNoteNumber,
        purchaseId: purchase.id,
        supplierId: purchase.supplierId,
        reason: input.reason,
        netAmount: calc.netAmount,
        vatAmount: calc.vatAmount,
        total: calc.total,
        appliedToBalance: calc.appliedToBalance,
        settledAmount: calc.settledAmount,
        settlement: plan.settlement,
        cashAccountId: plan.cashAccountId ?? undefined,
        createdById: userId,
        lines: {
          create: calc.lines.map((l) => ({
            purchaseItemId: l.purchaseItemId,
            quantity: l.quantity,
            stockOut: l.stockOut,
            net: l.net,
            vatAmount: l.vatAmount,
            vatCategory: l.vatCategory,
            unitCost: l.unitCost,
          })),
        },
      },
      include: { lines: true },
    });

    // Units actually sent back leave the branch the purchase was received at – the same branch
    // voidPurchase() removes stock from (Module 28).
    for (const line of calc.lines) {
      if (!line.stockOut) continue;
      const item = purchase.items.find((i) => i.id === line.purchaseItemId)!;
      await recordInventoryMovement({
        tx,
        businessId,
        productId: item.productId,
        type: "RETURN_OUT",
        delta: -line.quantity,
        branchId: purchase.branchId,
        referenceType: "SupplierDebitNote",
        referenceId: note.id,
        reason: `Debit note ${debitNoteNumber} on purchase ${purchase.purchaseNumber}: ${input.reason}`,
        createdById: userId,
      }).catch((err) => {
        if (err instanceof StockError) throw new DebitNoteError(err.message);
        throw err;
      });
    }

    if (plan.settlement === "CASH") {
      await postCashTransactionForDebitNote({
        tx,
        businessId,
        debitNoteId: note.id,
        debitNoteNumber,
        accountId: plan.cashAccountId!,
        amount: calc.settledAmount,
        branchId: purchase.branchId,
        createdById: userId,
      });
    }

    await postJournalEntryForDebitNote({
      tx,
      businessId,
      debitNoteId: note.id,
      debitNoteNumber,
      purchaseNumber: purchase.purchaseNumber,
      netAmount: calc.netAmount,
      serviceNetAmount: splitNetByKind(calc.lines.map((l) => ({ isStocked: l.isStocked, net: l.net }))).serviceNet,
      vatAmount: calc.vatAmount,
      appliedToBalance: calc.appliedToBalance,
      settledAmount: calc.settledAmount,
      settlement: plan.settlement,
      cashAccountType,
      createdById: userId,
    });

    // Only the balance moves. Purchase.total and Purchase.amountPaid stay exactly as they were.
    const newBalance = Math.max(0, round2(Number(purchase.balance) - calc.appliedToBalance));
    await tx.purchase.update({
      where: { id: purchase.id },
      data: {
        balance: newBalance,
        status: statusAfterBalance(purchase.status as "PAID" | "PARTIAL" | "CREDIT", newBalance),
      },
    });

    await logAudit({
      tx,
      businessId,
      userId,
      action: "debitnote.create",
      entityType: "SupplierDebitNote",
      entityId: note.id,
      metadata: {
        debitNoteNumber,
        purchaseId: purchase.id,
        purchaseNumber: purchase.purchaseNumber,
        total: calc.total,
        vatAmount: calc.vatAmount,
        appliedToBalance: calc.appliedToBalance,
        settledAmount: calc.settledAmount,
        settlement: plan.settlement,
      },
    });

    return tx.supplierDebitNote.findUniqueOrThrow({
      where: { id: note.id },
      include: { lines: { include: { purchaseItem: { include: { product: true } } } }, purchase: true, supplier: true, cashAccount: true },
    });
  });
}

export async function listDebitNotes(businessId: string, branchId?: string | null) {
  return prisma.supplierDebitNote.findMany({
    where: { businessId, ...(branchId ? { branchId } : {}) },
    include: { purchase: { select: { id: true, purchaseNumber: true } }, supplier: { select: { id: true, name: true } } },
    orderBy: { issuedAt: "desc" },
    take: 200,
  });
}

/** Debit notes on one purchase, newest first, for the purchase detail page. */
export async function listDebitNotesForPurchase(businessId: string, purchaseId: string) {
  return prisma.supplierDebitNote.findMany({
    where: { businessId, purchaseId },
    orderBy: { issuedAt: "desc" },
  });
}

export async function getDebitNote(params: { businessId: string; debitNoteId: string }) {
  const note = await prisma.supplierDebitNote.findUnique({
    where: { id: params.debitNoteId },
    include: {
      lines: { include: { purchaseItem: { include: { product: true } } } },
      purchase: true,
      supplier: true,
      cashAccount: true,
      business: true,
    },
  });
  if (!note || note.businessId !== params.businessId) return null;
  return note;
}

/**
 * Called by voidPurchase() inside its transaction, AFTER it has locked the purchase row.
 * Design choice 3 above.
 */
export async function assertNoDebitNotes(tx: Prisma.TransactionClient, purchaseId: string, purchaseNumber: string) {
  const notes = await tx.supplierDebitNote.findMany({ where: { purchaseId }, select: { debitNoteNumber: true }, take: 3 });
  if (notes.length > 0) {
    throw new DebitNoteError(
      `Purchase ${purchaseNumber} has debit notes against it (${notes.map((n) => n.debitNoteNumber).join(", ")}), so it can't be voided. ` +
        `The debit notes already reverse the part that was returned.`
    );
  }
}
