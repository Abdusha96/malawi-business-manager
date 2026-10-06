"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PAYMENT_METHODS } from "@/lib/validation";
import { computeSettlement } from "@/lib/fx-calc";

type CashAccountOption = { id: string; name: string; type: string };

function accountTypeForMethod(method: string) {
  if (method === "CARD") return "BANK";
  return method;
}

/**
 * Module 40 – record a payment on ONE foreign-currency Sale/Purchase, stated in
 * the document's own currency. The preview uses the same computeSettlement()
 * the server does, so what you see is what posts.
 */
export function SettleForeignForm({
  businessId,
  kind,
  documentId,
  currency,
  bookRate,
  balance,
  foreignBalance,
  cashAccounts = [],
}: {
  businessId: string;
  kind: "SALE" | "PURCHASE";
  documentId: string;
  currency: string;
  bookRate: number;
  balance: number; // kwacha
  foreignBalance: number;
  cashAccounts?: CashAccountOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [foreignAmount, setForeignAmount] = useState<number | "">(foreignBalance);
  const [rate, setRate] = useState<number | "">(bookRate);
  const firstAccount = cashAccounts[0];
  const initialMethod = firstAccount?.type === "BANK" ? "BANK" : firstAccount?.type ?? "BANK";
  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]>(initialMethod as (typeof PAYMENT_METHODS)[number]);
  const [cashAccountId, setCashAccountId] = useState(firstAccount?.id ?? "");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const side = kind === "SALE" ? "RECEIVE" : "PAY";
  const availableMethods = kind === "SALE" && cashAccounts.length > 0
    ? PAYMENT_METHODS.filter((m) => m !== "CREDIT" && cashAccounts.some((a) => a.type === accountTypeForMethod(m)))
    : PAYMENT_METHODS.filter((m) => m !== "CREDIT");
  const availableAccounts = cashAccounts.filter((a) => a.type === accountTypeForMethod(method));
  let preview: ReturnType<typeof computeSettlement> | null = null;
  let previewError: string | null = null;
  if (foreignAmount !== "" && rate !== "" && Number(foreignAmount) > 0 && Number(rate) > 0) {
    try {
      preview = computeSettlement({ side, foreignAmount: Number(foreignAmount), bookRate, settlementRate: Number(rate), balance });
    } catch (e) {
      previewError = (e as Error).message;
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await fetch(`/api/business/${businessId}/foreign-settlements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(kind === "SALE" ? { saleId: documentId } : { purchaseId: documentId }),
        foreignAmount: Number(foreignAmount),
        settlementRate: Number(rate),
        method,
        cashAccountId: kind === "SALE" ? cashAccountId || null : null,
        reference: reference || null,
      }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.message ?? "Could not record the payment.");
      return;
    }
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded bg-erp-primary px-4 py-2 text-erp-primary-fg hover:opacity-90">
        Record {currency} payment
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded border bg-erp-surface p-4 text-sm">
      <p className="font-semibold">
        {kind === "SALE" ? "Payment received" : "Payment made"} in {currency}
      </p>
      <p className="text-xs text-erp-muted">
        Still owing: {currency} {foreignBalance.toLocaleString()} (MWK {balance.toLocaleString()} at the booked rate of {bookRate}).
      </p>
      {error && <p className="rounded bg-erp-danger/10 p-2 text-xs text-erp-danger">{error}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs text-erp-muted">Amount ({currency})</label>
          <input type="number" min="0.01" step="0.01" required value={foreignAmount} className="erp-input"
            onChange={(e) => setForeignAmount(e.target.value === "" ? "" : Number(e.target.value))} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-erp-muted">Rate today (MWK per {currency})</label>
          <input type="number" min="0.0001" step="0.0001" required value={rate} className="erp-input"
            onChange={(e) => setRate(e.target.value === "" ? "" : Number(e.target.value))} />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <select value={method} onChange={(e) => {
          const nextMethod = e.target.value;
          setMethod(nextMethod as (typeof PAYMENT_METHODS)[number]);
          setCashAccountId(cashAccounts.find((a) => a.type === accountTypeForMethod(nextMethod))?.id ?? "");
        }} className="erp-input">
          {availableMethods.map((m) => (
            <option key={m} value={m}>{m.replace("_", " ")}</option>
          ))}
        </select>
        {kind === "SALE" && cashAccounts.length > 0 && (
          <select value={cashAccountId} onChange={(e) => setCashAccountId(e.target.value)} className="erp-input" required>
            {availableAccounts.map((account) => (
              <option key={account.id} value={account.id}>{account.name} · {account.type.replace("_", " ")}</option>
            ))}
          </select>
        )}
        <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Reference (optional)" className="erp-input" />
      </div>
      {previewError && <p className="text-xs text-erp-danger">{previewError}</p>}
      {preview && (
        <div className="rounded bg-erp-subtle p-3 text-xs">
          <div className="flex justify-between"><span>Cleared off the document</span><span>MWK {preview.bookAmount.toLocaleString()}</span></div>
          <div className="flex justify-between"><span>{kind === "SALE" ? "Cash received" : "Cash paid"}</span><span>MWK {preview.cashAmount.toLocaleString()}</span></div>
          <div className={`flex justify-between font-medium ${preview.gainLoss > 0 ? "text-erp-success" : preview.gainLoss < 0 ? "text-erp-danger" : ""}`}>
            <span>Exchange {preview.gainLoss < 0 ? "loss" : "gain"}</span>
            <span>MWK {Math.abs(preview.gainLoss).toLocaleString()}</span>
          </div>
        </div>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={loading || !preview} className="flex-1 rounded bg-erp-primary py-2 text-erp-primary-fg hover:opacity-90 disabled:opacity-60">
          {loading ? "Saving..." : "Save"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="flex-1 rounded border border-erp-border py-2 hover:bg-erp-subtle">
          Cancel
        </button>
      </div>
    </form>
  );
}
