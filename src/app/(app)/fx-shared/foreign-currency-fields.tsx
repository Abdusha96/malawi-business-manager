"use client";

/**
 * Module 40 – optional "this document is in a foreign currency" block for the
 * new-sale / new-purchase forms. Prices stay in kwacha; this only records the
 * currency and the BOOK rate (kwacha per 1 unit) and shows the foreign total as
 * a preview. Server (createSale/createPurchase) validates and stores it.
 */
export function ForeignCurrencyFields({
  currency,
  rate,
  onCurrency,
  onRate,
  total,
  businessCurrency = "MWK",
}: {
  currency: string;
  rate: number | "";
  onCurrency: (v: string) => void;
  onRate: (v: number | "") => void;
  total: number;
  businessCurrency?: string;
}) {
  const foreignTotal = currency && rate !== "" && Number(rate) > 0 ? Math.round((total / Number(rate)) * 100) / 100 : null;
  return (
    <div className="rounded border bg-erp-surface p-4 text-sm">
      <p className="mb-2 font-medium">Foreign currency (optional)</p>
      <p className="mb-3 text-xs text-erp-muted">
        Only if this is agreed in another currency. Prices above stay in {businessCurrency}; the rate is what the
        document is booked at, and later payments are measured against it to work out any exchange gain or loss.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input
          value={currency}
          onChange={(e) => onCurrency(e.target.value.toUpperCase().slice(0, 3))}
          placeholder="Currency, e.g. USD"
          className="erp-input"
        />
        <input
          type="number"
          min="0"
          step="0.0001"
          value={rate}
          onChange={(e) => onRate(e.target.value === "" ? "" : Number(e.target.value))}
          placeholder={`${businessCurrency} per 1 ${currency || "unit"}`}
          className="erp-input"
        />
      </div>
      {foreignTotal !== null && (
        <p className="mt-2 text-erp-muted">
          Total in {currency}: <span className="font-medium">{foreignTotal.toLocaleString()}</span>
        </p>
      )}
    </div>
  );
}
