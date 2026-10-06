import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { importBankStatementSchema } from "@/lib/validation";
import { importBankStatementCsv, BankReconciliationError } from "@/lib/bank-reconciliation";

/**
 * Module 62. Separate route from `../route.ts` (single-line POST) for the
 * same reason Stock Transfers' receive/cancel and Module 60's apply-to-all
 * are: it's a different action with a different body, not a variant of the
 * same one. Same `bankrecon.manage` permission as adding a line by hand –
 * no new permission, no re-seed.
 *
 * `dryRun: true` is the Preview step: it parses and reports and writes nothing.
 */
export async function POST(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; reconciliationId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "bankrecon.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = importBankStatementSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await importBankStatementCsv({
      businessId: params.businessId,
      reconciliationId: params.reconciliationId,
      createdById: ctx.userId,
      csv: parsed.data.csv,
      format: parsed.data.format,
      dateOrder: parsed.data.dateOrder,
      dryRun: parsed.data.dryRun,
      skipDuplicates: parsed.data.skipDuplicates,
      skipInvalid: parsed.data.skipInvalid,
      skipOutOfPeriod: parsed.data.skipOutOfPeriod,
      skipOtherStatementRepeats: parsed.data.skipOtherStatementRepeats,
    });
    return NextResponse.json({ result }, { status: result.dryRun ? 200 : 201 });
  } catch (err) {
    if (err instanceof BankReconciliationError) {
      return NextResponse.json({ error: "bank_reconciliation_error", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
