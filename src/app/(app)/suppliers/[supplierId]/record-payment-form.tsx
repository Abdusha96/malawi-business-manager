"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PAYMENT_METHODS } from "@/lib/validation";

export function RecordSupplierPaymentForm({ businessId, supplierId }: { businessId: string; supplierId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(e.currentTarget);
    const res = await fetch(`/api/business/${businessId}/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        supplierId,
        amount: Number(form.get("amount")),
        method: form.get("method"),
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
    <form onSubmit={handleSubmit} className="w-72 space-y-3 rounded border bg-erp-surface p-4">
      {error && <p className="rounded bg-erp-danger/10 p-2 text-xs text-erp-danger">{error}</p>}
      <input name="amount" type="number" min="0.01" step="0.01" placeholder="Amount (MWK)" required className="erp-input" />
      <select name="method" className="erp-input">
        {PAYMENT_METHODS.filter((m) => m !== "CREDIT").map((m) => (
          <option key={m} value={m}>{m.replace("_", " ")}</option>
        ))}
      </select>
      <input name="reference" placeholder="Reference (optional)" className="erp-input" />
      <div className="flex gap-2">
        <button type="submit" disabled={loading} className="flex-1 rounded bg-erp-primary py-2 text-sm text-erp-primary-fg hover:opacity-90 disabled:opacity-60">
          {loading ? "Saving..." : "Save"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="flex-1 rounded border border-erp-border py-2 text-sm hover:bg-erp-subtle">
          Cancel
        </button>
      </div>
    </form>
  );
}
