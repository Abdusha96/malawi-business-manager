import { NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getStockTransfer } from "@/lib/stock-transfers";

export async function GET(
  _req: Request,
  props: { params: Promise<{ businessId: string; transferId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "inventory.view");
  if (ctx instanceof NextResponse) return ctx;

  const transfer = await getStockTransfer(params.businessId, params.transferId);
  if (!transfer) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // A branch-restricted member can only view a transfer that touches their
  // own branch – same reasoning as the POST guard in the list route.
  if (
    ctx.membership.branchId &&
    transfer.fromBranchId !== ctx.membership.branchId &&
    transfer.toBranchId !== ctx.membership.branchId
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  return NextResponse.json({ transfer });
}
