"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PAYMENT_METHODS } from "@/lib/validation";

type CashAccountOption = { id: string; name: string; type: string };

function accountTypeForMethod(method: string) {
  if (method === "CARD") return "BANK";
  return method;
}

export function RecordPaymentForm({ businessId, customerId, cashAccounts }: { businessId: string; customerId: string; cashAccounts: CashAccountOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const initialAccount = cashAccounts[0];
  const initialMethod = initialAccount?.type === "BANK" ? "BANK" : initialAccount?.type ?? "CASH";
  const [method, setMethod] = useState(initialMethod as (typeof PAYMENT_METHODS)[number]);
  const [cashAccountId, setCashAccountId] = useState(initialAccount?.id ?? "");
  const methods = PAYMENT_METHODS.filter((m) => m !== "CREDIT" && cashAccounts.some((a) => a.type === accountTypeForMethod(m)));
  const availableAccounts = cashAccounts.filter((a) => a.type === accountTypeForMethod(method));

  function changeMethod(nextMethod: string) {
    setMethod(nextMethod as (typeof PAYMENT_METHODS)[number]);
    setCashAccountId(cashAccounts.find((a) => a.type === accountTypeForMethod(nextMethod))?.id ?? "");
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(e.currentTarget);
    const res = await fetch(`/api/business/${businessId}/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerId,
        amount: Number(form.get("amount")),
        method,
        cashAccountId: cashAccountId || null,
        reference: form.get("reference") || null,
      }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Could not record payment.");
      return;
    }

    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded bg-erp-primary px-4 py-2 text-erp-primary-fg hover:opacity-90">
        Record Payment
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="w-80 space-y-3 rounded border bg-erp-surface p-4">
      {error && <p className="rounded bg-erp-danger/10 p-2 text-xs text-erp-danger">{error}</p>}
      <input name="amount" type="number" min="0.01" step="0.01" placeholder="Amount (MWK)" required className="erp-input" />
      <select name="method" value={method} onChange={(e) => changeMethod(e.target.value)} className="erp-input" required>
        {methods.map((m) => (
          <option key={m} value={m}>{m.replace("_", " ")}</option>
        ))}
      </select>
      <label className="block text-xs font-medium text-erp-muted">
        Received into
        <select name="cashAccountId" value={cashAccountId} onChange={(e) => setCashAccountId(e.target.value)} className="erp-input mt-1" required>
          {availableAccounts.map((account) => (
            <option key={account.id} value={account.id}>{account.name} · {account.type.replace("_", " ")}</option>
          ))}
        </select>
      </label>
      {cashAccounts.length === 0 && <p className="text-xs text-erp-danger">Add a cash, bank, or mobile-money account in Cashbook before recording this payment.</p>}
      <input name="reference" placeholder="Reference (optional)" className="erp-input" />
      <div className="flex gap-2">
        <button type="submit" disabled={loading || !cashAccountId} className="flex-1 rounded bg-erp-primary py-2 text-sm text-erp-primary-fg hover:opacity-90 disabled:opacity-60">
          {loading ? "Saving..." : "Save"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="flex-1 rounded border border-erp-border py-2 text-sm hover:bg-erp-subtle">
          Cancel
        </button>
      </div>
    </form>
  );
}
