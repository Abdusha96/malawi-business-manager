"use client";

import { useEffect, useState } from "react";
import { formatDateTimeIn } from "@/lib/timezone";

// Module 74 – "Get paid online" on a sale with a balance. Shows nothing unless the business has set up
// online payments. The link is the customer's whole way in: share it by SMS, WhatsApp or email.
interface Status {
  available: boolean;
  url: string | null;
  payments: { id: string; txRef: string; amount: number; status: string; createdAt: string; channel: string | null; excessAmount: number; applyError: string | null; failureReason: string | null }[];
}

export function PayLinkPanel({ businessId, saleId, timeZone }: { businessId: string; saleId: string; timeZone: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const base = `/api/business/${businessId}/sales/${saleId}/pay-link`;

  async function load() {
    const res = await fetch(base);
    if (res.ok) setStatus(await res.json());
  }
  useEffect(() => { load(); }, [saleId]);

  async function create() {
    setBusy(true); setError(null);
    const res = await fetch(base, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) setError(data.message ?? "Couldn't create the link.");
    await load();
    setBusy(false);
  }
  async function revoke() {
    if (!confirm("Stop this link from working? Anyone who has it will no longer be able to pay through it.")) return;
    setBusy(true);
    await fetch(base, { method: "DELETE" });
    await load();
    setBusy(false);
  }
  async function copy() {
    if (!status?.url) return;
    await navigator.clipboard.writeText(status.url).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!status || !status.available) return null;
  return (
    <div className="rounded border border-erp-border p-3 text-sm">
      <div className="mb-2 font-medium">Get paid online</div>
      {status.url ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input readOnly value={status.url} className="w-full rounded border border-erp-border px-2 py-1 text-xs" onFocus={(e) => e.currentTarget.select()} />
            <button onClick={copy} className="rounded border border-erp-border px-2 py-1 text-xs hover:bg-erp-subtle">{copied ? "Copied" : "Copy"}</button>
            <button onClick={revoke} disabled={busy} className="rounded border border-erp-danger/40 px-2 py-1 text-xs text-erp-danger hover:bg-erp-danger/10">Stop link</button>
          </div>
          <p className="text-xs text-erp-muted">Send this to the customer. They pay the balance by Airtel Money, TNM Mpamba or card, and it is recorded here automatically once the gateway confirms it.</p>
        </div>
      ) : (
        <button onClick={create} disabled={busy} className="rounded bg-erp-primary px-3 py-1.5 text-erp-primary-fg hover:opacity-90 disabled:opacity-50">Create payment link</button>
      )}
      {error && <p className="mt-2 text-xs text-erp-danger">{error}</p>}
      {status.payments.length > 0 && (
        <ul className="mt-3 space-y-1 border-t pt-2 text-xs text-erp-muted">
          {status.payments.map((p) => (
            <li key={p.id}>
              MWK {p.amount.toLocaleString()} – {p.status === "SUCCEEDED" ? (p.applyError ? <span className="text-erp-danger">paid but not applied: {p.applyError}</span> : <span className="text-erp-success">paid{p.channel ? ` (${p.channel})` : ""}{p.excessAmount >= 1 ? `, MWK ${p.excessAmount.toLocaleString()} over the balance` : ""}</span>) : p.status === "FAILED" ? <span className="text-erp-danger">failed{p.failureReason ? `: ${p.failureReason}` : ""}</span> : <span className="text-erp-warning">waiting for payment</span>}
              <span className="ml-1 text-erp-muted">{formatDateTimeIn(p.createdAt, timeZone)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
