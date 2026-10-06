"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { todayYmd } from "@/lib/date-range";
import { formatDateIn } from "@/lib/timezone";
import { classifyLineDate, OUT_OF_PERIOD_LOOKBACK_DAYS } from "@/lib/bank-statement-csv";
import { describeOverlap, StatementOverlap } from "@/lib/statement-overlap";

function fmt(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type Line = {
  id: string;
  lineDate: string;
  description: string;
  amount: number;
  status: "UNMATCHED" | "MATCHED" | "POSTED" | "IGNORED";
  matchedTransaction?: { id: string; description: string | null; amount: number; createdAt: string } | null;
};

type Reconciliation = {
  id: string;
  status: "IN_PROGRESS" | "COMPLETED";
  statementDate: string;
  periodStart: string | null; // Module 69 – first day the statement covers; null = not recorded
  outOfPeriodLines: number; // Module 69 – lines already here that sit outside the period
  // Module 70 – computed live on the server (never stored).
  statementOverlaps: StatementOverlap[]; // other statements of this account sharing days with this one
  overlapNotComparable: number; // other statements that couldn't be compared (no recorded start)
  repeatedLineIds: string[]; // lines here whose date + description + amount is already on another statement
  statementEndingBalance: number;
  bookBalanceAtStart: number;
  currentBookBalance: number;
  difference: number;
  account: { id: string; name: string; type: string };
  lines: Line[];
  counts: { unmatched: number; matched: number; posted: number; ignored: number };
  readyToComplete: boolean;
  completedAt: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
  // Module 54: the statement line (if any) the most recent reopen was
  // about – cross-referenced against `lines` below for display; may point
  // at a line that's since been deleted (only possible while UNMATCHED).
  reopenLineId: string | null;
  reopenCount: number;
  maxReopens: number;
  reopensRemaining: number;
  history: HistoryRow[];
  historyNextCursor: string | null;
};

type HistoryRow = { id: string; action: string; at: string; by: string | null; reason: string | null; lineLabel: string | null };

// Module 62 – mirrors ImportBankStatementResult in src/lib/bank-reconciliation.ts
// Module 64 added periodFlag (after the statement date / long before it) and the period counts below.
// Module 69 added BEFORE_START (dated before the recorded start date – definite) beside the LONG_BEFORE guess.
type PeriodFlag = "AFTER_STATEMENT" | "LONG_BEFORE" | "BEFORE_START";
type ImportPreviewRow = { rowNumber: number; lineDate: string; description: string; amount: number; possibleDuplicate: boolean; periodFlag: PeriodFlag | null; repeatsOtherStatement: boolean };
type ImportResult = {
  dryRun: boolean;
  delimiter: string;
  columns: { date: string; description: string; amount: string | null; debit: string | null; credit: string | null; indicator: string | null };
  warnings: string[];
  totalRows: number;
  readableRows: number;
  duplicateRows: number;
  repeatedElsewhereRows: number; // Module 70
  repeatedElsewhereOnlyRows: number;
  skippedRepeatedElsewhere: number;
  statementOverlaps: StatementOverlap[];
  statementDate: string;
  periodStart: string | null;
  afterStatementRows: number;
  beforeStartRows: number;
  longBeforeRows: number;
  outOfPeriodOnlyRows: number;
  invalidRowCount: number;
  invalidRows: { rowNumber: number; message: string }[];
  willImport: number;
  imported: number;
  skippedDuplicates: number;
  skippedInvalid: number;
  skippedOutOfPeriod: number;
  preview: ImportPreviewRow[];
};

type Suggestion = { lineId: string; transactionId: string; description: string | null; amount: number; createdAt: string };

export function ReconciliationWorkspace({
  businessId,
  reconciliationId,
  canManage,
  canReopen,
  timeZone,
}: {
  timeZone: string;
  businessId: string;
  reconciliationId: string;
  canManage: boolean;
  canReopen: boolean;
}) {
  const router = useRouter();
  const [data, setData] = useState<Reconciliation | null>(null);
  const [unmatchedTxns, setUnmatchedTxns] = useState<{ id: string; description: string | null; amount: number; createdAt: string }[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [matchingLineId, setMatchingLineId] = useState<string | null>(null);
  const [reopenReasonInput, setReopenReasonInput] = useState("");
  // Module 62 – CSV import panel
  const [importOpen, setImportOpen] = useState(false);
  const [importCsv, setImportCsv] = useState<string | null>(null);
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [importFormat, setImportFormat] = useState<"CSV" | "OFX">("CSV");
  const [importDateOrder, setImportDateOrder] = useState<"DMY" | "MDY">("DMY");
  const [importSkipDuplicates, setImportSkipDuplicates] = useState(true);
  const [importSkipInvalid, setImportSkipInvalid] = useState(false);
  const [importSkipOutOfPeriod, setImportSkipOutOfPeriod] = useState(false); // Module 64
  const [importSkipOtherRepeats, setImportSkipOtherRepeats] = useState(false); // Module 70
  const [addLineNotice, setAddLineNotice] = useState<string | null>(null); // Module 64
  // Module 69 – editing the statement's first day
  const [editingStart, setEditingStart] = useState(false);
  const [startInput, setStartInput] = useState("");
  const [startNotice, setStartNotice] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<ImportResult | null>(null);
  const [importDone, setImportDone] = useState<ImportResult | null>(null);
  const [reopenLineIdInput, setReopenLineIdInput] = useState("");
  // Module 52: `data.history`/`data.historyNextCursor` are always just the
  // first page (embedded in the detail fetch); additional pages the user
  // has asked to see live here instead, so a fresh `load()` – after a
  // reopen or complete, say – cleanly resets back to page one.
  const [moreHistory, setMoreHistory] = useState<HistoryRow[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [loadingMoreHistory, setLoadingMoreHistory] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/business/${businessId}/bank-reconciliation/${reconciliationId}`);
    if (!res.ok) return;
    const d = await res.json();
    setData(d.reconciliation);
    setMoreHistory([]);
    setHistoryCursor(d.reconciliation.historyNextCursor);
  }, [businessId, reconciliationId]);

  const loadMoreHistory = useCallback(async () => {
    if (!historyCursor) return;
    setLoadingMoreHistory(true);
    const res = await fetch(
      `/api/business/${businessId}/bank-reconciliation/${reconciliationId}/reopen-history?cursor=${encodeURIComponent(historyCursor)}`
    );
    setLoadingMoreHistory(false);
    if (!res.ok) return;
    const d = await res.json();
    setMoreHistory((prev) => [...prev, ...d.rows]);
    setHistoryCursor(d.nextCursor);
  }, [businessId, reconciliationId, historyCursor]);

  const loadUnmatchedTxns = useCallback(async () => {
    if (!data) return;
    const res = await fetch(`/api/business/${businessId}/cashbook/accounts/${data.account.id}/transactions?unmatched=true&limit=200`);
    if (!res.ok) return;
    const d = await res.json();
    setUnmatchedTxns(d.transactions ?? []);
  }, [businessId, data]);

  useEffect(() => {
    load();
  }, [load]);

  async function runAction(lineId: string, action: string, body?: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/business/${businessId}/bank-reconciliation/${reconciliationId}/lines/${lineId}`, {
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
    setMatchingLineId(null);
    await load();
  }

  async function deleteLine(lineId: string) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/business/${businessId}/bank-reconciliation/${reconciliationId}/lines/${lineId}`, { method: "DELETE" });
    const d = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(d.message ?? "Could not delete line.");
      return;
    }
    await load();
  }

  async function addLine(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setAddLineNotice(null);
    const form = new FormData(e.currentTarget);
    const payload = {
      lineDate: new Date(form.get("lineDate") as string).toISOString(),
      description: form.get("description") as string,
      amount: Number(form.get("amount") || 0),
    };
    setBusy(true);
    const res = await fetch(`/api/business/${businessId}/bank-reconciliation/${reconciliationId}/lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(d.message ?? "Could not add line.");
      return;
    }
    (e.target as HTMLFormElement).reset();
    // Module 64: the line is kept either way; just say when its date looks wrong for this statement.
    setAddLineNotice(
      d.periodFlag === "AFTER_STATEMENT"
        ? "That line is dated after this statement's date, so it can't match a book transaction in scope for this reconciliation. Check the date."
        : d.periodFlag === "BEFORE_START"
        ? "That line is dated before this statement's start date, so it belongs to an earlier statement. Check the date."
        : d.periodFlag === "LONG_BEFORE"
        ? "That line is dated more than about three months before the statement date – it may belong to an earlier statement. Check the date (or record this statement's start date above for an exact check)."
        : d.repeatsOtherStatement
        ? "The same date, description and amount is already on another statement for this account – it may be a line you've already reconciled. The line was added; delete it if it's a repeat."
        : null
    );
    await load();
  }

  // Module 69 – save (or clear, with null) the statement's first day.
  async function savePeriodStart(value: string | null) {
    setError(null);
    setStartNotice(null);
    setBusy(true);
    const res = await fetch(`/api/business/${businessId}/bank-reconciliation/${reconciliationId}/period-start`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ periodStart: value ? new Date(value).toISOString() : null }),
    });
    const d = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(d.message ?? "Could not save the start date.");
      return;
    }
    setEditingStart(false);
    const n: number = d.result.outOfPeriodLines;
    setStartNotice(
      n > 0
        ? `${n} line${n === 1 ? " here is" : "s here are"} dated outside this statement's period – they're marked below. Nothing was changed or removed.`
        : null
    );
    await load();
  }

  // Module 70: the "Import N lines" count comes from the server's dry run, so re-run the
  // preview whenever a skip option changes while one is showing. Writes nothing.
  useEffect(() => {
    if (importPreview && importCsv && !busy) void runImport(true);
  }, [importSkipDuplicates, importSkipInvalid, importSkipOutOfPeriod, importSkipOtherRepeats]);

  async function runImport(dryRun: boolean, csvOverride?: string | null, dateOrderOverride?: "DMY" | "MDY", formatOverride?: "CSV" | "OFX") {
    const csv = csvOverride ?? importCsv;
    if (!csv) return;
    setError(null);
    setBusy(true);
    const res = await fetch(`/api/business/${businessId}/bank-reconciliation/${reconciliationId}/lines/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        csv,
        format: formatOverride ?? importFormat,
        dateOrder: dateOrderOverride ?? importDateOrder,
        dryRun,
        skipDuplicates: importSkipDuplicates,
        skipInvalid: importSkipInvalid,
        skipOutOfPeriod: importSkipOutOfPeriod,
        skipOtherStatementRepeats: importSkipOtherRepeats,
      }),
    });
    const d = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(d.message ?? (d.details ? "The file couldn't be read." : "Could not import."));
      if (dryRun) setImportPreview(null);
      return;
    }
    if (dryRun) {
      setImportPreview(d.result);
      setImportDone(null);
    } else {
      setImportDone(d.result);
      setImportPreview(null);
      setImportCsv(null);
      setImportFileName(null);
      setImportFormat("CSV");
      await load();
    }
  }

  async function onImportFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setImportPreview(null);
    setImportDone(null);
    if (!file) {
      setImportCsv(null);
      setImportFileName(null);
      setImportFormat("CSV");
      return;
    }
    const text = await file.text();
    const format = /\.(ofx|qfx)$/i.test(file.name) ? "OFX" : "CSV";
    setImportCsv(text);
    setImportFileName(file.name);
    setImportFormat(format);
    // Pass the selected format directly: React state may not have committed yet.
    await runImport(true, text, undefined, format);
  }

  async function fetchSuggestions() {
    setError(null);
    const res = await fetch(`/api/business/${businessId}/bank-reconciliation/${reconciliationId}/suggest-matches`);
    const d = await res.json();
    if (!res.ok) {
      setError(d.message ?? "Could not load suggestions.");
      return;
    }
    setSuggestions(d.suggestions);
  }

  async function complete() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/business/${businessId}/bank-reconciliation/${reconciliationId}/complete`, { method: "POST" });
    const d = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(d.message ?? "Could not complete reconciliation.");
      return;
    }
    await load();
  }

  async function reopen() {
    if (!reopenReasonInput.trim()) return;
    if (!confirm("Reopen this completed reconciliation? It will go back to In Progress until it's completed again.")) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/business/${businessId}/bank-reconciliation/${reconciliationId}/reopen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reopenReasonInput, lineId: reopenLineIdInput || null }),
    });
    const d = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(d.message ?? "Could not reopen reconciliation.");
      return;
    }
    setReopenReasonInput("");
    setReopenLineIdInput("");
    await load();
  }

  async function remove() {
    if (!confirm("Delete this reconciliation? This can't be undone.")) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/business/${businessId}/bank-reconciliation/${reconciliationId}`, { method: "DELETE" });
    const d = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(d.message ?? "Could not delete reconciliation.");
      return;
    }
    router.push("/bank-reconciliation");
  }

  if (!data) return <p className="text-sm text-erp-muted">Loading...</p>;

  const isOpen = data.status === "IN_PROGRESS";

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{data.account.name} Reconciliation</h1>
          <p className="text-sm text-erp-muted">
            {data.periodStart ? (
              <>
                Statement period: {formatDateIn(data.periodStart, timeZone)} to {formatDateIn(data.statementDate, timeZone)}
              </>
            ) : (
              <>Statement date: {formatDateIn(data.statementDate, timeZone)} (start date not recorded)</>
            )}
            {isOpen && canManage && !editingStart && (
              <button
                type="button"
                className="ml-2 text-xs text-erp-primary underline"
                onClick={() => {
                  setStartInput(data.periodStart ? data.periodStart.slice(0, 10) : "");
                  setEditingStart(true);
                }}
              >
                {data.periodStart ? "Change start date" : "Set start date"}
              </button>
            )}
          </p>
          {editingStart && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <label className="text-erp-muted">First day on the statement</label>
              <input type="date" value={startInput} max={data.statementDate.slice(0, 10)} onChange={(e) => setStartInput(e.target.value)} className="erp-input" />
              <button
                type="button"
                disabled={busy || !startInput}
                onClick={() => savePeriodStart(startInput)}
                className="rounded bg-erp-primary px-3 py-1.5 text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
              >
                Save
              </button>
              {data.periodStart && (
                <button type="button" disabled={busy} onClick={() => savePeriodStart(null)} className="rounded border px-3 py-1.5 text-erp-text disabled:opacity-60">
                  Clear
                </button>
              )}
              <button type="button" onClick={() => setEditingStart(false)} className="text-erp-muted underline">
                Cancel
              </button>
            </div>
          )}
        </div>
        <span className={`rounded-full px-3 py-1 text-xs ${isOpen ? "bg-erp-warning/15 text-erp-warning" : "bg-erp-success/15 text-erp-success"}`}>
          {isOpen ? "In progress" : "Completed"}
        </span>
      </div>

      {error && <p className="mb-4 rounded bg-erp-danger/10 p-2 text-sm text-erp-danger">{error}</p>}

      {startNotice && <div className="mb-4 rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-xs text-erp-warning">{startNotice}</div>}
      {data.statementOverlaps.length > 0 && (
        <div className="mb-4 rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-xs text-erp-warning">
          <p className="font-medium">This statement overlaps another one for {data.account.name}</p>
          <ul className="list-disc pl-4">
            {data.statementOverlaps.map((o) => (
              <li key={o.id}>
                <a className="underline" href={`/bank-reconciliation/${o.id}`}>
                  {describeOverlap(o)}
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-1">
            Lines in the shared days may already be settled there, and a book transaction can only settle one statement line. Some banks
            do repeat the closing day, so this is a warning only.
          </p>
        </div>
      )}
      {isOpen && data.repeatedLineIds.length > 0 && (
        <div className="mb-4 rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-xs text-erp-warning">
          {data.repeatedLineIds.length} line{data.repeatedLineIds.length === 1 ? " here matches" : "s here match"} a line already on another
          statement for this account (same date, description and amount) – marked "on another statement" in the list. If it was already
          reconciled there, it can't be matched again here; delete the repeat.
        </div>
      )}
      {isOpen && data.outOfPeriodLines > 0 && !startNotice && (
        <div className="mb-4 rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-xs text-erp-warning">
          {data.outOfPeriodLines} line{data.outOfPeriodLines === 1 ? " is" : "s are"} dated outside this statement's period
          {data.periodStart ? "" : " (judged against the statement date only, since no start date is recorded)"} – they're marked in the list.
        </div>
      )}

      {data.reopenedAt && (
        <div className="mb-4 rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-xs text-erp-warning">
          Reopened on {formatDateIn(data.reopenedAt, timeZone)}
          {data.reopenReason ? ` – ${data.reopenReason}` : ""}
          {data.reopenLineId && (
            <>
              {" "}(re:{" "}
              {data.lines.find((l) => l.id === data.reopenLineId)?.description ?? "a line no longer on this reconciliation"})
            </>
          )}
          {isOpen ? ". Complete it again once corrections are done." : " (since completed again)."}
          {" "}({data.reopenCount} of {data.maxReopens} reopens used)
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded border bg-erp-surface p-4">
          <p className="text-xs text-erp-muted">Statement Balance</p>
          <p className="text-lg font-semibold">MWK {fmt(data.statementEndingBalance)}</p>
        </div>
        <div className="rounded border bg-erp-surface p-4">
          <p className="text-xs text-erp-muted">Current Book Balance</p>
          <p className="text-lg font-semibold">MWK {fmt(data.currentBookBalance)}</p>
        </div>
        <div className="rounded border bg-erp-surface p-4">
          <p className="text-xs text-erp-muted">Difference</p>
          <p className={`text-lg font-semibold ${Math.abs(data.difference) > 0.01 ? "text-erp-warning" : "text-erp-success"}`}>
            MWK {fmt(data.difference)}
          </p>
        </div>
        <div className="rounded border bg-erp-surface p-4">
          <p className="text-xs text-erp-muted">Unmatched Lines</p>
          <p className="text-lg font-semibold">{data.counts.unmatched}</p>
        </div>
      </div>

      {isOpen && Math.abs(data.difference) > 0.01 && data.counts.unmatched === 0 && (
        <div className="mb-6 rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-xs text-erp-warning">
          Every line has been handled, but the book and statement balances still don't match exactly – this is
          often a normal timing gap (a transaction recorded today that the bank hasn't processed yet). You can
          still complete this reconciliation; the difference is shown for your records either way.
        </div>
      )}

      {isOpen && canManage && (
        <form onSubmit={addLine} className="mb-6 grid grid-cols-1 gap-3 rounded border bg-erp-surface p-4 sm:grid-cols-4">
          <div>
            <label className="mb-1 block text-xs text-erp-muted">Date</label>
            <input name="lineDate" type="date" required defaultValue={todayYmd(timeZone)} className="erp-input" />
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs text-erp-muted">Description (as printed on statement)</label>
            <input name="description" type="text" required placeholder="e.g. Monthly account fee" className="erp-input" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-erp-muted">Amount (+in / -out)</label>
            <input name="amount" type="number" step="0.01" required placeholder="-1500.00" className="erp-input" />
          </div>
          <div className="sm:col-span-4">
            <button type="submit" disabled={busy} className="rounded bg-erp-primary px-4 py-2 text-sm text-erp-primary-fg hover:opacity-90 disabled:opacity-60">
              + Add Statement Line
            </button>
          </div>
        </form>
      )}

      {isOpen && canManage && addLineNotice && (
        <div className="mb-4 rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-xs text-erp-warning">{addLineNotice}</div>
      )}

      {isOpen && canManage && (
        <div className="mb-6 rounded border bg-erp-surface p-4">
          <button type="button" onClick={() => setImportOpen((v) => !v)} className="text-sm font-medium text-erp-primary hover:underline">
            {importOpen ? "▾" : "▸"} Import statement lines from CSV or OFX/QFX
          </button>

          {importOpen && (
            <div className="mt-3 space-y-3 text-sm">
              <p className="text-xs text-erp-muted">
                Download a CSV or OFX/QFX statement from your bank or mobile-money portal. CSV files need a header row with a
                Date column, a Description (or Narration / Details) column, and either one signed Amount column, separate
                Debit and Credit columns, or an Amount column with a Dr/Cr column beside it. On a statement, Debit (DR)
                means money out and Credit (CR) means money in. Imported lines start unmatched, exactly like lines typed
                in by hand.
              </p>

              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="mb-1 block text-xs text-erp-muted">CSV or OFX/QFX file</label>
                  <input type="file" accept=".csv,.ofx,.qfx,text/csv,text/plain,application/x-ofx,application/ofx,application/xml,text/xml" onChange={onImportFileChosen} className="text-sm" />
                </div>
                {importFormat === "CSV" && <div>
                  <label className="mb-1 block text-xs text-erp-muted">Dates like 01/09/2026 are</label>
                  <select
                    value={importDateOrder}
                    onChange={async (e) => {
                      const v = e.target.value as "DMY" | "MDY";
                      setImportDateOrder(v);
                      if (importCsv) await runImport(true, importCsv, v);
                    }}
                    className="erp-input"
                  >
                    <option value="DMY">Day / Month / Year</option>
                    <option value="MDY">Month / Day / Year</option>
                  </select>
                </div>}
              </div>

              {importPreview && (
                <div className="space-y-3">
                  <div className="rounded bg-erp-subtle p-3 text-xs text-erp-text">
                    <p>
                      <span className="font-medium">{importFileName}</span> – {importPreview.totalRows} data row
                      {importPreview.totalRows === 1 ? "" : "s"}: {importPreview.readableRows} readable
                      {importPreview.duplicateRows > 0 && <>, {importPreview.duplicateRows} already in this reconciliation</>}
                      {importPreview.invalidRowCount > 0 && <>, {importPreview.invalidRowCount} unreadable</>}.
                    </p>
                    <p className="mt-1 text-erp-muted">
                      Columns used – date: {importPreview.columns.date}; description: {importPreview.columns.description};{" "}
                      {importPreview.columns.amount
                        ? `amount: ${importPreview.columns.amount}${importPreview.columns.indicator ? `, money in/out from: ${importPreview.columns.indicator}` : ""}`
                        : `debit: ${importPreview.columns.debit}, credit: ${importPreview.columns.credit}`}
                    </p>
                  </div>

                  {importPreview.warnings.length > 0 && (
                    <div className="rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-xs text-erp-warning">
                      <ul className="list-disc pl-4">
                        {importPreview.warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {importPreview.invalidRowCount > 0 && (
                    <div className="rounded border border-erp-danger/40 bg-erp-danger/10 p-3 text-xs text-erp-danger">
                      <p className="mb-1 font-medium">Rows that couldn't be read</p>
                      <ul className="list-disc pl-4">
                        {importPreview.invalidRows.map((r) => (
                          <li key={r.rowNumber}>
                            Row {r.rowNumber}: {r.message}
                          </li>
                        ))}
                      </ul>
                      {importPreview.invalidRowCount > importPreview.invalidRows.length && (
                        <p className="mt-1">…and {importPreview.invalidRowCount - importPreview.invalidRows.length} more.</p>
                      )}
                      <label className="mt-2 flex items-center gap-2">
                        <input type="checkbox" checked={importSkipInvalid} onChange={(e) => setImportSkipInvalid(e.target.checked)} />
                        Skip these rows and import the rest
                      </label>
                    </div>
                  )}

                  {importPreview.duplicateRows > 0 && (
                    <label className="flex items-center gap-2 text-xs text-erp-text">
                      <input
                        type="checkbox"
                        checked={importSkipDuplicates}
                        onChange={async (e) => {
                          setImportSkipDuplicates(e.target.checked);
                        }}
                      />
                      Skip rows already in this reconciliation (same date, description and amount)
                    </label>
                  )}

                  {importPreview.statementOverlaps.length > 0 && (
                    <div className="rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-xs text-erp-warning">
                      This statement's period overlaps {importPreview.statementOverlaps.length} other statement
                      {importPreview.statementOverlaps.length === 1 ? "" : "s"} for this account:{" "}
                      {importPreview.statementOverlaps.map((o) => describeOverlap(o)).join("; ")}.
                    </div>
                  )}

                  {importPreview.repeatedElsewhereRows > 0 && (
                    <div className="rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-xs text-erp-warning">
                      <p>
                        {importPreview.repeatedElsewhereRows} row{importPreview.repeatedElsewhereRows === 1 ? " is" : "s are"} already on another
                        statement for this account (same date, description and amount). If that statement is reconciled, these lines can't be
                        matched again here.
                      </p>
                      <p className="mt-1">They're imported unless you tick the box below – your call, a genuinely repeated transaction is possible.</p>
                      <label className="mt-2 flex items-center gap-2">
                        <input type="checkbox" checked={importSkipOtherRepeats} onChange={(e) => setImportSkipOtherRepeats(e.target.checked)} />
                        Leave these rows out
                      </label>
                    </div>
                  )}

                  {(importPreview.afterStatementRows > 0 || importPreview.beforeStartRows > 0 || importPreview.longBeforeRows > 0) && (
                    <div className="rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-xs text-erp-warning">
                      <p className="mb-1 font-medium">Dates outside this statement's period</p>
                      <ul className="list-disc pl-4">
                        {importPreview.afterStatementRows > 0 && (
                          <li>
                            {importPreview.afterStatementRows} row{importPreview.afterStatementRows === 1 ? " is" : "s are"} dated after the
                            statement date ({importPreview.statementDate}). The books side of this reconciliation stops at that date, so
                            these can't match a book transaction here.
                          </li>
                        )}
                        {importPreview.beforeStartRows > 0 && (
                          <li>
                            {importPreview.beforeStartRows} row{importPreview.beforeStartRows === 1 ? " is" : "s are"} dated before this
                            statement's start date ({importPreview.periodStart}) – they belong to an earlier statement, or the day/month
                            setting above is the wrong way round.
                          </li>
                        )}
                        {importPreview.longBeforeRows > 0 && (
                          <li>
                            {importPreview.longBeforeRows} row{importPreview.longBeforeRows === 1 ? " is" : "s are"} dated more than about
                            three months before the statement date – possibly an earlier statement's lines, or a wrong date order
                            (check the day/month setting above).
                          </li>
                        )}
                      </ul>
                      <p className="mt-1">They're imported unless you tick the box below – your call, the file may be right.</p>
                      <label className="mt-2 flex items-center gap-2">
                          <input type="checkbox" checked={importSkipOutOfPeriod} onChange={(e) => setImportSkipOutOfPeriod(e.target.checked)} />
                          Leave these rows out
                        </label>
                    </div>
                  )}

                  {importPreview.preview.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="text-left text-erp-muted">
                          <tr>
                            <th className="p-1">Row</th>
                            <th className="p-1">Date</th>
                            <th className="p-1">Description</th>
                            <th className="p-1 text-right">Amount</th>
                            <th className="p-1"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {importPreview.preview.map((r) => (
                            <tr key={r.rowNumber} className="border-t">
                              <td className="p-1 text-erp-muted">{r.rowNumber}</td>
                              <td className="p-1">{r.lineDate}</td>
                              <td className="p-1">{r.description}</td>
                              <td className={`p-1 text-right ${r.amount < 0 ? "text-erp-danger" : "text-erp-success"}`}>{fmt(r.amount)}</td>
                              <td className="p-1 text-erp-warning">
                                {[
                                  r.possibleDuplicate ? "already here" : null,
                                  r.repeatsOtherStatement ? "on another statement" : null,
                                  r.periodFlag === "AFTER_STATEMENT"
                                    ? "after statement date"
                                    : r.periodFlag === "BEFORE_START"
                                    ? "before start date"
                                    : r.periodFlag === "LONG_BEFORE"
                                    ? "long before"
                                    : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {importPreview.readableRows > importPreview.preview.length && (
                        <p className="mt-1 text-xs text-erp-muted">Showing the first {importPreview.preview.length} of {importPreview.readableRows} readable rows.</p>
                      )}
                    </div>
                  )}

                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => runImport(false)}
                    className="rounded bg-erp-primary px-4 py-2 text-sm text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
                  >
                    Import{" "}
{(() => {
                      // Module 70: three skip options now interact (duplicate / on another statement / out of
                      // period), so the count comes from the server's own dry run, which re-runs whenever a
                      // skip option changes (see the effect above) instead of being re-derived here.
                      const n = importPreview.willImport;
                      return `${n} line${n === 1 ? "" : "s"}`;
                    })()}
                  </button>
                </div>
              )}

              {importDone && (
                <div className="rounded border border-erp-success/40 bg-erp-success/10 p-3 text-xs text-erp-success">
                  Imported {importDone.imported} line{importDone.imported === 1 ? "" : "s"}
                  {importDone.skippedDuplicates > 0 && <>, skipped {importDone.skippedDuplicates} already here</>}
                  {importDone.skippedRepeatedElsewhere > 0 && <>, left out {importDone.skippedRepeatedElsewhere} already on another statement</>}
                  {importDone.skippedOutOfPeriod > 0 && <>, left out {importDone.skippedOutOfPeriod} outside the statement period</>}
                  {importDone.skippedInvalid > 0 && <>, skipped {importDone.skippedInvalid} unreadable</>}. They're in the list below, unmatched.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {isOpen && canManage && (
        <div className="mb-4">
          <button onClick={fetchSuggestions} className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">
            Suggest Matches
          </button>
          {suggestions && (
            <div className="mt-2 rounded border bg-erp-surface p-3 text-sm">
              {suggestions.length === 0 ? (
                <p className="text-erp-muted">No amount/date matches found for the remaining unmatched lines.</p>
              ) : (
                <div className="space-y-2">
                  {suggestions.map((s, i) => (
                    <div key={i} className="flex items-center justify-between border-t pt-2 first:border-t-0 first:pt-0">
                      <span>
                        MWK {fmt(s.amount)} – {s.description ?? "Book transaction"} ({formatDateIn(s.createdAt, timeZone)})
                      </span>
                      <button
                        onClick={() => runAction(s.lineId, "match", { transactionId: s.transactionId })}
                        disabled={busy}
                        className="rounded bg-erp-primary px-2 py-1 text-xs text-erp-primary-fg hover:opacity-90"
                      >
                        Confirm Match
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="overflow-x-auto"><table className="mb-6 w-full border-collapse overflow-hidden rounded border bg-erp-surface text-sm">
        <thead className="bg-erp-subtle text-left">
          <tr>
            <th className="p-3">Date</th>
            <th className="p-3">Description</th>
            <th className="p-3 text-right">Amount</th>
            <th className="p-3">Status</th>
            {isOpen && canManage && <th className="p-3">Action</th>}
          </tr>
        </thead>
        <tbody>
          {data.lines.length === 0 && (
            <tr>
              <td colSpan={5} className="p-4 text-center text-erp-muted">
                No statement lines added yet.
              </td>
            </tr>
          )}
          {data.lines.map((l) => (
            <tr key={l.id} className="border-t align-top">
              <td className="p-3 text-erp-muted">
                {formatDateIn(l.lineDate, timeZone)}
                {(() => {
                  // Module 69: same pure classifier the server uses, so the tag always agrees with the counts.
                  const flag = classifyLineDate(
                    l.lineDate.slice(0, 10),
                    data.statementDate.slice(0, 10),
                    OUT_OF_PERIOD_LOOKBACK_DAYS,
                    data.periodStart ? data.periodStart.slice(0, 10) : null
                  );
                  return flag ? (
                    <span className="ml-1 rounded bg-erp-warning/15 px-1 py-0.5 text-[10px] text-erp-warning">
                      {flag === "AFTER_STATEMENT" ? "after statement" : flag === "BEFORE_START" ? "before start" : "long before"}
                    </span>
                  ) : null;
                })()}
              </td>
              <td className="p-3">
                {l.description}
                {data.repeatedLineIds.includes(l.id) && (
                  <span className="ml-1 rounded bg-erp-warning/15 px-1 py-0.5 text-[10px] text-erp-warning">on another statement</span>
                )}
                {l.status === "MATCHED" && l.matchedTransaction && (
                  <p className="text-xs text-erp-muted">Matched to: {l.matchedTransaction.description ?? "book transaction"}</p>
                )}
                {data.reopenLineId === l.id && (
                  <p className="text-xs text-erp-warning">↩ Reason for the most recent reopen</p>
                )}
              </td>
              <td className={`p-3 text-right ${l.amount < 0 ? "text-erp-danger" : "text-erp-success"}`}>{fmt(l.amount)}</td>
              <td className="p-3">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    l.status === "UNMATCHED"
                      ? "bg-erp-subtle text-erp-muted"
                      : l.status === "MATCHED"
                      ? "bg-erp-info/15 text-erp-text"
                      : l.status === "POSTED"
                      ? "bg-erp-success/15 text-erp-success"
                      : "bg-erp-subtle text-erp-muted"
                  }`}
                >
                  {l.status}
                </span>
              </td>
              {isOpen && canManage && (
                <td className="p-3">
                  {l.status === "UNMATCHED" && (
                    <div className="space-y-1">
                      {matchingLineId === l.id ? (
                        <div className="flex flex-col gap-1">
                          <select
                            className="erp-input text-xs"
                            onChange={(e) => e.target.value && runAction(l.id, "match", { transactionId: e.target.value })}
                            defaultValue=""
                          >
                            <option value="">Pick a book transaction...</option>
                            {unmatchedTxns.map((t) => (
                              <option key={t.id} value={t.id}>
                                MWK {fmt(t.amount)} – {t.description ?? "–"} ({formatDateIn(t.createdAt, timeZone)})
                              </option>
                            ))}
                          </select>
                          <button onClick={() => setMatchingLineId(null)} className="text-left text-xs text-erp-muted underline">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setMatchingLineId(l.id);
                            loadUnmatchedTxns();
                          }}
                          className="mr-2 text-xs text-erp-primary underline"
                        >
                          Match
                        </button>
                      )}
                      <button onClick={() => runAction(l.id, "post")} disabled={busy} className="mr-2 text-xs text-erp-primary underline">
                        Post as new
                      </button>
                      <button onClick={() => runAction(l.id, "ignore")} disabled={busy} className="mr-2 text-xs text-erp-muted underline">
                        Ignore
                      </button>
                      <button onClick={() => deleteLine(l.id)} disabled={busy} className="text-xs text-erp-danger underline">
                        Delete
                      </button>
                    </div>
                  )}
                  {l.status === "MATCHED" && (
                    <button onClick={() => runAction(l.id, "unmatch")} disabled={busy} className="text-xs text-erp-muted underline">
                      Unmatch
                    </button>
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
            title={!data.readyToComplete ? "Every line must be matched, posted, or ignored first" : undefined}
          >
            Complete Reconciliation
          </button>
          <button onClick={remove} disabled={busy} className="rounded border border-erp-danger/40 px-4 py-2 text-erp-danger hover:bg-erp-danger/10">
            Delete Reconciliation
          </button>
        </div>
      )}

      {!isOpen && canReopen && (
        <div className="rounded border bg-erp-surface p-4">
          {data.reopensRemaining > 0 ? (
            <>
              <p className="mb-2 text-sm font-medium">Reopen this reconciliation</p>
              <p className="mb-3 text-xs text-erp-muted">
                Puts it back to In Progress so a match, a posted adjustment, or a line can be corrected. A reason is
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
                  <option value="">Which line? (optional)</option>
                  {data.lines.map((l) => (
                    <option key={l.id} value={l.id}>
                      {formatDateIn(l.lineDate, timeZone)} – {l.description}
                    </option>
                  ))}
                </select>
                <button
                  onClick={reopen}
                  disabled={busy || !reopenReasonInput.trim()}
                  className="rounded border border-erp-warning/50 px-4 py-2 text-sm text-erp-warning hover:bg-erp-warning/10 disabled:opacity-40"
                >
                  Reopen Reconciliation
                </button>
              </div>
            </>
          ) : (
            <p className="text-xs text-erp-muted">
              This reconciliation has already been reopened {data.maxReopens} times, the maximum allowed. Record any
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
                <span className="font-medium text-erp-text">{h.action === "bankrecon.reopen" ? "Reopened" : "Completed"}</span>
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
