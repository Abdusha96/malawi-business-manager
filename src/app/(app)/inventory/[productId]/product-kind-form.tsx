"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Module 77: switch a product between stocked goods and a service. The server refuses to make a product a
// service while it still holds stock, sits on an in-transit transfer or is in an open stock take, and says why.
export function ProductKindForm({
  businessId,
  productId,
  isStocked,
  canManage,
}: {
  businessId: string;
  productId: string;
  isStocked: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function change() {
    setError(null);
    setLoading(true);
    const res = await fetch(`/api/business/${businessId}/products/${productId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isStocked: !isStocked }),
    });
    const data = await res.json().catch(() => ({}));
    setLoading(false);
    if (!res.ok) {
      setError(data.message ?? "Could not change the product type.");
      return;
    }
    router.refresh();
  }

  return (
    <section className="mb-6 rounded border border-erp-border p-4 text-sm">
      <div className="flex items-center justify-between gap-4">
        <p>
          <span className="font-medium">Type:</span> {isStocked ? "Stocked goods" : "Service (no stock)"}
        </p>
        {canManage && (
          <button
            type="button"
            onClick={change}
            disabled={loading}
            className="rounded border border-erp-border px-3 py-1.5 hover:bg-erp-subtle disabled:opacity-60"
          >
            {loading ? "Saving..." : isStocked ? "Make this a service" : "Make this stocked goods"}
          </button>
        )}
      </div>
      {error && <p className="mt-3 rounded bg-erp-danger/10 p-3 text-erp-danger">{error}</p>}
    </section>
  );
}
