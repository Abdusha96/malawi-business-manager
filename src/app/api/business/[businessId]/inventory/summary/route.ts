import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getLowStockProducts, getOutOfStockProducts, getInventoryValue, getInTransitSummary } from "@/lib/inventory";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "inventory.view");
  if (ctx instanceof NextResponse) return ctx;

  const [lowStock, outOfStock, inventoryValue, inTransit] = await Promise.all([
    getLowStockProducts(params.businessId),
    getOutOfStockProducts(params.businessId),
    getInventoryValue(params.businessId),
    // Module 56: business-wide, so it doesn't take a branchId – an in-transit
    // transfer inherently spans two branches, unlike on-hand stock.
    getInTransitSummary(params.businessId),
  ]);

  return NextResponse.json({
    lowStockCount: lowStock.length,
    outOfStockCount: outOfStock.length,
    inventoryValue,
    lowStockProducts: lowStock,
    outOfStockProducts: outOfStock,
    inTransitTransferCount: inTransit.transferCount,
    inTransitQuantity: inTransit.totalQuantity,
    inTransitValue: inTransit.totalValue,
  });
}
