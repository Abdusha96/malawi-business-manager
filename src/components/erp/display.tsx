import type { ReactNode } from "react";
import { formatAmount, formatMoney, isNegativeAmount } from "@/lib/erp/format";

/** Right-aligned, tabular, red when negative. Pass `bare` inside a column headed with the currency. */
export function AmountDisplay({ value, currency = "MWK", bare, className = "" }: { value: number | null | undefined; currency?: string; bare?: boolean; className?: string }) {
  const neg = isNegativeAmount(value);
  return (
    <span className={`tabular whitespace-nowrap ${neg ? "text-erp-danger" : ""} ${className}`}>
      {bare ? formatAmount(value) : formatMoney(value, currency)}
    </span>
  );
}

const TONES = {
  neutral: "bg-erp-subtle text-erp-muted",
  success: "bg-erp-success/10 text-erp-success",
  warning: "bg-erp-warning/10 text-erp-warning",
  danger: "bg-erp-danger/10 text-erp-danger",
  info: "bg-erp-info/10 text-erp-info",
} as const;

export function StatusBadge({ tone = "neutral", children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${TONES[tone]}`}>{children}</span>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-erp-border pb-3">
      <div>
        <h1 className="text-lg font-semibold text-erp-text">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-erp-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function KpiCard({ label, value, tone, note }: { label: string; value: ReactNode; tone?: "good" | "bad"; note?: string }) {
  return (
    <div className="rounded border border-erp-border bg-erp-surface px-3 py-2.5 shadow-sm">
      <p className="text-[11px] font-medium uppercase tracking-wide text-erp-muted">{label}</p>
      <p className={`mt-1 text-base font-semibold tabular ${tone === "bad" ? "text-erp-danger" : tone === "good" ? "text-erp-success" : "text-erp-text"}`}>{value}</p>
      {note && <p className="mt-0.5 text-[11px] text-erp-muted">{note}</p>}
    </div>
  );
}

/** Labelled form row: visible label, optional hint, optional error. Use with className="erp-input" controls. */
export function Field({ label, htmlFor, hint, required, children }: { label: string; htmlFor?: string; hint?: string; required?: boolean; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-erp-text">
        {label}
        {required && <span className="ml-0.5 text-erp-danger" aria-hidden>*</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-erp-muted">{hint}</p>}
    </div>
  );
}

/** Card wrapper for a form page. */
export function FormCard({ children }: { children: ReactNode }) {
  return <div className="rounded border border-erp-border bg-erp-surface p-4 shadow-sm">{children}</div>;
}

/** Label/value facts for a document header (customer, date, method ...). Entries with a nullish value are skipped. */
export function DetailList({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="mb-4 grid grid-cols-1 gap-x-6 gap-y-2 rounded border border-erp-border bg-erp-surface p-3 text-sm shadow-sm sm:grid-cols-2">
      {items
        .filter((i) => i.value !== null && i.value !== undefined && i.value !== false)
        .map((i) => (
          <div key={i.label} className="flex gap-2">
            <dt className="w-32 shrink-0 text-erp-muted">{i.label}</dt>
            <dd className="min-w-0 break-words text-erp-text">{i.value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** Read-only document lines (sale, quotation, credit note). Quantity is a plain number, price/total are amounts. */
export function LineItemsTable({ lines, currency = "MWK", priceLabel = "Price" }: { priceLabel?: string; lines: { id: string; name: ReactNode; quantity: number; unitPrice: number; total: number }[]; currency?: string }) {
  const th = "border-b border-erp-border px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-erp-muted";
  const td = "border-b border-erp-border px-2.5 py-1";
  return (
    <div className="mb-4 overflow-auto rounded border border-erp-border bg-erp-surface shadow-sm">
      <table className="w-full border-separate border-spacing-0 text-[13px]">
        <thead className="bg-erp-subtle">
          <tr>
            <th scope="col" className={`${th} text-left`}>Item</th>
            <th scope="col" className={`${th} text-right`}>Qty</th>
            <th scope="col" className={`${th} text-right`}>{priceLabel} ({currency})</th>
            <th scope="col" className={`${th} text-right`}>Total ({currency})</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="hover:bg-erp-subtle/60">
              <td className={td}>{l.name}</td>
              <td className={`${td} text-right tabular`}>{l.quantity}</td>
              <td className={`${td} text-right`}><AmountDisplay value={l.unitPrice} bare /></td>
              <td className={`${td} text-right`}><AmountDisplay value={l.total} bare /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Right-aligned totals block. Rows with `strong` get a rule above and bold type. */
export function TotalsPanel({ rows, currency = "MWK" }: { rows: { label: string; value: number; strong?: boolean }[]; currency?: string }) {
  return (
    <div className="mb-6 ml-auto w-full max-w-sm space-y-1 rounded border border-erp-border bg-erp-subtle p-3 text-sm">
      {rows.map((r) => (
        <div key={r.label} className={`flex justify-between ${r.strong ? "border-t border-erp-border pt-1 font-semibold" : ""}`}>
          <span>{r.label}</span>
          <AmountDisplay value={r.value} currency={currency} />
        </div>
      ))}
    </div>
  );
}

/** Bordered section with a title, for the optional panels on a document page. */
export function Panel({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-4 rounded border border-erp-border bg-erp-surface p-3 text-sm shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-erp-text">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Credit/debit note lines: net and VAT per line plus a yes/no stock flag (Restocked / Sent back). */
export function NoteLinesTable({ lines, flagLabel }: { flagLabel: string; lines: { id: string; name: string; quantity: number; net: number; vat: number; flag: boolean }[] }) {
  const th = "border-b border-erp-border px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-erp-muted";
  const td = "border-b border-erp-border px-2.5 py-1";
  return (
    <div className="mb-4 overflow-auto rounded border border-erp-border bg-erp-surface shadow-sm">
      <table className="w-full border-separate border-spacing-0 text-[13px]">
        <thead className="bg-erp-subtle">
          <tr>
            <th scope="col" className={`${th} text-left`}>Item</th>
            <th scope="col" className={`${th} text-right`}>Qty</th>
            <th scope="col" className={`${th} text-right`}>Net (MWK)</th>
            <th scope="col" className={`${th} text-right`}>VAT (MWK)</th>
            <th scope="col" className={`${th} text-left`}>{flagLabel}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="hover:bg-erp-subtle/60">
              <td className={td}>{l.name}</td>
              <td className={`${td} text-right tabular`}>{l.quantity}</td>
              <td className={`${td} text-right`}><AmountDisplay value={l.net} bare /></td>
              <td className={`${td} text-right`}><AmountDisplay value={l.vat} bare /></td>
              <td className={td}>{l.flag ? "Yes" : "No"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
