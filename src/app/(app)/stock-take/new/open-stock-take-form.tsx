"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function OpenStockTakeForm({
  businessId,
  branches,
}: {
  businessId: string;
  branches: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch(`/api/business/${businessId}/categories`)
      .then((r) => (r.ok ? r.json() : { categories: [] }))
      .then((d) => setCategories(d.categories ?? []))
      .catch(() => setCategories([]));
  }, [businessId]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(e.currentTarget);
    const categoryId = form.get("categoryId") as string;
    const branchId = form.get("branchId") as string;
    const payload = {
      categoryId: categoryId || null,
      branchId: branchId || null,
      note: (form.get("note") as string) || null,
    };

    const res = await fetch(`/api/business/${businessId}/stock-take`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Could not start stock take.");
      return;
    }
    router.push(`/stock-take/${data.stockTake.id}`);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded border bg-erp-surface p-5 text-sm">
      {error && <p className="rounded bg-erp-danger/10 p-2 text-erp-danger">{error}</p>}

      <div>
        <label className="mb-1 block text-xs text-erp-muted">Scope</label>
        <select name="categoryId" className="erp-input">
          <option value="">Whole catalog</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-erp-muted">Every active product in this scope gets a line to count, snapshotted at today's book quantity.</p>
      </div>

      {branches.length > 0 && (
        <div>
          <label className="mb-1 block text-xs text-erp-muted">Branch</label>
          <select name="branchId" className="erp-input">
            <option value="">Whole business</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-erp-muted">
            Counting a branch snapshots that branch's own stock, not the business-wide total – a product never yet attributed to this branch starts at 0.
          </p>
        </div>
      )}

      <div>
        <label className="mb-1 block text-xs text-erp-muted">Note (optional)</label>
        <input name="note" type="text" placeholder="e.g. Q3 2026 count" className="erp-input" />
      </div>

      <button type="submit" disabled={loading} className="rounded bg-erp-primary px-4 py-2 text-erp-primary-fg hover:opacity-90 disabled:opacity-60">
        {loading ? "Starting..." : "Start Stock Take"}
      </button>
    </form>
  );
}
