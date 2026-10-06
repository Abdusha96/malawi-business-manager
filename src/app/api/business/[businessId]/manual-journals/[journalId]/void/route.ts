import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { voidManualJournalSchema } from "@/lib/validation";
import { voidManualJournal, ManualJournalError } from "@/lib/manual-journal";
import { AccountingError } from "@/lib/accounting";

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; journalId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "accounting.manage");
  if (ctx instanceof NextResponse) return ctx;

  if (ctx.membership.branchId) {
    return NextResponse.json(
      { error: "forbidden", message: "Journal entries post to the whole business's books. A branch-restricted member can't void one." },
      { status: 403 }
    );
  }

  const parsed = voidManualJournalSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const journal = await voidManualJournal({
      businessId: params.businessId,
      journalId: params.journalId,
      userId: ctx.userId,
      reason: parsed.data.reason,
    });
    return NextResponse.json({ journal });
  } catch (err) {
    if (err instanceof ManualJournalError || err instanceof AccountingError) {
      return NextResponse.json({ error: "manual_journal_failed", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
