import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { debitNoteSchema } from "@/lib/validation";
import { createDebitNote, listDebitNotes, DebitNoteError } from "@/lib/debit-notes";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "refunds.view");
  if (ctx instanceof NextResponse) return ctx;

  const debitNotes = await listDebitNotes(params.businessId, ctx.membership.branchId);
  return NextResponse.json({ debitNotes });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "refunds.manage");
  if (ctx instanceof NextResponse) return ctx;
  const { userId, membership } = ctx;

  const parsed = debitNoteSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const debitNote = await createDebitNote({
      businessId: params.businessId,
      userId,
      branchLock: membership.branchId,
      input: parsed.data,
    });
    return NextResponse.json({ debitNote }, { status: 201 });
  } catch (err) {
    if (err instanceof DebitNoteError) {
      return NextResponse.json({ error: "debit_note_failed", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
