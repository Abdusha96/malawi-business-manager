import { getDashboardData } from "./dashboard";
import { getReceivablesAging } from "./customers";
import { getSupplierDebtList } from "./suppliers";
import { getProductProfitabilityReport, getSalesReport, getExpenseReport } from "./reports";
import { getBusinessTimeZone } from "./business-timezone";
import { startOfMonthIn } from "./timezone";

/**
 * SECURITY BOUNDARY: this is the only data Mobi Accountant (Module 12) is
 * allowed to see. Every field here comes from a function that already
 * takes `businessId` and filters by it – the same functions the Dashboard,
 * Reports, and Debt modules use. The AI layer never receives a database
 * connection, a raw query capability, or any means to ask for "more" data
 * than what's assembled here. This is what makes "the AI must ONLY use
 * data the authenticated user is authorized to access" (spec section 22)
 * true by construction, not by hoping the model behaves – there is no
 * cross-tenant data for it to leak even if it wanted to.
 */
export async function buildBusinessContext(businessId: string) {
  const tz = await getBusinessTimeZone(businessId);
  const now = new Date();
  const monthStart = startOfMonthIn(now, tz);

  const [dashboard, receivables, payables, profitability, salesReport, expenseReport] = await Promise.all([
    getDashboardData(businessId),
    getReceivablesAging(businessId),
    getSupplierDebtList(businessId),
    getProductProfitabilityReport(businessId, monthStart, now),
    getSalesReport(businessId, monthStart, now, "daily"),
    getExpenseReport(businessId, monthStart, now),
  ]);

  return {
    asOf: now.toISOString(),
    financialSummary: dashboard.financialSummary,
    businessHealth: dashboard.businessHealth,
    topProducts: dashboard.charts.topProducts,
    salesByDay: dashboard.charts.salesByDay,
    expensesByCategory: dashboard.charts.expensesByCategory,
    paymentMethodBreakdown: dashboard.charts.paymentMethodBreakdown,
    topDebtors: receivables.customers.slice(0, 10),
    totalReceivables: receivables.totalReceivables,
    topCreditors: payables.slice(0, 10),
    productProfitability: profitability.slice(0, 20),
    monthSalesTotal: salesReport.netTotal, // Module 43: net of credit notes
    monthExpenseTotal: expenseReport.grandTotal,
    expenseBreakdown: expenseReport.byCategory,
  };
}

export type BusinessContext = Awaited<ReturnType<typeof buildBusinessContext>>;
