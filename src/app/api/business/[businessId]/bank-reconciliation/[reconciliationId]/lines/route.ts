import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { bankStatementLineSchema } from "@/lib/validation";
import { addBankStatementLine, BankReconciliationError } from "@/lib/bank-reconciliation";

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; reconciliationId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "bankrecon.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = bankStatementLineSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const { line, periodFlag, repeatsOtherStatement } = await addBankStatementLine({
      businessId: params.businessId,
      reconciliationId: params.reconciliationId,
      createdById: ctx.userId,
      data: parsed.data,
    });
    return NextResponse.json({ line, periodFlag, repeatsOtherStatement }, { status: 201 });
  } catch (err) {
    if (err instanceof BankReconciliationError) {
      return NextResponse.json({ error: "bank_reconciliation_error", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
