"use client";

import { useState } from "react";

export function InvoiceButton({ businessId, saleId }: { businessId: string; saleId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setError(null);
    setLoading(true);
    // Generating is idempotent – see getOrCreateInvoiceForSale in
    // src/lib/invoices.ts – so it's safe to call this every click rather
    // than tracking client-side whether one already exists.
    const res = await fetch(`/api/business/${businessId}/sales/${saleId}/invoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    setLoading(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.message ?? "Could not generate invoice.");
      return;
    }
    window.open(`/api/business/${businessId}/sales/${saleId}/invoice/pdf`, "_blank");
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className="rounded border border-erp-border px-4 py-2 text-sm hover:bg-erp-subtle disabled:opacity-60"
      >
        {loading ? "Preparing invoice..." : "Get Invoice"}
      </button>
      {error && <p className="text-xs text-erp-danger">{error}</p>}
    </div>
  );
}
