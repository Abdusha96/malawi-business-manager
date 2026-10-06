import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; purchaseId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "purchases.view");
  if (ctx instanceof NextResponse) return ctx;

  const purchase = await prisma.purchase.findUnique({
    where: { id: params.purchaseId },
    include: { items: { include: { product: true } }, supplier: true, payments: true },
  });

  if (!purchase || purchase.businessId !== params.businessId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ purchase });
}
