"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { computeCreditNote, planSettlement, CreditNoteCalcError } from "@/lib/credit-note-calc";

type ItemOption = {
  id: string;
  productName: string;
  vatCategory: "STANDARD" | "ZERO_RATED" | "EXEMPT";
  unitCost: number;
  isStocked: boolean;
  poolQuantity: number;
  poolNet: number;
  poolVat: number;
};
type CashAccountOption = { id: string; name: string; type: string; balance: number };

type LineState = { include: boolean; quantity: string; useAmount: boolean; amount: string; restock: boolean };

function emptyLine(): LineState {
  return { include: false, quantity: "", useAmount: false, amount: "", restock: false };
}

export function CreditNoteForm({
  businessId,
  saleId,
  sale,
  creditedTotal,
  creditedDiscountShare,
  hasCustomer,
  items,
  cashAccounts,
}: {
  businessId: string;
  saleId: string;
  sale: { subtotal: number; discount: number; total: number; balance: number };
  creditedTotal: number;
  creditedDiscountShare: number;
  hasCustomer: boolean;
  items: ItemOption[];
  cashAccounts: CashAccountOption[];
}) {
  const router = useRouter();
  const [lines, setLines] = useState<Record<string, LineState>>(
    Object.fromEntries(items.map((i) => [i.id, emptyLine()]))
  );
  const [reason, setReason] = useState("");
  const [settlementMethod, setSettlementMethod] = useState<"CASH" | "CUSTOMER_CREDIT">("CASH");
  const [cashAccountId, setCashAccountId] = useState(cashAccounts[0]?.id ?? "");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function updateLine(id: string, patch: Partial<LineState>) {
    setLines((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  // Reuses the exact server-side math (src/lib/credit-note-calc.ts): what this preview shows is what
  // the server will post, because the "items" passed in are already this sale's remaining pools (what
  // earlier credit notes have not yet taken), with no priors of their own – see the design note in
  // src/app/credit-notes/new/page.tsx for why that produces the same figures as the server's own
  // items-plus-priors computation.
  const preview = useMemo(() => {
    const requestLines = items
      .filter((i) => lines[i.id]?.include)
      .map((i) => {
        const l = lines[i.id];
        return {
          saleItemId: i.id,
          quantity: l.useAmount ? 0 : Number(l.quantity || 0),
          netAmount: l.useAmount ? Number(l.amount || 0) : null,
          restock: l.restock,
        };
      });
    if (requestLines.length === 0) return { error: null, calc: null as ReturnType<typeof computeCreditNote> | null };
    try {
      const calc = computeCreditNote({
        sale,
        items: items.map((i) => ({
          id: i.id,
          productName: i.productName,
          quantity: i.poolQuantity,
          total: i.poolNet,
          vatAmount: i.poolVat,
          vatCategory: i.vatCategory,
          unitCost: i.unitCost,
          isStocked: i.isStocked,
        })),
        priors: [],
        priorDiscountShare: creditedDiscountShare,
        priorTotal: creditedTotal,
        lines: requestLines,
      });
      return { error: null, calc };
    } catch (err) {
      return { error: err instanceof CreditNoteCalcError ? err.message : "Could not compute this credit.", calc: null };
    }
  }, [lines, items, sale, creditedDiscountShare, creditedTotal]);

  const settlementPreview = useMemo(() => {
    if (!preview.calc || preview.calc.settledAmount <= 0.005) return null;
    try {
      return planSettlement({
        settledAmount: preview.calc.settledAmount,
        method: settlementMethod,
        hasCustomer,
        cashAccountId,
      });
    } catch (err) {
      return { error: err instanceof CreditNoteCalcError ? err.message : "Choose a settlement method." };
    }
  }, [preview.calc, settlementMethod, hasCustomer, cashAccountId]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitError(null);

    if (!reason.trim()) {
      setSubmitError("A reason is required.");
      return;
    }
    if (!preview.calc) {
      setSubmitError(preview.error ?? "Select at least one line to credit.");
      return;
    }
    if (preview.calc.settledAmount > 0.005 && (!settlementPreview || "error" in settlementPreview)) {
      setSubmitError(
        settlementPreview && "error" in settlementPreview ? settlementPreview.error : "Choose how to settle the refunded amount."
      );
      return;
    }

    const requestLines = items
      .filter((i) => lines[i.id]?.include)
      .map((i) => {
        const l = lines[i.id];
        return {
          saleItemId: i.id,
          quantity: l.useAmount ? 0 : Number(l.quantity || 0),
          netAmount: l.useAmount ? Number(l.amount || 0) : null,
          restock: l.restock,
        };
      });

    setLoading(true);
    const res = await fetch(`/api/business/${businessId}/credit-notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        saleId,
        reason,
        lines: requestLines,
        settlementMethod: preview.calc.settledAmount > 0.005 ? settlementMethod : null,
        cashAccountId: preview.calc.settledAmount > 0.005 && settlementMethod === "CASH" ? cashAccountId : null,
      }),
    });
    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setSubmitError(data.message ?? "Could not issue this credit note.");
      return;
    }

    router.push(`/credit-notes/${data.creditNote.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="overflow-hidden rounded border bg-erp-surface">
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead className="bg-erp-subtle text-left">
            <tr>
              <th className="p-2"></th>
              <th className="p-2">Item</th>
              <th className="p-2 text-right">Left to credit</th>
              <th className="p-2">Quantity or amount</th>
              <th className="p-2">Restock</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const line = lines[item.id];
              const nothingLeft = item.poolQuantity <= 0.0005 && item.poolNet <= 0.005;
              return (
                <tr key={item.id} className="border-t align-top">
                  <td className="p-2">
                    <input
                      type="checkbox"
                      checked={line.include}
                      disabled={nothingLeft}
                      onChange={(e) => updateLine(item.id, { include: e.target.checked })}
                    />
                  </td>
                  <td className="p-2">{item.productName}</td>
                  <td className="p-2 text-right text-erp-muted">
                    {nothingLeft ? "fully credited" : `${item.poolQuantity} units / MWK ${item.poolNet.toLocaleString()}`}
                  </td>
                  <td className="p-2">
                    {line.include && (
                      <div className="space-y-1">
                        <label className="flex items-center gap-1 text-xs text-erp-muted">
                          <input
                            type="checkbox"
                            checked={line.useAmount}
                            onChange={(e) => updateLine(item.id, { useAmount: e.target.checked })}
                          />
                          price adjustment instead of a quantity
                        </label>
                        {line.useAmount ? (
                          <input
                            type="number"
                            min="0.01"
                            step="0.01"
                            placeholder="Amount (MWK, before VAT)"
                            value={line.amount}
                            onChange={(e) => updateLine(item.id, { amount: e.target.value })}
                            className="erp-input"
                          />
                        ) : (
                          <input
                            type="number"
                            min="0"
                            max={item.poolQuantity}
                            step="0.001"
                            placeholder="Quantity"
                            value={line.quantity}
                            onChange={(e) => updateLine(item.id, { quantity: e.target.value })}
                            className="erp-input"
                          />
                        )}
                      </div>
                    )}
                  </td>
                  <td className="p-2">
                    {line.include && !line.useAmount && item.isStocked && (
                      <input
                        type="checkbox"
                        checked={line.restock}
                        onChange={(e) => updateLine(item.id, { restock: e.target.checked })}
                        title="Goods go back on the shelf"
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </div>

      {preview.error && <p className="rounded bg-erp-danger/10 p-2 text-xs text-erp-danger">{preview.error}</p>}

      {preview.calc && (
        <div className="space-y-1 rounded border bg-erp-subtle p-4 text-sm">
          <div className="flex justify-between"><span>Net</span><span>MWK {preview.calc.netAmount.toLocaleString()}</span></div>
          {preview.calc.discountShare > 0 && (
            <div className="flex justify-between text-erp-muted"><span>Discount share returned</span><span>-MWK {preview.calc.discountShare.toLocaleString()}</span></div>
          )}
          <div className="flex justify-between"><span>VAT</span><span>MWK {preview.calc.vatAmount.toLocaleString()}</span></div>
          <div className="flex justify-between border-t pt-1 font-semibold"><span>Total credit</span><span>MWK {preview.calc.total.toLocaleString()}</span></div>
          <div className="flex justify-between text-erp-muted"><span>Applied to balance owed</span><span>MWK {preview.calc.appliedToBalance.toLocaleString()}</span></div>
          {preview.calc.settledAmount > 0.005 && (
            <div className="flex justify-between text-erp-muted"><span>Already paid – needs settling</span><span>MWK {preview.calc.settledAmount.toLocaleString()}</span></div>
          )}
        </div>
      )}

      {preview.calc && preview.calc.settledAmount > 0.005 && (
        <div className="space-y-2 rounded border bg-erp-surface p-4 text-sm">
          <p className="text-xs text-erp-muted">
            The customer already paid part of what this credit covers. Choose what happens to that money.
          </p>
          <select
            value={settlementMethod}
            onChange={(e) => setSettlementMethod(e.target.value as typeof settlementMethod)}
            className="erp-input"
          >
            <option value="CASH">Refund in cash</option>
            <option value="CUSTOMER_CREDIT" disabled={!hasCustomer}>
              Keep as customer credit{!hasCustomer ? " (no customer on a walk-in sale)" : ""}
            </option>
          </select>
          {settlementMethod === "CASH" && (
            <>
              {cashAccounts.length === 0 ? (
                <p className="text-xs text-erp-danger">No active cash accounts found – set one up in Cashbook first.</p>
              ) : (
                <select value={cashAccountId} onChange={(e) => setCashAccountId(e.target.value)} className="erp-input">
                  {cashAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.type.replace("_", " ")}) – MWK {a.balance.toLocaleString()}
                    </option>
                  ))}
                </select>
              )}
            </>
          )}
          {settlementPreview && "error" in settlementPreview && (
            <p className="text-xs text-erp-danger">{settlementPreview.error}</p>
          )}
        </div>
      )}

      <div>
        <label className="mb-1 block text-xs font-medium text-erp-muted">Reason</label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="erp-input"
          rows={2}
          placeholder="Why is this credit note being issued?"
          required
        />
      </div>

      {submitError && <p className="rounded bg-erp-danger/10 p-2 text-xs text-erp-danger">{submitError}</p>}

      <button
        type="submit"
        disabled={loading || !preview.calc}
        className="w-full rounded bg-erp-primary py-2 text-sm font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
      >
        {loading ? "Issuing..." : "Issue Credit Note"}
      </button>
    </form>
  );
}
