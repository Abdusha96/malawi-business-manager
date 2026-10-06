import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getDebitablePurchase } from "@/lib/debit-notes";

/** What the debit note form needs for one purchase: items, what is still debitable, and whether it's blocked. */
export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; purchaseId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "refunds.manage");
  if (ctx instanceof NextResponse) return ctx;

  const data = await getDebitablePurchase({
    businessId: params.businessId,
    purchaseId: params.purchaseId,
    branchLock: ctx.membership.branchId,
  });
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({
    purchase: {
      id: data.purchase.id,
      purchaseNumber: data.purchase.purchaseNumber,
      purchaseDate: data.purchase.purchaseDate,
      subtotal: Number(data.purchase.subtotal),
      total: Number(data.purchase.total),
      balance: Number(data.purchase.balance),
      supplier: { id: data.purchase.supplier.id, name: data.purchase.supplier.name },
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
    debitedTotal: data.debitedTotal,
    blocked: data.blocked,
  });
}
