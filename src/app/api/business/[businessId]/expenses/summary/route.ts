import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { getBusinessTimeZone } from "@/lib/business-timezone";
import { startOfDayIn, startOfMonthIn } from "@/lib/timezone";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "expenses.view");
  if (ctx instanceof NextResponse) return ctx;

  const tz = await getBusinessTimeZone(params.businessId);
  const now = new Date();
  const startOfToday = startOfDayIn(now, tz);
  const startOfMonth = startOfMonthIn(now, tz);

  const [todayAgg, monthAgg, byCategory] = await Promise.all([
    prisma.expense.aggregate({
      where: { businessId: params.businessId, expenseDate: { gte: startOfToday } },
      _sum: { amount: true },
    }),
    prisma.expense.aggregate({
      where: { businessId: params.businessId, expenseDate: { gte: startOfMonth } },
      _sum: { amount: true },
    }),
    prisma.expense.groupBy({
      by: ["category"],
      where: { businessId: params.businessId, expenseDate: { gte: startOfMonth } },
      _sum: { amount: true },
      orderBy: { _sum: { amount: "desc" } },
    }),
  ]);

  return NextResponse.json({
    todayTotal: Number(todayAgg._sum.amount ?? 0),
    monthTotal: Number(monthAgg._sum.amount ?? 0),
    byCategory: byCategory.map((c) => ({ category: c.category, total: Number(c._sum.amount ?? 0) })),
  });
}
