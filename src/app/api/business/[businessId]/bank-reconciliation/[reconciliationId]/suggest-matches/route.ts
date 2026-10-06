import { NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { suggestBankStatementMatches, BankReconciliationError } from "@/lib/bank-reconciliation";

export async function GET(
  _req: Request,
  props: { params: Promise<{ businessId: string; reconciliationId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "bankrecon.view");
  if (ctx instanceof NextResponse) return ctx;

  try {
    const suggestions = await suggestBankStatementMatches(params.businessId, params.reconciliationId);
    return NextResponse.json({ suggestions });
  } catch (err) {
    if (err instanceof BankReconciliationError) {
      return NextResponse.json({ error: "bank_reconciliation_error", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
