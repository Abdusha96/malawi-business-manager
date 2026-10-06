"use client";

import { useState } from "react";

/**
 * Module 72: a small "text this person" button used beside a supplier payment and
 * on a paid payroll row. POSTs to `url` (optionally with a JSON body) and shows the
 * route's plain-language `note`. Nothing is sent until the button is pressed.
 */
export function SendNoticeButton({
  url,
  body,
  label,
  confirmText,
}: {
  url: string;
  body?: Record<string, unknown>;
  label: string;
  /** When set, the person confirms first (used for pay amounts, which are private). */
  confirmText?: string;
}) {
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [note, setNote] = useState<string | null>(null);

  async function handleClick() {
    if (confirmText && !window.confirm(confirmText)) return;
    setStatus("sending");
    setNote(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus("error");
        setNote(data.message ?? "Could not send the text.");
        return;
      }
      setStatus("done");
      setNote(data.note ?? "Sent.");
    } catch {
      setStatus("error");
      setNote("Could not reach the server.");
    }
  }

  return (
    <span className="inline-flex flex-col items-end">
      <button
        type="button"
        onClick={handleClick}
        disabled={status === "sending"}
        className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-60"
      >
        {status === "sending" ? "Sending..." : label}
      </button>
      {note && (
        <span className={`mt-1 max-w-[16rem] text-right text-xs ${status === "error" ? "text-red-700" : "text-gray-500"}`}>
          {note}
        </span>
      )}
    </span>
  );
}
