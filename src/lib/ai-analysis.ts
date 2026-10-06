import { prisma } from "./prisma";
import { sumCreditNoteTotal } from "./credit-note-queries";
import { getProductProfitabilityReport } from "./reports";
import { getReceivablesAging } from "./customers";
import { getBusinessTimeZone } from "./business-timezone";
import { startOfMonthIn } from "./timezone";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type Severity = "info" | "warning" | "critical";

export interface Finding {
  category: string;
  severity: Severity;
  message: string;
  metric?: Record<string, number | string>;
}

/**
 * Every check here is a plain calculation – percentage comparisons,
 * threshold checks – not an LLM guessing at "does this look weird." Spec
 * section 23's own example ("transport expenses increased by 38% this
 * month") is exactly this kind of check, which is why this file has no
 * dependency on src/lib/ai-assistant.ts at all.
 */
export async function runTransactionAnalysis(businessId: string): Promise<Finding[]> {
  const findings: Finding[] = [];

  const tz = await getBusinessTimeZone(businessId);
  const now = new Date();
  const monthStart = startOfMonthIn(now, tz);
  const lastMonthStart = startOfMonthIn(now, tz, -1);

  await Promise.all([
    checkExpenseCategoryIncreases(businessId, monthStart, lastMonthStart, findings),
    checkNegativeMarginProducts(businessId, monthStart, now, findings),
    checkLowProfitProducts(businessId, monthStart, now, findings),
    checkLargeDebtorBalances(businessId, findings),
    checkSalesDecline(businessId, monthStart, lastMonthStart, findings),
    checkDuplicateTransactions(businessId, findings),
  ]);

  return findings;
}

/** Spec section 23's own example: category-level expense increase vs. the prior month. */
async function checkExpenseCategoryIncreases(
  businessId: string,
  monthStart: Date,
  lastMonthStart: Date,
  findings: Finding[]
) {
  const [thisMonth, lastMonth] = await Promise.all([
    prisma.expense.groupBy({
      by: ["category"],
      where: { businessId, expenseDate: { gte: monthStart } },
      _sum: { amount: true },
    }),
    prisma.expense.groupBy({
      by: ["category"],
      where: { businessId, expenseDate: { gte: lastMonthStart, lt: monthStart } },
      _sum: { amount: true },
    }),
  ]);

  const lastMonthByCategory = new Map<string, number>(
    lastMonth.map((c) => [String(c.category), Number(c._sum.amount ?? 0)])
  );

  for (const c of thisMonth) {
    const current = Number(c._sum.amount ?? 0);
    const previous = Number(lastMonthByCategory.get(String(c.category)) ?? 0);
    if (previous < 1000) continue; // avoid noisy percentage swings on tiny bases

    const percentChange = round2(((current - previous) / previous) * 100);
    if (percentChange >= 30) {
      findings.push({
        category: "expense_increase",
        severity: percentChange >= 60 ? "critical" : "warning",
        message: `Your ${String(c.category).replace("_", " ").toLowerCase()} expenses increased by ${percentChange}% this month compared with last month.`,
        metric: { category: String(c.category), current, previous, percentChange },
      });
    }
  }
}

async function checkNegativeMarginProducts(businessId: string, from: Date, to: Date, findings: Finding[]) {
  const profitability = await getProductProfitabilityReport(businessId, from, to);
  for (const p of profitability) {
    if (p.profit < 0) {
      findings.push({
        category: "negative_margin",
        severity: "critical",
        message: `${p.product} sold at a loss this month – revenue MWK ${p.revenue.toLocaleString()} vs. cost MWK ${p.cost.toLocaleString()}.`,
        metric: { product: p.product, revenue: p.revenue, cost: p.cost, profit: p.profit },
      });
    }
  }
}

async function checkLowProfitProducts(businessId: string, from: Date, to: Date, findings: Finding[]) {
  const profitability = await getProductProfitabilityReport(businessId, from, to);
  for (const p of profitability) {
    if (p.profit >= 0 && p.marginPercent < 10 && p.revenue > 5000) {
      findings.push({
        category: "low_profit_product",
        severity: "info",
        message: `${p.product} has a thin margin this month (${p.marginPercent}%) – worth reviewing its price or supplier cost.`,
        metric: { product: p.product, marginPercent: p.marginPercent, revenue: p.revenue },
      });
    }
  }
}

