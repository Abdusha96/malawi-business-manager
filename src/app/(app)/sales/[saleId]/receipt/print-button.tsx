"use client";

export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="rounded border border-erp-border px-4 py-2 text-sm hover:bg-erp-subtle"
    >
      Print / Save as PDF
    </button>
  );
}
