"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { formatDateIn, formatDateTimeIn } from "@/lib/timezone";
import { daysInTransit, isStaleTransfer } from "@/lib/stale-transfer";
import { lineShortfall, resolveReceipt, transferHasShortfall } from "@/lib/stock-transfer-receipt";
import {
  lineRecovered,
  outstandingShortfall,
  resolveRecovery,
  transferHasOutstandingShortfall,
  MAX_RECOVERY_NOTE_LENGTH,
} from "@/lib/stock-transfer-recovery";

type Line = {
  id: string;
  quantity: number;
  // Module 59: unitCostAtDispatch is null on any line created before this
  // module shipped – fall back to the product's current purchasePrice for
  // those, same estimate getInTransitSummary() used to make for every line.
  unitCostAtDispatch: number | null;
  // Module 65: null on a transfer received before this module (always in
  // full) and on any transfer not yet received.
  quantityReceived: number | null;
  shortfallReason: string | null;
  // Module 66: running total of the shortfall brought back since. Null = none.
  quantityRecovered: number | null;
  product: { id: string; name: string; sku: string | null; unit: string; purchasePrice: number };
};

type Transfer = {
  id: string;
  transferNumber: string;
  notes: string | null;
  createdAt: string;
  status: "IN_TRANSIT" | "RECEIVED" | "CANCELLED";
  receivedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  fromBranchId: string;
  toBranchId: string;
  fromBranch: { id: string; name: string };
  toBranch: { id: string; name: string };
  lines: Line[];
};

