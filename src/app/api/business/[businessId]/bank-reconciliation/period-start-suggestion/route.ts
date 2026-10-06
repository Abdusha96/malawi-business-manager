import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getSuggestedPeriodStart, BankReconciliationError } from "@/lib/bank-reconciliation";

/**
 * Module 69. `GET ?accountId=&statementDate=YYYY-MM-DD` – the day after this
 * account's latest completed statement that ends before `statementDate`, for the
 * "Start a reconciliation" form to pre-fill. A suggestion only; nothing is stored.
 * A static segment beside `[reconciliationId]`, which Next resolves first.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "bankrecon.view");
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId");
  const statementDate = searchParams.get("statementDate");
  if (!accountId || !statementDate || !/^\d{4}-\d{2}-\d{2}$/.test(statementDate)) {
    return NextResponse.json(
      { error: "validation_error", message: "accountId and statementDate (YYYY-MM-DD) are required." },
      { status: 400 }
    );
  }

  try {
    const result = await getSuggestedPeriodStart({ businessId: params.businessId, accountId, statementDate });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof BankReconciliationError) {
      return NextResponse.json({ error: "bank_reconciliation_error", message: err.message }, { status: err.status });
    }
    throw err;
  }
}
