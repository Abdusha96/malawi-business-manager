import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { openBankReconciliationSchema } from "@/lib/validation";
import { openBankReconciliation, listBankReconciliations, BankReconciliationError } from "@/lib/bank-reconciliation";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "bankrecon.view");
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId") ?? undefined;

  const reconciliations = await listBankReconciliations(params.businessId, accountId);
  return NextResponse.json({ reconciliations });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "bankrecon.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = openBankReconciliationSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const reconciliation = await openBankReconciliation({
      businessId: params.businessId,
      createdById: ctx.userId,
      data: parsed.data,
    });
    return NextResponse.json({ reconciliation }, { status: 201 });
  } catch (err) {
    if (err instanceof BankReconciliationError) {
      return NextResponse.json({ error: "bank_reconciliation_error", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
