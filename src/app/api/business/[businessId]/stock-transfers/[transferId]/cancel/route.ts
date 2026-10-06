import { NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { cancelStockTransferSchema } from "@/lib/validation";
import { getStockTransfer, cancelStockTransfer, StockTransferValidationError } from "@/lib/stock-transfers";

/**
 * Module 55: cancels a transfer that never arrived, reversing its
 * TRANSFER_OUT and returning the stock to fromBranch. Reuses
 * inventory.manage, same reasoning as the receive route's header.
 *
 * A branch-restricted member may only cancel a transfer that left THEIR OWN
 * branch – the mirror image of the receive guard – since cancelling is the
 * source branch admitting the dispatch it made didn't arrive.
 */
export async function POST(
  req: Request,
  props: { params: Promise<{ businessId: string; transferId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "inventory.manage");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const parsed = cancelStockTransferSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  const transfer = await getStockTransfer(params.businessId, params.transferId);
  if (!transfer) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (ctx.membership.branchId && transfer.fromBranchId !== ctx.membership.branchId) {
    return NextResponse.json(
      { error: "forbidden", message: "Only a member of the source branch can cancel this transfer." },
      { status: 403 }
    );
  }

  try {
    const updated = await cancelStockTransfer({
      businessId: params.businessId,
      userId,
      transferId: params.transferId,
      reason: parsed.data.reason,
    });
    return NextResponse.json({ transfer: updated });
  } catch (err) {
    if (err instanceof StockTransferValidationError) {
      return NextResponse.json({ error: "cancel_invalid", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
