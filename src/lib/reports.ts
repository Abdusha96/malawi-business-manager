import { prisma } from "./prisma";
import { getLowStockProducts, getOutOfStockProducts, getInventoryValue, getBranchStockList } from "./inventory";
import { getReceivablesAging } from "./customers";
import { getPayablesAging } from "./suppliers";
import { ymd } from "./tax-period";
import { getBusinessTimeZone } from "./business-timezone";

/**
 * Module 30: every report in this file now accepts an optional trailing
 * `branchId`. Threading it through follows the exact pattern Module 27
 * established for `getReceivablesAging`/`getSupplierDebtList` (undefined/
 * null = business-wide, unchanged default) – the report routes resolve it
 * via `resolveBranchScope()` before calling into here, the same as every
 * other branch-scoped list route (`/sales`, `/purchases`, `/employees`).
 * This closes the KNOWN LIMITATION Module 27 documented ("no report in
 * this module currently branch-filters, so singling out just customer/
 * supplier debt would be inconsistent") by doing all seven at once.
 */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Module 18 (VAT) note on a convention used throughout this file: reports
 * that sum Sale.total ("Sales Report", "Salesperson Report") are
 * deliberately VAT-INCLUSIVE – they answer "how much did customers pay",
 * a gross figure, same as a retail Z-report. Reports that sum SaleItem.total
 * or derive profit (getProductProfitabilityReport) are correctly
 * VAT-EXCLUSIVE already, since SaleItem.total never included VAT to begin
 * with (VAT lives in the separate SaleItem.vatAmount field – see
 * src/lib/vat.ts). The one place this distinction actually mattered and
 * needed a real code change was src/lib/dashboard.ts's headline "Revenue"
 * KPI, which now explicitly subtracts Sale.tax – see that file's own
 * comment for why.
 */

// Module 34: the shared `?from=&to=` parser that used to live here
// (`parseReportDateRange`) moved to src/lib/date-range.ts (`readDateRange`,
// wrapped for routes by `readDateRangeOrResponse` in date-range-api.ts) so
// the accounting-hub routes and these report routes share ONE definition of
// "a date-only `to` means the end of that day". The old version fixed the end
// of day here but parsed the day itself as UTC, and the accounting routes
// never fixed it at all.

import { getCreditNotesInRange } from "./credit-note-queries";
import type { ReportPeriod } from "./report-period";
import { periodKey } from "./report-period";
export type { ReportPeriod } from "./report-period";

// ----------------------------------------------------------------------------
// SALES REPORT (spec section 21)
// ----------------------------------------------------------------------------

export async function getSalesReport(
  businessId: string,
  from: Date,
  to: Date,
  period: ReportPeriod,
  branchId?: string | null
) {
  const sales = await prisma.sale.findMany({
    where: {
      businessId,
      status: { not: "VOIDED" },
      saleDate: { gte: from, lte: to },
      ...(branchId ? { branchId } : {}),
    },
    orderBy: { saleDate: "asc" },
  });

  const tz = await getBusinessTimeZone(businessId);
  // Module 43: credit notes are counted in the period they were issued.
  const creditNotes = await getCreditNotesInRange(businessId, { from, to, toInclusive: true, branchId });
  const byPeriod = new Map<string, { total: number; count: number; credits: number }>();
  for (const sale of sales) {
    const key = periodKey(sale.saleDate, period, tz);
    const existing = byPeriod.get(key) ?? { total: 0, count: 0, credits: 0 };
    existing.total += Number(sale.total);
    existing.count += 1;
    byPeriod.set(key, existing);
  }
  for (const note of creditNotes) {
    const key = periodKey(note.issuedAt, period, tz);
    const existing = byPeriod.get(key) ?? { total: 0, count: 0, credits: 0 };
    existing.credits += note.total;
    byPeriod.set(key, existing);
  }

  const rows = Array.from(byPeriod.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([periodLabel, v]) => ({
      period: periodLabel,
      salesCount: v.count,
      totalSales: round2(v.total),
      creditNotes: round2(v.credits),
      netSales: round2(v.total - v.credits),
    }));

  const grandTotal = round2(sales.reduce((sum, s) => sum + Number(s.total), 0));
  const creditNotesTotal = round2(creditNotes.reduce((sum, n) => sum + n.total, 0));

  return {
    rows,
    grandTotal, // gross sales, VAT included
    creditNotesTotal,
    netTotal: round2(grandTotal - creditNotesTotal),
    saleCount: sales.length,
  };
}

// ----------------------------------------------------------------------------
// EXPENSE REPORT
// ----------------------------------------------------------------------------

