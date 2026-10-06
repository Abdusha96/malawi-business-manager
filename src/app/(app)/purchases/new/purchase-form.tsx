"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PAYMENT_METHODS } from "@/lib/validation";
import { ForeignCurrencyFields } from "../../fx-shared/foreign-currency-fields";

type ProductOption = { id: string; name: string; purchasePrice: number; unit: string; isStocked: boolean; vatCategory: "STANDARD" | "ZERO_RATED" | "EXEMPT" };
type SupplierOption = { id: string; name: string };
type BranchOption = { id: string; name: string };

interface CartLine {
  productId: string;
  quantity: number;
  unitCost: number;
}

export function NewPurchaseForm({
  businessId,
  products,
  suppliers,
  branches = [],
  vatConfig,
}: {
  businessId: string;
  products: ProductOption[];
  suppliers: SupplierOption[];
  branches?: BranchOption[];
  vatConfig: { vatRegistered: boolean; vatRate: number };
}) {
  const router = useRouter();
  const [lines, setLines] = useState<CartLine[]>([]);
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? "");
  const [branchId, setBranchId] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<(typeof PAYMENT_METHODS)[number]>("CASH");
  const [amountPaid, setAmountPaid] = useState<number | "">("");
  const [currency, setCurrency] = useState("");
  const [exchangeRate, setExchangeRate] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const subtotal = useMemo(() => lines.reduce((sum, l) => sum + l.quantity * l.unitCost, 0), [lines]);
  // Module 18 (VAT): preview only – src/lib/purchases.ts::createPurchase
  // recomputes this for real, the same way src/app/sales/new/sale-form.tsx
  // does for Sales.
  const tax = useMemo(() => {
    if (!vatConfig.vatRegistered) return 0;
    return round2(
      lines.reduce((sum, l) => {
        const product = products.find((p) => p.id === l.productId);
        if (!product || product.vatCategory !== "STANDARD") return sum;
        return sum + l.quantity * l.unitCost * (vatConfig.vatRate / 100);
      }, 0)
    );
  }, [lines, products, vatConfig]);
  const total = round2(subtotal + tax);
  const paid = amountPaid === "" ? total : Number(amountPaid);
  const balance = round2(total - paid);

  function addLine() {
    if (products.length === 0) return;
    const first = products[0];
    setLines((prev) => [...prev, { productId: first.id, quantity: 1, unitCost: first.purchasePrice }]);
  }

  function updateLine(index: number, patch: Partial<CartLine>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  function handleProductChange(index: number, productId: string) {
    const product = products.find((p) => p.id === productId);
    updateLine(index, { productId, unitCost: product?.purchasePrice ?? 0 });
  }

  async function handleSubmit() {
    setError(null);

    if (!supplierId) {
      setError("A supplier is required.");
      return;
    }
    if (lines.length === 0) {
      setError("Add at least one product to the purchase.");
      return;
    }

    setLoading(true);

    const res = await fetch(`/api/business/${businessId}/purchases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        supplierId,
        branchId: branchId || null,
        items: lines,
        paymentMethod,
        amountPaid: paid,
        currency: currency || null,
        exchangeRate: currency && exchangeRate !== "" ? Number(exchangeRate) : null,
      }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Could not record purchase.");
      return;
    }

    router.push("/purchases");
    router.refresh();
  }

  if (suppliers.length === 0) {
    return (
      <p className="text-erp-muted">
        You need at least one supplier before recording a purchase.{" "}
        <a href="/suppliers/new" className="text-erp-primary underline">Add one first.</a>
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {error && <p className="rounded bg-erp-danger/10 p-3 text-sm text-erp-danger">{error}</p>}

      <div>
        <label className="mb-1 block text-sm font-medium">Supplier</label>
        <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="erp-input">
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
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
            + Add product
          </button>
        </div>

        {lines.length === 0 ? (
          <p className="text-sm text-erp-muted">No items added yet.</p>
        ) : (
          <div className="space-y-3">
            {lines.map((line, i) => {
              const lineTotal = round2(line.quantity * line.unitCost);
              return (
                <div key={i} className="grid grid-cols-12 items-center gap-2 text-sm">
                  <select
                    value={line.productId}
                    onChange={(e) => handleProductChange(i, e.target.value)}
                    className="erp-input col-span-5"
                  >
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.isStocked ? p.name : `${p.name} (service)`}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={0.001}
                    step="0.001"
                    value={line.quantity}
                    onChange={(e) => updateLine(i, { quantity: Number(e.target.value) })}
                    className="erp-input col-span-2"
                    placeholder="Qty"
                  />
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={line.unitCost}
                    onChange={(e) => updateLine(i, { unitCost: Number(e.target.value) })}
                    className="erp-input col-span-3"
                    placeholder="Unit cost"
                  />
                  <span className="col-span-1 text-right">{lineTotal.toLocaleString()}</span>
                  <button type="button" onClick={() => removeLine(i)} className="col-span-1 text-erp-danger">
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 rounded border bg-erp-surface p-4">
        <div>
          <label className="mb-1 block text-sm font-medium">
            {vatConfig.vatRegistered ? `Input VAT (${vatConfig.vatRate}%)` : "Input VAT"}
          </label>
          {vatConfig.vatRegistered ? (
            <p className="erp-input flex items-center bg-erp-subtle text-erp-text">MWK {tax.toLocaleString()}</p>
          ) : (
            <p className="erp-input flex items-center bg-erp-subtle text-erp-muted">Not VAT-registered</p>
          )}
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Payment method</label>
          <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as any)} className="erp-input">
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>{m.replace("_", " ")}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Amount paid</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={amountPaid}
            onChange={(e) => setAmountPaid(e.target.value === "" ? "" : Number(e.target.value))}
            placeholder={`Full amount (${total.toLocaleString()})`}
            className="erp-input"
          />
        </div>
      </div>

      <ForeignCurrencyFields currency={currency} rate={exchangeRate} onCurrency={setCurrency} onRate={setExchangeRate} total={total} />

      <div className="rounded border bg-erp-subtle p-4 text-sm">
        <div className="flex justify-between"><span>Subtotal</span><span>MWK {subtotal.toLocaleString()}</span></div>
        {vatConfig.vatRegistered && (
          <div className="flex justify-between"><span>Input VAT</span><span>+MWK {tax.toLocaleString()}</span></div>
        )}
        <div className="mt-1 flex justify-between border-t pt-1 font-semibold"><span>Total</span><span>MWK {total.toLocaleString()}</span></div>
        <div className={`flex justify-between ${balance > 0 ? "text-erp-danger" : "text-erp-success"}`}>
          <span>Balance owed to supplier</span><span>MWK {balance.toLocaleString()}</span>
        </div>
      </div>

      <button
        type="button"
        onClick={handleSubmit}
        disabled={loading}
        className="w-full rounded bg-erp-primary py-2.5 font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
      >
        {loading ? "Recording purchase..." : "Complete Purchase"}
      </button>
    </div>
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
