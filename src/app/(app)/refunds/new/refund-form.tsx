"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type CashAccountOption = { id: string; name: string; type: string; balance: number };

const METHOD_INFO: Record<string, string> = {
  CASH: "Money actually leaves/enters a real cash account now, and the books are updated to match.",
  CREDIT_NOTE:
    "No cash moves yet. Recorded as a balance owed – shown on the customer/supplier's profile, but not yet automatically applied to a future sale or purchase.",
  WRITE_OFF: "A deliberate decision that nothing is owed either way (e.g. the void was a pure data-entry fix).",
};

export function RefundForm({
  businessId,
  saleId,
  purchaseId,
  kind,
  refundable,
  cashAccounts,
}: {
  businessId: string;
  saleId?: string;
  purchaseId?: string;
  kind: "SALE" | "PURCHASE";
  refundable: number;
  cashAccounts: CashAccountOption[];
}) {
  const router = useRouter();
  const [amount, setAmount] = useState(String(refundable));
  const [method, setMethod] = useState<"CASH" | "CREDIT_NOTE" | "WRITE_OFF">("CASH");
  const [cashAccountId, setCashAccountId] = useState(cashAccounts[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (method === "CASH" && !cashAccountId) {
      setError("Select which cash account this refund is coming from or into.");
      return;
    }
    if (!reason.trim()) {
      setError("A reason is required.");
      return;
    }

    setLoading(true);
    const res = await fetch(`/api/business/${businessId}/refunds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        saleId: saleId ?? null,
        purchaseId: purchaseId ?? null,
        amount: Number(amount),
        method,
        reason,
        cashAccountId: method === "CASH" ? cashAccountId : null,
      }),
    });
    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Could not process this refund.");
      return;
    }

    router.push(saleId ? `/sales/${saleId}` : `/purchases/${purchaseId}`);
    router.refresh();
  }

  const selectedAccount = cashAccounts.find((a) => a.id === cashAccountId);

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded border bg-erp-surface p-4">
      {error && <p className="rounded bg-erp-danger/10 p-2 text-xs text-erp-danger">{error}</p>}

      <div>
        <label className="mb-1 block text-xs font-medium text-erp-muted">Amount to refund (MWK)</label>
        <input
          type="number"
          min="0.01"
          max={refundable}
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="erp-input"
          required
        />
        <p className="mt-1 text-xs text-erp-muted">Up to MWK {refundable.toLocaleString()} unresolved.</p>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-erp-muted">Method</label>
        <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)} className="erp-input">
          <option value="CASH">Cash {kind === "SALE" ? "back to customer" : "back from supplier"}</option>
          <option value="CREDIT_NOTE">{kind === "SALE" ? "Customer credit note" : "Supplier credit note"}</option>
          <option value="WRITE_OFF">Write off – nothing owed</option>
        </select>
        <p className="mt-1 text-xs text-erp-muted">{METHOD_INFO[method]}</p>
      </div>

      {method === "CASH" && (
        <div>
          <label className="mb-1 block text-xs font-medium text-erp-muted">
            {kind === "SALE" ? "Pay out from" : "Deposit into"}
          </label>
          {cashAccounts.length === 0 ? (
            <p className="text-xs text-erp-danger">No active cash accounts found – set one up in Cashbook first.</p>
          ) : (
            <select value={cashAccountId} onChange={(e) => setCashAccountId(e.target.value)} className="erp-input">
              {cashAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.type.replace("_", " ")}) – MWK {a.balance.toLocaleString()}
                </option>
              ))}
            </select>
          )}
          {kind === "SALE" && selectedAccount && Number(amount) > selectedAccount.balance && (
            <p className="mt-1 text-xs text-erp-danger">
              {selectedAccount.name} only holds MWK {selectedAccount.balance.toLocaleString()}.
            </p>
          )}
        </div>
      )}

      <div>
        <label className="mb-1 block text-xs font-medium text-erp-muted">Reason</label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="erp-input"
          rows={2}
          placeholder="Why is this refund being processed?"
          required
        />
      </div>

      <button
        type="submit"
        disabled={loading || (method === "CASH" && cashAccounts.length === 0)}
        className="w-full rounded bg-erp-primary py-2 text-sm font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
      >
        {loading ? "Processing..." : "Confirm Refund"}
      </button>
    </form>
  );
}
