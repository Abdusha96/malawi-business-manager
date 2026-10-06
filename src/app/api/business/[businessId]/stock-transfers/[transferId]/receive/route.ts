import { NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getStockTransfer, receiveStockTransfer, StockTransferValidationError } from "@/lib/stock-transfers";
import { receiveStockTransferSchema } from "@/lib/validation";

/**
 * Module 55: confirms a transfer's goods arrived at toBranch. Reuses
 * inventory.manage (Owner+Manager) – same tier as creating a transfer, not
 * a new "stocktransfers.manage" key.
 *
 * A branch-restricted member may only receive a transfer landing at their
 * OWN branch – unlike the POST /stock-transfers guard (which allows either
 * end, since dispatching can be initiated from either side), receiving is
 * specifically the destination branch confirming its own delivery, so only
 * toBranchId is checked here.
 *
 * Module 65: the body is now OPTIONAL – `{ lines: [{ lineId, quantityReceived,
 * shortfallReason? }] }` records a short/damaged receipt. No body, or `{}`,
 * still means "everything arrived in full", so a Module 55 client keeps
 * working unchanged. Same permission and destination-branch guard; no new
 * permission, no re-seed.
 */
export async function POST(
  req: Request,
  props: { params: Promise<{ businessId: string; transferId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "inventory.manage");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const transfer = await getStockTransfer(params.businessId, params.transferId);
  if (!transfer) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (ctx.membership.branchId && transfer.toBranchId !== ctx.membership.branchId) {
    return NextResponse.json(
      { error: "forbidden", message: "Only a member of the destination branch can confirm receipt." },
      { status: 403 }
    );
  }

  // An absent/empty/non-JSON body is the Module 55 "receive in full" call, not an error.
  let raw: unknown = {};
  const text = await req.text();
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "invalid_json", message: "Request body is not valid JSON." }, { status: 400 });
    }
  }
  const parsed = receiveStockTransferSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", message: parsed.error.issues[0]?.message ?? "Invalid receipt.", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const updated = await receiveStockTransfer({
      businessId: params.businessId,
      userId,
      transferId: params.transferId,
      lines: parsed.data.lines,
    });
    return NextResponse.json({ transfer: updated });
  } catch (err) {
    if (err instanceof StockTransferValidationError) {
      return NextResponse.json({ error: "receive_invalid", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
