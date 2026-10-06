import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { recordInventoryMovement } from "./inventory";
import { postCashTransactionForCreditNote } from "./cashbook";
import { postJournalEntryForCreditNote } from "./accounting-integrations";
import { logAudit } from "./audit";
import { CreditNoteInput } from "./validation";
import {
  computeCreditNote,
  computePools,
  planSettlement,
  statusAfterBalance,
  round2,
  CreditNoteCalcError,
  CreditVatCategory,
  ItemPool,
  PriorCreditLine,
  SaleItemForCredit,
} from "./credit-note-calc";

/**
 * CREDIT NOTES, Module 43. Closes Module 42's known limitation: a return from a closed month used to need
 * an Owner reopen, because a refund follows a void and a sale in a closed period can't be voided.
 *
 * DESIGN CHOICES, stated plainly:
 *
 * 1. DATED NOW, ALWAYS. A credit note has no date field to pick. It is issued today, in the open period, so
 *    the period lock never has to be bypassed and never has to be checked: the ledger entries carry no
 *    explicit date (Module 42's rule that an undated entry is never refused). The VAT return counts the
 *    credit in the period it was issued, which is also when the ledger entry lands.
 *
 * 2. THE SALE ROW IS THE LOCK. createCreditNote() writes to the sale row first (a no-op updatedAt write) so
 *    Postgres serialises it against another credit note on the same sale, a customer payment, a foreign
 *    settlement and a void. Every read after that sees whatever committed first. Without it, two credit
 *    notes issued at the same instant against a fully paid sale (which leaves Sale.balance unchanged, so a
 *    conditional write on the balance would not notice) could each credit the same item.
 *
 * 3. voidSale() REFUSES A SALE THAT HAS CREDIT NOTES (assertNoCreditNotes). A void restocks every unit and
 *    the credit note has already restocked some of them; it would also leave the credited revenue reversed
 *    twice. The credit notes are the cancellation of the part that was returned.
 *
 * 4. NO EDIT, NO VOID. The correction path for a wrong credit note is a new sale for the customer, which
 *    bills the goods again and takes the stock out again. Reversing a credit note is its own module: it has
 *    to take restocked units back out, un-apply a balance and claw back a customer credit that may already
 *    have been spent.
 *
 * 5. NO NEW PERMISSION. Refunds and credit notes are the same authority: `refunds.manage` issues, `refunds.view`
 *    reads (Owner and Manager issue, Accountant reads). No re-seed. A branch-locked member may credit only
 *    sales made at their own branch.
 *
 * 6. KWACHA ONLY, AT THE SALE'S OWN FIGURES. A credit note on a foreign-currency sale (Module 40) credits the
 *    kwacha the sale booked, at the sale's book rate. It creates no exchange difference, and a cash refund is
 *    the kwacha amount.
 */

export class CreditNoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditNoteError";
  }
}

type Db = Prisma.TransactionClient | typeof prisma;

async function loadCreditBasis(db: Db, saleId: string) {
  const [lines, agg] = await Promise.all([
    db.creditNoteLine.findMany({
      where: { creditNote: { saleId } },
      select: { saleItemId: true, quantity: true, net: true, vatAmount: true },
    }),
    db.creditNote.aggregate({ where: { saleId }, _sum: { discountShare: true, total: true } }),
  ]);
  const priors: PriorCreditLine[] = lines.map((l) => ({
    saleItemId: l.saleItemId,
    quantity: Number(l.quantity),
    net: Number(l.net),
    vatAmount: Number(l.vatAmount),
  }));
  return {
    priors,
    priorDiscountShare: round2(Number(agg._sum.discountShare ?? 0)),
    priorTotal: round2(Number(agg._sum.total ?? 0)),
  };
}

type SaleWithItems = Prisma.SaleGetPayload<{ include: { items: { include: { product: true } } } }>;

function itemsForCalc(sale: SaleWithItems): SaleItemForCredit[] {
  return sale.items.map((i) => ({
    id: i.id,
    productName: i.product.name,
    quantity: Number(i.quantity),
    total: Number(i.total),
    vatAmount: Number(i.vatAmount),
    vatCategory: i.vatCategory as CreditVatCategory,
    unitCost: Number(i.unitCost),
    isStocked: i.product.isStocked,
  }));
}

/**
 * What the credit note form needs: the sale, each item with what is still creditable, and what has been credited
 * so far. Returns null when the sale is not in this business. `blocked` carries the reason a credit note can't be
 * issued right now (voided, wrong branch, fully credited), so the page can say so instead of showing a dead form.
 */
