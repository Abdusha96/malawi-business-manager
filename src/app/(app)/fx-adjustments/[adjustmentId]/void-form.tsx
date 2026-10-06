"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function VoidFxAdjustmentForm({ businessId, adjustmentId }: { businessId: string; adjustmentId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await fetch(`/api/business/${businessId}/fx-adjustments/${adjustmentId}/void`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.message ?? "Could not void this adjustment.");
      return;
    }
    router.refresh();
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded border border-erp-danger/40 px-4 py-2 text-erp-danger hover:bg-erp-danger/10">
        Void this adjustment
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded border bg-erp-surface p-4 text-sm">
      <h3 className="font-semibold">Void Adjustment</h3>
      <p className="text-xs text-erp-muted">
        The account's balance and the exchange gain/loss account go back to where they were; this record stays as
        history. You can then record a corrected adjustment.
      </p>
      {error && <p className="rounded bg-erp-danger/10 p-2 text-erp-danger">{error}</p>}
      <textarea value={reason} onChange={(e) => setReason(e.target.value)} className="erp-input" rows={2} placeholder="Why is this being voided?" required />
      <div className="flex gap-3">
        <button type="submit" disabled={loading} className="rounded bg-erp-danger px-4 py-2 text-erp-primary-fg hover:opacity-90 disabled:opacity-60">
          {loading ? "Voiding..." : "Confirm Void"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-erp-muted underline">Cancel</button>
      </div>
    </form>
  );
}