async function checkLargeDebtorBalances(businessId: string, findings: Finding[]) {
  const aging = await getReceivablesAging(businessId);
  for (const c of aging.customers) {
    if (c.buckets.days61to90 + c.buckets.days90plus > 0) {
      const overdueAmount = round2(c.buckets.days61to90 + c.buckets.days90plus);
      findings.push({
        category: "large_debtor_balance",
        severity: c.buckets.days90plus > 0 ? "critical" : "warning",
        message: `${c.customerName} has MWK ${overdueAmount.toLocaleString()} overdue by more than 60 days.`,
        metric: { customer: c.customerName, overdueAmount },
      });
    }
  }
}

/** Sudden sales decline: this month vs. last month, business-wide. */
async function checkSalesDecline(businessId: string, monthStart: Date, lastMonthStart: Date, findings: Finding[]) {
  const [thisMonth, lastMonth] = await Promise.all([
    prisma.sale.aggregate({
      where: { businessId, status: { not: "VOIDED" }, saleDate: { gte: monthStart } },
      _sum: { total: true },
    }),
    prisma.sale.aggregate({
      where: { businessId, status: { not: "VOIDED" }, saleDate: { gte: lastMonthStart, lt: monthStart } },
      _sum: { total: true },
    }),
  ]);

  // Module 43: net of credit notes issued in each month.
  const [creditsThis, creditsLast] = await Promise.all([
    sumCreditNoteTotal(businessId, { from: monthStart, to: new Date(), toInclusive: true }),
    sumCreditNoteTotal(businessId, { from: lastMonthStart, to: monthStart, toInclusive: false }),
  ]);
  const current = Number(thisMonth._sum.total ?? 0) - creditsThis;
  const previous = Number(lastMonth._sum.total ?? 0) - creditsLast;
  if (previous < 5000) return; // no meaningful baseline yet

  const percentChange = round2(((current - previous) / previous) * 100);
  if (percentChange <= -25) {
    findings.push({
      category: "sales_decline",
      severity: percentChange <= -50 ? "critical" : "warning",
      message: `Sales are down ${Math.abs(percentChange)}% this month compared with last month.`,
      metric: { current, previous, percentChange },
    });
  }
}

/**
 * Duplicate transactions: two sales for the same customer, same amount,
 * within a short window – a common data-entry error (recording the same
 * sale twice). Flags for review; does NOT auto-void anything.
 */
async function checkDuplicateTransactions(businessId: string, findings: Finding[]) {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const sales = await prisma.sale.findMany({
    where: { businessId, status: { not: "VOIDED" }, saleDate: { gte: since }, customerId: { not: null } },
    orderBy: { saleDate: "asc" },
  });

  for (let i = 0; i < sales.length; i++) {
    for (let j = i + 1; j < sales.length; j++) {
      const a = sales[i];
      const b = sales[j];
      if (a.customerId !== b.customerId) continue;
      const minutesApart = Math.abs(b.saleDate.getTime() - a.saleDate.getTime()) / 60_000;
      if (minutesApart > 10) break; // sales sorted by date – no later sale can be closer
      if (Number(a.total) === Number(b.total) && Number(a.total) > 0) {
        findings.push({
          category: "duplicate_transaction",
          severity: "warning",
          message: `Sales ${a.saleNumber} and ${b.saleNumber} are for the same customer, same amount (MWK ${Number(a.total).toLocaleString()}), within ${Math.round(minutesApart)} minutes – check this isn't a duplicate entry.`,
          metric: { saleA: a.saleNumber, saleB: b.saleNumber, amount: Number(a.total) },
        });
      }
    }
  }
}

export async function saveAnalysisRun(businessId: string, findings: Finding[], runById: string) {
  return prisma.aIAnalysis.create({
    data: { businessId, findings: findings as any, runById },
  });
}
