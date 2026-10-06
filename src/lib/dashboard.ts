import { prisma } from "./prisma";
import { getLowStockProducts, getOutOfStockProducts, getInventoryValue, getInTransitSummary } from "./inventory";
import { getReceivablesAging } from "./customers";
import { getTotalSupplierDebt } from "./suppliers";
import { getCashbookSummary } from "./cashbook";
import { ymd } from "./tax-period";
import { getCreditNotesInRange } from "./credit-note-queries";
import { getBusinessTimeZone } from "./business-timezone";
import { addDaysIn, startOfDayIn, startOfMonthIn, zonedParts } from "./timezone";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Module 35: "today" and "this month" are the BUSINESS'S calendar (Business.timezone), not the
// server's – see src/lib/timezone.ts. A UTC host used to start "today" at 02:00 Malawi time, so a
// sale rung up at 01:00 counted toward yesterday's dashboard figure.

/**
 * Revenue and cost figures for a date range, computed from non-voided sales
 * and their line items. Cost uses SaleItem.unitCost (snapshotted at sale
 * time – see the schema comment) rather than the product's current
 * purchasePrice, so this stays correct even after purchase prices change.
 */
async function getSalesAndCost(businessId: string, from: Date, to?: Date, branchId?: string | null) {
  const sales = await prisma.sale.findMany({
    where: {
      businessId,
      status: { not: "VOIDED" },
      saleDate: { gte: from, ...(to ? { lt: to } : {}) },
      ...(branchId ? { branchId } : {}),
    },
    include: { items: true },
  });

  // Module 18 (VAT): revenue excludes VAT – sale.total is VAT-inclusive
  // (what the customer actually paid), but the VAT portion isn't the
  // business's revenue, it's money held for the MRA (see
  // VAT_OUTPUT_PAYABLE in src/lib/accounting-integrations.ts). Before this
  // module, sale.tax was always a manual, rarely-used number, so this
  // distinction didn't practically matter; now that VAT is computed
  // automatically for VAT-registered businesses, using sale.total directly
  // here would overstate revenue by the VAT amount on every dashboard and
  // report that reads it.
  const revenue = sales.reduce((sum, s) => sum + (Number(s.total) - Number(s.tax)), 0);
  const cost = sales.reduce(
    (sum, s) => sum + s.items.reduce((itemSum, i) => itemSum + Number(i.quantity) * Number(i.unitCost), 0),
    0
  );

  // Module 43: credit notes issued in the same window reduce revenue (ex-VAT, after the discount share) and
  // cost (restocked units only). The window's upper bound is exclusive here, like the sales query above.
  const creditNotes = await getCreditNotesInRange(businessId, { from, to: to ?? new Date(), toInclusive: !to, branchId });
  const creditRevenue = creditNotes.reduce((sum, n) => sum + n.netAmount, 0);
  const creditCost = creditNotes.reduce((sum, n) => sum + n.costRestored, 0);

  return { revenue: round2(revenue - creditRevenue), cost: round2(cost - creditCost), saleCount: sales.length };
}

async function getExpenseTotal(businessId: string, from: Date, to?: Date, branchId?: string | null) {
  const agg = await prisma.expense.aggregate({
    where: { businessId, expenseDate: { gte: from, ...(to ? { lt: to } : {}) }, ...(branchId ? { branchId } : {}) },
    _sum: { amount: true },
  });
  return round2(Number(agg._sum.amount ?? 0));
}

/**
 * Cash/mobile-money/bank balances now come from the real Cashbook ledger
 * (Module 9) rather than being derived after the fact from Payment/Expense
 * sums. getChannelBalances() (the old approximation) has been removed –
 * see src/lib/cashbook.ts::getCashbookSummary for the real implementation.
 * Multiple accounts of the same type (e.g. two bank accounts) are summed
 * per type here for the dashboard's single-figure display; the Cashbook
 * page itself shows each account separately.
 */
