import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { getAccountBalance } from "@/lib/accounting";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "accounting.view");
  if (ctx instanceof NextResponse) return ctx;

  // Module 41: ?includeInactive=1 also returns deactivated custom accounts so they can be reactivated
  // from the Chart of Accounts tab. Everything else in the app still reads active accounts only.
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";

  const accounts = await prisma.account.findMany({
    where: { businessId: params.businessId, ...(includeInactive ? {} : { isActive: true }) },
    orderBy: { code: "asc" },
  });

  // Module 41: which accounts have ever been posted to – those can't be deactivated (see
  // src/lib/account-admin.ts, rule 4). One grouped query, not one per account.
  const usage = await prisma.journalLine.groupBy({
    by: ["accountId"],
    where: { journalEntry: { businessId: params.businessId } },
    _count: { _all: true },
  });
  const posted = new Set(usage.map((u) => u.accountId));

  const withBalances = await Promise.all(
    accounts.map(async (a) => ({ ...a, balance: await getAccountBalance(params.businessId, a.id), hasPostings: posted.has(a.id) }))
  );

  return NextResponse.json({ accounts: withBalances });
}
