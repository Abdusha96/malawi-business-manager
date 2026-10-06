"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatDateIn, formatDateTimeIn } from "@/lib/timezone";
import { isRealYmd } from "@/lib/period-lock";

interface Preset { key: string; label: string; date: string }
interface HistoryRow { id: string; action: "period.closed" | "period.reopened"; from: string | null; to: string | null; reason: string | null; by: string | null; at: string }
interface Overview { closedThrough: string | null; today: string; latestClosable: string; presets: Preset[]; history: HistoryRow[] }
interface Readiness { draftPayrollPeriods: { period: string; runs: number }[]; openBankReconciliations: number }

// A bare calendar day "YYYY-MM-DD" shown as a date. Parsed at noon UTC so no zone can shift it.
function showDay(ymd: string, tz: string) {
  return formatDateIn(new Date(`${ymd}T12:00:00Z`), "UTC", { day: "numeric", month: "long", year: "numeric" });
}

export function PeriodCloseClient({
  businessId, timeZone, canManage, canReopen, initial,
}: { businessId: string; timeZone: string; canManage: boolean; canReopen: boolean; initial: Overview }) {
  const router = useRouter();
  const [date, setDate] = useState(initial.presets[0]?.date ?? "");
  const [reason, setReason] = useState("");
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const current = initial.closedThrough;
  const valid = isRealYmd(date) && date <= initial.latestClosable;
  const isReopen = valid && current !== null && date < current;

  async function pick(value: string) {
    setDate(value);
    setReadiness(null);
    setError(null);
    if (!isRealYmd(value) || value > initial.latestClosable || (current && value <= current)) return;
    const res = await fetch(`/api/business/${businessId}/period-close?through=${value}`);
    if (res.ok) setReadiness((await res.json()).readiness);
  }

  async function submit(closedThrough: string | null) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/business/${businessId}/period-close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ closedThrough, reason: reason || null }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.message ?? "Could not change the closed period.");
      return;
    }
    setReason("");
    setNotice(closedThrough ? `Books are now closed through ${showDay(closedThrough, timeZone)}.` : "The books are open again.");
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className={`rounded border p-4 ${current ? "border-erp-success/40 bg-erp-success/10" : "border-erp-border bg-erp-surface"}`}>
        <p className="text-sm text-erp-muted">Status</p>
        <p className="text-lg font-semibold">
          {current ? `Closed through ${showDay(current, timeZone)}` : "Open. No period is closed."}
        </p>
        <p className="mt-2 text-sm text-erp-muted">
          Records dated on or before the closed day can't be created, edited or voided. Journal entries, depreciation,
          tax payments and foreign exchange adjustments can't be dated into it. A sale, purchase or expense in the period
          can't be changed or voided, because the VAT return and reports read them directly. Today's books stay open.
        </p>
      </div>

      {notice && <p className="rounded bg-erp-success/10 p-3 text-sm text-erp-success">{notice}</p>}
      {error && <p className="rounded bg-erp-danger/10 p-3 text-sm text-erp-danger">{error}</p>}

      {canManage ? (
        <div className="space-y-4 rounded border bg-erp-surface p-4">
          <h2 className="font-semibold">Close or reopen</h2>
          <div className="flex flex-wrap gap-2">
            {initial.presets.map((p) => (
              <button key={p.key} type="button" onClick={() => pick(p.date)} className="rounded border border-erp-border px-3 py-1 text-sm hover:bg-erp-subtle">
                {p.label} ({p.date})
              </button>
            ))}
          </div>
          <label className="block text-sm">
            Close the books through (last day)
            <input type="date" className="erp-input mt-1" value={date} max={initial.latestClosable} onChange={(e) => pick(e.target.value)} />
          </label>

          {readiness && (readiness.draftPayrollPeriods.length > 0 || readiness.openBankReconciliations > 0) && (
            <div className="rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-sm text-erp-text">
              <p className="font-medium">Unfinished work inside this period</p>
              <ul className="ml-5 list-disc">
                {readiness.draftPayrollPeriods.map((d) => (
                  <li key={d.period}>Payroll for {d.period} is still in draft ({d.runs} {d.runs === 1 ? "run" : "runs"}).</li>
                ))}
                {readiness.openBankReconciliations > 0 && (
                  <li>{readiness.openBankReconciliations} bank reconciliation(s) dated in this period are still in progress.</li>
                )}
              </ul>
              <p className="mt-1">Closing does not block these. Check them first.</p>
            </div>
          )}

          <label className="block text-sm">
            {isReopen ? "Reason for reopening (required)" : "Note (optional)"}
            <input className="erp-input mt-1" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder={isReopen ? "Why the period must be reopened" : "For example: March VAT return filed"} />
          </label>

          {isReopen && !canReopen && <p className="text-sm text-erp-danger">Only the Owner can move the closed date back.</p>}

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={busy || !valid || (current !== null && date === current) || (isReopen && (!canReopen || !reason.trim()))}
              onClick={() => submit(date)}
              className="rounded bg-erp-primary px-4 py-2 text-erp-primary-fg hover:opacity-90 disabled:opacity-50"
            >
              {isReopen ? "Reopen back to this date" : "Close through this date"}
            </button>
            {current && canReopen && (
              <button
                type="button"
                disabled={busy || !reason.trim()}
                onClick={() => submit(null)}
                className="rounded border border-erp-danger/40 px-4 py-2 text-erp-danger hover:bg-erp-danger/10 disabled:opacity-50"
              >
                Reopen all (needs a reason)
              </button>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-erp-muted">You can view the closed period. Closing needs an Owner or Accountant who is not restricted to one branch.</p>
      )}

      <div>
        <h2 className="mb-2 font-semibold">History</h2>
        {initial.history.length === 0 ? (
          <p className="text-sm text-erp-muted">No changes yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse overflow-hidden rounded border bg-erp-surface text-sm">
              <thead className="bg-erp-subtle text-left">
                <tr><th className="p-3">When</th><th className="p-3">Action</th><th className="p-3">Closed through</th><th className="p-3">By</th><th className="p-3">Reason</th></tr>
              </thead>
              <tbody>
                {initial.history.map((h) => (
                  <tr key={h.id} className="border-t">
                    <td className="p-3">{formatDateTimeIn(h.at, timeZone)}</td>
                    <td className="p-3">{h.action === "period.closed" ? "Closed" : "Reopened"}</td>
                    <td className="p-3">{h.from ?? "none"} to {h.to ?? "none"}</td>
                    <td className="p-3">{h.by ?? "-"}</td>
                    <td className="p-3">{h.reason ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
