import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { listAccountsForManualJournal } from "@/lib/manual-journal";

// The accounts the journal form can offer, plus the ones it can't (each with the reason and where to
// go instead). Needs accounting.manage: only someone who can post needs the picker. Making sure the
// income tax accounts exist for a business that registered before Module 41 happens inside this call.
export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "accounting.manage");
  if (ctx instanceof NextResponse) return ctx;
  return NextResponse.json(await listAccountsForManualJournal(params.businessId));
}
