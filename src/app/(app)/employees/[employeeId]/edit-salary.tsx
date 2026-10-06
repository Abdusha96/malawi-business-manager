"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function EditSalary({
  businessId,
  employeeId,
  monthlySalary,
}: {
  businessId: string;
  employeeId: string;
  monthlySalary: number;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const res = await fetch(`/api/business/${businessId}/employees/${employeeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ monthlySalary: Number(form.get("monthlySalary")) }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.message ?? "Could not update salary.");
      return;
    }
    setEditing(false);
    router.refresh();
  }

  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} className="mt-1 text-xs font-medium text-erp-primary hover:underline">
        Edit salary
      </button>
    );
  }

  return (
    <form onSubmit={save} className="mt-2 flex flex-wrap items-end gap-2">
      <label className="text-xs text-erp-muted">
        Monthly salary (MWK)
        <input name="monthlySalary" type="number" min="0" step="0.01" required defaultValue={monthlySalary} className="erp-input mt-1 block w-44" />
      </label>
      <button type="submit" disabled={busy} className="rounded bg-erp-primary px-3 py-2 text-xs font-medium text-erp-primary-fg disabled:opacity-60">
        {busy ? "Saving…" : "Save"}
      </button>
      <button type="button" disabled={busy} onClick={() => { setEditing(false); setError(null); }} className="rounded border border-erp-border px-3 py-2 text-xs">
        Cancel
      </button>
      {error && <p role="alert" className="w-full text-xs text-erp-danger">{error}</p>}
    </form>
  );
}