// Module 57: once an IN_TRANSIT transfer is stale (see stale-transfer.ts),
// the banner says so directly instead of leaving it to the bell alone –
// someone looking at this specific transfer should see it here too.
// Module 58: the threshold is now the business's own configured value,
// passed down from the server page – not a shared constant.
function StatusBanner({ transfer, tz, staleTransferAlertDays }: { transfer: Transfer; tz: string; staleTransferAlertDays: number }) {
  if (transfer.status === "IN_TRANSIT") {
    const createdAt = new Date(transfer.createdAt);
    const stale = isStaleTransfer(transfer.status, createdAt, staleTransferAlertDays);
    return (
      <div className="mb-4 rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-sm text-erp-warning">
        In transit – dispatched from {transfer.fromBranch.name}, awaiting confirmation at {transfer.toBranch.name}.
        {stale && (
          <span className="mt-1 block font-medium text-erp-danger">
            Stale: {daysInTransit(createdAt)} days in transit with no confirmation. Check whether it arrived, or
            cancel it if it didn't.
          </span>
        )}
      </div>
    );
  }
  if (transfer.status === "RECEIVED") {
    const toNum = (v: number | null) => (v == null ? null : Number(v));
    const arrivedShort = transferHasShortfall(
      transfer.lines.map((l) => ({ quantity: Number(l.quantity), quantityReceived: toNum(l.quantityReceived) }))
    );
    // Module 66: "short" now means stock is STILL missing; a transfer whose
    // whole shortfall has been recovered reads as received (with a note).
    const short = transferHasOutstandingShortfall(
      transfer.lines.map((l) => ({
        quantity: Number(l.quantity),
        quantityReceived: toNum(l.quantityReceived),
        quantityRecovered: toNum(l.quantityRecovered),
      }))
    );
    return (
      <div
        className={
          short
            ? "mb-4 rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-sm text-erp-warning"
            : "mb-4 rounded border border-erp-success/40 bg-erp-success/10 p-3 text-sm text-erp-success"
        }
      >
        {short ? "Received short" : "Received"} at {transfer.toBranch.name}
        {transfer.receivedAt ? ` on ${formatDateTimeIn(new Date(transfer.receivedAt), tz)}` : ""}.
        {short && (
          <span className="mt-1 block">
            Part of this transfer didn't arrive. The missing quantity was written off to Inventory Shrinkage at its
            dispatch-time cost – see the lines below for what and why. If it turns up, record it below and the
            write-off is reversed.
          </span>
        )}
        {!short && arrivedShort && (
          <span className="mt-1 block">
            This transfer arrived short, but everything that was missing has since been recovered.
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="mb-4 rounded border border-erp-border bg-erp-subtle p-3 text-sm text-erp-text">
      Cancelled{transfer.cancelledAt ? ` on ${formatDateTimeIn(new Date(transfer.cancelledAt), tz)}` : ""} – stock returned to{" "}
      {transfer.fromBranch.name}.
      {transfer.cancelReason && <> Reason: {transfer.cancelReason}</>}
    </div>
  );
}

export function StockTransferWorkspace({
  businessId,
  transferId,
  canManage,
  ownBranchId,
  timeZone,
  staleTransferAlertDays,
}: {
  businessId: string;
  transferId: string;
  canManage: boolean;
  ownBranchId: string | null;
  timeZone: string;
  staleTransferAlertDays: number;
}) {
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  // Module 65: the "received short or damaged" panel. Keyed by line id; a
  // blank quantity means "as dispatched", so only the lines that differ need
  // touching.
  const [showShortForm, setShowShortForm] = useState(false);
  const [receivedQty, setReceivedQty] = useState<Record<string, string>>({});
  const [shortReasons, setShortReasons] = useState<Record<string, string>>({});
  // Module 66: the "record recovered stock" panel. Keyed by line id; a blank
  // quantity means "none of this line", so only the lines that turned up need
  // touching (the opposite default to a receipt).
  const [showRecoverForm, setShowRecoverForm] = useState(false);
  const [recoverQty, setRecoverQty] = useState<Record<string, string>>({});
  const [recoverNote, setRecoverNote] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/business/${businessId}/stock-transfers/${transferId}`);
    if (!res.ok) return;
    const d = await res.json();
    setTransfer(d.transfer);
  }, [businessId, transferId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!transfer) {
    return <p className="text-erp-muted">Loading…</p>;
  }

  // A branch-restricted member can only receive at their own destination
  // branch, or cancel from their own source branch – an Owner/unrestricted
  // Manager (ownBranchId === null) can do either.
  const canReceive = canManage && transfer.status === "IN_TRANSIT" && (!ownBranchId || ownBranchId === transfer.toBranchId);
  const canCancel = canManage && transfer.status === "IN_TRANSIT" && (!ownBranchId || ownBranchId === transfer.fromBranchId);

  async function postReceive(body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/business/${businessId}/stock-transfers/${transferId}/receive`, {
        method: "POST",
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      const d = await res.json();
      if (!res.ok) {
        setError(d.message ?? "Could not confirm receipt.");
        return;
      }
      setTransfer(d.transfer);
      setShowShortForm(false);
      setReceivedQty({});
      setShortReasons({});
    } finally {
      setBusy(false);
    }
  }

  // Everything arrived as dispatched – the original one-click path, no body.
  function receive() {
    return postReceive();
  }

  // Module 65: the same pure resolveReceipt() the server runs, so the form
  // shows exactly what the server will accept or refuse before anything is sent.
  const draftLines = (transfer.lines ?? []).map((line) => {
    const raw = receivedQty[line.id];
    return {
      lineId: line.id,
      quantityReceived: raw === undefined || raw.trim() === "" ? Number(line.quantity) : Number(raw),
      shortfallReason: shortReasons[line.id] ?? "",
    };
  });
  const draft = resolveReceipt(
    transfer.lines.map((line) => ({
      id: line.id,
      productName: line.product.name,
      quantity: Number(line.quantity),
      unitCost: Number(line.unitCostAtDispatch ?? line.product.purchasePrice),
    })),
    draftLines
  );

  function receiveWithShortfall() {
    if (!draft.ok) {
      setError(draft.error);
      return;
    }
    if (draft.shortLineCount === 0) {
      setError("Every line is at its dispatched quantity – use Confirm Receipt, or enter what was actually received.");
      return;
    }
    return postReceive({
      lines: draftLines
        .filter((l) => draft.lines.find((r) => r.lineId === l.lineId)?.isShort)
        .map((l) => ({ lineId: l.lineId, quantityReceived: l.quantityReceived, shortfallReason: l.shortfallReason })),
    });
  }

  // Module 66: recovery of stock written off as short. Lands in the destination
  // branch's stock, so a branch-restricted member can only do it at their own.
  const outstandingLines = transfer.lines
    .map((line) => ({
      line,
      outstanding: outstandingShortfall(
        Number(line.quantity),
        line.quantityReceived == null ? null : Number(line.quantityReceived),
        line.quantityRecovered == null ? null : Number(line.quantityRecovered)
      ),
    }))
    .filter((x) => x.outstanding > 0);
  const canRecover =
    canManage && transfer.status === "RECEIVED" && outstandingLines.length > 0 && (!ownBranchId || ownBranchId === transfer.toBranchId);

  const recoverInputs = transfer.lines
    .filter((line) => (recoverQty[line.id] ?? "").trim() !== "")
    .map((line) => ({ lineId: line.id, quantityRecovered: Number(recoverQty[line.id]) }));
  // The same pure resolveRecovery() the server runs, so the form shows what
  // the server will accept or refuse before anything is sent.
  const recoverDraft = resolveRecovery(
    transfer.lines.map((line) => ({
      id: line.id,
      productName: line.product.name,
      quantity: Number(line.quantity),
      quantityReceived: line.quantityReceived == null ? null : Number(line.quantityReceived),
      quantityRecovered: line.quantityRecovered == null ? null : Number(line.quantityRecovered),
      unitCost: Number(line.unitCostAtDispatch ?? line.product.purchasePrice),
    })),
    recoverInputs
  );

  async function recoverStock() {
    if (!recoverDraft.ok) {
      setError(recoverDraft.error);
      return;
    }
    if (!recoverNote.trim()) {
      setError("A note is required – say where the missing stock turned up.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/business/${businessId}/stock-transfers/${transferId}/recover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines: recoverInputs, note: recoverNote }),
      });
      const d = await res.json();
      if (!res.ok) {
        setError(d.message ?? "Could not record the recovered stock.");
        return;
      }
      setTransfer(d.transfer);
      setShowRecoverForm(false);
      setRecoverQty({});
      setRecoverNote("");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!cancelReason.trim()) {
      setError("A reason is required to cancel a transfer.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/business/${businessId}/stock-transfers/${transferId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: cancelReason }),
      });
      const d = await res.json();
      if (!res.ok) {
        setError(d.message ?? "Could not cancel transfer.");
        return;
      }
      setTransfer(d.transfer);
      setShowCancelForm(false);
      setCancelReason("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-start justify-between">
        <h1 className="text-2xl font-bold">{transfer.transferNumber}</h1>
        <Link href="/stock-transfers" className="rounded border border-erp-border px-3 py-2 text-sm hover:bg-erp-subtle">
          Back to Stock Transfers
        </Link>
      </div>

      <StatusBanner transfer={transfer} tz={timeZone} staleTransferAlertDays={staleTransferAlertDays} />

      {error && <div className="mb-4 rounded border border-erp-danger/40 bg-erp-danger/10 p-3 text-sm text-erp-danger">{error}</div>}

      <div className="mb-4 rounded border bg-erp-surface p-4 text-sm">
        <p><span className="text-erp-muted">From:</span> {transfer.fromBranch.name}</p>
        <p><span className="text-erp-muted">To:</span> {transfer.toBranch.name}</p>
        <p><span className="text-erp-muted">Dispatched:</span> {formatDateIn(new Date(transfer.createdAt), timeZone)}</p>
        {transfer.notes && <p><span className="text-erp-muted">Notes:</span> {transfer.notes}</p>}
      </div>

      <div className="overflow-x-auto"><table className="mb-6 w-full border-collapse overflow-hidden rounded border bg-erp-surface text-sm">
        <thead className="bg-erp-subtle text-left">
          <tr>
            <th className="p-2">Product</th>
            <th className="p-2 text-right">{transfer.status === "RECEIVED" ? "Dispatched" : "Quantity"}</th>
            {transfer.status === "RECEIVED" && <th className="p-2 text-right">Received</th>}
            <th className="p-2 text-right">Est. value at dispatch</th>
          </tr>
        </thead>
        <tbody>
          {transfer.lines.map((line) => {
            const unitCost = line.unitCostAtDispatch ?? line.product.purchasePrice;
            return (
              <tr key={line.id} className="border-t">
                <td className="p-2">{line.product.name}</td>
                <td className="p-2 text-right">
                  {Number(line.quantity)} {line.product.unit}
                </td>
                {transfer.status === "RECEIVED" && (
                  <td className="p-2 text-right">
                    {line.quantityReceived == null ? Number(line.quantity) : Number(line.quantityReceived)} {line.product.unit}
                    {lineShortfall(Number(line.quantity), line.quantityReceived == null ? null : Number(line.quantityReceived)) > 0 && (
                      <span className="block text-xs text-erp-warning">
                        {lineShortfall(Number(line.quantity), Number(line.quantityReceived))} short
                        {line.shortfallReason ? ` – ${line.shortfallReason}` : ""}
                      </span>
                    )}
                    {lineRecovered(line.quantityRecovered == null ? null : Number(line.quantityRecovered)) > 0 && (
                      <span className="block text-xs text-erp-success">
                        {lineRecovered(Number(line.quantityRecovered))} recovered later
                        {outstandingShortfall(
                          Number(line.quantity),
                          Number(line.quantityReceived),
                          Number(line.quantityRecovered)
                        ) > 0
                          ? `, ${outstandingShortfall(Number(line.quantity), Number(line.quantityReceived), Number(line.quantityRecovered))} still missing`
                          : ""}
                      </span>
                    )}
                  </td>
                )}
                <td className="p-2 text-right text-erp-muted">
                  MWK {Math.round(Number(line.quantity) * Number(unitCost)).toLocaleString()}
                  {line.unitCostAtDispatch == null && <span className="text-erp-muted"> (current cost)</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table></div>

      {canRecover && (
        <div className="mb-6 rounded border bg-erp-surface p-4">
          {!showRecoverForm ? (
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => {
                  setShowRecoverForm(true);
                  setError(null);
                }}
                disabled={busy}
                className="rounded border border-erp-success/40 px-4 py-2 text-sm text-erp-success hover:bg-erp-success/10 disabled:opacity-50"
              >
                Missing stock turned up…
              </button>
              <span className="text-sm text-erp-muted">
                Brings written-off stock back into {transfer.toBranch.name} and reverses that part of the write-off.
              </span>
            </div>
          ) : (
            <div>
              <p className="mb-3 text-sm text-erp-muted">
                Enter how much of the missing stock has now arrived at {transfer.toBranch.name}. Leave a line blank if none of
                it turned up. It goes into {transfer.toBranch.name}'s stock and the write-off is reversed at the same cost it
                was written off at.
              </p>
              <div className="space-y-3">
                {outstandingLines.map(({ line, outstanding }) => {
                  const resolved = recoverDraft.ok ? recoverDraft.lines.find((r) => r.lineId === line.id) : undefined;
                  return (
                    <div key={line.id} className="rounded border p-3">
                      <div className="flex flex-wrap items-center gap-3 text-sm">
                        <span className="min-w-[10rem] font-medium">{line.product.name}</span>
                        <span className="text-erp-muted">
                          {outstanding} {line.product.unit} still missing
                        </span>
                        <label className="flex items-center gap-2">
                          <span className="text-erp-muted">recovered</span>
                          <input
                            type="number"
                            min={0}
                            max={outstanding}
                            step="any"
                            value={recoverQty[line.id] ?? ""}
                            placeholder="0"
                            onChange={(e) => setRecoverQty((q) => ({ ...q, [line.id]: e.target.value }))}
                            className="w-28 rounded border border-erp-border p-1.5 text-right text-sm"
                          />
                        </label>
                      </div>
                      {resolved && (
                        <p className="mt-1 text-xs text-erp-success">
                          {resolved.quantity} {line.product.unit} back into stock – MWK{" "}
                          {Math.round(resolved.value).toLocaleString()} of the write-off reversed
                          {resolved.fullyRecovered ? " (line fully recovered)" : ""}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
              <input
                type="text"
                value={recoverNote}
                onChange={(e) => setRecoverNote(e.target.value)}
                maxLength={MAX_RECOVERY_NOTE_LENGTH}
                placeholder="Where did it turn up? (e.g. second truck delivered on Friday)"
                className="mt-3 w-full rounded border border-erp-border p-1.5 text-sm"
              />
              {recoverInputs.length > 0 && !recoverDraft.ok && <p className="mt-3 text-sm text-erp-danger">{recoverDraft.error}</p>}
              <div className="mt-3 flex gap-2">
                <button
                  onClick={recoverStock}
                  disabled={busy || !recoverDraft.ok || !recoverNote.trim()}
                  className="rounded bg-erp-success px-4 py-2 text-sm text-erp-primary-fg hover:opacity-90 disabled:opacity-50"
                >
                  Record recovered stock
                  {recoverDraft.ok ? ` (MWK ${Math.round(recoverDraft.totalValue).toLocaleString()} reversed)` : ""}
                </button>
                <button
                  onClick={() => {
                    setShowRecoverForm(false);
                    setRecoverQty({});
                    setRecoverNote("");
                    setError(null);
                  }}
                  disabled={busy}
                  className="rounded border border-erp-border px-4 py-2 text-sm hover:bg-erp-subtle"
                >
                  Never mind
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {transfer.status === "IN_TRANSIT" && (canReceive || canCancel) && (
        <div className="rounded border bg-erp-surface p-4">
          <div className="flex flex-wrap gap-3">
            {canReceive && (
              <button
                onClick={receive}
                disabled={busy}
                className="rounded bg-erp-primary px-4 py-2 text-sm text-erp-primary-fg hover:opacity-90 disabled:opacity-50"
              >
                Confirm Receipt
              </button>
            )}
            {canReceive && !showShortForm && (
              <button
                onClick={() => {
                  setShowShortForm(true);
                  setShowCancelForm(false);
                  setError(null);
                }}
                disabled={busy}
                className="rounded border border-erp-warning/40 px-4 py-2 text-sm text-erp-warning hover:bg-erp-warning/10 disabled:opacity-50"
              >
                Received short or damaged…
              </button>
            )}
            {canCancel && !showCancelForm && (
              <button
                onClick={() => {
                  setShowCancelForm(true);
                  setShowShortForm(false);
                }}
                disabled={busy}
                className="rounded border border-erp-danger/40 px-4 py-2 text-sm text-erp-danger hover:bg-erp-danger/10 disabled:opacity-50"
              >
                Cancel Transfer
              </button>
            )}
          </div>

          {showShortForm && canReceive && (
            <div className="mt-4 border-t pt-4">
              <p className="mb-3 text-sm text-erp-muted">
                Enter what actually arrived at {transfer.toBranch.name}. Leave a line blank if it arrived in full. Anything
                short is written off at its dispatch-time cost and does not go into {transfer.toBranch.name}'s stock.
              </p>
              <div className="space-y-3">
                {transfer.lines.map((line) => {
                  const resolved = draft.ok ? draft.lines.find((r) => r.lineId === line.id) : undefined;
                  return (
                    <div key={line.id} className="rounded border p-3">
                      <div className="flex flex-wrap items-center gap-3 text-sm">
                        <span className="min-w-[10rem] font-medium">{line.product.name}</span>
                        <span className="text-erp-muted">
                          sent {Number(line.quantity)} {line.product.unit}
                        </span>
                        <label className="flex items-center gap-2">
                          <span className="text-erp-muted">received</span>
                          <input
                            type="number"
                            min={0}
                            max={Number(line.quantity)}
                            step="any"
                            value={receivedQty[line.id] ?? ""}
                            placeholder={String(Number(line.quantity))}
                            onChange={(e) => setReceivedQty((q) => ({ ...q, [line.id]: e.target.value }))}
                            className="w-28 rounded border border-erp-border p-1.5 text-right text-sm"
                          />
                        </label>
                      </div>
                      {resolved?.isShort && (
                        <div className="mt-2">
                          <input
                            type="text"
                            value={shortReasons[line.id] ?? ""}
                            onChange={(e) => setShortReasons((r) => ({ ...r, [line.id]: e.target.value }))}
                            maxLength={200}
                            placeholder={`Why ${resolved.shortfall} ${line.product.unit} didn't arrive (e.g. damaged in transit)`}
                            className="w-full rounded border border-erp-border p-1.5 text-sm"
                          />
                          <p className="mt-1 text-xs text-erp-warning">
                            {resolved.shortfall} {line.product.unit} short – MWK {Math.round(resolved.shortfallValue).toLocaleString()} written off
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {draft.ok && draft.receivedNothing && (
                <p className="mt-3 text-sm text-erp-danger">
                  Nothing arrived on any line. If the goods never left or came back, cancel the transfer instead so the
                  stock returns to {transfer.fromBranch.name}; use this only when the goods are lost or unusable.
                </p>
              )}
              {!draft.ok && <p className="mt-3 text-sm text-erp-danger">{draft.error}</p>}
              <div className="mt-3 flex gap-2">
                <button
                  onClick={receiveWithShortfall}
                  disabled={busy || !draft.ok || draft.shortLineCount === 0}
                  className="rounded bg-erp-warning px-4 py-2 text-sm text-erp-primary-fg hover:opacity-90 disabled:opacity-50"
                >
                  Confirm short receipt
                  {draft.ok && draft.shortLineCount > 0 ? ` (MWK ${Math.round(draft.totalShortfallValue).toLocaleString()} written off)` : ""}
                </button>
                <button
                  onClick={() => {
                    setShowShortForm(false);
                    setReceivedQty({});
                    setShortReasons({});
                    setError(null);
                  }}
                  disabled={busy}
                  className="rounded border border-erp-border px-4 py-2 text-sm hover:bg-erp-subtle"
                >
                  Never mind
                </button>
              </div>
            </div>
          )}

          {showCancelForm && (
            <div className="mt-4 border-t pt-4">
              <label className="mb-1 block text-sm font-medium text-erp-text">Reason for cancelling</label>
              <textarea
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                rows={2}
                className="mb-2 w-full rounded border border-erp-border p-2 text-sm"
                placeholder="e.g. wrong branch selected, goods never left the warehouse"
              />
              <div className="flex gap-2">
                <button
                  onClick={cancel}
                  disabled={busy}
                  className="rounded bg-erp-danger px-4 py-2 text-sm text-erp-primary-fg hover:opacity-90 disabled:opacity-50"
                >
                  Confirm Cancellation
                </button>
                <button
                  onClick={() => {
                    setShowCancelForm(false);
                    setCancelReason("");
                    setError(null);
                  }}
                  disabled={busy}
                  className="rounded border border-erp-border px-4 py-2 text-sm hover:bg-erp-subtle"
                >
                  Never mind
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
