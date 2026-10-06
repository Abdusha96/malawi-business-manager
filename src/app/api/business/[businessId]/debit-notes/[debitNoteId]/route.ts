import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getDebitNote } from "@/lib/debit-notes";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; debitNoteId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "refunds.view");
  if (ctx instanceof NextResponse) return ctx;

  const debitNote = await getDebitNote({ businessId: params.businessId, debitNoteId: params.debitNoteId });
  if (!debitNote) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (ctx.membership.branchId && debitNote.branchId !== ctx.membership.branchId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ debitNote });
}
