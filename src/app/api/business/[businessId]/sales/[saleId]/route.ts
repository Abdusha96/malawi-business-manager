import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; saleId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "sales.view");
  if (ctx instanceof NextResponse) return ctx;

  const sale = await prisma.sale.findUnique({
    where: { id: params.saleId },
    include: {
      items: { include: { product: true } },
      customer: true,
      receipt: true,
      business: true,
      payments: true,
    },
  });

  if (!sale || sale.businessId !== params.businessId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ sale });
}
