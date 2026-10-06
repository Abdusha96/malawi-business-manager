"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type ProductOption = { id: string; name: string; sellingPrice: number; unit: string; vatCategory: "STANDARD" | "ZERO_RATED" | "EXEMPT" };
type CustomerOption = { id: string; name: string };
type BranchOption = { id: string; name: string };

const CUSTOM_ITEM = "__custom__";

interface QuoteLine {
  productId: string | null; // null = free-text / not-yet-stocked item
  description: string;
  quantity: number;
  unitPrice: number;
  discount: number;
}

export function NewQuotationForm({
  businessId,
  products,
  customers,
  branches = [],
  vatConfig,
}: {
  businessId: string;
  products: ProductOption[];
  customers: CustomerOption[];
  branches?: BranchOption[];
  vatConfig: { vatRegistered: boolean; vatRate: number };
}) {
  const router = useRouter();
  const [lines, setLines] = useState<QuoteLine[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [branchId, setBranchId] = useState("");
  const [quoteDiscount, setQuoteDiscount] = useState(0);
  const [expiryDate, setExpiryDate] = useState("");
  const [notes, setNotes] = useState("");
  const [terms, setTerms] = useState("Prices are valid until the expiry date shown above.");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const subtotal = useMemo(
    () => lines.reduce((sum, l) => sum + (l.quantity * l.unitPrice - l.discount), 0),
    [lines]
  );
  // Module 18 (VAT): preview only, same reasoning as the Sale/Purchase
  // forms – a free-text line (productId === null) has no real VAT category
  // to check, so it's previewed as STANDARD here too, matching
  // src/lib/quotations.ts::computeQuotationTotals's own default.
  const tax = useMemo(() => {
    if (!vatConfig.vatRegistered) return 0;
    return round2(
      lines.reduce((sum, l) => {
        const product = l.productId ? products.find((p) => p.id === l.productId) : null;
        const category = product?.vatCategory ?? "STANDARD";
        if (category !== "STANDARD") return sum;
        const lineTotal = l.quantity * l.unitPrice - l.discount;
        return sum + lineTotal * (vatConfig.vatRate / 100);
      }, 0)
    );
  }, [lines, products, vatConfig]);
  const total = Math.max(0, subtotal - quoteDiscount + tax);

  function addLine() {
    setLines((prev) => [...prev, { productId: null, description: "", quantity: 1, unitPrice: 0, discount: 0 }]);
  }

  function updateLine(index: number, patch: Partial<QuoteLine>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  function handleProductChange(index: number, value: string) {
    if (value === CUSTOM_ITEM) {
      updateLine(index, { productId: null, description: "", unitPrice: 0 });
      return;
    }
    const product = products.find((p) => p.id === value);
    updateLine(index, { productId: value, description: product?.name ?? "", unitPrice: product?.sellingPrice ?? 0 });
  }

  async function handleSubmit() {
    setError(null);

    if (lines.length === 0) {
      setError("Add at least one item to the quotation.");
      return;
    }
    if (lines.some((l) => !l.description.trim())) {
      setError("Every line needs a description.");
      return;
    }

    setLoading(true);

    const res = await fetch(`/api/business/${businessId}/quotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerId: customerId || null,
        customerName: customerId ? null : customerName || null,
        branchId: branchId || null,
        items: lines.map((l) => ({
          productId: l.productId,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discount: l.discount,
        })),
        discount: quoteDiscount,
        expiryDate: expiryDate ? new Date(expiryDate).toISOString() : null,
        notes: notes || null,
        terms: terms || null,
      }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Could not create quotation.");
      return;
    }

    router.push(`/quotations/${data.quotation.id}`);
  }

  return (
    <div className="space-y-6">
      {error && <p className="rounded bg-erp-danger/10 p-3 text-sm text-erp-danger">{error}</p>}

      <div>
        <label className="mb-1 block text-sm font-medium">Customer</label>
        <select
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          className="erp-input"
        >
          <option value="">Not a tracked customer yet</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        {!customerId && (
          <input
            type="text"
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder="Prospect's name (optional)"
            className="erp-input mt-2"
          />
        )}
      </div>

      {branches.length > 0 && (
        <div>
          <label className="mb-1 block text-sm font-medium">Branch</label>
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="erp-input">
            <option value="">Not attributed to a branch</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
      )}

      <div className="rounded border bg-erp-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Items</h2>
          <button type="button" onClick={addLine} className="text-sm text-erp-primary underline">
            + Add item
          </button>
        </div>

        {lines.length === 0 ? (
          <p className="text-sm text-erp-muted">No items added yet.</p>
        ) : (
          <div className="space-y-3">
            {lines.map((line, i) => {
              const lineTotal = round2(line.quantity * line.unitPrice - line.discount);
              return (
                <div key={i} className="grid grid-cols-12 items-center gap-2 text-sm">
                  <select
                    value={line.productId ?? CUSTOM_ITEM}
                    onChange={(e) => handleProductChange(i, e.target.value)}
                    className="erp-input col-span-3"
                  >
                    <option value={CUSTOM_ITEM}>Custom item</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={line.description}
                    onChange={(e) => updateLine(i, { description: e.target.value })}
                    placeholder="Description"
                    className="erp-input col-span-3"
                  />
                  <input
                    type="number"
                    min={0.001}
                    step="0.001"
                    value={line.quantity}
                    onChange={(e) => updateLine(i, { quantity: Number(e.target.value) })}
                    className="erp-input col-span-1"
                    placeholder="Qty"
                  />
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={line.unitPrice}
                    onChange={(e) => updateLine(i, { unitPrice: Number(e.target.value) })}
                    className="erp-input col-span-2"
                    placeholder="Price"
                  />
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={line.discount}
                    onChange={(e) => updateLine(i, { discount: Number(e.target.value) })}
                    className="erp-input col-span-2"
                    placeholder="Discount"
                  />
                  <span className="col-span-1 text-right">{lineTotal.toLocaleString()}</span>
                  <button type="button" onClick={() => removeLine(i)} className="col-span-12 text-right text-xs text-erp-danger">
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded border bg-erp-surface p-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Quote discount</label>
          <input type="number" min={0} step="0.01" value={quoteDiscount} onChange={(e) => setQuoteDiscount(Number(e.target.value))} className="erp-input" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">
            {vatConfig.vatRegistered ? `VAT (${vatConfig.vatRate}%)` : "VAT"}
          </label>
          {vatConfig.vatRegistered ? (
            <p className="erp-input flex items-center bg-erp-subtle text-erp-text">MWK {tax.toLocaleString()}</p>
          ) : (
            <p className="erp-input flex items-center bg-erp-subtle text-erp-muted">Not VAT-registered</p>
          )}
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Valid until</label>
          <input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} className="erp-input" />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">Notes</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="erp-input" rows={2} />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">Terms</label>
        <textarea value={terms} onChange={(e) => setTerms(e.target.value)} className="erp-input" rows={2} />
      </div>

      <div className="rounded border bg-erp-subtle p-4 text-sm">
        <div className="flex justify-between"><span>Subtotal</span><span>MWK {subtotal.toLocaleString()}</span></div>
        <div className="flex justify-between"><span>Discount</span><span>-MWK {quoteDiscount.toLocaleString()}</span></div>
        {vatConfig.vatRegistered && (
          <div className="flex justify-between"><span>VAT</span><span>+MWK {tax.toLocaleString()}</span></div>
        )}
        <div className="mt-1 flex justify-between border-t pt-1 font-semibold"><span>Total</span><span>MWK {total.toLocaleString()}</span></div>
      </div>

      <button
        type="button"
        onClick={handleSubmit}
        disabled={loading}
        className="w-full rounded bg-erp-primary py-2.5 font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
      >
        {loading ? "Saving..." : "Save Quotation"}
      </button>
    </div>
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
