"use client";

import { useEffect, useMemo, useState } from "react";
import { todayYmd, firstOfMonthYmd } from "@/lib/date-range";
import { DataTable, TableSkeleton, type DataColumn, type DataRow } from "@/components/erp/data-table";
import { KpiCard, Field, Panel, PageHeader } from "@/components/erp/display";
import { formatMoney, formatNumber, formatPercent, formatQuantity } from "@/lib/erp/format";

type ReportKey =
  | "sales"
  | "expenses"
  | "inventory"
  | "customer-debt"
  | "supplier-debt"
  | "salesperson"
  | "product-profitability";

const REPORTS: { key: ReportKey; label: string; description: string; needsDateRange: boolean }[] = [
  { key: "sales", label: "Sales", description: "Sales by period, net of credit notes issued in the same period.", needsDateRange: true },
  { key: "expenses", label: "Expenses", description: "Every expense in the range, with withholding tax.", needsDateRange: true },
  { key: "product-profitability", label: "Product Profitability", description: "Revenue, cost and margin per product, net of credit notes.", needsDateRange: true },
  { key: "salesperson", label: "Salesperson", description: "Sales and credit notes by the person who made the sale.", needsDateRange: true },
  { key: "inventory", label: "Inventory", description: "Stock on hand and its value at purchase price.", needsDateRange: false },
  { key: "customer-debt", label: "Debtors Analysis", description: "Receivables aged from the sale date.", needsDateRange: false },
  { key: "supplier-debt", label: "Creditors Analysis", description: "Payables aged from the purchase date.", needsDateRange: false },
];

// Column sets are plain data, one per report. Row field names are the ones the report routes already return.
const COLUMNS: Record<ReportKey, DataColumn[]> = {
  sales: [
    { key: "period", header: "Period" },
    { key: "salesCount", header: "Sales", type: "number", total: true },
    { key: "totalSales", header: "Total Sales", type: "money", total: true },
    { key: "creditNotes", header: "Credit Notes", type: "money", total: true },
    { key: "netSales", header: "Net Sales", type: "money", total: true },
  ],
  expenses: [
    { key: "date", header: "Date" },
    { key: "category", header: "Category" },
    { key: "description", header: "Description" },
    { key: "payee", header: "Payee" },
    { key: "amount", header: "Amount", type: "money", total: true },
    { key: "withholdingTaxCategory", header: "WHT Category", defaultHidden: true },
    { key: "withholdingTaxAmount", header: "Withheld", type: "money", total: true },
    { key: "netPaid", header: "Net Paid", type: "money", total: true },
  ],
  "product-profitability": [
    { key: "product", header: "Product" },
    { key: "quantitySoldText", header: "Qty Sold", sortKey: "quantitySold" },
    { key: "quantityReturnedText", header: "Qty Returned", sortKey: "quantityReturned", defaultHidden: true },
    { key: "revenue", header: "Revenue", type: "money", total: true },
    { key: "cost", header: "Cost", type: "money", total: true },
    { key: "profit", header: "Profit", type: "money", total: true },
    { key: "marginText", header: "Margin", sortKey: "marginPercent" },
  ],
  salesperson: [
    { key: "salesperson", header: "Salesperson" },
    { key: "salesCount", header: "Sales", type: "number", total: true },
    { key: "totalSales", header: "Total Sales", type: "money", total: true },
    { key: "creditNotes", header: "Credit Notes", type: "money", total: true },
    { key: "netSales", header: "Net Sales", type: "money", total: true },
  ],
  inventory: [
    { key: "product", header: "Product" },
    { key: "category", header: "Category" },
    { key: "quantityText", header: "Quantity", sortKey: "quantity" },
    { key: "unit", header: "Unit" },
    { key: "purchasePrice", header: "Purchase Price", type: "money", defaultHidden: true },
    { key: "sellingPrice", header: "Selling Price", type: "money", defaultHidden: true },
    { key: "stockValue", header: "Stock Value", type: "money", total: true },
    { key: "reorderLevelText", header: "Reorder Level", sortKey: "reorderLevel", defaultHidden: true },
    { key: "stockStatus", header: "Status", type: "badge", toneKey: "stockTone" },
  ],
  "customer-debt": [
    { key: "customer", header: "Customer" },
    { key: "phone", header: "Phone", defaultHidden: true },
    { key: "current", header: "Current", type: "money", total: true },
    { key: "days1to30", header: "1–30 days", type: "money", total: true },
    { key: "days31to60", header: "31–60 days", type: "money", total: true },
    { key: "days61to90", header: "61–90 days", type: "money", total: true },
    { key: "days90plus", header: "90+ days", type: "money", total: true },
    { key: "totalOutstanding", header: "Outstanding", type: "money", total: true },
  ],
  "supplier-debt": [
    { key: "supplier", header: "Supplier" },
    { key: "phone", header: "Phone", defaultHidden: true },
    { key: "current", header: "Current", type: "money", total: true },
    { key: "days1to30", header: "1–30 days", type: "money", total: true },
    { key: "days31to60", header: "31–60 days", type: "money", total: true },
    { key: "days61to90", header: "61–90 days", type: "money", total: true },
    { key: "days90plus", header: "90+ days", type: "money", total: true },
    { key: "totalOutstanding", header: "Outstanding", type: "money", total: true },
  ],
};

