"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type ProductOption = { id: string; name: string; unit: string };
type BranchOption = { id: string; name: string };

interface TransferLine {
  productId: string;
  quantity: number;
}

export function NewStockTransferForm({
  businessId,
  products,
  branches,
  ownBranchId,
}: {
  businessId: string;
  products: ProductOption[];
  branches: BranchOption[];
  ownBranchId: string | null;
}) {
  const router = useRouter();
  // A branch-restricted member is defaulted into their own branch as the
  // "From" (the common case: sending their own overstock elsewhere) but can
  // still switch it to "To" by picking their branch there instead – the
  // POST route accepts either end matching their own branch.
  const [fromBranchId, setFromBranchId] = useState(ownBranchId ?? branches[0]?.id ?? "");
  const [toBranchId, setToBranchId] = useState(
    branches.find((b) => b.id !== (ownBranchId ?? branches[0]?.id))?.id ?? ""
  );
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<TransferLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function addLine() {
    if (products.length === 0) return;
    setLines((prev) => [...prev, { productId: products[0].id, quantity: 1 }]);
  }

  function updateLine(index: number, patch: Partial<TransferLine>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit() {
    setError(null);

    if (fromBranchId === toBranchId) {
      setError("Source and destination branch must be different.");
      return;
    }
    if (lines.length === 0) {
      setError("Add at least one product to transfer.");
      return;
    }

    setLoading(true);

    const res = await fetch(`/api/business/${businessId}/stock-transfers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromBranchId,
        toBranchId,
        items: lines,
        notes: notes || null,
      }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Could not record transfer.");
      return;
    }

    router.push(`/stock-transfers/${data.transfer.id}`);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {error && <p className="rounded bg-erp-danger/10 p-3 text-sm text-erp-danger">{error}</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-sm font-medium">From branch</label>
          <select value={fromBranchId} onChange={(e) => setFromBranchId(e.target.value)} className="erp-input">
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">To branch</label>
          <select value={toBranchId} onChange={(e) => setToBranchId(e.target.value)} className="erp-input">
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="rounded border bg-erp-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Items</h2>
          <button type="button" onClick={addLine} className="text-sm text-erp-primary underline">
            + Add product
          </button>
        </div>

        {lines.length === 0 ? (
          <p className="text-sm text-erp-muted">
            No items added yet. Only stock already attributed to the source branch can be transferred –
            see the Inventory page for what's currently attributed where.
          </p>
        ) : (
          <div className="space-y-3">
            {lines.map((line, i) => {
              const product = products.find((p) => p.id === line.productId);
              return (
                <div key={i} className="grid grid-cols-12 items-center gap-2 text-sm">
                  <select
                    value={line.productId}
                    onChange={(e) => updateLine(i, { productId: e.target.value })}
                    className="erp-input col-span-7"
                  >
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={0.001}
                    step="0.001"
                    value={line.quantity}
                    onChange={(e) => updateLine(i, { quantity: Number(e.target.value) })}
                    className="erp-input col-span-3"
                    placeholder="Qty"
                  />
                  <span className="col-span-1 text-erp-muted">{product?.unit}</span>
                  <button type="button" onClick={() => removeLine(i)} className="col-span-1 text-erp-danger">
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">Notes (optional)</label>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} className="erp-input" placeholder="e.g. Restocking after low-stock alert" />
      </div>

      <button
        type="button"
        onClick={handleSubmit}
        disabled={loading}
        className="w-full rounded bg-erp-primary py-2.5 font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
      >
        {loading ? "Dispatching..." : "Dispatch Transfer"}
      </button>
    </div>
  );
}
