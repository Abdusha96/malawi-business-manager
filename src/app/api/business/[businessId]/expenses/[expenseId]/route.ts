import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { expenseUpdateSchema } from "@/lib/validation";
import { logAudit } from "@/lib/audit";
import { reverseCashTransactionsForReference, postCashTransactionForExpense } from "@/lib/cashbook";
import { reverseJournalEntriesForExpense, postJournalEntryForExpense } from "@/lib/accounting-integrations";
import { getWithholdingTaxConfig, computeWithholdingTax } from "@/lib/withholding-tax";
import { assertRecordDateOpen } from "@/lib/period-close";
import { PeriodClosedError } from "@/lib/accounting";

async function loadOwnedExpense(businessId: string, expenseId: string) {
  const expense = await prisma.expense.findUnique({ where: { id: expenseId } });
  if (!expense || expense.businessId !== businessId) return null;
  return expense;
}

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; expenseId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "expenses.view");
  if (ctx instanceof NextResponse) return ctx;

  const expense = await loadOwnedExpense(params.businessId, params.expenseId);
  if (!expense) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({ expense });
}

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; expenseId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "expenses.manage");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const existing = await loadOwnedExpense(params.businessId, params.expenseId);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = expenseUpdateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  // Module 19 (Withholding Tax): recompute rate/amount server-side whenever
  // either input to the calculation changes – the gross amount or the
  // category itself. Uses TODAY's configured rate, same as a fresh
  // creation would (this is an edit, not a historical correction tool) –
  // if that's not desired for a given change, delete and re-create instead.
  const withholdingRelevantChange =
    (data.amount !== undefined && data.amount !== Number(existing.amount)) ||
    (data.withholdingTaxCategory !== undefined && data.withholdingTaxCategory !== existing.withholdingTaxCategory);

  let withholdingTaxRate = Number(existing.withholdingTaxRate);
  let withholdingTaxAmount = Number(existing.withholdingTaxAmount);
  if (withholdingRelevantChange) {
    const whtConfig = await getWithholdingTaxConfig(params.businessId);
    const nextAmount = data.amount ?? Number(existing.amount);
    const nextCategory = data.withholdingTaxCategory !== undefined ? data.withholdingTaxCategory : existing.withholdingTaxCategory;
    const computed = computeWithholdingTax(nextAmount, nextCategory, whtConfig);
    withholdingTaxRate = computed.rate;
    withholdingTaxAmount = computed.amount;
  }

  // Cash (Cashbook) cares about amount/paymentMethod/withholding – any of
  // those can change how much cash actually leaves. Accounting also cares
  // about category, since that decides which expense account gets
  // debited, even if the cash side is unchanged.
  const cashImpactChanged =
    (data.amount !== undefined && data.amount !== Number(existing.amount)) ||
    (data.paymentMethod !== undefined && data.paymentMethod !== existing.paymentMethod) ||
    withholdingRelevantChange;
  const accountingImpactChanged = cashImpactChanged || (data.category !== undefined && data.category !== existing.category);

  // Module 42: an expense in a closed period can't be edited at all, and it can't be moved INTO one.
  let expense;
  try {
    expense = await prisma.$transaction(async (tx) => {
      await assertRecordDateOpen({
        tx,
        businessId: params.businessId,
        instant: existing.expenseDate,
        what: "this expense",
        mode: "change",
      });
      if (data.expenseDate !== undefined) {
        await assertRecordDateOpen({
          tx,
          businessId: params.businessId,
          instant: new Date(data.expenseDate),
          what: "the new expense date",
          mode: "date",
        });
      }
      const updated = await tx.expense.update({
        where: { id: params.expenseId },
        data: {
          ...(data.category !== undefined ? { category: data.category } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.amount !== undefined ? { amount: data.amount } : {}),
          ...(data.expenseDate !== undefined ? { expenseDate: new Date(data.expenseDate!) } : {}),
          ...(data.paymentMethod !== undefined ? { paymentMethod: data.paymentMethod } : {}),
          ...(data.payee !== undefined ? { payee: data.payee } : {}),
          ...(data.receiptUrl !== undefined ? { receiptUrl: data.receiptUrl } : {}),
          ...(data.notes !== undefined ? { notes: data.notes } : {}),
          ...(data.withholdingTaxCategory !== undefined ? { withholdingTaxCategory: data.withholdingTaxCategory } : {}),
          ...(data.payeeTpin !== undefined ? { payeeTpin: data.payeeTpin } : {}),
          ...(withholdingRelevantChange ? { withholdingTaxRate, withholdingTaxAmount } : {}),
        },
      });

      if (cashImpactChanged) {
        await reverseCashTransactionsForReference({
          tx,
          businessId: params.businessId,
          referenceType: "Expense",
          referenceId: updated.id,
          createdById: userId,
          reason: "Expense edited – amount, payment method, or withholding tax changed",
        });
        await postCashTransactionForExpense({
          tx,
          businessId: params.businessId,
          expenseId: updated.id,
          createdById: userId,
        });
      }

      if (accountingImpactChanged) {
        await reverseJournalEntriesForExpense({
          tx,
          businessId: params.businessId,
          expenseId: updated.id,
          createdById: userId,
          reason: "Expense edited – amount, category, payment method, or withholding tax changed",
        });
        await postJournalEntryForExpense({
          tx,
          businessId: params.businessId,
          expenseId: updated.id,
          category: updated.category,
          amount: Number(updated.amount),
          withholdingTaxAmount: Number(updated.withholdingTaxAmount),
          paymentMethod: updated.paymentMethod,
          createdById: userId,
        });
      }

      return updated;
    });
  } catch (err) {
    if (err instanceof PeriodClosedError) {
      return NextResponse.json({ error: "period_closed", message: err.message }, { status: 400 });
    }
    throw err;
  }

  await logAudit({
    businessId: params.businessId,
    userId,
    action: "expense.update",
    entityType: "Expense",
    entityId: expense.id,
    metadata: { before: { amount: Number(existing.amount) }, after: { amount: Number(expense.amount) } },
  });

  return NextResponse.json({ expense });
}