async function getChannelBalancesFromLedger(businessId: string) {
  const summary = await getCashbookSummary(businessId);
  const balances: Record<string, number> = { CASH: 0, BANK: 0, AIRTEL_MONEY: 0, TNM_MPAMBA: 0 };
  for (const account of summary.accounts) {
    balances[account.type] = round2((balances[account.type] ?? 0) + account.balance);
  }
  return { balances, totalBalance: summary.totalBalance, accountCount: summary.accounts.length };
}

async function getOverdueReceivables(businessId: string, branchId?: string | null) {
  // A receivable is only considered overdue when an issued invoice has an
  // explicit due date. Sales without invoice terms remain outstanding, but
  // the app has no basis to call them overdue.
  const openSales = await prisma.sale.findMany({
    where: {
      businessId,
      status: { in: ["PARTIAL", "CREDIT"] },
      balance: { gt: 0 },
      ...(branchId ? { branchId } : {}),
      invoice: { is: { dueDate: { lt: new Date() } } },
    },
    select: { balance: true },
  });
  return round2(openSales.reduce((sum, sale) => sum + Number(sale.balance), 0));
}

export async function getDashboardData(businessId: string, branchId?: string | null) {
  const tz = await getBusinessTimeZone(businessId);
  const now = new Date();
  const today = startOfDayIn(now, tz);
  const monthStart = startOfMonthIn(now, tz);
  const lastMonthStart = startOfMonthIn(now, tz, -1);
  // Compare matching month-to-date windows. Comparing (for example) five
  // days of this month with all of last month makes the growth percentage
  // misleading, especially early in a month.
  const todayParts = zonedParts(now, tz);
  const lastMonthParts = zonedParts(lastMonthStart, tz);
  const daysInLastMonth = new Date(Date.UTC(lastMonthParts.year, lastMonthParts.month, 0)).getUTCDate();
  const lastMonthComparisonEnd = addDaysIn(lastMonthStart, tz, Math.min(todayParts.day, daysInLastMonth));

  const [
    todaySales,
    todayExpenses,
    monthSales,
    monthExpenses,
    lastMonthSales,
    lastMonthExpenses,
    channelBalances,
    lowStock,
    outOfStock,
    inventoryValue,
    inTransit,
    receivables,
    topProducts,
    paymentMethodBreakdown,
    salesByDay,
    expensesByCategory,
    supplierDebt,
    overdueReceivables,
    openPurchaseCount,
  ] = await Promise.all([
    getSalesAndCost(businessId, today, undefined, branchId),
    getExpenseTotal(businessId, today, undefined, branchId),
    getSalesAndCost(businessId, monthStart, undefined, branchId),
    getExpenseTotal(businessId, monthStart, undefined, branchId),
    getSalesAndCost(businessId, lastMonthStart, lastMonthComparisonEnd, branchId),
    getExpenseTotal(businessId, lastMonthStart, lastMonthComparisonEnd, branchId),
    // Module 27: receivables and supplier debt are now branch-filterable
    // (Sale already carried branchId since Module 13; Purchase gained one
    // this module) – pass branchId through like every other figure below.
    // Cash/mobile-money/bank balances and inventory are the two figures
    // that STAY business-wide on purpose: a CashAccount balance is a
    // whole-account fact (see its model comment) and Product/inventory is
    // a deliberately deferred, separate piece of future work (see
    // Product's model comment) – neither is an oversight.
    getChannelBalancesFromLedger(businessId),
    getLowStockProducts(businessId),
    getOutOfStockProducts(businessId),
    getInventoryValue(businessId),
    // Module 56: business-wide like inventoryValue above, for the same
    // reason – a transfer inherently spans two branches, and StockLevel's
    // own branch scoping doesn't apply to stock that hasn't landed anywhere.
    getInTransitSummary(businessId),
    getReceivablesAging(businessId, branchId),
    getTopSellingProducts(businessId, monthStart, 5, branchId),
    getPaymentMethodBreakdown(businessId, monthStart, branchId),
    getSalesByDay(businessId, 14, tz, branchId),
    getExpensesByCategory(businessId, monthStart, branchId),
    getTotalSupplierDebt(businessId, branchId),
    getOverdueReceivables(businessId, branchId),
    prisma.purchase.count({
      where: { businessId, status: { in: ["PARTIAL", "CREDIT"] }, balance: { gt: 0 }, ...(branchId ? { branchId } : {}) },
    }),
  ]);

  const todayProfit = round2(todaySales.revenue - todaySales.cost - todayExpenses);
  const monthGrossProfit = round2(monthSales.revenue - monthSales.cost);
  const monthNetProfit = round2(monthGrossProfit - monthExpenses);
  const lastMonthNetProfit = round2(lastMonthSales.revenue - lastMonthSales.cost - lastMonthExpenses);

  const grossProfitMargin = monthSales.revenue > 0 ? round2((monthGrossProfit / monthSales.revenue) * 100) : 0;
  const netProfitMargin = monthSales.revenue > 0 ? round2((monthNetProfit / monthSales.revenue) * 100) : 0;
  const salesGrowth =
    lastMonthSales.revenue > 0
      ? round2(((monthSales.revenue - lastMonthSales.revenue) / lastMonthSales.revenue) * 100)
      : null; // null = no baseline to compare against yet, not zero growth
  const expenseGrowth =
    lastMonthExpenses > 0 ? round2(((monthExpenses - lastMonthExpenses) / lastMonthExpenses) * 100) : null;

  return {
    financialSummary: {
      todaySales: todaySales.revenue,
      todayExpenses,
      todayProfit,
      monthlySales: monthSales.revenue,
      monthlyExpenses: monthExpenses,
      monthlyProfit: monthNetProfit,
      cashPosition: channelBalances.totalBalance,
      cashAccountCount: channelBalances.accountCount,
      overdueReceivables,
      openPurchaseCount,
      cashBalance: channelBalances.balances.CASH,
      mobileMoneyBalance: round2(channelBalances.balances.AIRTEL_MONEY + channelBalances.balances.TNM_MPAMBA),
      bankBalance: channelBalances.balances.BANK,
      balancesAreApproximate: false, // real Cashbook ledger (Module 9) as of this dashboard version
    },
    businessHealth: {
      grossProfitMargin,
      netProfitMargin,
      salesGrowth,
      expenseGrowth,
      inventoryValue: round2(inventoryValue),
      outstandingCustomerDebt: round2(receivables.totalReceivables),
      supplierDebt,
      supplierDebtAvailable: true, // Suppliers module (Module 8) now provides real data
      lowStockCount: lowStock.length,
      outOfStockCount: outOfStock.length,
      stockInTransitCount: inTransit.transferCount,
      stockInTransitValue: round2(inTransit.totalValue),
    },
    // Module 82: the lists behind the dashboard's aging / low-stock panels, taken
    // from the same queries as the headline figures above so the two never disagree.
    lists: {
      receivableBuckets: receivables.bucketTotals,
      receivableCustomers: receivables.customers.slice(0, 15).map((c) => ({
        customerId: c.customerId,
        customerName: c.customerName,
        total: round2(c.totalOutstanding),
        current: round2(c.buckets.current),
        days1to30: round2(c.buckets.days1to30),
        days31to60: round2(c.buckets.days31to60),
        days61to90: round2(c.buckets.days61to90),
        days90plus: round2(c.buckets.days90plus),
      })),
      lowStock: lowStock.slice(0, 15).map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        quantity: Number(p.quantity),
        reorderLevel: Number(p.reorderLevel),
      })),
    },
    charts: {
      salesByDay,
      expensesByCategory,
      topProducts,
      paymentMethodBreakdown,
      profitTrend: {
        thisMonth: monthNetProfit,
        lastMonth: lastMonthNetProfit,
      },
    },
  };
}

