import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { resolveBranchScope, TenantAccessError } from "@/lib/tenant";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; accountId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "cashbook.view");
  if (ctx instanceof NextResponse) return ctx;

  const account = await prisma.cashAccount.findUnique({ where: { id: params.accountId } });
  if (!account || account.businessId !== params.businessId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? 50), 200);
  // Module 22 (Bank Reconciliation): narrows the list to transactions not
  // yet linked to any BankStatementLine – what the reconciliation match
  // picker needs, without a second endpoint just for that filter.
  const unmatchedOnly = searchParams.get("unmatched") === "true";

  // Module 27: filters which TRANSACTIONS are listed, not the account's
  // balance (which stays whole-account – see the CashAccount model
  // comment). A branch-restricted member only sees their branch's
  // transactions in this drill-down list; an unrestricted member can
  // filter the same way by passing ?branchId=.
  let branchId: string | null;
  try {
    branchId = resolveBranchScope(ctx.membership, searchParams.get("branchId"));
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: "forbidden" }, { status: err.status });
    throw err;
  }

  let excludeIds: string[] = [];
  if (unmatchedOnly) {
    const matchedLines = await prisma.bankStatementLine.findMany({
      where: { accountId: params.accountId, matchedTransactionId: { not: null } },
      select: { matchedTransactionId: true },
    });
    excludeIds = matchedLines.map((l) => l.matchedTransactionId as string);
  }

  const transactions = await prisma.cashTransaction.findMany({
    where: {
      accountId: params.accountId,
      ...(branchId ? { branchId } : {}),
      ...(unmatchedOnly && excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
    },
    include: { relatedAccount: true, branch: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return NextResponse.json({ account, transactions });
}
