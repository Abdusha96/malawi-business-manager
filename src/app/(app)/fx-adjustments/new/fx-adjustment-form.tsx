"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { todayYmd } from "@/lib/date-range";
import { computeFxGainLossFromRates, signedFromDirection } from "@/lib/fx-calc";

interface CashAccountOption { id: string; name: string; type: string; balance: number }

function fmt(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function FxAdjustmentForm({
  businessId,
  currency,
  cashAccounts,
  timeZone,
}: {
  businessId: string;
  currency: string;
  cashAccounts: CashAccountOption[];
  timeZone: string;
}) {
  const router = useRouter();
  const [cashAccountId, setCashAccountId] = useState(cashAccounts[0]?.id ?? "");
  const [kind, setKind] = useState<"UNREALISED" | "REALISED">("UNREALISED");
  const [currencyCode, setCurrencyCode] = useState("USD");
  const [method, setMethod] = useState<"RATES" | "AMOUNT">("RATES");
  const [foreignAmount, setForeignAmount] = useState("");
  const [bookRate, setBookRate] = useState("");
  const [newRate, setNewRate] = useState("");
  const [direction, setDirection] = useState<"GAIN" | "LOSS">("GAIN");
  const [amount, setAmount] = useState("");
  const [adjustmentDate, setAdjustmentDate] = useState(todayYmd(timeZone));
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // The same arithmetic the server runs (src/lib/fx-calc.ts) – shown live so the
  // figure isn't a surprise. The server recomputes it and is the authority.
  let signed: number | null = null;
  try {
    if (method === "RATES") {
      if (Number(foreignAmount) > 0 && Number(bookRate) > 0 && Number(newRate) > 0) {
        signed = computeFxGainLossFromRates({ foreignAmount: Number(foreignAmount), bookRate: Number(bookRate), newRate: Number(newRate) });
      }
    } else if (Number(amount) > 0) {
      signed = signedFromDirection(direction, Number(amount));
    }
  } catch {
    signed = null;
  }

  const account = cashAccounts.find((a) => a.id === cashAccountId);
  const tooBigLoss = signed !== null && signed < 0 && account && Math.abs(signed) > account.balance;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const res = await fetch(`/api/business/${businessId}/fx-adjustments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cashAccountId,
        kind,
        currencyCode,
        method,
        adjustmentDate: adjustmentDate ? new Date(adjustmentDate).toISOString() : null,
        foreignAmount: method === "RATES" ? Number(foreignAmount) : null,
        bookRate: method === "RATES" ? Number(bookRate) : null,
        newRate: method === "RATES" ? Number(newRate) : null,
        direction: method === "AMOUNT" ? direction : null,
        amount: method === "AMOUNT" ? Number(amount) : null,
        reference: reference || null,
        notes: notes || null,
      }),
    });
    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? data.details?.formErrors?.[0] ?? "Could not record this adjustment.");
      return;
    }
    router.push(`/fx-adjustments/${data.adjustment.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 text-sm">
      {error && <p className="rounded bg-erp-danger/10 p-2 text-erp-danger">{error}</p>}

      <div>
        <label className="mb-1 block text-xs font-medium text-erp-muted">Account that holds the foreign currency</label>
        {cashAccounts.length === 0 ? (
          <p className="text-xs text-erp-danger">No active cash accounts found – set one up in Cashbook first.</p>
        ) : (
          <select value={cashAccountId} onChange={(e) => setCashAccountId(e.target.value)} className="erp-input">
            {cashAccounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name} ({a.type.replace("_", " ")}) – {currency} {fmt(a.balance)}</option>
            ))}
          </select>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-erp-muted">Foreign currency</label>
          <input value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value.toUpperCase())} className="erp-input" maxLength={3} placeholder="USD" required />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-erp-muted">Type</label>
          <select value={kind} onChange={(e) => setKind(e.target.value as "UNREALISED" | "REALISED")} className="erp-input">
            <option value="UNREALISED">Unrealised – period-end revaluation</option>
            <option value="REALISED">Realised – actually converted / received</option>
          </select>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-erp-muted">How do you want to state the difference?</label>
        <select value={method} onChange={(e) => setMethod(e.target.value as "RATES" | "AMOUNT")} className="erp-input">
          <option value="RATES">Work it out from the exchange rates</option>
          <option value="AMOUNT">I already know the {currency} gain or loss</option>
        </select>
      </div>

      {method === "RATES" ? (
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-erp-muted">Amount of {currencyCode || "foreign currency"} held</label>
            <input type="number" min="0.01" step="0.01" value={foreignAmount} onChange={(e) => setForeignAmount(e.target.value)} className="erp-input" required />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-erp-muted">Rate it's carried at ({currency} per 1 {currencyCode || "unit"})</label>
              <input type="number" min="0.000001" step="0.000001" value={bookRate} onChange={(e) => setBookRate(e.target.value)} className="erp-input" required />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-erp-muted">New rate</label>
              <input type="number" min="0.000001" step="0.000001" value={newRate} onChange={(e) => setNewRate(e.target.value)} className="erp-input" required />
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-erp-muted">Gain or loss</label>
            <select value={direction} onChange={(e) => setDirection(e.target.value as "GAIN" | "LOSS")} className="erp-input">
              <option value="GAIN">Gain</option>
              <option value="LOSS">Loss</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-erp-muted">Amount ({currency})</label>
            <input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="erp-input" required />
          </div>
        </div>
      )}

      {signed !== null && signed !== 0 && (
        <p className={`rounded border p-3 text-sm font-medium ${signed > 0 ? "border-erp-success/40 bg-erp-success/10 text-erp-success" : "border-erp-danger/40 bg-erp-danger/10 text-erp-danger"}`}>
          {signed > 0 ? "Gain" : "Loss"} of {currency} {fmt(Math.abs(signed))} – the account's balance will {signed > 0 ? "increase" : "decrease"} by this amount.
        </p>
      )}
      {signed === 0 && <p className="text-xs text-erp-danger">Those rates give no difference – there is nothing to record.</p>}
      {tooBigLoss && account && (
        <p className="text-xs text-erp-danger">{account.name} only carries {currency} {fmt(account.balance)}, which is less than this loss.</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-erp-muted">Date</label>
          <input type="date" value={adjustmentDate} max={todayYmd(timeZone)} onChange={(e) => setAdjustmentDate(e.target.value)} className="erp-input" required />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-erp-muted">Rate source / reference</label>
          <input value={reference} onChange={(e) => setReference(e.target.value)} className="erp-input" maxLength={100} placeholder="e.g. bank advice, RBM rate" />
        </div>
      </div>

      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="erp-input" rows={2} placeholder="Notes (optional)" />

      <button
        type="submit"
        disabled={loading || !cashAccountId || signed === null || signed === 0 || !!tooBigLoss}
        className="rounded bg-erp-primary px-4 py-2 text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
      >
        {loading ? "Recording..." : "Record Adjustment"}
      </button>
    </form>
  );
}
