"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatAmount, formatNumber, isNegativeAmount } from "@/lib/erp/format";

/**
 * Reusable ERP table (Module 82, Phase 3).
 *
 * Columns are plain data (no render functions) so a Server Component can pass
 * them straight in. Rows are plain objects; the server formats dates in the
 * business time zone (formatDateIn) and passes the display string, optionally
 * with a separate sort field named by `sortKey`.
 *
 * Scope, stated honestly: search, sort, paging, column visibility, row
 * selection and CSV export all run in the browser over the rows the page
 * supplies. That is right for the lists these pages already load whole (the
 * app's own comments call this "SME scale"); it is not server-side paging, so a
 * list that can grow to many thousands of rows needs the page to filter and
 * page in its query first. Column resizing and inline editing are not built.
 */
export type DataColumn = {
  key: string;
  header: string;
  /** text (default) | money (right, MWK-less amount, red when negative) | number | badge */
  type?: "text" | "money" | "number" | "badge";
  /** Row field holding an href; the cell renders as a link. */
  hrefKey?: string;
  /** Row field holding the numeric/ISO value to sort by when the display string would sort wrongly. */
  sortKey?: string;
  /** Row field holding a badge tone: neutral | success | warning | danger | info. */
  toneKey?: string;
  sticky?: boolean;
  defaultHidden?: boolean;
  /** Footer total for money/number columns. */
  total?: boolean;
};
export type DataRow = Record<string, string | number | null | undefined>;

const TONE: Record<string, string> = {
  neutral: "bg-erp-subtle text-erp-muted",
  success: "bg-erp-success/10 text-erp-success",
  warning: "bg-erp-warning/10 text-erp-warning",
  danger: "bg-erp-danger/10 text-erp-danger",
  info: "bg-erp-info/10 text-erp-info",
};

