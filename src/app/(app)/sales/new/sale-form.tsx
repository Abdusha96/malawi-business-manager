"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PAYMENT_METHODS } from "@/lib/validation";
import { formatMoney } from "@/lib/erp/format";
import { ForeignCurrencyFields } from "../../fx-shared/foreign-currency-fields";

type ProductOption = { id: string; name: string; sellingPrice: number; quantity: number; isStocked: boolean; unit: string; vatCategory: "STANDARD" | "ZERO_RATED" | "EXEMPT" };
type CustomerOption = { id: string; name: string; creditLimit: number; outstanding: number };
type BranchOption = { id: string; name: string };
type CashAccountOption = { id: string; name: string; type: string };

function accountTypeForMethod(method: string) {
  if (method === "CARD") return "BANK";
  return method;
}

interface CartLine {
  productId: string;
  quantity: number;
  unitPrice: number;
  discount: number;
}

export function NewSaleForm({
  businessId,
  products,
  customers,
  branches = [],
  vatConfig,
  cashAccounts,
}: {
  businessId: string;
  products: ProductOption[];
  customers: CustomerOption[];
  branches?: BranchOption[];
  vatConfig: { vatRegistered: boolean; vatRate: number };
  cashAccounts: CashAccountOption[];
}) {
  const router = useRouter();
  const [lines, setLines] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [saleDiscount, setSaleDiscount] = useState(0);
  const firstAccount = cashAccounts[0];
  const initialMethod = firstAccount?.type === "BANK" ? "BANK" : firstAccount?.type ?? "CASH";
  const [paymentMethod, setPaymentMethod] = useState<(typeof PAYMENT_METHODS)[number]>(initialMethod as (typeof PAYMENT_METHODS)[number]);
  const [cashAccountId, setCashAccountId] = useState(firstAccount?.id ?? "");
  const [amountPaid, setAmountPaid] = useState<number | "">("");
  const [currency, setCurrency] = useState("");
  const [exchangeRate, setExchangeRate] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const subtotal = useMemo(
    () => lines.reduce((sum, l) => sum + (l.quantity * l.unitPrice - l.discount), 0),
    [lines]
  );
  // Module 18 (VAT): a live PREVIEW only, mirroring the same per-line logic
  // src/lib/vat.ts::computeLineVat uses server-side – the server always
  // recomputes this for real from the authoritative product data at save
  // time (see src/lib/sales.ts::createSale), so this can never be trusted
  // as the actual charge, only shown so the cashier isn't surprised by it.
  const tax = useMemo(() => {
    if (!vatConfig.vatRegistered) return 0;
    return round2(
      lines.reduce((sum, l) => {
        const product = products.find((p) => p.id === l.productId);
        if (!product || product.vatCategory !== "STANDARD") return sum;
        const lineTotal = l.quantity * l.unitPrice - l.discount;
        return sum + lineTotal * (vatConfig.vatRate / 100);
      }, 0)
    );
  }, [lines, products, vatConfig]);
  const total = Math.max(0, subtotal - saleDiscount + tax);
  const paid = amountPaid === "" ? total : Number(amountPaid);
  const balance = round2(total - paid);
  const selectedCustomer = customers.find((customer) => customer.id === customerId);
  const projectedOutstanding = (selectedCustomer?.outstanding ?? 0) + Math.max(0, balance);
  const exceedsCreditLimit = !!selectedCustomer && selectedCustomer.creditLimit > 0 && projectedOutstanding > selectedCustomer.creditLimit + 0.01;
  const availablePaymentMethods = cashAccounts.length === 0
    ? PAYMENT_METHODS
    : PAYMENT_METHODS.filter((method) => method === "CREDIT" || cashAccounts.some((account) => account.type === accountTypeForMethod(method)));
  const availableCashAccounts = cashAccounts.filter((account) => account.type === accountTypeForMethod(paymentMethod));

  function changePaymentMethod(method: string) {
    setPaymentMethod(method as (typeof PAYMENT_METHODS)[number]);
    setCashAccountId(cashAccounts.find((account) => account.type === accountTypeForMethod(method))?.id ?? "");
  }

  function addLine() {
    if (products.length === 0) return;
    const first = products[0];
    setLines((prev) => [...prev, { productId: first.id, quantity: 1, unitPrice: first.sellingPrice, discount: 0 }]);
  }

  function updateLine(index: number, patch: Partial<CartLine>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  function handleProductChange(index: number, productId: string) {
    const product = products.find((p) => p.id === productId);
    updateLine(index, { productId, unitPrice: product?.sellingPrice ?? 0 });
  }

  async function handleSubmit() {
    setError(null);

    if (lines.length === 0) {
      setError("Add at least one product to the sale.");
      return;
    }
    if (balance > 0.01 && !customerId) {
      setError("A customer is required for a partial or credit sale.");
      return;
    }

    setLoading(true);

    const res = await fetch(`/api/business/${businessId}/sales`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerId: customerId || null,
        branchId: branchId || null,
        items: lines,
        discount: saleDiscount,
        paymentMethod,
        cashAccountId: cashAccountId || null,
        amountPaid: paid,
        currency: currency || null,
        exchangeRate: currency && exchangeRate !== "" ? Number(exchangeRate) : null,
      }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Could not record sale.");
      return;
    }

    router.push(`/sales/${data.sale.id}/receipt`);
  }

  return (
    <div className="space-y-6">
      {error && <p role="alert" className="rounded bg-erp-danger/10 p-3 text-sm text-erp-danger">{error}</p>}

      <div>
        <label className="mb-1 block text-sm font-medium">Customer (optional for full-payment sales)</label>
        <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} className="erp-input">
          <option value="">Walk-in customer</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        {selectedCustomer && selectedCustomer.creditLimit > 0 && (
          <p aria-live="polite" className={`mt-1 text-xs ${exceedsCreditLimit ? "text-erp-danger" : "text-erp-muted"}`}>
            Current outstanding {formatMoney(selectedCustomer.outstanding)}; after this sale {formatMoney(projectedOutstanding)} of {formatMoney(selectedCustomer.creditLimit)} credit limit.
            {exceedsCreditLimit ? " Collect more payment or adjust the customer’s limit before saving." : ""}
          </p>
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
            + Add product
          </button>
        </div>

        {lines.length === 0 ? (
          <p className="text-sm text-erp-muted">No items added yet.</p>
        ) : (
          <div className="space-y-3">
            {lines.map((line, i) => {
              const product = products.find((p) => p.id === line.productId);
              const lineTotal = round2(line.quantity * line.unitPrice - line.discount);
              return (
                <div key={i} className="grid grid-cols-12 items-center gap-2 text-sm">
                  <select
                    value={line.productId}
                    onChange={(e) => handleProductChange(i, e.target.value)}
                    className="erp-input col-span-4"
                  >
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.isStocked ? `${p.name} (${p.quantity} ${p.unit} left)` : `${p.name} (service)`}
                      </option>
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
                  <button type="button" onClick={() => removeLine(i)} className="col-span-1 text-erp-danger">
                    ✕
                  </button>
                  {product && product.isStocked && line.quantity > product.quantity && (
                    <p className="col-span-12 text-xs text-erp-danger">
                      Only {product.quantity} {product.unit} in stock.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded border bg-erp-surface p-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Sale discount</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={saleDiscount}
            onChange={(e) => setSaleDiscount(Number(e.target.value))}
            className="erp-input"
          />
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
          <label className="mb-1 block text-sm font-medium">Payment method</label>
          <select value={paymentMethod} onChange={(e) => changePaymentMethod(e.target.value)} className="erp-input">
            {availablePaymentMethods.map((m) => (
              <option key={m} value={m}>{m.replace("_", " ")}</option>
            ))}
          </select>
        </div>
        {paymentMethod !== "CREDIT" && cashAccounts.length > 0 && (
          <div>
            <label className="mb-1 block text-sm font-medium">Received into</label>
            <select value={cashAccountId} onChange={(e) => setCashAccountId(e.target.value)} className="erp-input" required>
              {availableCashAccounts.map((account) => (
                <option key={account.id} value={account.id}>{account.name} · {account.type.replace("_", " ")}</option>
              ))}
            </select>
          </div>
        )}
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
        <div className="flex justify-between"><span>Discount</span><span>-MWK {saleDiscount.toLocaleString()}</span></div>
        {vatConfig.vatRegistered && (
          <div className="flex justify-between"><span>VAT</span><span>+MWK {tax.toLocaleString()}</span></div>
        )}
        <div className="mt-1 flex justify-between border-t pt-1 font-semibold"><span>Total</span><span>MWK {total.toLocaleString()}</span></div>
        <div className={`flex justify-between ${balance > 0 ? "text-erp-danger" : "text-erp-success"}`}>
          <span>Balance</span><span>MWK {balance.toLocaleString()}</span>
        </div>
      </div>

      <button
        type="button"
        onClick={handleSubmit}
        disabled={loading}
        className="w-full rounded bg-erp-primary py-2.5 font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
      >
        {loading ? "Recording sale..." : "Complete Sale"}
      </button>
    </div>
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
