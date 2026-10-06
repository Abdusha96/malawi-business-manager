"use client";

import { useState } from "react";

export function PayClient({ token, amount }: { token: string; amount: number }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/pay/${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email || null, name: name || null }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.checkoutUrl) { setError(data.message ?? "Couldn't start the payment."); setBusy(false); return; }
      window.location.href = data.checkoutUrl;
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name (optional)" className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email for your receipt (optional)" type="email" className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
      <button onClick={pay} disabled={busy} className="w-full rounded-md bg-brand-600 px-4 py-2.5 text-white hover:bg-brand-700 disabled:opacity-50">{busy ? "Opening payment…" : `Pay MWK ${amount.toLocaleString()}`}</button>
      <p className="text-xs text-gray-500">You will be taken to a secure payment page (Airtel Money, TNM Mpamba or card). This site never sees your card number or PIN.</p>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
