import { NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getBankReconciliation, deleteBankReconciliation, BankReconciliationError } from "@/lib/bank-reconciliation";

export async function GET(
  _req: Request,
  props: { params: Promise<{ businessId: string; reconciliationId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "bankrecon.view");
  if (ctx instanceof NextResponse) return ctx;

  const reconciliation = await getBankReconciliation(params.businessId, params.reconciliationId);
  if (!reconciliation) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({ reconciliation });
}

export async function DELETE(
  _req: Request,
  props: { params: Promise<{ businessId: string; reconciliationId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "bankrecon.manage");
  if (ctx instanceof NextResponse) return ctx;

  try {
    await deleteBankReconciliation({
      businessId: params.businessId,
      reconciliationId: params.reconciliationId,
      deletedById: ctx.userId,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof BankReconciliationError) {
      return NextResponse.json({ error: "bank_reconciliation_error", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
