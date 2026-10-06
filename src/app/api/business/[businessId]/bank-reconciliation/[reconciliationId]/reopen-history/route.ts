import { NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getReopenHistory } from "@/lib/reopen-audit";

// Module 52. The detail route (../route.ts, via getBankReconciliation) already
// embeds the first page of history for free – this route exists only for the
// "load more" click once a record has been reopened past one page. Same
// "bankrecon.view" permission as reading the reconciliation itself; no new
// permission, no re-seed.
export async function GET(
  req: Request,
  props: { params: Promise<{ businessId: string; reconciliationId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "bankrecon.view");
  if (ctx instanceof NextResponse) return ctx;

  const cursor = new URL(req.url).searchParams.get("cursor") ?? undefined;

  const page = await getReopenHistory(params.businessId, "BankReconciliation", params.reconciliationId, { cursor });
  return NextResponse.json(page);
}
