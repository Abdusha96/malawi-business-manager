"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { todayYmd } from "@/lib/date-range";

export function OpenReconciliationForm({ businessId, timeZone }: { businessId: string; timeZone: string }) {
  const router = useRouter();
  const [accounts, setAccounts] = useState<{ id: string; name: string; balance: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Module 69 – optional first day of the statement, pre-filled with the day after
  // this account's previous completed statement. The person can change or clear it;
  // once they have typed in the box a later suggestion never overwrites it.
  const [accountId, setAccountId] = useState("");
  const [statementDate, setStatementDate] = useState(todayYmd(timeZone));
  const [periodStart, setPeriodStart] = useState("");
  const [startTouched, setStartTouched] = useState(false);
  const [suggestedFrom, setSuggestedFrom] = useState<string | null>(null); // previous statement's date, for the hint

  useEffect(() => {
    if (!accountId || !statementDate || startTouched) return;
    let cancelled = false;
    fetch(`/api/business/${businessId}/bank-reconciliation/period-start-suggestion?accountId=${encodeURIComponent(accountId)}&statementDate=${statementDate}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setPeriodStart(d.suggestedPeriodStart ?? "");
        setSuggestedFrom(d.suggestedPeriodStart ? d.previousStatementDate : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [businessId, accountId, statementDate, startTouched]);

  useEffect(() => {
    fetch(`/api/business/${businessId}/cashbook/accounts`)
      .then((r) => (r.ok ? r.json() : { accounts: [] }))
      .then((d) => setAccounts(d.accounts ?? []))
      .catch(() => setAccounts([]));
  }, [businessId]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(e.currentTarget);
    const payload = {
      accountId: form.get("accountId") as string,
      statementDate: new Date(form.get("statementDate") as string).toISOString(),
      periodStart: periodStart ? new Date(periodStart).toISOString() : null,
      statementEndingBalance: Number(form.get("statementEndingBalance") || 0),
    };

    const res = await fetch(`/api/business/${businessId}/bank-reconciliation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Could not start reconciliation.");
      return;
    }
    router.push(`/bank-reconciliation/${data.reconciliation.id}`);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded border bg-erp-surface p-5 text-sm">
      {error && <p className="rounded bg-erp-danger/10 p-2 text-erp-danger">{error}</p>}

      <div>
        <label className="mb-1 block text-xs text-erp-muted">Account</label>
        <select name="accountId" required className="erp-input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">Select an account...</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} – current book balance MWK {a.balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1 block text-xs text-erp-muted">Statement date</label>
        <input name="statementDate" type="date" required value={statementDate} onChange={(e) => setStatementDate(e.target.value)} className="erp-input" />
      </div>

      <div>
        <label className="mb-1 block text-xs text-erp-muted">First day on the statement (optional)</label>
        <input
          name="periodStart"
          type="date"
          value={periodStart}
          max={statementDate}
          onChange={(e) => {
            setPeriodStart(e.target.value);
            setStartTouched(true);
          }}
          className="erp-input"
        />
        <p className="mt-1 text-xs text-erp-muted">
          {suggestedFrom && !startTouched
            ? `Suggested: the day after your last completed statement for this account (${suggestedFrom}). Change it if this statement starts elsewhere.`
            : "With a start date, statement lines dated before it are flagged exactly; without one, only lines more than about three months before the statement date are."}
        </p>
      </div>

      <div>
        <label className="mb-1 block text-xs text-erp-muted">Statement ending balance (MWK)</label>
        <input name="statementEndingBalance" type="number" step="0.01" required className="erp-input" />
      </div>

      <button type="submit" disabled={loading} className="rounded bg-erp-primary px-4 py-2 text-erp-primary-fg hover:opacity-90 disabled:opacity-60">
        {loading ? "Starting..." : "Start Reconciliation"}
      </button>
    </form>
  );
}