export async function getExpenseReport(businessId: string, from: Date, to: Date, branchId?: string | null) {
  const expenses = await prisma.expense.findMany({
    where: { businessId, expenseDate: { gte: from, lte: to }, ...(branchId ? { branchId } : {}) },
    orderBy: { expenseDate: "asc" },
  });

  const tz = await getBusinessTimeZone(businessId);
  const byCategory = new Map<string, number>();
  for (const e of expenses) {
    byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + Number(e.amount));
  }

  return {
    rows: expenses.map((e) => ({
      date: ymd(e.expenseDate, tz),
      category: e.category,
      description: e.description,
      payee: e.payee ?? "",
      amount: round2(Number(e.amount)),
      // Module 19 (Withholding Tax)
      withholdingTaxCategory: e.withholdingTaxCategory ?? "",
      withholdingTaxAmount: round2(Number(e.withholdingTaxAmount)),
      netPaid: round2(Number(e.amount) - Number(e.withholdingTaxAmount)),
    })),
    byCategory: Array.from(byCategory.entries()).map(([category, total]) => ({ category, total: round2(total) })),
    grandTotal: round2(expenses.reduce((sum, e) => sum + Number(e.amount), 0)),
  };
}

// ----------------------------------------------------------------------------
// INVENTORY REPORT – thin wrapper reusing Module 2's inventory functions,
// kept here so all report endpoints have one consistent home.
// ----------------------------------------------------------------------------

export async function getInventoryReport(businessId: string, branchId?: string | null) {
  // Module 30: Product.quantity is still the business-wide total (Module 28
  // deliberately left it that way – see that module's write-up), so a
  // per-branch view can't just filter the same Product query by branchId.
  // It goes through getBranchStockList() instead – the Module 28 function
  // built for exactly this ("every product's stock at one branch"), same
  // source `/inventory`'s own business-wide/per-branch toggle already uses.
  // A product never attributed to this branch simply doesn't appear here,
  // the same "real answer, not a misleading 0" choice getBranchStockList()
  // documents.
  if (branchId) {
    const levels = await getBranchStockList(businessId, branchId);
    let lowStockCount = 0;
    let outOfStockCount = 0;
    let inventoryValue = 0;
    const rows = levels.map(({ product, quantity, effectiveReorderLevel, inTransitIn }) => {
      // Module 53: effectiveReorderLevel is the branch's own override if one
      // was set, else the business-wide Product.reorderLevel – closes the
      // KNOWN LIMITATION Module 30 carried forward here (applying the one
      // business-wide threshold to a branch's own quantity was the best
      // available reading before this module existed).
      if (effectiveReorderLevel > 0 && quantity <= effectiveReorderLevel) lowStockCount += 1;
      if (quantity <= 0) outOfStockCount += 1;
      inventoryValue += quantity * Number(product.purchasePrice);
      return {
        product: product.name,
        category: product.category?.name ?? "",
        quantity,
        unit: product.unit,
        purchasePrice: Number(product.purchasePrice),
        sellingPrice: Number(product.sellingPrice),
        stockValue: round2(quantity * Number(product.purchasePrice)),
        reorderLevel: effectiveReorderLevel,
        isLowStock: effectiveReorderLevel > 0 && quantity <= effectiveReorderLevel,
        // Module 56: informational only – not counted in stockValue/inventoryValue
        // above, since it hasn't landed at this branch (or anywhere) yet.
        inTransitIn,
      };
    });

    return {
      rows,
      inventoryValue: round2(inventoryValue),
      lowStockCount,
      outOfStockCount,
    };
  }

  const [products, lowStock, outOfStock, inventoryValue] = await Promise.all([
    prisma.product.findMany({ where: { businessId, isActive: true, isStocked: true }, include: { category: true } }), // Module 77: services aren't stock
    getLowStockProducts(businessId),
    getOutOfStockProducts(businessId),
    getInventoryValue(businessId),
  ]);

  return {
    rows: products.map((p) => ({
      product: p.name,
      category: p.category?.name ?? "",
      quantity: Number(p.quantity),
      unit: p.unit,
      purchasePrice: Number(p.purchasePrice),
      sellingPrice: Number(p.sellingPrice),
      stockValue: round2(Number(p.quantity) * Number(p.purchasePrice)),
    })),
    inventoryValue: round2(inventoryValue),
    lowStockCount: lowStock.length,
    outOfStockCount: outOfStock.length,
  };
}

// ----------------------------------------------------------------------------
// CUSTOMER DEBT REPORT – thin wrapper reusing Module 5's aging logic.
// ----------------------------------------------------------------------------

export async function getCustomerDebtReport(businessId: string, branchId?: string | null) {
  const aging = await getReceivablesAging(businessId, branchId);
  return {
    rows: aging.customers.map((c) => ({
      customer: c.customerName,
      phone: c.phone ?? "",
      current: round2(c.buckets.current),
      days1to30: round2(c.buckets.days1to30),
      days31to60: round2(c.buckets.days31to60),
      days61to90: round2(c.buckets.days61to90),
      days90plus: round2(c.buckets.days90plus),
      totalOutstanding: round2(c.totalOutstanding),
    })),
    totalReceivables: round2(aging.totalReceivables),
  };
}

// ----------------------------------------------------------------------------
// SUPPLIER DEBT REPORT – mirrors the customer receivables aging buckets.
// ----------------------------------------------------------------------------

