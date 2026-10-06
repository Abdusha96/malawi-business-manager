"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Branch = {
  id: string;
  name: string;
  district: string | null;
  city: string | null;
  address: string | null;
  isActive: boolean;
  isHeadOffice: boolean;
};

export function EditBranchForm({ businessId, branch }: { businessId: string; branch: Branch }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isActive, setIsActive] = useState(branch.isActive);

  async function save(payload: Record<string, unknown>) {
    setError(null);
    setLoading(true);

    const res = await fetch(`/api/business/${businessId}/branches/${branch.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Could not update branch.");
      return false;
    }
    router.refresh();
    return true;
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await save({
      name: form.get("name"),
      district: form.get("district") || null,
      city: form.get("city") || null,
      address: form.get("address") || null,
    });
  }

  async function toggleActive() {
    const next = !isActive;
    const ok = await save({ isActive: next });
    if (ok) setIsActive(next);
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <p className="rounded bg-erp-danger/10 p-3 text-sm text-erp-danger">{error}</p>}

        <div>
          <label className="mb-1 block text-sm font-medium">Branch name</label>
          <input name="name" defaultValue={branch.name} required className="erp-input" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">City</label>
          <input name="city" defaultValue={branch.city ?? ""} className="erp-input" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">District</label>
          <input name="district" defaultValue={branch.district ?? ""} className="erp-input" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Address</label>
          <input name="address" defaultValue={branch.address ?? ""} className="erp-input" />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded bg-erp-primary py-2.5 font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
        >
          {loading ? "Saving..." : "Save Changes"}
        </button>
      </form>

      <div className="rounded border bg-erp-surface p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Branch status</p>
            <p className="text-xs text-erp-muted">
              {branch.isHeadOffice
                ? "The head office branch can't be deactivated – every business needs at least one default branch."
                : isActive
                ? "Active branches can be used for new sales and expenses."
                : "Inactive branches are hidden from new-sale/expense pickers but keep their history."}
            </p>
          </div>
          <button
            type="button"
            onClick={toggleActive}
            disabled={loading || branch.isHeadOffice}
            className={`shrink-0 rounded px-3 py-1.5 text-sm font-medium disabled:opacity-40 ${
              isActive ? "border border-erp-danger/40 text-erp-danger hover:bg-erp-danger/10" : "bg-erp-primary text-erp-primary-fg hover:opacity-90"
            }`}
          >
            {isActive ? "Deactivate" : "Activate"}
          </button>
        </div>
      </div>
    </div>
  );
}
