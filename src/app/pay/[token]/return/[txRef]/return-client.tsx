"use client";

import { useEffect, useState } from "react";

export function ReturnClient({ token, txRef }: { token: string; txRef: string }) {
  const [message, setMessage] = useState("Checking your payment…");
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    async function check() {
      tries++;
      try {
        const res = await fetch(`/api/pay/${token}/payments/${txRef}`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (data.message) setMessage(data.message);
        if (data.done) { setDone(true); return; }
      } catch {
        if (!cancelled) setMessage("Couldn't reach the server. Trying again…");
      }
      if (!cancelled && tries < 12) setTimeout(check, 5000); // mobile money can take a minute to confirm
    }
    check();
    return () => { cancelled = true; };
  }, [token, txRef]);

  return (
    <div className="space-y-3">
      <p className="rounded-md border border-gray-200 bg-gray-50 p-4 text-sm">{message}</p>
      {done && <a href={`/pay/${token}`} className="text-sm text-brand-700 underline">Back to the invoice</a>}
    </div>
  );
}
