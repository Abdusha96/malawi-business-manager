"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function VoidPurchaseForm({ businessId, purchaseId }: { businessId: string; purchaseId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleVoid() {
    if (!reason.trim()) {
      setError("A reason is required to void this purchase.");
      return;
    }
    setError(null);
    setLoading(true);
    const res = await fetch(`/api/business/${businessId}/purchases/${purchaseId}/void`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.message ?? "Could not void this purchase.");
      return;
    }
    router.refresh();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-erp-danger/40 px-4 py-2 text-sm text-erp-danger hover:bg-erp-danger/10"
      >
        Void Purchase
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded border border-erp-danger/40 bg-erp-danger/10 p-4">
      <p className="text-sm text-erp-danger">
        Voiding reverses stock but does not touch any cash already paid to the supplier – if this purchase was paid,
        decide on a refund separately afterward.
      </p>
      {error && <p className="rounded bg-erp-danger/15 p-2 text-xs text-erp-danger">{error}</p>}
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason for voiding (required)"
        className="erp-input"
        rows={2}
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={loading}
          onClick={handleVoid}
          className="flex-1 rounded bg-erp-danger py-2 text-sm font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
        >
          {loading ? "Voiding..." : "Confirm Void"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="flex-1 rounded border border-erp-border py-2 text-sm hover:bg-erp-subtle"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
