"use client";

import { useState } from "react";

export function SendReminderButton({ businessId, customerId }: { businessId: string; customerId: string }) {
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleClick() {
    setStatus("sending");
    const res = await fetch(`/api/business/${businessId}/customers/${customerId}/reminder`, { method: "POST" });
    const data = await res.json();

    if (!res.ok) {
      setStatus("error");
      setMessage(data.message ?? "Could not send reminder.");
      return;
    }

    setStatus("sent");
    setMessage(data.note ?? "Reminder sent.");
  }

  return (
    <div className="text-right">
      <button
        onClick={handleClick}
        disabled={status === "sending"}
        className="rounded border border-erp-warning/40 bg-erp-warning/10 px-4 py-2 text-erp-warning hover:bg-erp-warning/15 disabled:opacity-60"
      >
        {status === "sending" ? "Sending..." : "Send Reminder"}
      </button>
      {message && <p className="mt-1 max-w-xs text-xs text-erp-muted">{message}</p>}
    </div>
  );
}
