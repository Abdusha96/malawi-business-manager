"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Module 58 – mirrors MaxReopensForm's shape exactly (same save/disabled
// pattern), one erp-input controlling Business.staleTransferAlertDays.
export function StaleTransferThresholdForm({
  businessId,
  initialAlertDays,
  min,
  max,
  canManage,
}: {
  businessId: string;
  initialAlertDays: number;
  min: number;
  max: number;
  canManage: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState(String(initialAlertDays));
  const [saved, setSaved] = useState(initialAlertDays);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const parsed = Number(value);
  const isValidInput = Number.isInteger(parsed) && parsed >= min && parsed <= max;

  async function save() {
    if (!isValidInput) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    const res = await fetch(`/api/business/${businessId}/stale-transfer-threshold`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ staleTransferAlertDays: parsed }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setError(data.message ?? data.details?.fieldErrors?.staleTransferAlertDays?.[0] ?? "Could not save the stale transfer threshold.");
      return;
    }
    setSaved(parsed);
    setMessage("Stale transfer threshold saved.");
    router.refresh();
  }

  return (
    <section className="mt-6 rounded border border-erp-border bg-erp-surface p-4 shadow-sm">
      <h2 className="mb-1 text-sm font-semibold text-erp-text">Stale transfer alert</h2>
      <p className="mb-4 text-sm text-erp-muted">
        How many days a stock transfer can sit dispatched and unconfirmed before the bell and the Stock Transfers
        pages call it stale. The "urgent" escalation fires at twice this number of days.
      </p>

      <label className="mb-1 block text-xs font-medium text-erp-text" htmlFor="stale-transfer-alert-days">Days before stale</label>
      <input
        id="stale-transfer-alert-days"
        type="number"
        min={min}
        max={max}
        step={1}
        className="erp-input w-32"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={!canManage}
      />
      <p className="mt-2 text-sm text-erp-muted">Must be between {min} and {max}.</p>

      {value !== "" && !isValidInput && (
        <p className="mt-3 text-sm text-erp-danger">Enter a whole number between {min} and {max}.</p>
      )}
      {error && <p className="mt-3 text-sm text-erp-danger">{error}</p>}
      {message && <p className="mt-3 text-sm text-erp-success">{message}</p>}

      {canManage ? (
        <button
          onClick={save}
          disabled={saving || !isValidInput || parsed === saved}
          className="mt-4 rounded bg-erp-primary px-5 py-2.5 font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save stale transfer threshold"}
        </button>
      ) : (
        <p className="mt-3 text-sm text-erp-muted">Only the business owner can change this.</p>
      )}
      <p className="mt-4 text-xs text-erp-muted">
        Changing this doesn't affect a transfer's history – it only changes when the next sync starts (or stops)
        calling an IN_TRANSIT transfer stale.
      </p>
    </section>
  );
}