export async function DELETE(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; expenseId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "expenses.manage");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const existing = await loadOwnedExpense(params.businessId, params.expenseId);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Hard delete is acceptable here (unlike Product/Sale) since nothing else
  // references an Expense by foreign key yet – but it's still audit-logged
  // with the amount captured, since the row itself won't be there to
  // inspect afterwards. Both the cash impact and the journal entry are
  // reversed before deletion, so neither ledger keeps money "spent" against
  // an expense that no longer exists.
  try {
    await prisma.$transaction(async (tx) => {
      await assertRecordDateOpen({
        tx,
        businessId: params.businessId,
        instant: existing.expenseDate,
        what: "this expense",
        mode: "change",
      });
      await reverseCashTransactionsForReference({
        tx,
        businessId: params.businessId,
        referenceType: "Expense",
        referenceId: params.expenseId,
        createdById: userId,
        reason: "Expense deleted",
      });
      await reverseJournalEntriesForExpense({
        tx,
        businessId: params.businessId,
        expenseId: params.expenseId,
        createdById: userId,
        reason: "Expense deleted",
      });
      await tx.expense.delete({ where: { id: params.expenseId } });
    });
  } catch (err) {
    if (err instanceof PeriodClosedError) {
      return NextResponse.json({ error: "period_closed", message: err.message }, { status: 400 });
    }
    throw err;
  }

  await logAudit({
    businessId: params.businessId,
    userId,
    action: "expense.delete",
    entityType: "Expense",
    entityId: params.expenseId,
    metadata: { amount: Number(existing.amount), category: existing.category, description: existing.description },
  });

  return NextResponse.json({ message: "Expense deleted." });
}
