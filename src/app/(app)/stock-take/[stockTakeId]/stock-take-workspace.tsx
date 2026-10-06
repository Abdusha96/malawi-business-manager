"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { formatDateIn } from "@/lib/timezone";

function fmt(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtQty(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

type Line = {
  id: string;
  status: "PENDING" | "COUNTED" | "POSTED" | "IGNORED";
  systemQuantityAtCount: number;
  countedQuantity: number | null;
  unitCost: number;
  variance: number | null;
  varianceValue: number | null;
  product: { id: string; name: string; sku: string | null; unit: string };
};

type StockTake = {
  id: string;
  status: "IN_PROGRESS" | "COMPLETED";
  note: string | null;
  createdAt: string;
  completedAt: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
  // Module 54: the stock take line (if any) the most recent reopen was
  // about – cross-referenced against `lines` below for display.
  reopenLineId: string | null;
  category: { id: string; name: string } | null;
  branch: { id: string; name: string } | null;
  lines: Line[];
  counts: { pending: number; counted: number; posted: number; ignored: number };
  readyToComplete: boolean;
  reopenCount: number;
  maxReopens: number;
  reopensRemaining: number;
  history: HistoryRow[];
  historyNextCursor: string | null;
};

type HistoryRow = { id: string; action: string; at: string; by: string | null; reason: string | null; lineLabel: string | null };

export function StockTakeWorkspace({
  businessId,
  stockTakeId,
  canManage,
  canReopen,
  timeZone,
}: {
  businessId: string;
  stockTakeId: string;
  canManage: boolean;
  canReopen: boolean;
  timeZone: string;
}) {
  const router = useRouter();
  const [data, setData] = useState<StockTake | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reopenReasonInput, setReopenReasonInput] = useState("");
  const [reopenLineIdInput, setReopenLineIdInput] = useState("");
  // Module 52: `data.history`/`data.historyNextCursor` are always just the
  // first page (embedded in the detail fetch); additional pages the user
  // has asked to see live here instead, so a fresh `load()` – after a
  // reopen or complete, say – cleanly resets back to page one.
  const [moreHistory, setMoreHistory] = useState<HistoryRow[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [loadingMoreHistory, setLoadingMoreHistory] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/business/${businessId}/stock-take/${stockTakeId}`);
    if (!res.ok) return;
    const d = await res.json();
    setData(d.stockTake);
    setMoreHistory([]);
    setHistoryCursor(d.stockTake.historyNextCursor);
  }, [businessId, stockTakeId]);

  const loadMoreHistory = useCallback(async () => {
    if (!historyCursor) return;
    setLoadingMoreHistory(true);
    const res = await fetch(
      `/api/business/${businessId}/stock-take/${stockTakeId}/reopen-history?cursor=${encodeURIComponent(historyCursor)}`
    );
    setLoadingMoreHistory(false);
    if (!res.ok) return;
    const d = await res.json();
    setMoreHistory((prev) => [...prev, ...d.rows]);
    setHistoryCursor(d.nextCursor);
  }, [businessId, stockTakeId, historyCursor]);

  useEffect(() => {
    load();
  }, [load]);

  async function runAction(lineId: string, action: string, body?: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/business/${businessId}/stock-take/${stockTakeId}/lines/${lineId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...body }),
    });
    const d = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(d.message ?? "Action failed.");
      return;
    }
    await load();
  }

  function recordCount(lineId: string) {
    const raw = counts[lineId];
    const value = Number(raw);
    if (raw === undefined || raw === "" || Number.isNaN(value) || value < 0) {
      setError("Enter a valid counted quantity (0 or more).");
      return;
    }
    runAction(lineId, "count", { countedQuantity: value });
  }

  async function complete() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/business/${businessId}/stock-take/${stockTakeId}/complete`, { method: "POST" });
    const d = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(d.message ?? "Could not complete stock take.");
      return;
    }
    await load();
  }

  async function reopen() {
    if (!reopenReasonInput.trim()) return;
    if (!confirm("Reopen this completed stock take? It will go back to In Progress until it's completed again.")) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/business/${businessId}/stock-take/${stockTakeId}/reopen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reopenReasonInput, lineId: reopenLineIdInput || null }),
    });
    const d = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(d.message ?? "Could not reopen stock take.");
      return;
    }
    setReopenReasonInput("");
    setReopenLineIdInput("");
    await load();
  }

  async function remove() {
    if (!confirm("Delete this stock take? This can't be undone.")) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/business/${businessId}/stock-take/${stockTakeId}`, { method: "DELETE" });
    const d = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(d.message ?? "Could not delete stock take.");
      return;
    }
    router.push("/stock-take");
  }

  if (!data) return <p className="text-sm text-erp-muted">Loading...</p>;

  const isOpen = data.status === "IN_PROGRESS";

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{data.category ? data.category.name : "Whole Catalog"} Stock Take{data.branch ? ` – ${data.branch.name}` : ""}</h1>
          <p className="text-sm text-erp-muted">
            Opened {formatDateIn(data.createdAt, timeZone)}{data.note ? ` – ${data.note}` : ""}
          </p>
          {data.branch && (
            <p className="text-xs text-erp-muted">Counting {data.branch.name}'s own stock, not the business-wide total.</p>
          )}
        </div>
        <span className={`rounded-full px-3 py-1 text-xs ${isOpen ? "bg-erp-warning/15 text-erp-warning" : "bg-erp-success/15 text-erp-success"}`}>
          {isOpen ? "In progress" : "Completed"}
        </span>
      </div>

      {error && <p className="mb-4 rounded bg-erp-danger/10 p-2 text-sm text-erp-danger">{error}</p>}

      {data.reopenedAt && (
        <div className="mb-4 rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-xs text-erp-warning">
          Reopened on {formatDateIn(data.reopenedAt, timeZone)}
          {data.reopenReason ? ` – ${data.reopenReason}` : ""}
          {data.reopenLineId && (
            <>
              {" "}(re:{" "}
              {data.lines.find((l) => l.id === data.reopenLineId)?.product.name ?? "a line no longer on this stock take"})
            </>
          )}
          {isOpen ? ". Complete it again once corrections are done." : " (since completed again)."}
          {" "}({data.reopenCount} of {data.maxReopens} reopens used)
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded border bg-erp-surface p-4">
          <p className="text-xs text-erp-muted">Products</p>
          <p className="text-lg font-semibold">{data.lines.length}</p>
        </div>
        <div className="rounded border bg-erp-surface p-4">
          <p className="text-xs text-erp-muted">Not Yet Counted</p>
          <p className="text-lg font-semibold">{data.counts.pending}</p>
        </div>
        <div className="rounded border bg-erp-surface p-4">
          <p className="text-xs text-erp-muted">Adjustments Posted</p>
          <p className="text-lg font-semibold">{data.counts.posted}</p>
        </div>
        <div className="rounded border bg-erp-surface p-4">
          <p className="text-xs text-erp-muted">Ignored</p>
          <p className="text-lg font-semibold">{data.counts.ignored}</p>
        </div>
      </div>

      <div className="overflow-x-auto"><table className="mb-6 w-full border-collapse overflow-hidden rounded border bg-erp-surface text-sm">
        <thead className="bg-erp-subtle text-left">
          <tr>
            <th className="p-3">Product</th>
            <th className="p-3 text-right">{data.branch ? "Branch Book Qty" : "Book Qty"}</th>
            <th className="p-3 text-right">Counted Qty</th>
            <th className="p-3 text-right">Variance</th>
            <th className="p-3 text-right">Value</th>
            <th className="p-3">Status</th>
            {isOpen && canManage && <th className="p-3">Action</th>}
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l) => (
            <tr key={l.id} className="border-t align-top">
              <td className="p-3">
                {l.product.name}
                {l.product.sku && <p className="text-xs text-erp-muted">{l.product.sku}</p>}
                {data.reopenLineId === l.id && (
                  <p className="text-xs text-erp-warning">↩ Reason for the most recent reopen</p>
                )}
              </td>
              <td className="p-3 text-right text-erp-muted">{fmtQty(l.systemQuantityAtCount)} {l.product.unit}</td>
              <td className="p-3 text-right">{l.countedQuantity === null ? "–" : `${fmtQty(l.countedQuantity)} ${l.product.unit}`}</td>
              <td className={`p-3 text-right ${l.variance === null || l.variance === 0 ? "text-erp-muted" : l.variance < 0 ? "text-erp-danger" : "text-erp-success"}`}>
                {l.variance === null ? "–" : `${l.variance > 0 ? "+" : ""}${fmtQty(l.variance)}`}
              </td>
              <td className={`p-3 text-right ${l.varianceValue === null || l.varianceValue === 0 ? "text-erp-muted" : l.varianceValue < 0 ? "text-erp-danger" : "text-erp-success"}`}>
                {l.varianceValue === null ? "–" : `MWK ${fmt(l.varianceValue)}`}
              </td>
              <td className="p-3">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    l.status === "PENDING"
                      ? "bg-erp-subtle text-erp-muted"
                      : l.status === "COUNTED"
                      ? l.variance === 0
                        ? "bg-erp-info/15 text-erp-text"
                        : "bg-erp-warning/15 text-erp-warning"
                      : l.status === "POSTED"
                      ? "bg-erp-success/15 text-erp-success"
                      : "bg-erp-subtle text-erp-muted"
                  }`}
                >
                  {l.status === "COUNTED" && l.variance === 0 ? "MATCHES BOOKS" : l.status}
                </span>
              </td>
              {isOpen && canManage && (
                <td className="p-3">
                  {l.status === "PENDING" && (
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        step="0.001"
                        min="0"
                        placeholder="Qty"
                        className="w-20 rounded border border-erp-border p-1 text-xs"
                        value={counts[l.id] ?? ""}
                        onChange={(e) => setCounts((c) => ({ ...c, [l.id]: e.target.value }))}
                      />
                      <button onClick={() => recordCount(l.id)} disabled={busy} className="text-xs text-erp-primary underline">
                        Record
                      </button>
                    </div>
                  )}
                  {l.status === "COUNTED" && l.variance === 0 && (
                    <button onClick={() => runAction(l.id, "uncount")} disabled={busy} className="text-xs text-erp-muted underline">
                      Re-count
                    </button>
                  )}
                  {l.status === "COUNTED" && l.variance !== 0 && (
                    <div className="space-x-2">
                      <button onClick={() => runAction(l.id, "post")} disabled={busy} className="text-xs text-erp-primary underline">
                        Post Adjustment
                      </button>
                      <button onClick={() => runAction(l.id, "ignore")} disabled={busy} className="text-xs text-erp-muted underline">
                        Ignore
                      </button>
                      <button onClick={() => runAction(l.id, "uncount")} disabled={busy} className="text-xs text-erp-muted underline">
                        Re-count
                      </button>
                    </div>
                  )}
                  {l.status === "POSTED" && (
                    <button onClick={() => runAction(l.id, "unpost")} disabled={busy} className="text-xs text-erp-muted underline">
                      Unpost
                    </button>
                  )}
                  {l.status === "IGNORED" && (
                    <button onClick={() => runAction(l.id, "unignore")} disabled={busy} className="text-xs text-erp-muted underline">
                      Un-ignore
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table></div>

      {isOpen && canManage && (
        <div className="flex gap-3">
          <button
            onClick={complete}
            disabled={busy || !data.readyToComplete}
            className="rounded bg-erp-primary px-4 py-2 text-erp-primary-fg hover:opacity-90 disabled:opacity-40"
            title={!data.readyToComplete ? "Every product must be counted, and every variance posted or ignored, first" : undefined}
          >
            Complete Stock Take
          </button>
          <button onClick={remove} disabled={busy} className="rounded border border-erp-danger/40 px-4 py-2 text-erp-danger hover:bg-erp-danger/10">
            Delete Stock Take
          </button>
        </div>
      )}

      {!isOpen && canReopen && (
        <div className="rounded border bg-erp-surface p-4">
          {data.reopensRemaining > 0 ? (
            <>
              <p className="mb-2 text-sm font-medium">Reopen this stock take</p>
              <p className="mb-3 text-xs text-erp-muted">
                Puts it back to In Progress so a count, a posted adjustment, or a line can be corrected. A reason is
                required. {data.reopensRemaining} of {data.maxReopens} reopens left before a manual journal is the
                only option.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  value={reopenReasonInput}
                  onChange={(e) => setReopenReasonInput(e.target.value)}
                  maxLength={500}
                  placeholder="Why this needs to be reopened"
                  className="erp-input flex-1"
                />
                <select
                  className="erp-input sm:w-64"
                  value={reopenLineIdInput}
                  onChange={(e) => setReopenLineIdInput(e.target.value)}
                >
                  <option value="">Which product? (optional)</option>
                  {data.lines.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.product.name}{l.product.sku ? ` (${l.product.sku})` : ""}
                    </option>
                  ))}
                </select>
                <button
                  onClick={reopen}
                  disabled={busy || !reopenReasonInput.trim()}
                  className="rounded border border-erp-warning/50 px-4 py-2 text-sm text-erp-warning hover:bg-erp-warning/10 disabled:opacity-40"
                >
                  Reopen Stock Take
                </button>
              </div>
            </>
          ) : (
            <p className="text-xs text-erp-muted">
              This stock take has already been reopened {data.maxReopens} times, the maximum allowed. Record any
              further correction as a manual journal entry instead.
            </p>
          )}
        </div>
      )}

      {data.history.length > 0 && (
        <details className="mt-6 rounded border bg-erp-surface p-4">
          <summary className="cursor-pointer text-sm font-medium">Reopen history</summary>
          <ul className="mt-3 space-y-2 text-xs text-erp-muted">
            {[...data.history, ...moreHistory].map((h) => (
              <li key={h.id} className="border-b pb-2 last:border-0 last:pb-0">
                <span className="font-medium text-erp-text">{h.action === "stocktake.reopen" ? "Reopened" : "Completed"}</span>
                {" "}on {formatDateIn(h.at, timeZone)}
                {h.by ? ` by ${h.by}` : ""}
                {h.reason ? ` – ${h.reason}` : ""}
                {h.lineLabel ? ` (re: ${h.lineLabel})` : ""}
              </li>
            ))}
          </ul>
          {historyCursor && (
            <button
              type="button"
              onClick={loadMoreHistory}
              disabled={loadingMoreHistory}
              className="mt-3 text-xs font-medium text-erp-text hover:underline disabled:opacity-50"
            >
              {loadingMoreHistory ? "Loading…" : "Load more"}
            </button>
          )}
        </details>
      )}
    </div>
  );
}
