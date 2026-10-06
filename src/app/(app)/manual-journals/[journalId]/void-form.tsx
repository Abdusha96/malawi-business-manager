"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function VoidManualJournalForm({ businessId, journalId }: { businessId: string; journalId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await fetch(`/api/business/${businessId}/manual-journals/${journalId}/void`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.message ?? "Could not void this journal entry.");
      return;
    }
    router.refresh();
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded border border-erp-danger/40 px-4 py-2 text-erp-danger hover:bg-erp-danger/10">
        Void this entry
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded border bg-erp-surface p-4 text-sm">
      <h3 className="font-semibold">Void Journal Entry</h3>
      <p className="text-xs text-erp-muted">
        An equal and opposite entry is posted today, so every account goes back to where it was. This entry stays as history.
        Post a corrected entry afterwards if one is needed.
      </p>
      {error && <p className="rounded bg-erp-danger/10 p-2 text-erp-danger">{error}</p>}
      <textarea value={reason} onChange={(e) => setReason(e.target.value)} className="erp-input" rows={2} placeholder="Why is this being voided?" required minLength={3} />
      <div className="flex gap-3">
        <button type="submit" disabled={loading} className="rounded bg-erp-danger px-4 py-2 text-erp-primary-fg hover:opacity-90 disabled:opacity-60">
          {loading ? "Voiding..." : "Confirm Void"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-erp-muted underline">Cancel</button>
      </div>
    </form>
  );
}