export function DataTable({
  columns,
  rows,
  rowKey = "id",
  rowHrefKey,
  searchPlaceholder = "Search…",
  pageSize = 25,
  selectable = false,
  exportName = "export",
  emptyMessage = "No records to show.",
  compact = false,
  currency = "MWK",
}: {
  columns: DataColumn[];
  rows: DataRow[];
  rowKey?: string;
  /** Row field with the href that Enter / row click opens. */
  rowHrefKey?: string;
  searchPlaceholder?: string;
  pageSize?: number;
  selectable?: boolean;
  exportName?: string;
  emptyMessage?: string;
  /** Hides toolbar and paging – for small dashboard panels. */
  compact?: boolean;
  currency?: string;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [page, setPage] = useState(0);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(columns.filter((c) => c.defaultHidden).map((c) => c.key)));
  const [showCols, setShowCols] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  const visible = columns.filter((c) => !hidden.has(c.key));
  const colByKey = useMemo(() => new Map(columns.map((c) => [c.key, c])), [columns]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = needle
      ? rows.filter((r) => columns.some((c) => String(r[c.key] ?? "").toLowerCase().includes(needle)))
      : rows;
    if (sort) {
      const col = colByKey.get(sort.key);
      const field = col?.sortKey ?? sort.key;
      out = [...out].sort((a, b) => {
        const x = a[field] ?? "";
        const y = b[field] ?? "";
        if (typeof x === "number" && typeof y === "number") return (x - y) * sort.dir;
        return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" }) * sort.dir;
      });
    }
    return out;
  }, [rows, q, sort, columns, colByKey]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = compact ? filtered : filtered.slice(safePage * pageSize, safePage * pageSize + pageSize);

  function toggleSort(key: string) {
    setSort((s) => (s?.key === key ? (s.dir === 1 ? { key, dir: -1 } : null) : { key, dir: 1 }));
    setPage(0);
  }

  function exportCsv() {
    const source = selected.size > 0 ? filtered.filter((r) => selected.has(String(r[rowKey]))) : filtered;
    const esc = (v: unknown) => {
      let s = String(v ?? "");
      // Spreadsheet formula injection: a cell starting with = + - @ would execute in Excel.
      if (/^[=+\-@]/.test(s) && typeof v !== "number") s = `'${s}`;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [visible.map((c) => esc(c.header)).join(",")];
    for (const r of source) lines.push(visible.map((c) => esc(c.type === "money" || c.type === "number" ? (r[c.key] ?? "") : r[c.key])).join(","));
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${exportName}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Arrow keys move between rows, Enter opens the row's record.
  function onRowKey(e: React.KeyboardEvent<HTMLTableRowElement>, href?: string) {
    const rowsEls = bodyRef.current ? Array.from(bodyRef.current.querySelectorAll<HTMLTableRowElement>("tr[data-row]")) : [];
    const i = rowsEls.indexOf(e.currentTarget);
    if (e.key === "ArrowDown") { e.preventDefault(); rowsEls[i + 1]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); rowsEls[i - 1]?.focus(); }
    else if (e.key === "Enter" && href && (e.target as HTMLElement).tagName !== "A") { e.preventDefault(); router.push(href); }
  }

  const totals = useMemo(() => {
    const t: Record<string, number> = {};
    for (const c of visible) if (c.total) t[c.key] = filtered.reduce((s, r) => s + (Number(r[c.key]) || 0), 0);
    return t;
  }, [visible, filtered]);
  const hasTotals = Object.keys(totals).length > 0;

  const allOnPage = pageRows.length > 0 && pageRows.every((r) => selected.has(String(r[rowKey])));

  return (
    <div className="rounded border border-erp-border bg-erp-surface shadow-sm">
      {!compact && (
        <div className="flex flex-wrap items-center gap-2 border-b border-erp-border p-2">
          <input
            type="search"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(0); }}
            placeholder={searchPlaceholder}
            aria-label="Search table"
            className="w-56 rounded border border-erp-border bg-erp-bg px-2.5 py-1.5 text-sm focus:border-erp-primary focus:outline-none focus:ring-1 focus:ring-erp-primary"
          />
          <span className="text-xs text-erp-muted" aria-live="polite">
            {filtered.length === rows.length ? `${formatNumber(rows.length)} records` : `${formatNumber(filtered.length)} of ${formatNumber(rows.length)}`}
            {selected.size > 0 && ` · ${selected.size} selected`}
          </span>
          <div className="flex-1" />
          {selected.size > 0 && (
            <button type="button" onClick={() => setSelected(new Set())} className="text-xs text-erp-muted underline">Clear selection</button>
          )}
          <button type="button" onClick={exportCsv} className="rounded border border-erp-border px-2.5 py-1.5 text-xs hover:bg-erp-subtle">
            Export CSV{selected.size > 0 ? " (selected)" : ""}
          </button>
          <div className="relative">
            <button type="button" aria-expanded={showCols} onClick={() => setShowCols((o) => !o)} className="rounded border border-erp-border px-2.5 py-1.5 text-xs hover:bg-erp-subtle">
              Columns
            </button>
            {showCols && (
              <div className="absolute right-0 z-20 mt-1 w-44 rounded border border-erp-border bg-erp-surface p-2 text-sm shadow-lg">
                {columns.map((c) => (
                  <label key={c.key} className="flex items-center gap-2 py-0.5">
                    <input
                      type="checkbox"
                      checked={!hidden.has(c.key)}
                      onChange={() => setHidden((h) => { const n = new Set(h); if (n.has(c.key)) n.delete(c.key); else if (visible.length > 1) n.add(c.key); return n; })}
                    />
                    {c.header}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead className="sticky top-0 z-10 bg-erp-subtle">
            <tr>
              {selectable && (
                <th className="w-8 border-b border-erp-border px-2 py-1.5">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    checked={allOnPage}
                    onChange={() => setSelected((s) => { const n = new Set(s); pageRows.forEach((r) => (allOnPage ? n.delete(String(r[rowKey])) : n.add(String(r[rowKey])))); return n; })}
                  />
                </th>
              )}
              {visible.map((c) => {
                const right = c.type === "money" || c.type === "number";
                const dir = sort?.key === c.key ? sort.dir : 0;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={dir === 1 ? "ascending" : dir === -1 ? "descending" : "none"}
                    className={`whitespace-nowrap border-b border-erp-border px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-erp-muted ${right ? "text-right" : "text-left"} ${c.sticky ? "sticky left-0 z-10 bg-erp-subtle" : ""}`}
                  >
                    <button type="button" onClick={() => toggleSort(c.key)} className="uppercase tracking-wide hover:text-erp-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-erp-primary">
                      {c.header}
                      {c.type === "money" ? ` (${currency})` : ""}
                      <span aria-hidden className="ml-1">{dir === 1 ? "▲" : dir === -1 ? "▼" : ""}</span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {pageRows.length === 0 && (
              <tr><td colSpan={visible.length + (selectable ? 1 : 0)} className="px-3 py-8 text-center text-sm text-erp-muted">{q ? "No records match your search." : emptyMessage}</td></tr>
            )}
            {pageRows.map((r) => {
              const id = String(r[rowKey]);
              const href = rowHrefKey ? (r[rowHrefKey] as string | undefined) : undefined;
              return (
                <tr
                  key={id}
                  data-row
                  tabIndex={0}
                  onKeyDown={(e) => onRowKey(e, href)}
                  className={`group hover:bg-erp-subtle/60 focus:bg-erp-primary/10 focus:outline-none ${selected.has(id) ? "bg-erp-primary/5" : ""}`}
                >
                  {selectable && (
                    <td className="border-b border-erp-border px-2 py-1">
                      <input type="checkbox" aria-label="Select row" checked={selected.has(id)} onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })} />
                    </td>
                  )}
                  {visible.map((c) => {
                    const v = r[c.key];
                    const right = c.type === "money" || c.type === "number";
                    let content: React.ReactNode;
                    if (c.type === "money") content = <span className={`tabular ${isNegativeAmount(Number(v)) ? "text-erp-danger" : ""}`}>{v === null || v === undefined || v === "" ? "–" : formatAmount(Number(v))}</span>;
                    else if (c.type === "number") content = <span className="tabular">{v === null || v === undefined || v === "" ? "–" : formatNumber(Number(v))}</span>;
                    else if (c.type === "badge") content = <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${TONE[String(r[c.toneKey ?? ""] ?? "neutral")] ?? TONE.neutral}`}>{String(v ?? "")}</span>;
                    else content = <>{v === null || v === undefined || v === "" ? "–" : String(v)}</>;
                    const linkHref = c.hrefKey ? (r[c.hrefKey] as string | undefined) : undefined;
                    if (linkHref) content = <Link href={linkHref} className="font-medium text-erp-primary hover:underline">{content}</Link>;
                    return (
                      <td key={c.key} className={`whitespace-nowrap border-b border-erp-border px-2.5 py-1 ${right ? "text-right" : ""} ${c.sticky ? "sticky left-0 bg-erp-surface group-hover:bg-erp-subtle" : ""}`}>
                        {content}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
          {hasTotals && (
            <tfoot className="sticky bottom-0 bg-erp-subtle">
              <tr>
                {selectable && <td />}
                {visible.map((c, i) => (
                  <td key={c.key} className={`border-t border-erp-border px-2.5 py-1.5 text-[13px] font-semibold ${c.type === "money" || c.type === "number" ? "text-right" : ""}`}>
                    {totals[c.key] !== undefined ? <span className={`tabular ${isNegativeAmount(totals[c.key]) ? "text-erp-danger" : ""}`}>{c.type === "money" ? formatAmount(totals[c.key]) : formatNumber(totals[c.key])}</span> : i === 0 ? "Total" : ""}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {!compact && pageCount > 1 && (
        <div className="flex items-center justify-between border-t border-erp-border px-3 py-1.5 text-xs text-erp-muted">
          <span>Page {safePage + 1} of {pageCount}</span>
          <span className="flex gap-1">
            <button type="button" disabled={safePage === 0} onClick={() => setPage(safePage - 1)} className="rounded border border-erp-border px-2 py-1 disabled:opacity-40">Previous</button>
            <button type="button" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)} className="rounded border border-erp-border px-2 py-1 disabled:opacity-40">Next</button>
          </span>
        </div>
      )}
    </div>
  );
}

/** Skeleton rows for a route's loading.tsx. */
export function TableSkeleton({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="animate-pulse rounded border border-erp-border bg-erp-surface p-3" aria-busy="true" aria-label="Loading">
      <div className="mb-3 h-7 w-56 rounded bg-erp-subtle" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="mb-2 flex gap-3">
          {Array.from({ length: cols }).map((_, j) => <div key={j} className="h-4 flex-1 rounded bg-erp-subtle" />)}
        </div>
      ))}
    </div>
  );
}
