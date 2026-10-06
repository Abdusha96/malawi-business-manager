import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { manualJournalSchema } from "@/lib/validation";
import { createManualJournal, listManualJournals, ManualJournalError } from "@/lib/manual-journal";
import { AccountingError } from "@/lib/accounting";
import { readDateParamOrResponse } from "@/lib/date-range-api";
import { getBusinessTimeZone } from "@/lib/business-timezone";

// Module 41 (Manual Journal Entries). Business-wide by design: the GL has no branch dimension,
// so there is no resolveBranchScope() – instead a branch-locked member may VIEW but not POST
// (see the POST handler). Viewing needs accounting.view, posting needs accounting.manage
// (Owner + Accountant); no new permission, so no re-seed.
export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "accounting.view");
  if (ctx instanceof NextResponse) return ctx;
  const tz = await getBusinessTimeZone(params.businessId);

  const { searchParams } = new URL(req.url);
  const from = readDateParamOrResponse(searchParams, "from", "start", tz);
  if (from instanceof NextResponse) return from;
  const to = readDateParamOrResponse(searchParams, "to", "end", tz);
  if (to instanceof NextResponse) return to;

  const journals = await listManualJournals(params.businessId, {
    status: searchParams.get("status") ?? undefined,
    q: searchParams.get("q") ?? undefined,
    from,
    to,
  });
  return NextResponse.json({ journals });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "accounting.manage");
  if (ctx instanceof NextResponse) return ctx;

  if (ctx.membership.branchId) {
    return NextResponse.json(
      { error: "forbidden", message: "Journal entries post to the whole business's books. A branch-restricted member can view them but not post one." },
      { status: 403 }
    );
  }

  const parsed = manualJournalSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const journal = await createManualJournal({ businessId: params.businessId, userId: ctx.userId, input: parsed.data });
    return NextResponse.json({ journal }, { status: 201 });
  } catch (err) {
    if (err instanceof ManualJournalError) {
      return NextResponse.json({ error: "manual_journal_failed", message: err.message, problems: err.problems }, { status: 400 });
    }
    if (err instanceof AccountingError) {
      return NextResponse.json({ error: "manual_journal_failed", message: err.message, problems: [err.message] }, { status: 400 });
    }
    throw err;
  }
}
