"use client";

import { useEffect, useState } from "react";

interface Status {
  encryptionReady: boolean; encryptionReason: string | null; appUrlReady: boolean; saved: boolean; active: boolean;
  secretKeyHint: string | null; hasWebhookSecret: boolean; webhookUrl: string | null; provider: string;
}

export function OnlinePaymentsClient({ businessId }: { businessId: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [secretKey, setSecretKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const url = `/api/business/${businessId}/online-payments`;

  async function load() { const r = await fetch(url); if (r.ok) setStatus(await r.json()); }
  useEffect(() => { load(); }, [businessId]);

  async function save() {
    setBusy(true); setMsg(null);
    const r = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secretKey, webhookSecret: webhookSecret || null }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) setMsg({ ok: false, text: d.message ?? "Couldn't save." });
    else { setStatus(d); setSecretKey(""); setWebhookSecret(""); setMsg({ ok: true, text: "Saved. Customers can now pay invoices through a payment link." }); }
    setBusy(false);
  }
  async function remove() {
    if (!confirm("Remove your PayChangu keys? Existing payment links will stop working.")) return;
    setBusy(true);
    const r = await fetch(url, { method: "DELETE" });
    if (r.ok) setStatus(await r.json());
    setBusy(false);
  }

  if (!status) return <p className="text-sm text-erp-muted">Loading…</p>;
  if (!status.encryptionReady || !status.appUrlReady) {
    return (
      <div className="rounded border border-erp-warning/40 bg-erp-warning/10 p-4 text-sm text-erp-warning">
        <strong>Not available on this server yet.</strong> {status.encryptionReason ?? "NEXTAUTH_URL is not set."} Ask whoever runs this deployment to set it, then come back.
      </div>
    );
  }
  return (
    <div className="space-y-6 text-sm">
      {status.saved && (
        <div className="rounded border border-erp-success/40 bg-erp-success/10 p-3 text-erp-success">
          PayChangu is connected (secret key ending <code>{status.secretKeyHint}</code>{status.hasWebhookSecret ? ", webhook secret saved" : ", no webhook secret"}).{" "}
          <button onClick={remove} disabled={busy} className="ml-2 underline">Remove</button>
        </div>
      )}
      <div className="space-y-3">
        <h2 className="font-semibold">{status.saved ? "Replace your keys" : "Connect your PayChangu account"}</h2>
        <label className="block">Secret key
          <input type="password" autoComplete="off" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} className="mt-1 erp-input" placeholder="From PayChangu dashboard, API keys" />
        </label>
        <label className="block">Webhook secret (recommended)
          <input type="password" autoComplete="off" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} className="mt-1 erp-input" placeholder="From PayChangu dashboard, API & Webhooks" />
        </label>
        <button onClick={save} disabled={busy || secretKey.trim().length < 8} className="rounded bg-erp-primary px-4 py-2 text-erp-primary-fg hover:opacity-90 disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
        {msg && <p className={msg.ok ? "text-erp-success" : "text-erp-danger"}>{msg.text}</p>}
        <p className="text-xs text-erp-muted">Your keys are encrypted before they are stored and are never shown again. Use test keys first.</p>
      </div>
      {status.webhookUrl && (
        <div className="space-y-1">
          <h2 className="font-semibold">Webhook address</h2>
          <p className="text-erp-muted">In your PayChangu dashboard (Settings, API & Webhooks) set the webhook URL to:</p>
          <input readOnly value={status.webhookUrl} onFocus={(e) => e.currentTarget.select()} className="erp-input text-xs" />
          <p className="text-xs text-erp-muted">Payments are also checked automatically when the customer returns and by a periodic job, so a missed webhook only delays confirmation.</p>
        </div>
      )}
    </div>
  );
}