export async function getCreditableSale(params: { businessId: string; saleId: string; branchLock?: string | null }) {
  const sale = await prisma.sale.findUnique({
    where: { id: params.saleId },
    include: { items: { include: { product: true } }, customer: true },
  });
  if (!sale || sale.businessId !== params.businessId) return null;

  const basis = await loadCreditBasis(prisma, sale.id);
  const items = itemsForCalc(sale);
  const pools = computePools(items, basis.priors);
  const anythingLeft = pools.some((p) => p.quantity > 0.0005 || p.net > 0.005);

  let blocked: string | null = null;
  if (sale.status === "VOIDED") blocked = "This sale has been voided, so it can't be credited.";
  else if (params.branchLock && sale.branchId !== params.branchLock) blocked = "This sale was made at another branch.";
  else if (!anythingLeft || round2(Number(sale.total) - basis.priorTotal) <= 0.01) blocked = "This sale has already been credited in full.";

  return {
    sale,
    items: items.map((item) => ({ ...item, pool: pools.find((p) => p.saleItemId === item.id) as ItemPool })),
    creditedTotal: basis.priorTotal,
    creditedDiscountShare: basis.priorDiscountShare,
    blocked,
  };
}

export async function createCreditNote(params: {
  businessId: string;
  userId: string;
  /** The member's own branch when they are branch-locked, else null. */
  branchLock: string | null;
  input: CreditNoteInput;
}) {
  const { businessId, userId, branchLock, input } = params;

  return prisma.$transaction(async (tx) => {
    // Rule 2: take the sale row lock first, THEN read. Everything below sees what committed before us.
    const locked = await tx.sale.updateMany({ where: { id: input.saleId, businessId }, data: { updatedAt: new Date() } });
    if (locked.count === 0) throw new CreditNoteError("Sale not found in this business.");

    const sale = await tx.sale.findUniqueOrThrow({
      where: { id: input.saleId },
      include: { items: { include: { product: true } } },
    });
    if (sale.status === "VOIDED") throw new CreditNoteError("This sale has been voided, so it can't be credited.");
    if (branchLock && sale.branchId !== branchLock) {
      throw new CreditNoteError("This sale was made at another branch, so your role can't credit it.");
    }

    const basis = await loadCreditBasis(tx, sale.id);

    let calc;
    try {
      calc = computeCreditNote({
        sale: {
          subtotal: Number(sale.subtotal),
          discount: Number(sale.discount),
          total: Number(sale.total),
          balance: Number(sale.balance),
        },
        items: itemsForCalc(sale),
        priors: basis.priors,
        priorDiscountShare: basis.priorDiscountShare,
        priorTotal: basis.priorTotal,
        lines: input.lines.map((l) => ({
          saleItemId: l.saleItemId,
          quantity: l.quantity ?? 0,
          netAmount: l.netAmount ?? null,
          restock: !!l.restock,
        })),
      });
    } catch (err) {
      if (err instanceof CreditNoteCalcError) throw new CreditNoteError(err.message);
      throw err;
    }

    let plan;
    try {
      plan = planSettlement({
        settledAmount: calc.settledAmount,
        method: input.settlementMethod ?? null,
        hasCustomer: !!sale.customerId,
        cashAccountId: input.cashAccountId ?? null,
      });
    } catch (err) {
      if (err instanceof CreditNoteCalcError) throw new CreditNoteError(err.message);
      throw err;
    }

    let cashAccountType: string | undefined;
    if (plan.settlement === "CASH") {
      const account = await tx.cashAccount.findUnique({ where: { id: plan.cashAccountId! } });
      if (!account || account.businessId !== businessId || !account.isActive) {
        throw new CreditNoteError("Cash account not found in this business.");
      }
      // Money is leaving the business: make sure the account holds it, read inside the transaction.
      const agg = await tx.cashTransaction.aggregate({ where: { accountId: account.id }, _sum: { amount: true } });
      const balance = round2(Number(account.openingBalance) + Number(agg._sum.amount ?? 0));
      if (balance < calc.settledAmount) {
        throw new CreditNoteError(
          `Insufficient balance in ${account.name}: has MWK ${balance.toLocaleString()}, tried to refund MWK ${calc.settledAmount.toLocaleString()}.`
        );
      }
      cashAccountType = account.type;
    }

    const business = await tx.business.update({
      where: { id: businessId },
      data: { nextCreditNoteNumber: { increment: 1 } },
    });
    const creditNoteNumber = `${business.creditNotePrefix}-${String(business.nextCreditNoteNumber - 1).padStart(6, "0")}`;

    const note = await tx.creditNote.create({
      data: {
        businessId,
        branchId: sale.branchId ?? undefined,
        creditNoteNumber,
        saleId: sale.id,
        customerId: sale.customerId ?? undefined,
        reason: input.reason,
        netAmount: calc.netAmount,
        discountShare: calc.discountShare,
        vatAmount: calc.vatAmount,
        total: calc.total,
        appliedToBalance: calc.appliedToBalance,
        settledAmount: calc.settledAmount,
        settlement: plan.settlement,
        cashAccountId: plan.cashAccountId ?? undefined,
        costRestored: calc.costRestored,
        createdById: userId,
        lines: {
          create: calc.lines.map((l) => ({
            saleItemId: l.saleItemId,
            quantity: l.quantity,
            restock: l.restock,
            net: l.net,
            vatAmount: l.vatAmount,
            vatCategory: l.vatCategory,
            unitCost: l.unitCost,
          })),
        },
      },
      include: { lines: true },
    });

    // Returned units that went back on the shelf come back to the branch the sale was made from, the same
    // branch voidSale() restores to (Module 28).
    for (const line of calc.lines) {
      if (!line.restock) continue;
      const item = sale.items.find((i) => i.id === line.saleItemId)!;
      await recordInventoryMovement({
        tx,
        businessId,
        productId: item.productId,
        type: "RETURN_IN",
        delta: line.quantity,
        branchId: sale.branchId,
        referenceType: "CreditNote",
        referenceId: note.id,
        reason: `Credit note ${creditNoteNumber} on sale ${sale.saleNumber}: ${input.reason}`,
        createdById: userId,
      });
    }

    if (plan.settlement === "CASH") {
      await postCashTransactionForCreditNote({
        tx,
        businessId,
        creditNoteId: note.id,
        creditNoteNumber,
        accountId: plan.cashAccountId!,
        amount: calc.settledAmount,
        branchId: sale.branchId,
        createdById: userId,
      });
    }

    await postJournalEntryForCreditNote({
      tx,
      businessId,
      creditNoteId: note.id,
      creditNoteNumber,
      saleNumber: sale.saleNumber,
      revenue: calc.netAmount,
      vatAmount: calc.vatAmount,
      appliedToBalance: calc.appliedToBalance,
      settledAmount: calc.settledAmount,
      settlement: plan.settlement,
      cashAccountType,
      costRestored: calc.costRestored,
      createdById: userId,
    });

    // Only the balance moves. Sale.total and Sale.amountPaid stay exactly as they were.
    const newBalance = Math.max(0, round2(Number(sale.balance) - calc.appliedToBalance));
    await tx.sale.update({
      where: { id: sale.id },
      data: {
        balance: newBalance,
        status: statusAfterBalance(sale.status as "PAID" | "PARTIAL" | "CREDIT", newBalance),
      },
    });

    await logAudit({
      tx,
      businessId,
      userId,
      action: "creditnote.create",
      entityType: "CreditNote",
      entityId: note.id,
      metadata: {
        creditNoteNumber,
        saleId: sale.id,
        saleNumber: sale.saleNumber,
        total: calc.total,
        vatAmount: calc.vatAmount,
        appliedToBalance: calc.appliedToBalance,
        settledAmount: calc.settledAmount,
        settlement: plan.settlement,
        costRestored: calc.costRestored,
      },
    });

    return tx.creditNote.findUniqueOrThrow({
      where: { id: note.id },
      include: { lines: { include: { saleItem: { include: { product: true } } } }, sale: true, customer: true, cashAccount: true },
    });
  });
}

