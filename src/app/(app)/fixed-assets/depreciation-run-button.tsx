"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { monthKey } from "@/lib/tax-period";
import { formatMoney } from "@/lib/erp/format";

// Module 35: the current month in the BUSINESS'S zone, not the browser's.
function currentPeriod(timeZone: string) {
  return monthKey(new Date(), timeZone);
}

export function DepreciationRunButton({ businessId, timeZone }: { businessId: string; timeZone: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState(currentPeriod(timeZone));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<{ assetName: string; amount: number; skipped?: string }[] | null>(null);

  async function runDepreciation() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/business/${businessId}/fixed-assets/depreciation-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Could not run depreciation.");
        return;
      }
      setResults(data.results);
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">
        Run Depreciation
      </button>
    );
  }

  return (
    <div className="w-full rounded border border-erp-border bg-erp-surface p-3 text-sm shadow-sm sm:w-auto sm:min-w-[22rem]">
      <div className="mb-2 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="dep-period" className="mb-1 block text-xs font-medium text-erp-text">Period</label>
          <input id="dep-period" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="erp-input" />
        </div>
        <button
          onClick={runDepreciation}
          disabled={loading || !period}
          className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
        >
          {loading ? "Running..." : "Run"}
        </button>
        <button onClick={() => setOpen(false)} className="text-xs text-erp-muted underline">
          Close
        </button>
      </div>
      {error && <p role="alert" className="rounded border border-erp-danger/40 bg-erp-danger/10 p-2 text-erp-danger">{error}</p>}
      {results && (
        <div className="max-h-48 overflow-y-auto rounded border border-erp-border">
          {results.length === 0 ? (
            <p className="p-2 text-erp-muted">No active assets to depreciate.</p>
          ) : (
            results.map((r, i) => (
              <div key={i} className="flex justify-between gap-3 border-t border-erp-border p-2 first:border-t-0">
                <span>{r.assetName}</span>
                <span className={`tabular ${r.skipped ? "text-erp-muted" : "font-medium"}`}>
                  {r.skipped ? r.skipped : formatMoney(r.amount)}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
