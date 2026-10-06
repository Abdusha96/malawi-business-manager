"use client";

import { useEffect, useState } from "react";
import { WITHHOLDING_TAX_CATEGORIES, WITHHOLDING_TAX_CATEGORY_LABELS } from "@/lib/validation";

interface Band {
  min: number;
  max: number | null;
  rate: number;
}

interface WithholdingRate {
  category: (typeof WITHHOLDING_TAX_CATEGORIES)[number];
  rate: number;
}

export function TaxSettingsForm({ businessId }: { businessId: string }) {
  const [bands, setBands] = useState<Band[]>([]);
  const [pensionEmployeeRate, setPensionEmployeeRate] = useState(0);
  const [pensionEmployerRate, setPensionEmployerRate] = useState(0);
  const [vatRegistered, setVatRegistered] = useState(false);
  const [vatNumber, setVatNumber] = useState("");
  const [vatStandardRate, setVatStandardRate] = useState(16.5);
  const [withholdingTaxRates, setWithholdingTaxRates] = useState<WithholdingRate[]>(
    WITHHOLDING_TAX_CATEGORIES.map((category) => ({ category, rate: 0 }))
  );
  const [corporateTaxRate, setCorporateTaxRate] = useState(30);
  const [vatPartialExemptionEnabled, setVatPartialExemptionEnabled] = useState(true);
  const [vatDeMinimisPercent, setVatDeMinimisPercent] = useState(0);
  const [financialYearStartMonth, setFinancialYearStartMonth] = useState(1);
  const [isExample, setIsExample] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch(`/api/business/${businessId}/tax-configuration`)
      .then((res) => res.json())
      .then((data) => {
        setBands(data.config.payeBands);
        setPensionEmployeeRate(Number(data.config.pensionEmployeeRate));
        setPensionEmployerRate(Number(data.config.pensionEmployerRate));
        setVatStandardRate(Number(data.config.vatStandardRate));
        setVatRegistered(data.business.vatRegistered);
        setVatNumber(data.business.vatNumber ?? "");
        // Module 19: fall back to 0 for any category the stored config
        // doesn't have yet (an older, pre-Module-19 config, before the
        // lazy backfill in getOrCreateTaxConfiguration ran) – same
        // defensive merge the server-side route does on save.
        const stored: WithholdingRate[] = data.config.withholdingTaxRates ?? [];
        setWithholdingTaxRates(
          WITHHOLDING_TAX_CATEGORIES.map((category) => ({
            category,
            rate: stored.find((r) => r.category === category)?.rate ?? 0,
          }))
        );
        // Module 20 (Corporate Tax & Tax Calendar)
        setCorporateTaxRate(Number(data.config.corporateTaxRate));
        // Module 45 (VAT Partial Exemption) – fall back to the same defaults the
        // schema column carries, for a config row saved before this module.
        setVatPartialExemptionEnabled(data.config.vatPartialExemptionEnabled ?? true);
        setVatDeMinimisPercent(Number(data.config.vatDeMinimisPercent ?? 0));
        setFinancialYearStartMonth(data.business.financialYearStartMonth);
        setIsExample(data.config.isExample);
        setLoading(false);
      });
  }, [businessId]);

  function updateBand(index: number, patch: Partial<Band>) {
    setBands((prev) => prev.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  }

  function addBand() {
    const lastMax = bands[bands.length - 1]?.max ?? 0;
    setBands((prev) => [...prev, { min: lastMax ?? 0, max: null, rate: 0 }]);
  }

  function removeBand(index: number) {
    setBands((prev) => prev.filter((_, i) => i !== index));
  }

  function updateWithholdingRate(category: WithholdingRate["category"], rate: number) {
    setWithholdingTaxRates((prev) => prev.map((r) => (r.category === category ? { ...r, rate } : r)));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);

    const res = await fetch(`/api/business/${businessId}/tax-configuration`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payeBands: bands,
        pensionEmployeeRate,
        pensionEmployerRate,
        vatRegistered,
        vatNumber: vatNumber || null,
        vatStandardRate,
        withholdingTaxRates,
        corporateTaxRate,
        financialYearStartMonth,
        vatPartialExemptionEnabled,
        vatDeMinimisPercent,
      }),
    });

    const data = await res.json();
    setSaving(false);

    if (!res.ok) {
      setError(data.message ?? "Could not save tax configuration.");
      return;
    }

    setIsExample(false);
    setSaved(true);
  }

  if (loading) return <p className="text-sm text-erp-muted">Loading...</p>;

  return (
    <div>
      <div className="mb-6 rounded border border-erp-warning/40 bg-erp-warning/10 p-4 text-sm text-erp-text">
        <strong>Important:</strong> These figures are estimates you configure – not official tax advice. Confirm
        current PAYE bands, pension rates, the standard VAT rate, and withholding tax rates with the Malawi
        Revenue Authority (or your accountant) before relying on them for real payroll, invoicing, or expense
        payments.
        {isExample && (
          <p className="mt-2 font-medium">
            This business is currently using placeholder EXAMPLE rates. Review and save below to confirm them.
          </p>
        )}
      </div>

      {error && <p className="mb-4 rounded border border-erp-danger/40 bg-erp-danger/10 p-3 text-sm text-erp-danger">{error}</p>}
      {saved && <p className="mb-4 rounded border border-erp-success/40 bg-erp-success/10 p-3 text-sm text-erp-success">Tax configuration saved.</p>}

      <h2 className="mb-2 font-semibold">PAYE Bands</h2>
      <div className="mb-4 space-y-2">
        {bands.map((band, i) => (
          <div key={i} className="grid grid-cols-2 items-center gap-2 text-sm sm:grid-cols-12">
            <input
              type="number"
              value={band.min}
              onChange={(e) => updateBand(i, { min: Number(e.target.value) })}
              className="erp-input sm:col-span-3"
              placeholder="Min"
            />
            <span className="hidden text-center text-erp-muted sm:col-span-1 sm:block">to</span>
            <input
              type="number"
              value={band.max ?? ""}
              onChange={(e) => updateBand(i, { max: e.target.value === "" ? null : Number(e.target.value) })}
              className="erp-input sm:col-span-3"
              placeholder="Max (blank = no limit)"
            />
            <div className="flex items-center gap-1 sm:col-span-3">
              <input
                type="number"
                value={band.rate}
                onChange={(e) => updateBand(i, { rate: Number(e.target.value) })}
                className="erp-input"
                placeholder="Rate"
              />
              <span className="text-erp-muted">%</span>
            </div>
            <button onClick={() => removeBand(i)} className="justify-self-start py-1 text-erp-danger sm:col-span-2">Remove</button>
          </div>
        ))}
      </div>
      <button onClick={addBand} className="mb-6 text-sm text-erp-primary underline">+ Add band</button>

      <h2 className="mb-2 font-semibold">Value-Added Tax (VAT)</h2>
      <p className="mb-3 text-sm text-erp-muted">
        Off by default – most small businesses fall under the MRA VAT registration turnover threshold. Turning this
        on makes Sales, Purchases, and Quotations start calculating VAT automatically, based on each product's VAT
        category (set on the product itself).
      </p>
      <div className="mb-6 space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={vatRegistered} onChange={(e) => setVatRegistered(e.target.checked)} />
          This business is VAT-registered
        </label>
        {vatRegistered && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded border border-erp-border p-3">
            <div>
              <label className="mb-1 block text-sm">VAT registration number</label>
              <input
                type="text"
                value={vatNumber}
                onChange={(e) => setVatNumber(e.target.value)}
                className="erp-input"
                placeholder="e.g. VAT-000000"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm">Standard VAT rate (%)</label>
              <input
                type="number"
                step="0.1"
                value={vatStandardRate}
                onChange={(e) => setVatStandardRate(Number(e.target.value))}
                className="erp-input"
              />
            </div>
            <div className="col-span-2 border-t border-erp-border pt-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={vatPartialExemptionEnabled}
                  onChange={(e) => setVatPartialExemptionEnabled(e.target.checked)}
                />
                Restrict erp-input VAT recovery for exempt sales (partial exemption)
              </label>
              <p className="mt-1 text-xs text-erp-muted">
                If this business also makes EXEMPT sales, MRA rules generally restrict how much erp-input VAT it can
                reclaim. When on, the VAT Return apportions a period&apos;s erp-input VAT by that period&apos;s taxable-vs-exempt
                sales mix. This is a simplified working method, not a substitute for advice on your specific supply
                mix – turn it off if you&apos;ve determined it doesn&apos;t apply to this business.
              </p>
              {vatPartialExemptionEnabled && (
                <div className="mt-2 max-w-xs">
                  <label className="mb-1 block text-sm">De minimis threshold (%)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={vatDeMinimisPercent}
                    onChange={(e) => setVatDeMinimisPercent(Number(e.target.value))}
                    className="erp-input"
                  />
                  <p className="mt-1 text-xs text-erp-muted">
                    A period where exempt sales are at or below this share of total sales keeps full erp-input VAT
                    recovery – no restriction for occasional or trivial exempt sales.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <h2 className="mb-2 font-semibold">Withholding Tax</h2>
      <p className="mb-3 text-sm text-erp-muted">
        Applies to specific Expense payment types – rent, commission, professional fees, contractor fees, casual
        labour, and public entertainment fees. When you record one of these as an Expense and pick the matching
        payment type, this rate is deducted from the payment automatically and held for the MRA instead of paid
        to the payee.
      </p>
      <div className="mb-6 space-y-2 rounded border border-erp-border p-3">
        {withholdingTaxRates.map((r) => (
          <div key={r.category} className="grid grid-cols-12 items-center gap-2 text-sm">
            <span className="col-span-8">{WITHHOLDING_TAX_CATEGORY_LABELS[r.category]}</span>
            <div className="col-span-4 flex items-center gap-1">
              <input
                type="number"
                step="0.1"
                value={r.rate}
                onChange={(e) => updateWithholdingRate(r.category, Number(e.target.value))}
                className="erp-input"
              />
              <span className="text-erp-muted">%</span>
            </div>
          </div>
        ))}
      </div>

      <h2 className="mb-2 font-semibold">Corporate (Company Income) Tax</h2>
      <p className="mb-3 text-sm text-erp-muted">
        Used for the Corporate Tax and Tax Calendar tabs on the Accounting page – a working estimate applied to your
        accounting Profit &amp; Loss, not an official computation with add-backs or capital allowances. Fiscal Year
        Start also drives when quarterly provisional tax installments and your annual income tax deadline fall.
      </p>
      <div className="mb-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-sm">Corporate tax rate (%)</label>
          <input
            type="number"
            step="0.1"
            value={corporateTaxRate}
            onChange={(e) => setCorporateTaxRate(Number(e.target.value))}
            className="erp-input"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm">Fiscal year start month</label>
          <select
            value={financialYearStartMonth}
            onChange={(e) => setFinancialYearStartMonth(Number(e.target.value))}
            className="erp-input"
          >
            {[
              "January", "February", "March", "April", "May", "June",
              "July", "August", "September", "October", "November", "December",
            ].map((name, i) => (
              <option key={name} value={i + 1}>{name}</option>
            ))}
          </select>
        </div>
      </div>

      <h2 className="mb-2 font-semibold">Pension Contributions</h2>
      <div className="mb-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-sm">Employee rate (%)</label>
          <input
            type="number"
            value={pensionEmployeeRate}
            onChange={(e) => setPensionEmployeeRate(Number(e.target.value))}
            className="erp-input"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm">Employer rate (%)</label>
          <input
            type="number"
            value={pensionEmployerRate}
            onChange={(e) => setPensionEmployerRate(Number(e.target.value))}
            className="erp-input"
          />
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="rounded bg-erp-primary px-5 py-2 font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
      >
        {saving ? "Saving..." : "Save Tax Configuration"}
      </button>
    </div>
  );
}
