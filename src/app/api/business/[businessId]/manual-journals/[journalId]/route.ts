import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getManualJournal } from "@/lib/manual-journal";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; journalId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "accounting.view");
  if (ctx instanceof NextResponse) return ctx;

  const result = await getManualJournal({ businessId: params.businessId, journalId: params.journalId });
  if (!result) return NextResponse.json({ error: "not_found", message: "Journal entry not found." }, { status: 404 });
  return NextResponse.json(result);
}
