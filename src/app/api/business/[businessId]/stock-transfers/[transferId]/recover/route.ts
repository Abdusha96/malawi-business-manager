import { NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import {
  getStockTransfer,
  recoverStockTransferShortfall,
  StockTransferValidationError,
} from "@/lib/stock-transfers";
import { recoverStockTransferSchema } from "@/lib/validation";

/**
 * Module 66: brings back stock that was written off as short at receipt and
 * has since turned up. Reuses inventory.manage (Owner+Manager) – same tier as
 * receiving, no new permission, no re-seed.
 *
 * Guarded like receive: a branch-restricted member may only recover stock for
 * a transfer that landed at their OWN branch, because the recovered units go
 * into that branch's StockLevel.
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
      { error: "forbidden", message: "Only a member of the destination branch can record recovered stock." },
      { status: 403 }
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json", message: "Request body is not valid JSON." }, { status: 400 });
  }
  const parsed = recoverStockTransferSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", message: parsed.error.issues[0]?.message ?? "Invalid recovery.", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const updated = await recoverStockTransferShortfall({
      businessId: params.businessId,
      userId,
      transferId: params.transferId,
      lines: parsed.data.lines,
      note: parsed.data.note,
    });
    return NextResponse.json({ transfer: updated });
  } catch (err) {
    if (err instanceof StockTransferValidationError) {
      return NextResponse.json({ error: "recover_invalid", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
