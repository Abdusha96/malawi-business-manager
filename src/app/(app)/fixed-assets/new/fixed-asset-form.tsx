"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { todayYmd } from "@/lib/date-range";
import { Field } from "@/components/erp/display";
import { FIXED_ASSET_CATEGORIES, FIXED_ASSET_CATEGORY_LABELS, FIXED_ASSET_PAYMENT_METHODS } from "@/lib/validation";

export function NewFixedAssetForm({ businessId, timeZone }: { businessId: string; timeZone: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [category, setCategory] = useState<(typeof FIXED_ASSET_CATEGORIES)[number]>("MOTOR_VEHICLES");
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    fetch(`/api/business/${businessId}/suppliers`)
      .then((r) => (r.ok ? r.json() : { suppliers: [] }))
      .then((d) => setSuppliers(d.suppliers ?? []))
      .catch(() => setSuppliers([]));
  }, [businessId]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(e.currentTarget);
    const acquisitionDateValue = form.get("acquisitionDate") as string;
    const supplierId = form.get("supplierId") as string;

    const payload = {
      name: form.get("name"),
      category,
      description: form.get("description") || null,
      acquisitionDate: acquisitionDateValue ? new Date(acquisitionDateValue).toISOString() : undefined,
      cost: Number(form.get("cost")),
      residualValue: Number(form.get("residualValue") || 0),
      usefulLifeYears: category === "LAND" ? null : Number(form.get("usefulLifeYears")),
      paymentMethod: form.get("paymentMethod"),
      supplierId: supplierId || null,
      notes: form.get("notes") || null,
    };

    try {
      const res = await fetch(`/api/business/${businessId}/fixed-assets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.message ?? "Could not record this asset.");
        return;
      }

      router.push(`/fixed-assets/${data.asset.id}`);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <p role="alert" className="rounded border border-erp-danger/40 bg-erp-danger/10 p-3 text-sm text-erp-danger">{error}</p>}

      <Field label="Asset name" htmlFor="fa-name" required hint="e.g. Toyota Hilux, Dell Laptop">
        <input id="fa-name" name="name" required className="erp-input" />
      </Field>

      <Field label="Category" htmlFor="fa-category" required>
        <select id="fa-category" value={category} onChange={(e) => setCategory(e.target.value as (typeof FIXED_ASSET_CATEGORIES)[number])} className="erp-input">
          {FIXED_ASSET_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {FIXED_ASSET_CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Description" htmlFor="fa-description" hint="Optional">
        <textarea id="fa-description" name="description" className="erp-input" rows={2} />
      </Field>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Acquisition date" htmlFor="fa-date" required>
          <input id="fa-date" name="acquisitionDate" type="date" className="erp-input" defaultValue={todayYmd(timeZone)} />
        </Field>
        <Field label="Cost (MWK)" htmlFor="fa-cost" required>
          <input id="fa-cost" name="cost" type="number" min="0.01" step="0.01" required className="erp-input" />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Residual value (MWK)" htmlFor="fa-residual">
          <input id="fa-residual" name="residualValue" type="number" min="0" step="0.01" defaultValue={0} className="erp-input" />
        </Field>
        {category !== "LAND" && (
          <Field label="Useful life (years)" htmlFor="fa-life" required>
            <input id="fa-life" name="usefulLifeYears" type="number" min="1" step="1" required className="erp-input" />
          </Field>
        )}
      </div>

      <Field label="Paid via" htmlFor="fa-method" required>
        <select id="fa-method" name="paymentMethod" required className="erp-input">
          {FIXED_ASSET_PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {m.replace("_", " ")}
            </option>
          ))}
        </select>
      </Field>

      {suppliers.length > 0 && (
        <Field label="Supplier" htmlFor="fa-supplier" hint="Optional">
          <select id="fa-supplier" name="supplierId" className="erp-input" defaultValue="">
            <option value="">– None –</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Notes" htmlFor="fa-notes" hint="Optional">
        <textarea id="fa-notes" name="notes" className="erp-input" rows={2} />
      </Field>

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded bg-erp-primary py-2 font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60 sm:w-auto sm:px-6"
      >
        {loading ? "Saving..." : "Record Asset"}
      </button>
    </form>
  );
}