async function getTopSellingProducts(businessId: string, since: Date, limit = 5, branchId?: string | null) {
  const items = await prisma.saleItem.findMany({
    where: {
      sale: { businessId, status: { not: "VOIDED" }, saleDate: { gte: since }, ...(branchId ? { branchId } : {}) },
    },
    include: { product: true },
  });

  const byProduct = new Map<string, { name: string; quantitySold: number; revenue: number }>();
  for (const item of items) {
    const existing = byProduct.get(item.productId) ?? { name: item.product.name, quantitySold: 0, revenue: 0 };
    existing.quantitySold += Number(item.quantity);
    existing.revenue += Number(item.total);
    byProduct.set(item.productId, existing);
  }

  // Module 43: net of credit notes issued since `since`.
  const creditNotes = await getCreditNotesInRange(businessId, { from: since, to: new Date(), toInclusive: true, branchId });
  for (const note of creditNotes) {
    for (const l of note.lines) {
      const existing = byProduct.get(l.productId) ?? { name: l.productName, quantitySold: 0, revenue: 0 };
      existing.quantitySold -= l.quantity;
      existing.revenue -= l.net;
      byProduct.set(l.productId, existing);
    }
  }

  return Array.from(byProduct.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit)
    .map((p) => ({ ...p, revenue: round2(p.revenue) }));
}