/** Adds the display-only fields (formatted quantities, status badge, row id) the DataTable columns above point at. */
function prepareRows(key: ReportKey, raw: Record<string, any>[]): DataRow[] {
  return raw.map((r, i) => {
    const row: DataRow = { ...r, id: String(i) };
    if (key === "product-profitability") {
      row.quantitySoldText = formatQuantity(r.quantitySold);
      row.quantityReturnedText = formatQuantity(r.quantityReturned);
      row.marginText = formatPercent(r.marginPercent);
    }
    if (key === "inventory") {
      row.quantityText = formatQuantity(r.quantity);
      row.reorderLevelText = r.reorderLevel === undefined ? "" : formatQuantity(r.reorderLevel);
      // isLowStock is only present on the per-branch view; the business-wide view has no per-row flag.
      if (r.quantity <= 0) { row.stockStatus = "Out of stock"; row.stockTone = "danger"; }
      else if (r.isLowStock) { row.stockStatus = "Low"; row.stockTone = "warning"; }
      else { row.stockStatus = ""; row.stockTone = "neutral"; }
    }
    return row;
  });
}

export function ReportsHub({
  businessId,
  branches,
  timeZone,
}: {
  businessId: string;
  timeZone: string;
  branches: { id: string; name: string }[];
}) {
  const [active, setActive] = useState<ReportKey>("sales");
  // Module 34/35: calendar dates in the BUSINESS'S zone – `toISOString().slice(0, 10)` converts to UTC first,
  // which put "From" on the last day of the previous month in Malawi (UTC+2).
  const [from, setFrom] = useState(() => firstOfMonthYmd(timeZone));
  const [to, setTo] = useState(() => todayYmd(timeZone));
  const [period, setPeriod] = useState("daily");
  // Module 30: "" = business-wide, same "All Branches" default the
  // dashboard's BranchSwitcher uses. Restricted members never see this
  // picker (branches=[] from the server) – the report routes lock them to
  // their own branch either way via resolveBranchScope(), so leaving this
  // unset for them is a real business-wide-view choice, not a gap.
  const [branchId, setBranchId] = useState("");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const activeConfig = REPORTS.find((r) => r.key === active)!;

  useEffect(() => {
    // Phase 10: a response that arrives after the person has already switched report or range is dropped,
    // so a slow earlier request can no longer overwrite the table they are now looking at.
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query = new URLSearchParams();
    if (activeConfig.needsDateRange) {
      query.set("from", from);
      query.set("to", to);
    }
    if (active === "sales") query.set("period", period);
    if (branchId) query.set("branchId", branchId);

    fetch(`/api/business/${businessId}/reports/${active}?${query.toString()}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(
            res.status === 403
              ? "You don't have access to this report."
              : typeof body?.error === "string" && body.error !== "forbidden"
                ? body.error
                : "The report could not be loaded. Check the dates and try again."
          );
        }
        return res.json();
      })
      .then((json) => { if (!cancelled) setData(json); })
      .catch((err: Error) => {
        if (!cancelled) { setData(null); setError(err.message); }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [active, from, to, period, branchId, businessId, activeConfig.needsDateRange]);

  function downloadCsv() {
    const query = new URLSearchParams({ format: "csv" });
    if (activeConfig.needsDateRange) {
      query.set("from", from);
      query.set("to", to);
    }
    if (active === "sales") query.set("period", period);
    if (branchId) query.set("branchId", branchId);
    window.location.href = `/api/business/${businessId}/reports/${active}?${query.toString()}`;
  }

  const rows = useMemo(() => prepareRows(active, (data?.rows ?? []) as Record<string, any>[]), [active, data]);
  const kpis = data ? buildKpis(active, data) : [];
  const byCategory: { category: string; total: number }[] = active === "expenses" ? data?.byCategory ?? [] : [];

  return (
    <div>
      <PageHeader
        title="Reports"
        description={activeConfig.description}
        actions={
          <button type="button" onClick={downloadCsv} className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">
            Download full CSV
          </button>
        }
      />

      <div role="tablist" aria-label="Report" className="mb-3 flex flex-wrap gap-1 border-b border-erp-border">
        {REPORTS.map((r) => (
          <button
            key={r.key}
            type="button"
            role="tab"
            aria-selected={active === r.key}
            onClick={() => setActive(r.key)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
              active === r.key
                ? "border-erp-primary font-medium text-erp-primary"
                : "border-transparent text-erp-muted hover:text-erp-text"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded border border-erp-border bg-erp-surface p-3 shadow-sm">
        {branches.length > 0 && (
          <Field label="Branch" htmlFor="rpt-branch">
            <select id="rpt-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)} className="erp-input">
              <option value="">All Branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </Field>
        )}
        {activeConfig.needsDateRange && (
          <>
            <Field label="From" htmlFor="rpt-from">
              <input id="rpt-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="erp-input" />
            </Field>
            <Field label="To" htmlFor="rpt-to">
              <input id="rpt-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="erp-input" />
            </Field>
          </>
        )}
        {active === "sales" && (
          <Field label="Group by" htmlFor="rpt-period">
            <select id="rpt-period" value={period} onChange={(e) => setPeriod(e.target.value)} className="erp-input">
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="annual">Annual</option>
            </select>
          </Field>
        )}
        {!activeConfig.needsDateRange && (
          <p className="pb-1.5 text-xs text-erp-muted">This report shows the position as it is now, so it has no date range.</p>
        )}
      </div>

      {error ? (
        <div role="alert" className="rounded border border-erp-danger/40 bg-erp-danger/10 p-3 text-sm text-erp-danger">{error}</div>
      ) : loading ? (
        <TableSkeleton rows={6} cols={5} />
      ) : (
        <>
          {kpis.length > 0 && (
            <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              {kpis.map((k) => (
                <KpiCard key={k.label} label={k.label} value={k.value} tone={k.tone} />
              ))}
            </div>
          )}

          {byCategory.length > 0 && (
            <Panel title="Expenses by category">
              <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                {byCategory.map((c) => (
                  <div key={c.category} className="flex justify-between gap-2 border-b border-erp-border py-1">
                    <dt className="text-erp-muted">{c.category}</dt>
                    <dd className="tabular">{formatMoney(c.total)}</dd>
                  </div>
                ))}
              </dl>
            </Panel>
          )}

          {/* key: switching report resets the table's own search, sort, paging and column choices */}
          <DataTable
            key={active}
            columns={COLUMNS[active]}
            rows={rows}
            exportName={`${active}-report-view`}
            searchPlaceholder="Search this report…"
            emptyMessage={activeConfig.needsDateRange ? "No data for this range." : "No data to show."}
          />
          <p className="mt-2 text-[11px] text-erp-muted">
            “Export CSV” in the table saves the rows currently shown; “Download full CSV” above saves the whole report from the server.
          </p>
        </>
      )}
    </div>
  );
}

type Kpi = { label: string; value: string; tone?: "good" | "bad" };

/** Top-of-report totals, from the figures each report route already returns. A figure the route doesn't send is not shown. */
function buildKpis(key: ReportKey, d: any): Kpi[] {
  const out: Kpi[] = [];
  const money = (label: string, v: unknown, tone?: Kpi["tone"]) => {
    if (typeof v === "number") out.push({ label, value: formatMoney(v), tone });
  };
  const count = (label: string, v: unknown, tone?: Kpi["tone"]) => {
    if (typeof v === "number") out.push({ label, value: formatNumber(v), tone });
  };
  switch (key) {
    case "sales":
      money("Gross sales", d.grandTotal);
      money("Credit notes", d.creditNotesTotal);
      money("Net sales", d.netTotal, "good");
      count("Sales", d.saleCount);
      break;
    case "expenses":
      money("Total expenses", d.grandTotal);
      count("Entries", Array.isArray(d.rows) ? d.rows.length : undefined);
      break;
    case "inventory":
      money("Inventory value", d.inventoryValue);
      count("Low stock", d.lowStockCount, d.lowStockCount > 0 ? "bad" : undefined);
      count("Out of stock", d.outOfStockCount, d.outOfStockCount > 0 ? "bad" : undefined);
      break;
    case "customer-debt":
      money("Total receivables", d.totalReceivables);
      break;
    case "supplier-debt":
      money("Total payables", d.totalPayables);
      break;
    case "salesperson": {
      const rows: any[] = d.rows ?? [];
      if (rows.length) money("Net sales", rows.reduce((s, r) => s + (Number(r.netSales) || 0), 0), "good");
      break;
    }
    case "product-profitability": {
      const rows: any[] = d.rows ?? [];
      if (rows.length) {
        const revenue = rows.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
        const profit = rows.reduce((s, r) => s + (Number(r.profit) || 0), 0);
        money("Revenue", revenue);
        money("Profit", profit, profit < 0 ? "bad" : "good");
        if (revenue > 0) out.push({ label: "Overall margin", value: formatPercent((profit / revenue) * 100) });
      }
      break;
    }
  }
  return out;
}
