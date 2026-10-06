import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getCreditableSale } from "@/lib/credit-notes";

/** What the credit note form needs for one sale: items, what is still creditable, and whether it's blocked. */
export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; saleId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "refunds.manage");
  if (ctx instanceof NextResponse) return ctx;

  const data = await getCreditableSale({
    businessId: params.businessId,
    saleId: params.saleId,
    branchLock: ctx.membership.branchId,
  });
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({
    sale: {
      id: data.sale.id,
      saleNumber: data.sale.saleNumber,
      saleDate: data.sale.saleDate,
      subtotal: Number(data.sale.subtotal),
      discount: Number(data.sale.discount),
      total: Number(data.sale.total),
      balance: Number(data.sale.balance),
      customer: data.sale.customer ? { id: data.sale.customer.id, name: data.sale.customer.name } : null,
    },
    items: data.items.map((i) => ({
      id: i.id,
      productName: i.productName,
      vatCategory: i.vatCategory,
      unitCost: i.unitCost,
      isStocked: i.isStocked,
      originalQuantity: i.quantity,
      originalNet: i.total,
      pool: { quantity: i.pool.quantity, net: i.pool.net, vatAmount: i.pool.vatAmount },
    })),
    creditedTotal: data.creditedTotal,
    creditedDiscountShare: data.creditedDiscountShare,
    blocked: data.blocked,
  });
}
