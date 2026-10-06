"use client";

import { useState } from "react";

// Module 82: a human-readable failure inside the shell. The raw message (which can be a
// Prisma error) is only shown behind "Technical details", never as the headline.
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [show, setShow] = useState(false);
  return (
    <main className="mx-auto max-w-xl p-4 sm:p-6">
      <div className="rounded border border-erp-danger/40 bg-erp-danger/5 p-4">
        <h1 className="text-base font-semibold text-erp-danger">This page could not be loaded</h1>
        <p className="mt-1 text-sm text-erp-text">Something went wrong while loading this page. Your data has not been changed. Try again, and contact support if it keeps happening.</p>
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={reset} className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg">Try again</button>
          <button type="button" onClick={() => setShow((s) => !s)} className="rounded border border-erp-border px-3 py-1.5 text-sm">Technical details</button>
        </div>
        {show && <pre className="mt-3 overflow-auto rounded bg-erp-subtle p-2 text-xs">{error.digest ? `Reference: ${error.digest}\n` : ""}{error.message}</pre>}
      </div>
    </main>
  );
}
