import { NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { hasPermission } from "@/lib/tenant";
import { reopenBankReconciliationSchema } from "@/lib/validation";
import { reopenBankReconciliation, BankReconciliationError } from "@/lib/bank-reconciliation";

// Module 48. Same permission split Period Close (Module 42) uses for its own
// close/reopen: completing needs "bankrecon.manage" (Owner + Accountant, already
// required to reach this reconciliation at all), reopening a COMPLETED one also
// needs "business.settings.manage" (Owner only). No new permission, so no re-seed.
export async function POST(
  req: Request,
  props: { params: Promise<{ businessId: string; reconciliationId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "bankrecon.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = reopenBankReconciliationSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  const canReopen = await hasPermission(ctx.membership, "business.settings.manage");

  try {
    const reconciliation = await reopenBankReconciliation({
      businessId: params.businessId,
      reconciliationId: params.reconciliationId,
      reason: parsed.data.reason,
      lineId: parsed.data.lineId,
      reopenedById: ctx.userId,
      canReopen,
    });
    return NextResponse.json({ reconciliation });
  } catch (err) {
    if (err instanceof BankReconciliationError) {
      return NextResponse.json({ error: "bank_reconciliation_error", message: err.message }, { status: err.status });
    }
    throw err;
  }
}