async function getPaymentMethodBreakdown(businessId: string, since: Date, branchId?: string | null) {
  // Module 18 (VAT): deliberately VAT-INCLUSIVE, unlike getSalesAndCost's
  // revenue figure above – this answers "how much money moved through each
  // channel", which is the actual amount collected, VAT included. It's not
  // labeled "revenue" anywhere it's displayed (see "Sales by Payment
  // Method" in src/app/dashboard/page.tsx).
  const grouped = await prisma.sale.groupBy({
    by: ["paymentMethod"],
    where: { businessId, status: { not: "VOIDED" }, saleDate: { gte: since }, ...(branchId ? { branchId } : {}) },
    _sum: { total: true },
  });

  return grouped.map((g) => ({ method: g.paymentMethod, total: round2(Number(g._sum.total ?? 0)) }));
}

async function getSalesByDay(businessId: string, days: number, tz: string, branchId?: string | null) {
  // Module 18 (VAT): same deliberate choice as getPaymentMethodBreakdown
  // above – a transaction-volume trend ("Sales by Day"), not the "Revenue"
  // KPI, so VAT-inclusive here is correct.
  const now = new Date();
  // `days` calendar days ending today, in the business's zone (stepped by calendar day, not by 24h).
  const since = addDaysIn(now, tz, -(days - 1));
  const sales = await prisma.sale.findMany({
    where: { businessId, status: { not: "VOIDED" }, saleDate: { gte: since }, ...(branchId ? { branchId } : {}) },
    select: { saleDate: true, total: true },
  });

  const totalsByDate = new Map<string, number>();
  for (const sale of sales) {
    // Module 34/35: the business's calendar day – toISOString() converted to UTC first, which
    // mis-filed any sale rung up before 02:00 in Malawi (UTC+2) under the previous day.
    const key = ymd(sale.saleDate, tz);
    totalsByDate.set(key, (totalsByDate.get(key) ?? 0) + Number(sale.total));
  }

  // Fill every day in the range, including zero-sale days, so the chart
  // doesn't misleadingly skip gaps.
  const result: { date: string; total: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = ymd(addDaysIn(now, tz, -i), tz);
    result.push({ date: key, total: round2(totalsByDate.get(key) ?? 0) });
  }
  return result;
}

async function getExpensesByCategory(businessId: string, since: Date, branchId?: string | null) {
  const grouped = await prisma.expense.groupBy({
    by: ["category"],
    where: { businessId, expenseDate: { gte: since }, ...(branchId ? { branchId } : {}) },
    _sum: { amount: true },
    orderBy: { _sum: { amount: "desc" } },
  });

  return grouped.map((g) => ({ category: g.category, total: round2(Number(g._sum.amount ?? 0)) }));
}
