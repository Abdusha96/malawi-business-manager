import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { setPeriodStartSchema } from "@/lib/validation";
import { setBankReconciliationPeriodStart, BankReconciliationError } from "@/lib/bank-reconciliation";

/**
 * Module 69. Sets, changes or clears (`periodStart: null`) the first day the
 * statement covers, while the reconciliation is IN_PROGRESS. Separate route for the
 * same reason `import`, `reopen` and Stock Transfers' `receive` are: a different
 * action with its own body. Same `bankrecon.manage` permission as every other write
 * on a reconciliation – no new permission, no re-seed.
 */
export async function PUT(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; reconciliationId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "bankrecon.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = setPeriodStartSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await setBankReconciliationPeriodStart({
      businessId: params.businessId,
      reconciliationId: params.reconciliationId,
      updatedById: ctx.userId,
      data: parsed.data,
    });
    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof BankReconciliationError) {
      return NextResponse.json({ error: "bank_reconciliation_error", message: err.message }, { status: err.status });
    }
    throw err;
  }
}
