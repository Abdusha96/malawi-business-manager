import { NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { completeBankReconciliation, BankReconciliationError } from "@/lib/bank-reconciliation";

export async function POST(
  _req: Request,
  props: { params: Promise<{ businessId: string; reconciliationId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "bankrecon.manage");
  if (ctx instanceof NextResponse) return ctx;

  try {
    const result = await completeBankReconciliation({
      businessId: params.businessId,
      reconciliationId: params.reconciliationId,
      completedById: ctx.userId,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof BankReconciliationError) {
      return NextResponse.json({ error: "bank_reconciliation_error", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
