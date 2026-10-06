"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Module 80 – mirrors StaleTransferThresholdForm's shape exactly, one input
// controlling Business.serviceCostAlertDays.
export function ServiceCostAlertForm({
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
    const res = await fetch(`/api/business/${businessId}/service-cost-alert-threshold`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serviceCostAlertDays: parsed }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setError(data.message ?? data.details?.fieldErrors?.serviceCostAlertDays?.[0] ?? "Could not save the service cost alert threshold.");
      return;
    }
    setSaved(parsed);
    setMessage("Service cost alert threshold saved.");
    router.refresh();
  }

  return (
    <section className="mt-6 rounded border border-erp-border bg-erp-surface p-4 shadow-sm">
      <h2 className="mb-1 text-sm font-semibold text-erp-text">Service cost clearing alert</h2>
      <p className="mb-4 text-sm text-erp-muted">
        How many days a service's leftover in Service Cost Clearing can sit untouched before the bell and the Service
        Cost Clearing page call it aged. The "urgent" escalation fires at twice this number of days. Leftovers under
        K1.00 never raise the alert.
      </p>

      <label className="mb-1 block text-xs font-medium text-erp-text" htmlFor="service-cost-alert-days">Days before aged</label>
      <input
        id="service-cost-alert-days"
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
          {saving ? "Saving…" : "Save service cost alert threshold"}
        </button>
      ) : (
        <p className="mt-3 text-sm text-erp-muted">Only the business owner can change this.</p>
      )}
      <p className="mt-4 text-xs text-erp-muted">
        Changing this doesn't change any balance or settlement – it only changes when the next sync starts (or stops)
        calling a leftover aged.
      </p>
    </section>
  );
}
