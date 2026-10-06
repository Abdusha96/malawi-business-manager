import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { cashAccountSchema } from "@/lib/validation";
import { getAccountBalance } from "@/lib/cashbook";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "cashbook.view");
  if (ctx instanceof NextResponse) return ctx;

  const accounts = await prisma.cashAccount.findMany({
    where: { businessId: params.businessId, isActive: true },
    orderBy: { createdAt: "asc" },
  });

  const withBalances = await Promise.all(
    accounts.map(async (a) => ({ ...a, balance: await getAccountBalance(a.id) }))
  );

  return NextResponse.json({ accounts: withBalances });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "cashbook.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = cashAccountSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  // A newly added named account becomes the auto-post target for this type.
  // Demote the previous default first, including the generic registration
  // account named "Bank" when a real bank account is added.
  const account = await prisma.$transaction(async (tx) => {
    await tx.cashAccount.updateMany({
      where: { businessId: params.businessId, type: parsed.data.type, isDefault: true },
      data: { isDefault: false },
    });
    return tx.cashAccount.create({
      data: {
        businessId: params.businessId,
        type: parsed.data.type,
        name: parsed.data.name,
        openingBalance: parsed.data.openingBalance,
        isDefault: true,
      },
    });
  });

  return NextResponse.json({ account }, { status: 201 });
}
