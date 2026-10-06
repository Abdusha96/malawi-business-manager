"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PRODUCT_UNITS, VAT_CATEGORIES } from "@/lib/validation";

export function NewProductForm({
  businessId,
  categories,
  branches = [],
}: {
  businessId: string;
  categories: { id: string; name: string }[];
  branches?: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Module 77: a service has no stock, so the stock-only fields disappear.
  const [isStocked, setIsStocked] = useState(true);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(e.currentTarget);
    const payload = {
      name: form.get("name"),
      categoryId: form.get("categoryId") || null,
      sku: form.get("sku") || null,
      barcode: form.get("barcode") || null,
      purchasePrice: Number(form.get("purchasePrice")),
      sellingPrice: Number(form.get("sellingPrice")),
      isStocked,
      openingQuantity: isStocked ? Number(form.get("openingQuantity") || 0) : 0,
      branchId: isStocked ? form.get("branchId") || null : null,
      unit: form.get("unit"),
      reorderLevel: isStocked ? Number(form.get("reorderLevel") || 0) : 0,
      vatCategory: form.get("vatCategory") || "STANDARD",
    };

    const res = await fetch(`/api/business/${businessId}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Could not save product.");
      return;
    }

    router.push("/inventory");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <p className="rounded bg-erp-danger/10 p-3 text-sm text-erp-danger">{error}</p>}

      <input name="name" placeholder="Product name" required className="erp-input" />

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={!isStocked} onChange={(e) => setIsStocked(!e.target.checked)} className="mt-1" />
        <span>
          <span className="font-medium">This is a service (no stock)</span>
          <span className="block text-erp-muted">
            Labour, delivery, repairs and similar. It can be quoted, sold and bought, but it has no quantity, stock level or reorder level. Enter what it costs you to provide one unit, so margins are right.
          </span>
        </span>
      </label>

      <select name="categoryId" className="erp-input">
        <option value="">No category</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input name="sku" placeholder="SKU (optional)" className="erp-input" />
        <input name="barcode" placeholder="Barcode (optional)" className="erp-input" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input name="purchasePrice" type="number" step="0.01" min="0" placeholder={isStocked ? "Purchase price" : "Cost to provide (per unit)"} required className="erp-input" />
        <input name="sellingPrice" type="number" step="0.01" min="0" placeholder="Selling price" required className="erp-input" />
      </div>

      <div className={isStocked ? "grid grid-cols-1 gap-3 sm:grid-cols-3" : "grid grid-cols-1 gap-3"}>
        {isStocked && (
          <input name="openingQuantity" type="number" step="0.001" min="0" placeholder="Opening quantity" className="erp-input" />
        )}
        <select name="unit" defaultValue="each" className="erp-input">
          {PRODUCT_UNITS.map((u) => (
            <option key={u} value={u}>{u}</option>
          ))}
        </select>
        {isStocked && (
          <input name="reorderLevel" type="number" step="0.001" min="0" placeholder="Reorder level" className="erp-input" />
        )}
      </div>

      {isStocked && branches.length > 0 && (
        <div>
          <label className="mb-1 block text-sm font-medium">
            Opening stock branch
            <span className="ml-1 font-normal text-erp-muted">(where the opening quantity above is physically located)</span>
          </label>
          <select name="branchId" defaultValue="" className="erp-input">
            <option value="">Not attributed to a branch</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label className="mb-1 block text-sm font-medium">
          VAT category
          <span className="ml-1 font-normal text-erp-muted">(only matters once VAT registration is turned on in Tax Settings)</span>
        </label>
        <select name="vatCategory" defaultValue="STANDARD" className="erp-input">
          {VAT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c === "STANDARD" ? "Standard-rated" : c === "ZERO_RATED" ? "Zero-rated" : "Exempt"}
            </option>
          ))}
        </select>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded bg-erp-primary py-2.5 font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
      >
        {loading ? "Saving..." : "Add Product"}
      </button>
    </form>
  );
}
