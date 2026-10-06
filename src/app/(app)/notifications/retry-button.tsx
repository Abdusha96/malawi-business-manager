"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Module 75 – re-send one FAILED message (Module 76: or a text the network reported as not delivered). The server decides whether it is allowed (not a refused
// number, not already retried) and takes the row over atomically, so a double click sends once.
export function RetryButton({ businessId, logId }: { businessId: string; logId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function retry() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/business/${businessId}/notifications/${logId}/retry`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      setMessage(data.message ?? (res.ok ? "Done." : "Could not retry."));
      if (res.ok || res.status === 409) router.refresh();
    } catch {
      setMessage("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={retry}
        disabled={busy}
        className="rounded border px-2 py-0.5 text-xs text-erp-primary hover:bg-erp-subtle disabled:opacity-50"
      >
        {busy ? "Retrying..." : "Retry"}
      </button>
      {message && <p className="mt-1 text-xs text-erp-muted">{message}</p>}
    </div>
  );
}
