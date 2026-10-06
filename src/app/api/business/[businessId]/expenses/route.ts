import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { readDateParamOrResponse } from "@/lib/date-range-api";
import { resolveBranchScope, TenantAccessError } from "@/lib/tenant";
import { expenseSchema } from "@/lib/validation";
import { logAudit } from "@/lib/audit";
import { postCashTransactionForExpense } from "@/lib/cashbook";
import { postJournalEntryForExpense } from "@/lib/accounting-integrations";
import { getWithholdingTaxConfig, computeWithholdingTax } from "@/lib/withholding-tax";
import { getBusinessTimeZone } from "@/lib/business-timezone";
import { assertRecordDateOpen } from "@/lib/period-close";
import { PeriodClosedError } from "@/lib/accounting";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "expenses.view");
  if (ctx instanceof NextResponse) return ctx;
  const tz = await getBusinessTimeZone(params.businessId);

  const { searchParams } = new URL(req.url);
  const category = searchParams.get("category");
  // Module 34: date-only bounds mean start/end of that local day – an
  // expense dated the 31st is included by `to=...-31` (it was dropped before).
  const from = readDateParamOrResponse(searchParams, "from", "start", tz);
  if (from instanceof NextResponse) return from;
  const to = readDateParamOrResponse(searchParams, "to", "end", tz);
  if (to instanceof NextResponse) return to;
  const limit = Math.min(Number(searchParams.get("limit") ?? 100), 500);

  // A branch-restricted member is locked to their branch; an unrestricted
  // member sees all branches unless they ask to filter to one – see
  // resolveBranchScope() in tenant.ts.
  let branchId: string | null;
  try {
    branchId = resolveBranchScope(ctx.membership, searchParams.get("branchId"));
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: "forbidden" }, { status: err.status });
    throw err;
  }

  const expenses = await prisma.expense.findMany({
    where: {
      businessId: params.businessId,
      ...(branchId ? { branchId } : {}),
      ...(category ? { category: category as any } : {}),
      ...(from || to
        ? {
            expenseDate: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    },
    include: { branch: { select: { name: true } } },
    orderBy: { expenseDate: "desc" },
    take: limit,
  });

  return NextResponse.json({ expenses });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "expenses.manage");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const parsed = expenseSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  let branchId: string | null;
  try {
    branchId = resolveBranchScope(ctx.membership, data.branchId ?? null);
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: "forbidden" }, { status: err.status });
    throw err;
  }

  if (branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch || branch.businessId !== params.businessId) {
      return NextResponse.json({ error: "invalid_branch" }, { status: 400 });
    }
  }

  // Module 19 (Withholding Tax): computed server-side from the business's
  // configured rate, the same "never trust a client-typed tax figure"
  // stance VAT took in Module 18 – withholdingTaxCategory is the only
  // client input; rate and amount are always derived here and snapshotted
  // onto the row.
  const whtConfig = await getWithholdingTaxConfig(params.businessId);
  const { rate: withholdingTaxRate, amount: withholdingTaxAmount } = computeWithholdingTax(
    data.amount,
    data.withholdingTaxCategory ?? null,
    whtConfig,
  );

  // Module 42: reports read expenseDate, so a date in a closed period would change a filed period.
  // An omitted date means today, which is never closed.
  let expense;
  try {
    expense = await prisma.$transaction(async (tx) => {
      await assertRecordDateOpen({
        tx,
        businessId: params.businessId,
        instant: data.expenseDate ? new Date(data.expenseDate) : null,
        what: "this expense",
        mode: "date",
      });
      const created = await tx.expense.create({
        data: {
          businessId: params.businessId,
          branchId: branchId ?? undefined,
          category: data.category,
          description: data.description,
          amount: data.amount,
          expenseDate: data.expenseDate ? new Date(data.expenseDate) : new Date(),
          paymentMethod: data.paymentMethod,
          payee: data.payee ?? undefined,
          receiptUrl: data.receiptUrl ?? undefined,
          notes: data.notes ?? undefined,
          recordedById: userId,
          withholdingTaxCategory: data.withholdingTaxCategory ?? undefined,
          withholdingTaxRate,
          withholdingTaxAmount,
          payeeTpin: data.payeeTpin ?? undefined,
        },
      });

      await postCashTransactionForExpense({
        tx,
        businessId: params.businessId,
        expenseId: created.id,
        createdById: userId,
      });

      await postJournalEntryForExpense({
        tx,
        businessId: params.businessId,
        expenseId: created.id,
        category: created.category,
        amount: Number(created.amount),
        withholdingTaxAmount: Number(created.withholdingTaxAmount),
        paymentMethod: created.paymentMethod,
        createdById: userId,
      });

      return created;
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
    action: "expense.create",
    entityType: "Expense",
    entityId: expense.id,
    metadata: { amount: data.amount, category: data.category, withholdingTaxAmount: Number(expense.withholdingTaxAmount) },
  });

  return NextResponse.json({ expense }, { status: 201 });
}
