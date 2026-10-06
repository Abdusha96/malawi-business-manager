"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function NewBranchForm({ businessId }: { businessId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(e.currentTarget);
    const payload = {
      name: form.get("name"),
      district: form.get("district") || null,
      city: form.get("city") || null,
      address: form.get("address") || null,
    };

    const res = await fetch(`/api/business/${businessId}/branches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Could not save branch.");
      return;
    }

    router.push(`/branches/${data.branch.id}`);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <p className="rounded bg-erp-danger/10 p-3 text-sm text-erp-danger">{error}</p>}

      <input name="name" placeholder="Branch name" required className="erp-input" />
      <input name="city" placeholder="City (optional)" className="erp-input" />
      <input name="district" placeholder="District (optional)" className="erp-input" />
      <input name="address" placeholder="Address (optional)" className="erp-input" />

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded bg-erp-primary py-2.5 font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
      >
        {loading ? "Saving..." : "Add Branch"}
      </button>
    </form>
  );
}
