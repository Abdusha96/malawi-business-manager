"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PAYMENT_METHODS } from "@/lib/validation";
import { resolveLineMapping } from "@/lib/quotation-line-mapping";

type FreeTextItem = { id: string; description: string; quantity: number; unitPrice: number };
type PickableProduct = { id: string; name: string; sku: string | null; sellingPrice: number };

const NEXT_STATUSES: Record<string, string[]> = {
  DRAFT: ["SENT", "DECLINED"],
  SENT: ["ACCEPTED", "DECLINED", "EXPIRED"],
  ACCEPTED: ["DECLINED", "EXPIRED"],
  DECLINED: ["DRAFT"],
  EXPIRED: ["DRAFT"],
};

export function QuotationActions({
  businessId,
  quotationId,
  status,
  total,
  hasCustomer,
  freeTextItems,
  products,
  canManage,
  canConvert,
}: {
  businessId: string;
  quotationId: string;
  status: string;
  total: number;
  hasCustomer: boolean;
  freeTextItems: FreeTextItem[];
  products: PickableProduct[];
  canManage: boolean;
  canConvert: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConvertForm, setShowConvertForm] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<(typeof PAYMENT_METHODS)[number]>("CASH");
  const [amountPaid, setAmountPaid] = useState<number | "">("");
  // Module 68: the product chosen for each free-text line, by quotation line id.
  const [chosen, setChosen] = useState<Record<string, string>>({});

  // The same pure resolver the server runs, so the button is only enabled for
  // a choice the server will accept (it still re-checks everything).
  const lineProducts = freeTextItems.filter((i) => chosen[i.id]).map((i) => ({ itemId: i.id, productId: chosen[i.id] }));
  const mapping = resolveLineMapping(
    freeTextItems.map((i) => ({ id: i.id, productId: null, description: i.description })),
    lineProducts
  );
  // Nothing to link (every line already has a product) is always ready; the
  // resolver would call an empty list "no items", which is not the case here.
  const linesReady = freeTextItems.length === 0 || mapping.ok;
  const noProductsToChoose = freeTextItems.length > 0 && products.length === 0;

  async function changeStatus(next: string) {
    setError(null);
    setLoading(true);
    const res = await fetch(`/api/business/${businessId}/quotations/${quotationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    setLoading(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.message ?? "Could not update status.");
      return;
    }
    router.refresh();
  }

  async function convert() {
    setError(null);
    setLoading(true);
    const paid = amountPaid === "" ? total : Number(amountPaid);
    const res = await fetch(`/api/business/${businessId}/quotations/${quotationId}/convert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentMethod, amountPaid: paid, ...(lineProducts.length > 0 ? { lineProducts } : {}) }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.message ?? "Could not convert this quotation.");
      return;
    }
    router.push(`/sales/${data.sale.id}/receipt`);
  }

  const nextStatuses = NEXT_STATUSES[status] ?? [];

  return (
    <div className="space-y-3 rounded border bg-erp-surface p-4">
      {error && <p className="rounded bg-erp-danger/10 p-3 text-sm text-erp-danger">{error}</p>}

      {canManage && nextStatuses.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium">Change status</p>
          <div className="flex flex-wrap gap-2">
            {nextStatuses.map((s) => (
              <button
                key={s}
                type="button"
                disabled={loading}
                onClick={() => changeStatus(s)}
                className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle disabled:opacity-60"
              >
                Mark {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {canConvert && (
        <div className="border-t pt-3">
          {noProductsToChoose ? (
            <p className="text-sm text-erp-warning">
              One or more items aren&apos;t linked to a real product, and there are no active products to link them to. Add the
              item to your inventory (or edit the quotation) before converting to a sale.
            </p>
          ) : !showConvertForm ? (
            <button
              type="button"
              onClick={() => setShowConvertForm(true)}
              className="rounded bg-erp-primary px-4 py-2 text-sm text-erp-primary-fg hover:opacity-90"
            >
              Convert to Sale
            </button>
          ) : (
            <div className="space-y-3">
              {freeTextItems.length > 0 && (
                <div className="rounded border border-erp-warning/40 bg-erp-warning/10 p-3">
                  <p className="mb-2 text-sm font-medium text-erp-warning">
                    Choose the product each of these items should be sold as
                  </p>
                  <p className="mb-2 text-xs text-erp-warning">
                    These lines aren&apos;t in your inventory. The sale takes stock from the product you pick, at the price
                    quoted. The choice is saved on the quotation.
                  </p>
                  <div className="space-y-2">
                    {freeTextItems.map((item) => (
                      <div key={item.id}>
                        <label className="mb-1 block text-xs font-medium">
                          {item.description} <span className="text-erp-muted">({item.quantity} x {item.unitPrice.toLocaleString()})</span>
                        </label>
                        <select
                          value={chosen[item.id] ?? ""}
                          onChange={(e) => setChosen((prev) => ({ ...prev, [item.id]: e.target.value }))}
                          className="erp-input"
                        >
                          <option value="">Choose a product...</option>
                          {products.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}{p.sku ? ` (${p.sku})` : ""} - {p.sellingPrice.toLocaleString()}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <label className="mb-1 block text-sm font-medium">Payment method</label>
                <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as any)} className="erp-input">
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>{m.replace("_", " ")}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Amount paid now</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={amountPaid}
                  onChange={(e) => setAmountPaid(e.target.value === "" ? "" : Number(e.target.value))}
                  placeholder={`Full amount (${total.toLocaleString()})`}
                  className="erp-input"
                />
                {!hasCustomer && (
                  <p className="mt-1 text-xs text-erp-warning">
                    No tracked customer on this quotation – a partial payment will need one added first.
                  </p>
                )}
              </div>
              <button
                type="button"
                disabled={loading || !linesReady}
                onClick={convert}
                className="w-full rounded bg-erp-primary py-2 text-sm font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
              >
                {loading ? "Converting..." : "Complete Sale"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
