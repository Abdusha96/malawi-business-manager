"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatDateTimeIn } from "@/lib/timezone";

interface Option {
  id: string;
  label: string;
  offsetHours: number;
}

export function TimeZoneForm({
  businessId,
  initialTimeZone,
  options,
  canManage,
}: {
  businessId: string;
  initialTimeZone: string;
  options: Option[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [timezone, setTimezone] = useState(initialTimeZone);
  const [saved, setSaved] = useState(initialTimeZone);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    setMessage(null);
    const res = await fetch(`/api/business/${businessId}/timezone`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setError(data.message ?? data.details?.fieldErrors?.timezone?.[0] ?? "Could not save the time zone.");
      return;
    }
    setSaved(timezone);
    setMessage("Time zone saved.");
    router.refresh();
  }

  return (
    <section className="rounded border border-erp-border bg-erp-surface p-4 shadow-sm">
      <h2 className="mb-1 text-sm font-semibold text-erp-text">Time zone</h2>
      <p className="mb-4 text-sm text-erp-muted">
        Decides what &ldquo;today&rdquo;, &ldquo;this month&rdquo;, a report&rsquo;s last day and a tax due date mean for
        this business. A sale rung up at 00:30 belongs to that day&rsquo;s figures in this zone, wherever the server is.
      </p>

      <label className="mb-1 block text-xs font-medium text-erp-text" htmlFor="tz">Business time zone</label>
      <select id="tz" className="erp-input" value={timezone} onChange={(e) => setTimezone(e.target.value)} disabled={!canManage}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label} – UTC{o.offsetHours >= 0 ? "+" : ""}{o.offsetHours}
          </option>
        ))}
      </select>
      <p className="mt-2 text-sm text-erp-muted">Right now in this zone: {formatDateTimeIn(new Date(), timezone)}</p>

      {timezone !== saved && (
        <p className="mt-3 rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-sm text-erp-text">
          Changing the zone moves the day and month boundaries of every report, so figures for a period can shift slightly
          (only for activity near midnight). Recorded transactions themselves are not changed.
        </p>
      )}
      {error && <p className="mt-3 text-sm text-erp-danger">{error}</p>}
      {message && <p className="mt-3 text-sm text-erp-success">{message}</p>}

      {canManage ? (
        <button onClick={save} disabled={saving || timezone === saved} className="mt-4 rounded bg-erp-primary px-5 py-2.5 font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60">
          {saving ? "Saving…" : "Save time zone"}
        </button>
      ) : (
        <p className="mt-3 text-sm text-erp-muted">Only the business owner can change this.</p>
      )}
      <p className="mt-4 text-xs text-erp-muted">
        Only zones at UTC+0 or east without daylight-saving changes are offered – see the README (Module 35) for why.
      </p>
    </section>
  );
}
