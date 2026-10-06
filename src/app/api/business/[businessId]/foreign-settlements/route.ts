import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { requirePermission, TenantAccessError } from "@/lib/tenant";
import { foreignSettlementSchema } from "@/lib/validation";
import { settleForeignDocument, ForeignSettlementError } from "@/lib/foreign-settlement";
import { AccountingError } from "@/lib/accounting";
import { CashAccountSelectionError } from "@/lib/cashbook";

// Module 40. Same trust split as POST /payments: receiving money on a Sale needs
// payments.record; paying a supplier needs suppliers.manage (Cashier has neither
// supplier access nor the right to pay them). Business-wide, no branch scope –
// like every payment, it clears a document, and the document's own branch is
// what the cashbook row inherits.
export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "payments.record");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = foreignSettlementSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  if (parsed.data.purchaseId) {
    try {
      await requirePermission(ctx.membership, "suppliers.manage");
    } catch (err) {
      if (err instanceof TenantAccessError) {
        return NextResponse.json({ error: "forbidden", message: err.message }, { status: err.status });
      }
      throw err;
    }
  }

  try {
    const result = await settleForeignDocument({ businessId: params.businessId, userId: ctx.userId, input: parsed.data });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof CashAccountSelectionError) {
      return NextResponse.json({ error: "invalid_cash_account", message: err.message }, { status: 400 });
    }
    if (err instanceof ForeignSettlementError || err instanceof AccountingError) {
      return NextResponse.json({ error: "settlement_failed", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
