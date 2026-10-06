export function DateFilter({
  from = "",
  to = "",
  error,
}: {
  from?: string;
  to?: string;
  error?: string;
}) {
  return (
    <div className="mb-3">
      <form method="get" className="flex flex-wrap items-end gap-3 rounded border border-erp-border bg-erp-surface p-3">
        <label className="text-xs text-erp-muted">
          From
          <input name="from" type="date" defaultValue={from} className="erp-input mt-1 block" />
        </label>
        <label className="text-xs text-erp-muted">
          To
          <input name="to" type="date" defaultValue={to} className="erp-input mt-1 block" />
        </label>
        <button type="submit" className="rounded bg-erp-primary px-3 py-2 text-sm font-medium text-erp-primary-fg">Filter dates</button>
        {(from || to) && <a href="?" className="rounded border border-erp-border px-3 py-2 text-sm">Clear</a>}
      </form>
      {error && <p role="alert" className="mt-2 text-xs text-erp-danger">{error}</p>}
    </div>
  );
}
