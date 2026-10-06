import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { cashAccountUpdateSchema } from "@/lib/validation";

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; accountId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "cashbook.manage");
  if (ctx instanceof NextResponse) return ctx;

  const existing = await prisma.cashAccount.findUnique({ where: { id: params.accountId } });
  if (!existing || existing.businessId !== params.businessId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const parsed = cashAccountUpdateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  // Changing openingBalance after transactions already exist retroactively
  // shifts every historical balanceAfter snapshot out of sync with reality
  // (those snapshots are computed at post-time, not recalculated). Allowed,
  // but only before any transaction has been posted to this account, to
  // avoid silently rewriting history.
  if (parsed.data.openingBalance !== undefined) {
    const hasTransactions = await prisma.cashTransaction.findFirst({ where: { accountId: params.accountId } });
    if (hasTransactions) {
      return NextResponse.json(
        {
          error: "has_transactions",
          message: "Cannot change the opening balance after transactions have been posted to this account. Use a transfer or adjustment instead.",
        },
        { status: 400 }
      );
    }
  }

  const account = await prisma.cashAccount.update({
    where: { id: params.accountId },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.openingBalance !== undefined ? { openingBalance: parsed.data.openingBalance } : {}),
    },
  });

  return NextResponse.json({ account });
}
