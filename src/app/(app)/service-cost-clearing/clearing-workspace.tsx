"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface ClearingRowView {
  productId: string;
  name: string;
  sku: string | null;
  /** Supplier bills less debit notes, net of VAT. */
  billed: number;
  /** Cost taken on sales. */
  recognised: number;
  /** Net of settlements: positive = more cost recognised, negative = less. */
  settled: number;
  /** Debit positive. */
  balance: number;
  /** Whole days since the balance was last touched; null = unknown. */
  ageDays: number | null;
  /** Leftover is at least K1.00 and older than the business's alert threshold. */
  aged: boolean;
  state: "SETTLED" | "BILLED_NOT_SOLD" | "SOLD_NOT_BILLED";
  stateLabel: string;
}

export interface SettlementView {
  id: string;
  productName: string;
  summary: string;
  amount: number;
  reason: string;
  status: "RECORDED" | "VOIDED";
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
}

function fmt(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Debit balance reads "Dr", credit balance "Cr", so nobody has to remember a sign convention. */
function fmtBalance(n: number) {
  if (Math.abs(n) < 0.005) return "0.00";
  return `${fmt(Math.abs(n))} ${n > 0 ? "Dr" : "Cr"}`;
}

export function ClearingWorkspace(props: {
  businessId: string;
  rows: ClearingRowView[];
  settlements: SettlementView[];
  ledgerBalance: number;
  unattributed: number;
  unattributedKind: "NONE" | "ROUNDING" | "REVIEW";
  unattributedNote: string | null;
  openCount: number;
  agedCount: number;
  alertDays: number;
  canSettle: boolean;
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [voidId, setVoidId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState("");

  // Module 80 - bulk settle. `selected` holds product ids; the leftover each row showed is what gets sent as
  // `expectedBalance`, so the server can refuse a service whose balance moved after the page loaded.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkReason, setBulkReason] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<{
    settledCount: number;
    skippedCount: number;
    totalSettled: number;
    results: { productId: string; name: string; status: "SETTLED" | "SKIPPED"; amount?: number; message?: string }[];
  } | null>(null);

  const openRows = props.rows.filter((r) => r.state !== "SETTLED");
  const selectedRows = openRows.filter((r) => selected.has(r.productId));
  const selectedNet = selectedRows.reduce((sum, r) => sum + r.balance, 0);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setBulkResult(null);
  }
  function selectWhere(pred: (r: ClearingRowView) => boolean) {
    setSelected(new Set(openRows.filter(pred).map((r) => r.productId)));
    setBulkResult(null);
  }

  async function submitBulk(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBulkError(null);
    setBulkLoading(true);
    const res = await fetch(`/api/business/${props.businessId}/service-cost-clearing/bulk-settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: bulkReason,
        items: selectedRows.map((r) => ({ productId: r.productId, expectedBalance: r.balance })),
      }),
    });
    const data = await res.json();
    setBulkLoading(false);
    if (!res.ok) {
      setBulkError(data.message ?? data.details?.fieldErrors?.reason?.[0] ?? "Could not settle these services.");
      return;
    }
    setBulkResult(data);
    setBulkOpen(false);
    setBulkReason("");
    setSelected(new Set());
    router.refresh();
  }

  function openSettle(id: string) {
    setOpenId(id);
    setAmount("");
    setReason("");
    setError(null);
  }

  async function submitSettle(e: React.FormEvent<HTMLFormElement>, productId: string) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    // Module 80: send the leftover the row showed so a balance that moved since page load is refused, not settled.
    const shown = props.rows.find((r) => r.productId === productId);
    const body: { productId: string; reason: string; amount?: number; expectedBalance?: number } = { productId, reason };
    if (shown) body.expectedBalance = shown.balance;
    if (amount.trim() !== "") {
      const n = Number(amount);
      if (!Number.isFinite(n)) {
        setLoading(false);
        setError("Enter the amount as a number, or leave it empty to settle everything left over.");
        return;
      }
      body.amount = n;
    }
    const res = await fetch(`/api/business/${props.businessId}/service-cost-clearing/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.message ?? "Could not settle this service.");
      return;
    }
    setOpenId(null);
    router.refresh();
  }

  async function submitVoid(e: React.FormEvent<HTMLFormElement>, settlementId: string) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await fetch(`/api/business/${props.businessId}/service-cost-clearing/settlements/${settlementId}/void`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: voidReason }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.message ?? "Could not void this settlement.");
      return;
    }
    setVoidId(null);
    setVoidReason("");
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-xs text-erp-warning">
        When a service is sold, its cost is credited here. When the supplier's bill is recorded, it is debited here. The two
        rarely match exactly, and a gap is normal while work is still in progress: a bill that has arrived before the job is
        sold shows as <strong>Dr</strong>, a job sold before its bill arrives shows as <strong>Cr</strong>. Settle a service only
        when you know the difference is final. Settling moves it to Cost of Goods Sold; it can be voided if you were wrong.
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded border bg-erp-surface p-4">
          <p className="text-xs text-erp-muted">Account 1210 holds</p>
          <p className="text-xl font-semibold">{fmtBalance(props.ledgerBalance)}</p>
        </div>
        <div className="rounded border bg-erp-surface p-4">
          <p className="text-xs text-erp-muted">Services with something left over</p>
          <p className="text-xl font-semibold">{props.openCount}</p>
        </div>
        <div className="rounded border bg-erp-surface p-4">
          <p className="text-xs text-erp-muted">Left over for {props.alertDays}+ days</p>
          <p className={`text-xl font-semibold ${props.agedCount > 0 ? "text-erp-warning" : ""}`}>{props.agedCount}</p>
        </div>
        <div className="rounded border bg-erp-surface p-4">
          <p className="text-xs text-erp-muted">Not explained by the services below</p>
          <p className={`text-xl font-semibold ${props.unattributedKind === "REVIEW" ? "text-erp-danger" : ""}`}>{fmtBalance(props.unattributed)}</p>
        </div>
      </div>

      {props.unattributedNote && (
        <p className={`rounded border p-3 text-xs ${props.unattributedKind === "REVIEW" ? "border-erp-danger/40 bg-erp-danger/10 text-erp-danger" : "border-erp-border bg-erp-subtle text-erp-text"}`}>
          {props.unattributedNote}
        </p>
      )}

      {error && openId === null && voidId === null && <p className="rounded bg-erp-danger/10 p-2 text-sm text-erp-danger">{error}</p>}

      {bulkResult && (
        <div className="rounded border border-erp-border bg-erp-surface p-3 text-sm">
          <p className="font-medium">
            {bulkResult.settledCount} settled ({fmt(bulkResult.totalSettled)} moved to Cost of Goods Sold or back), {bulkResult.skippedCount} skipped.
          </p>
          {bulkResult.results.some((r) => r.status === "SKIPPED") && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-erp-warning">
              {bulkResult.results
                .filter((r) => r.status === "SKIPPED")
                .map((r) => (
                  <li key={r.productId}>
                    <strong>{r.name}</strong>: {r.message}
                  </li>
                ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-erp-muted">Each settled service appears below as its own settlement and can be voided on its own.</p>
        </div>
      )}

      {props.canSettle && openRows.length > 0 && (
        <div className="rounded border border-erp-border bg-erp-subtle p-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-erp-muted">Settle several at once:</span>
            <button type="button" onClick={() => selectWhere((r) => r.aged)} disabled={props.agedCount === 0} className="text-xs text-erp-primary underline disabled:text-erp-muted disabled:no-underline">
              Select aged ({props.agedCount})
            </button>
            <button type="button" onClick={() => selectWhere(() => true)} className="text-xs text-erp-primary underline">Select all ({openRows.length})</button>
            <button type="button" onClick={() => { setSelected(new Set()); setBulkOpen(false); }} disabled={selected.size === 0} className="text-xs text-erp-muted underline disabled:text-erp-muted disabled:no-underline">Clear</button>
            {selectedRows.length > 0 && !bulkOpen && (
              <button type="button" onClick={() => { setBulkOpen(true); setBulkError(null); }} className="ml-auto rounded bg-erp-primary px-3 py-1.5 text-erp-primary-fg hover:opacity-90">
                Settle {selectedRows.length} selected...
              </button>
            )}
          </div>
          {bulkOpen && selectedRows.length > 0 && (
            <form onSubmit={submitBulk} className="mt-3 space-y-3">
              <p className="text-xs text-erp-muted">
                This clears the <strong>whole</strong> leftover of {selectedRows.length} service{selectedRows.length === 1 ? "" : "s"} (net {fmtBalance(selectedNet)}),
                each as its own settlement with the reason below. A service whose leftover has changed since this page loaded is skipped, not settled.
                Use the single Settle on a row if you only want part of a balance.
              </p>
              {bulkError && <p className="rounded bg-erp-danger/10 p-2 text-erp-danger">{bulkError}</p>}
              <input
                value={bulkReason}
                onChange={(e) => setBulkReason(e.target.value)}
                className="erp-input w-full"
                placeholder="Reason for all of them, e.g. Supplier bills are final"
                maxLength={200}
                required
              />
              <div className="flex gap-3">
                <button type="submit" disabled={bulkLoading} className="rounded bg-erp-primary px-4 py-2 text-erp-primary-fg hover:opacity-90 disabled:opacity-60">
                  {bulkLoading ? "Settling..." : `Settle ${selectedRows.length}`}
                </button>
                <button type="button" onClick={() => setBulkOpen(false)} className="text-erp-muted underline">Cancel</button>
              </div>
            </form>
          )}
        </div>
      )}

      {props.rows.length === 0 ? (
        <p className="text-sm text-erp-muted">
          No service has been bought or sold yet. Mark a product as a service on the Inventory page and give it a cost, and it will appear here.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse overflow-hidden rounded border bg-erp-surface text-sm">
            <thead className="bg-erp-subtle text-left">
              <tr>
                {props.canSettle && <th className="w-8 p-2" />}
                <th className="p-2">Service</th>
                <th className="p-2 text-right">Billed (net of debit notes)</th>
                <th className="p-2 text-right">Cost taken on sales</th>
                <th className="p-2 text-right">Settled</th>
                <th className="p-2 text-right">Left over</th>
                <th className="p-2">Meaning</th>
                <th className="p-2 text-right">Untouched for</th>
                {props.canSettle && <th className="p-2" />}
              </tr>
            </thead>
            <tbody>
              {props.rows.map((r) => (
                <>
                  <tr key={r.productId} className="border-t">
                    {props.canSettle && (
                      <td className="p-2">
                        {r.state !== "SETTLED" && (
                          <input type="checkbox" checked={selected.has(r.productId)} onChange={() => toggle(r.productId)} aria-label={`Select ${r.name}`} />
                        )}
                      </td>
                    )}
                    <td className="p-2">
                      {r.name}
                      {r.sku && <span className="ml-1 text-xs text-erp-muted">({r.sku})</span>}
                    </td>
                    <td className="p-2 text-right">{fmt(r.billed)}</td>
                    <td className="p-2 text-right">{fmt(r.recognised)}</td>
                    <td className="p-2 text-right">{r.settled === 0 ? "-" : fmt(r.settled)}</td>
                    <td className="p-2 text-right font-medium">{fmtBalance(r.balance)}</td>
                    <td className="p-2 text-xs text-erp-muted">{r.stateLabel}</td>
                    <td className="p-2 text-right text-xs">
                      {r.state === "SETTLED" || r.ageDays === null ? (
                        <span className="text-erp-muted">-</span>
                      ) : (
                        <span className={r.aged ? "rounded bg-erp-warning/15 px-1.5 py-0.5 font-medium text-erp-warning" : "text-erp-muted"}>
                          {r.ageDays} day{r.ageDays === 1 ? "" : "s"}
                        </span>
                      )}
                    </td>
                    {props.canSettle && (
                      <td className="p-2 text-right">
                        {r.state !== "SETTLED" && (
                          <button onClick={() => openSettle(r.productId)} className="text-erp-primary underline">Settle...</button>
                        )}
                      </td>
                    )}
                  </tr>
                  {openId === r.productId && (
                    <tr key={`${r.productId}-form`} className="border-t bg-erp-subtle">
                      <td colSpan={props.canSettle ? 9 : 7} className="p-3">
                        <form onSubmit={(e) => submitSettle(e, r.productId)} className="space-y-3 text-sm">
                          <p className="text-xs text-erp-muted">
                            {r.state === "BILLED_NOT_SOLD"
                              ? `Left over: ${fmtBalance(r.balance)}. Settling recognises this much more cost (Dr Cost of Goods Sold, Cr Service Cost Clearing).`
                              : `Left over: ${fmtBalance(r.balance)}. Settling recognises this much less cost (Dr Service Cost Clearing, Cr Cost of Goods Sold).`}
                          </p>
                          {error && <p className="rounded bg-erp-danger/10 p-2 text-erp-danger">{error}</p>}
                          <div className="flex flex-wrap gap-3">
                            <input
                              value={amount}
                              onChange={(e) => setAmount(e.target.value)}
                              inputMode="decimal"
                              className="erp-input w-48"
                              placeholder={`Amount (empty = all ${fmt(Math.abs(r.balance))})`}
                            />
                            <input
                              value={reason}
                              onChange={(e) => setReason(e.target.value)}
                              className="erp-input min-w-[16rem] flex-1"
                              placeholder="Reason, e.g. Supplier bill is final"
                              maxLength={200}
                              required
                            />
                          </div>
                          <div className="flex gap-3">
                            <button type="submit" disabled={loading} className="rounded bg-erp-primary px-4 py-2 text-erp-primary-fg hover:opacity-90 disabled:opacity-60">
                              {loading ? "Settling..." : "Settle"}
                            </button>
                            <button type="button" onClick={() => setOpenId(null)} className="text-erp-muted underline">Cancel</button>
                          </div>
                        </form>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <h2 className="mb-2 text-lg font-semibold">Settlements</h2>
        {props.settlements.length === 0 ? (
          <p className="text-sm text-erp-muted">Nothing has been settled yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse overflow-hidden rounded border bg-erp-surface text-sm">
              <thead className="bg-erp-subtle text-left">
                <tr>
                  <th className="p-2">When</th>
                  <th className="p-2">Service</th>
                  <th className="p-2">What it did</th>
                  <th className="p-2">Reason</th>
                  <th className="p-2">Status</th>
                  {props.canSettle && <th className="p-2" />}
                </tr>
              </thead>
              <tbody>
                {props.settlements.map((s) => (
                  <>
                    <tr key={s.id} className="border-t">
                      <td className="p-2 whitespace-nowrap">{s.createdAt}</td>
                      <td className="p-2">{s.productName}</td>
                      <td className="p-2">{s.summary}</td>
                      <td className="p-2 text-erp-text">{s.reason}</td>
                      <td className="p-2">
                        {s.status === "VOIDED" ? (
                          <span className="text-xs text-erp-muted">Voided {s.voidedAt}{s.voidReason ? `: ${s.voidReason}` : ""}</span>
                        ) : (
                          <span className="text-xs text-erp-success">Recorded</span>
                        )}
                      </td>
                      {props.canSettle && (
                        <td className="p-2 text-right">
                          {s.status === "RECORDED" && (
                            <button onClick={() => { setVoidId(s.id); setVoidReason(""); setError(null); }} className="text-erp-danger underline">Void</button>
                          )}
                        </td>
                      )}
                    </tr>
                    {voidId === s.id && (
                      <tr key={`${s.id}-void`} className="border-t bg-erp-subtle">
                        <td colSpan={props.canSettle ? 6 : 5} className="p-3">
                          <form onSubmit={(e) => submitVoid(e, s.id)} className="space-y-3 text-sm">
                            <p className="text-xs text-erp-muted">
                              An equal and opposite entry is posted today and the service's leftover comes back. This settlement stays as history.
                            </p>
                            {error && <p className="rounded bg-erp-danger/10 p-2 text-erp-danger">{error}</p>}
                            <input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} className="erp-input w-full" placeholder="Why is this being voided?" required minLength={3} />
                            <div className="flex gap-3">
                              <button type="submit" disabled={loading} className="rounded bg-erp-danger px-4 py-2 text-erp-primary-fg hover:opacity-90 disabled:opacity-60">
                                {loading ? "Voiding..." : "Confirm Void"}
                              </button>
                              <button type="button" onClick={() => setVoidId(null)} className="text-erp-muted underline">Cancel</button>
                            </div>
                          </form>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
