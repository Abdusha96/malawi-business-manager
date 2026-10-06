"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { todayYmd } from "@/lib/date-range";
import { Field } from "@/components/erp/display";

export function DisposeAssetForm({ businessId, assetId, timeZone }: { businessId: string; assetId: string; timeZone: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [proceeds, setProceeds] = useState("0");
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (!open) return;
    fetch(`/api/business/${businessId}/cashbook/accounts`)
      .then((r) => (r.ok ? r.json() : { accounts: [] }))
      .then((d) => setAccounts(d.accounts ?? []))
      .catch(() => setAccounts([]));
  }, [open, businessId]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(e.currentTarget);
    const disposalDateValue = form.get("disposalDate") as string;

    const payload = {
      disposalDate: disposalDateValue ? new Date(disposalDateValue).toISOString() : undefined,
      disposalProceeds: Number(proceeds || 0),
      cashAccountId: Number(proceeds || 0) > 0 ? form.get("cashAccountId") : null,
      disposalNotes: form.get("disposalNotes") || null,
    };

    try {
      const res = await fetch(`/api/business/${businessId}/fixed-assets/${assetId}/dispose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.message ?? "Could not record disposal.");
        return;
      }

      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded border border-erp-danger/50 px-3 py-1.5 text-sm text-erp-danger hover:bg-erp-danger/10">
        Dispose of this asset
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded border border-erp-border bg-erp-surface p-4 text-sm shadow-sm">
      <h3 className="text-sm font-semibold text-erp-text">Dispose of Asset</h3>
      {error && <p role="alert" className="rounded border border-erp-danger/40 bg-erp-danger/10 p-2 text-erp-danger">{error}</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Disposal date" htmlFor="disp-date" required>
          <input id="disp-date" name="disposalDate" type="date" className="erp-input" defaultValue={todayYmd(timeZone)} />
        </Field>
        <Field label="Proceeds received (MWK)" htmlFor="disp-proceeds" hint="0 if scrapped or written off">
          <input
            id="disp-proceeds"
            name="disposalProceeds"
            type="number"
            min="0"
            step="0.01"
            value={proceeds}
            onChange={(e) => setProceeds(e.target.value)}
            className="erp-input"
          />
        </Field>
      </div>

      {Number(proceeds || 0) > 0 && (
        <Field label="Deposit proceeds into" htmlFor="disp-account" required>
          <select id="disp-account" name="cashAccountId" required className="erp-input">
            <option value="">Select an account...</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Notes" htmlFor="disp-notes" hint="Optional">
        <textarea id="disp-notes" name="disposalNotes" className="erp-input" rows={2} />
      </Field>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={loading}
          className="rounded bg-erp-danger px-4 py-1.5 font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
        >
          {loading ? "Saving..." : "Confirm Disposal"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-erp-muted underline">
          Cancel
        </button>
      </div>
    </form>
  );
}
