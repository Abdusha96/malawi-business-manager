import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { resolveBranchScope, TenantAccessError } from "@/lib/tenant";
import { stockTransferSchema } from "@/lib/validation";
import { createStockTransfer, getStockTransfers, StockTransferValidationError } from "@/lib/stock-transfers";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "inventory.view");
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? 50), 200);

  // A branch-restricted member sees transfers touching their own branch
  // (either end) – same resolveBranchScope() lock every other branch-scoped
  // list uses, applied here to "does this transfer touch my branch" rather
  // than a single branchId column.
  let branchId: string | null;
  try {
    branchId = resolveBranchScope(ctx.membership, searchParams.get("branchId"));
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: "forbidden" }, { status: err.status });
    throw err;
  }

  const transfers = await getStockTransfers(params.businessId, { branchId, limit });
  return NextResponse.json({ transfers });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  // inventory.manage, not a new "stocktransfers.manage" key – moving stock
  // between branches is the same tier of operational stock work as editing
  // a product or setting opening quantity, already granted to Owner +
  // Manager only (Accountant/Cashier keep inventory.view, read-only here).
  const ctx = await requireApiContext(params.businessId, "inventory.manage");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const parsed = stockTransferSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  // A branch-restricted member may only move stock into or out of their own
  // branch – unlike Sale/Purchase (which touch one branch), a transfer
  // inherently touches two, so the usual resolveBranchScope() equality
  // check doesn't fit; requiring the member's own branch on EITHER end lets
  // a branch-locked Manager send overstock out or receive an incoming
  // transfer, while still blocking a transfer between two other branches
  // they have no visibility into.
  if (ctx.membership.branchId) {
    const own = ctx.membership.branchId;
    if (parsed.data.fromBranchId !== own && parsed.data.toBranchId !== own) {
      return NextResponse.json(
        { error: "forbidden", message: "You can only transfer stock into or out of your own branch." },
        { status: 403 }
      );
    }
  }

  try {
    const transfer = await createStockTransfer({
      businessId: params.businessId,
      userId,
      input: parsed.data,
    });
    return NextResponse.json({ transfer }, { status: 201 });
  } catch (err) {
    if (err instanceof StockTransferValidationError) {
      return NextResponse.json({ error: "transfer_invalid", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
