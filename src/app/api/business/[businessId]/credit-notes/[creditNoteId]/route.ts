import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getCreditNote } from "@/lib/credit-notes";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; creditNoteId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "refunds.view");
  if (ctx instanceof NextResponse) return ctx;

  const creditNote = await getCreditNote({ businessId: params.businessId, creditNoteId: params.creditNoteId });
  if (!creditNote) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (ctx.membership.branchId && creditNote.branchId !== ctx.membership.branchId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ creditNote });
}
