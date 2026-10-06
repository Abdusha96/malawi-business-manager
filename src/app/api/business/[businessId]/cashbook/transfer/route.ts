import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { cashTransferSchema } from "@/lib/validation";
import { transferBetweenAccounts, CashbookError } from "@/lib/cashbook";

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "cashbook.manage");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const parsed = cashTransferSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await transferBetweenAccounts({
      businessId: params.businessId,
      fromAccountId: parsed.data.fromAccountId,
      toAccountId: parsed.data.toAccountId,
      amount: parsed.data.amount,
      description: parsed.data.description ?? undefined,
      createdById: userId,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof CashbookError) {
      return NextResponse.json({ error: "transfer_failed", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