export async function listCreditNotes(businessId: string, branchId?: string | null) {
  return prisma.creditNote.findMany({
    where: { businessId, ...(branchId ? { branchId } : {}) },
    include: { sale: { select: { id: true, saleNumber: true } }, customer: { select: { id: true, name: true } } },
    orderBy: { issuedAt: "desc" },
    take: 200,
  });
}

/** Credit notes on one sale, newest first, for the sale detail page. */
export async function listCreditNotesForSale(businessId: string, saleId: string) {
  return prisma.creditNote.findMany({
    where: { businessId, saleId },
    orderBy: { issuedAt: "desc" },
  });
}

export async function getCreditNote(params: { businessId: string; creditNoteId: string }) {
  const note = await prisma.creditNote.findUnique({
    where: { id: params.creditNoteId },
    include: {
      lines: { include: { saleItem: { include: { product: true } } } },
      sale: true,
      customer: true,
      cashAccount: true,
      business: true,
    },
  });
  if (!note || note.businessId !== params.businessId) return null;
  return note;
}

/**
 * Called by voidSale() inside its transaction, AFTER it has locked the sale row. Design choice 3 above.
 */
export async function assertNoCreditNotes(tx: Prisma.TransactionClient, saleId: string, saleNumber: string) {
  const notes = await tx.creditNote.findMany({ where: { saleId }, select: { creditNoteNumber: true }, take: 3 });
  if (notes.length > 0) {
    throw new CreditNoteError(
      `Sale ${saleNumber} has credit notes against it (${notes.map((n) => n.creditNoteNumber).join(", ")}), so it can't be voided. ` +
        `The credit notes already reverse the part that was returned.`
    );
  }
}