export async function getSupplierDebtReport(businessId: string, branchId?: string | null) {
  const aging = await getPayablesAging(businessId, branchId);
  return {
    rows: aging.suppliers.map((s) => ({
      supplier: s.supplierName,
      phone: s.phone ?? "",
      current: round2(s.buckets.current),
      days1to30: round2(s.buckets.days1to30),
      days31to60: round2(s.buckets.days31to60),
      days61to90: round2(s.buckets.days61to90),
      days90plus: round2(s.buckets.days90plus),
      totalOutstanding: round2(s.totalOutstanding),
    })),
    totalPayables: round2(aging.totalPayables),
  };
}

// ----------------------------------------------------------------------------
// SALESPERSON REPORT – Sale.salespersonId is a plain userId (no FK relation
// in the schema, since User lives outside any one business's tenant scope),
// so names are joined here rather than via a Prisma include.
// ----------------------------------------------------------------------------

export async function getSalespersonReport(businessId: string, from: Date, to: Date, branchId?: string | null) {
  const sales = await prisma.sale.findMany({
    where: {
      businessId,
      status: { not: "VOIDED" },
      saleDate: { gte: from, lte: to },
      ...(branchId ? { branchId } : {}),
    },
  });

  // Module 43: a credit note reduces the salesperson who made the ORIGINAL sale, in the period it was issued.
  const creditNotes = await getCreditNotesInRange(businessId, { from, to, toInclusive: true, branchId });

  const salespersonIds = Array.from(new Set([...sales.map((s) => s.salespersonId), ...creditNotes.map((n) => n.salespersonId)]));
  const users = await prisma.user.findMany({ where: { id: { in: salespersonIds } } });
  const nameById = new Map<string, string>(users.map((u) => [u.id, u.name]));

  const byPerson = new Map<string, { salesCount: number; totalSales: number; credits: number }>();
  for (const sale of sales) {
    const existing = byPerson.get(sale.salespersonId) ?? { salesCount: 0, totalSales: 0, credits: 0 };
    existing.salesCount += 1;
    existing.totalSales += Number(sale.total);
    byPerson.set(sale.salespersonId, existing);
  }
  for (const note of creditNotes) {
    const existing = byPerson.get(note.salespersonId) ?? { salesCount: 0, totalSales: 0, credits: 0 };
    existing.credits += note.total;
    byPerson.set(note.salespersonId, existing);
  }

  return Array.from(byPerson.entries())
    .map(([userId, v]) => ({
      salesperson: nameById.get(userId) ?? "Unknown user",
      salesCount: v.salesCount,
      totalSales: round2(v.totalSales),
      creditNotes: round2(v.credits),
      netSales: round2(v.totalSales - v.credits),
    }))
    .sort((a, b) => b.netSales - a.netSales);
}

// ----------------------------------------------------------------------------
// PRODUCT PROFITABILITY REPORT – uses SaleItem.unitCost (snapshotted at sale
// time, added in Module 6) rather than the product's current purchasePrice,
// so this stays accurate even after purchase prices change later.
// ----------------------------------------------------------------------------

export async function getProductProfitabilityReport(
  businessId: string,
  from: Date,
  to: Date,
  branchId?: string | null
) {
  const items = await prisma.saleItem.findMany({
    where: {
      sale: {
        businessId,
        status: { not: "VOIDED" },
        saleDate: { gte: from, lte: to },
        ...(branchId ? { branchId } : {}),
      },
    },
    include: { product: true },
  });

  const byProduct = new Map<
    string,
    { name: string; quantitySold: number; revenue: number; cost: number; quantityReturned: number }
  >();

  for (const item of items) {
    const existing = byProduct.get(item.productId) ?? {
      name: item.product.name,
      quantitySold: 0,
      revenue: 0,
      cost: 0,
      quantityReturned: 0,
    };
    existing.quantitySold += Number(item.quantity);
    existing.revenue += Number(item.total);
    existing.cost += Number(item.quantity) * Number(item.unitCost);
    byProduct.set(item.productId, existing);
  }

  // Module 43: figures are NET of credit notes issued in the range. Revenue falls by the line net credited;
  // cost falls only for units that went back on the shelf (a damaged return keeps its cost).
  const creditNotes = await getCreditNotesInRange(businessId, { from, to, toInclusive: true, branchId });
  for (const note of creditNotes) {
    for (const l of note.lines) {
      const existing = byProduct.get(l.productId) ?? { name: l.productName, quantitySold: 0, revenue: 0, cost: 0, quantityReturned: 0 };
      existing.quantitySold -= l.quantity;
      existing.quantityReturned += l.quantity;
      existing.revenue -= l.net;
      if (l.restock) existing.cost -= l.quantity * l.unitCost;
      byProduct.set(l.productId, existing);
    }
  }

  return Array.from(byProduct.values())
    .map((p) => {
      const profit = round2(p.revenue - p.cost);
      const margin = p.revenue > 0 ? round2((profit / p.revenue) * 100) : 0;
      return {
        product: p.name,
        quantitySold: p.quantitySold,
        quantityReturned: p.quantityReturned,
        revenue: round2(p.revenue),
        cost: round2(p.cost),
        profit,
        marginPercent: margin,
      };
    })
    .sort((a, b) => b.profit - a.profit);
}
