"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, PAYMENT_METHODS, WITHHOLDING_TAX_CATEGORIES, WITHHOLDING_TAX_CATEGORY_LABELS } from "@/lib/validation";

export function NewExpenseForm({
  businessId,
  branches = [],
  withholdingTaxRates = [],
}: {
  businessId: string;
  branches?: { id: string; name: string }[];
  // Module 19: passed down from the server component so the client can show
  // a live "tax withheld / net paid" preview without a round trip – see
  // src/app/expenses/new/page.tsx for where this comes from.
  withholdingTaxRates?: { category: (typeof WITHHOLDING_TAX_CATEGORIES)[number]; rate: number }[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [branchId, setBranchId] = useState("");
  const [amount, setAmount] = useState("");
  const [withholdingTaxCategory, setWithholdingTaxCategory] = useState("");

  const preview = useMemo(() => {
    const gross = Number(amount);
    if (!withholdingTaxCategory || !gross) return null;
    const rate = withholdingTaxRates.find((r) => r.category === withholdingTaxCategory)?.rate ?? 0;
    const taxWithheld = Math.round(gross * (rate / 100) * 100) / 100;
    return { rate, taxWithheld, netPaid: Math.round((gross - taxWithheld) * 100) / 100 };
  }, [amount, withholdingTaxCategory, withholdingTaxRates]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(e.currentTarget);
    const payload = {
      category: form.get("category"),
      description: form.get("description"),
      amount: Number(form.get("amount")),
      paymentMethod: form.get("paymentMethod"),
      payee: form.get("payee") || null,
      notes: form.get("notes") || null,
      branchId: branchId || null,
      withholdingTaxCategory: withholdingTaxCategory || null,
      payeeTpin: form.get("payeeTpin") || null,
    };

    const res = await fetch(`/api/business/${businessId}/expenses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Could not save expense.");
      return;
    }

    router.push("/expenses");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <p className="rounded bg-erp-danger/10 p-3 text-sm text-erp-danger">{error}</p>}

      <select name="category" required className="erp-input">
        <option value="">Select category</option>
        {EXPENSE_CATEGORIES.map((c) => (
          <option key={c} value={c}>{EXPENSE_CATEGORY_LABELS[c]}</option>
        ))}
      </select>

      <input name="description" placeholder="Description" required className="erp-input" />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input
          name="amount"
          type="number"
          min="0.01"
          step="0.01"
          placeholder="Amount (MWK)"
          required
          className="erp-input"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <select name="paymentMethod" required className="erp-input">
          {PAYMENT_METHODS.filter((m) => m !== "CREDIT").map((m) => (
            <option key={m} value={m}>{m.replace("_", " ")}</option>
          ))}
        </select>
      </div>

      <input name="payee" placeholder="Supplier/payee (optional)" className="erp-input" />

      <div>
        <label className="mb-1 block text-sm text-erp-muted">Withholding tax (optional)</label>
        <select
          value={withholdingTaxCategory}
          onChange={(e) => setWithholdingTaxCategory(e.target.value)}
          className="erp-input"
        >
          <option value="">Not subject to withholding tax</option>
          {WITHHOLDING_TAX_CATEGORIES.map((c) => (
            <option key={c} value={c}>{WITHHOLDING_TAX_CATEGORY_LABELS[c]}</option>
          ))}
        </select>
      </div>

      {withholdingTaxCategory && (
        <div className="space-y-3 rounded border border-erp-border p-3">
          <input name="payeeTpin" placeholder="Payee TPIN (for their withholding certificate)" className="erp-input" />
          {preview && (
            <div className="rounded bg-erp-subtle p-2 text-sm text-erp-text">
              <div className="flex justify-between"><span>Tax withheld ({preview.rate}%)</span><span>MWK {preview.taxWithheld.toLocaleString()}</span></div>
              <div className="flex justify-between font-medium"><span>Net paid to payee</span><span>MWK {preview.netPaid.toLocaleString()}</span></div>
            </div>
          )}
        </div>
      )}

      <textarea name="notes" placeholder="Notes (optional)" className="erp-input" rows={2} />

      {branches.length > 0 && (
        <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="erp-input">
          <option value="">Not attributed to a branch</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded bg-erp-primary py-2.5 font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
      >
        {loading ? "Saving..." : "Add Expense"}
      </button>
    </form>
  );
}
