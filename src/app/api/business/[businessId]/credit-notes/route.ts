import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { creditNoteSchema } from "@/lib/validation";
import { createCreditNote, listCreditNotes, CreditNoteError } from "@/lib/credit-notes";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "refunds.view");
  if (ctx instanceof NextResponse) return ctx;

  const creditNotes = await listCreditNotes(params.businessId, ctx.membership.branchId);
  return NextResponse.json({ creditNotes });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "refunds.manage");
  if (ctx instanceof NextResponse) return ctx;
  const { userId, membership } = ctx;

  const parsed = creditNoteSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const creditNote = await createCreditNote({
      businessId: params.businessId,
      userId,
      branchLock: membership.branchId,
      input: parsed.data,
    });
    return NextResponse.json({ creditNote }, { status: 201 });
  } catch (err) {
    if (err instanceof CreditNoteError) {
      return NextResponse.json({ error: "credit_note_failed", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
