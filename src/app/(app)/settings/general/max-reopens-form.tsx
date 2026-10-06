"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function MaxReopensForm({
  businessId,
  initialMaxReopens,
  min,
  max,
  canManage,
}: {
  businessId: string;
  initialMaxReopens: number;
  min: number;
  max: number;
  canManage: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState(String(initialMaxReopens));
  const [saved, setSaved] = useState(initialMaxReopens);
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
    const res = await fetch(`/api/business/${businessId}/max-reopens`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxReopens: parsed }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setError(data.message ?? data.details?.fieldErrors?.maxReopens?.[0] ?? "Could not save the reopen limit.");
      return;
    }
    setSaved(parsed);
    setMessage("Reopen limit saved.");
    router.refresh();
  }

  return (
    <section className="mt-6 rounded border border-erp-border bg-erp-surface p-4 shadow-sm">
      <h2 className="mb-1 text-sm font-semibold text-erp-text">Reopen limit</h2>
      <p className="mb-4 text-sm text-erp-muted">
        How many times a completed bank reconciliation or stock take can be reopened before the app points at a manual
        journal entry (Manual Journal Entries) instead. Applies to both, business-wide.
      </p>

      <label className="mb-1 block text-xs font-medium text-erp-text" htmlFor="max-reopens">Maximum reopens</label>
      <input
        id="max-reopens"
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
          {saving ? "Saving…" : "Save reopen limit"}
        </button>
      ) : (
        <p className="mt-3 text-sm text-erp-muted">Only the business owner can change this.</p>
      )}
      <p className="mt-4 text-xs text-erp-muted">
        Lowering this does not affect reopens that have already happened – it only applies the next time someone tries
        to reopen a completed reconciliation or stock take.
      </p>
    </section>
  );
}
