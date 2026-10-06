"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ApplySupplierCreditForm({
  businessId,
  supplierId,
  totalAvailable,
}: {
  businessId: string;
  supplierId: string;
  totalAvailable: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(amount?: number) {
    setError(null);
    setLoading(true);

    const res = await fetch(`/api/business/${businessId}/credits/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ supplierId, amount }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Could not apply credit.");
      return;
    }

    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded border border-erp-primary px-3 py-1.5 text-sm text-erp-primary hover:bg-erp-subtle"
      >
        Apply Credit
      </button>
    );
  }

  return (
    <div className="w-72 space-y-3 rounded border bg-erp-surface p-4">
      {error && <p className="rounded bg-erp-danger/10 p-2 text-xs text-erp-danger">{error}</p>}
      <p className="text-sm text-erp-muted">
        MWK {totalAvailable.toLocaleString()} of standing credit is available from this supplier, from a past
        overpayment or a refund credit note.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const amount = Number(new FormData(e.currentTarget).get("amount"));
          submit(amount);
        }}
        className="space-y-2"
      >
        <input
          name="amount"
          type="number"
          min="0.01"
          max={totalAvailable}
          step="0.01"
          placeholder={`Amount (up to ${totalAvailable.toLocaleString()})`}
          required
          className="erp-input"
        />
        <button type="submit" disabled={loading} className="w-full rounded bg-erp-primary py-2 text-sm text-erp-primary-fg hover:opacity-90 disabled:opacity-60">
          {loading ? "Applying..." : "Apply This Amount"}
        </button>
      </form>
      <button
        onClick={() => submit(undefined)}
        disabled={loading}
        className="w-full rounded border border-erp-border py-2 text-sm hover:bg-erp-subtle disabled:opacity-60"
      >
        Apply Maximum Possible
      </button>
      <button onClick={() => setOpen(false)} className="w-full rounded border border-erp-border py-2 text-sm hover:bg-erp-subtle">
        Cancel
      </button>
    </div>
  );
}
