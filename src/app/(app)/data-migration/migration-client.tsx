"use client";
import { useMemo, useState } from "react";
import Link from "next/link";

type Kind = "PRODUCTS" | "FIXED_ASSETS";
type Issue = { rowNumber: number; code: string; field: string; value: string; error: string };
type History = { id: string; kind: string; filename: string; createdAt: string; migrationDate: string; totalRows: number; importedRows: number; rejectedRows: number; status: string; user: string | null };
const fields: Record<Kind, string[]> = { PRODUCTS: ["sku", "name", "description", "category", "unit", "openingQuantity", "unitCost", "sellingPrice", "branch", "vatCategory", "barcode"], FIXED_ASSETS: ["name", "category", "acquisitionDate", "cost", "accumulatedDepreciation", "netBookValue", "usefulLifeYears", "residualValue", "branch", "notes"] };
const labels: Record<string, string> = { sku: "Product Code", name: "Name", description: "Description", category: "Category", unit: "Unit", openingQuantity: "Opening Quantity", unitCost: "Unit Cost", sellingPrice: "Selling Price", branch: "Branch", vatCategory: "VAT Code", barcode: "Barcode", acquisitionDate: "Acquisition Date", cost: "Original Cost", accumulatedDepreciation: "Accumulated Depreciation", netBookValue: "Net Book Value", usefulLifeYears: "Useful Life Years", residualValue: "Residual Value", notes: "Notes" };
export function DataMigrationClient({ businessId, canProducts, canAssets, initialKind, history }: { businessId: string; canProducts: boolean; canAssets: boolean; initialKind: Kind; history: History[] }) {
  const [kind, setKind] = useState<Kind>(initialKind); const [file, setFile] = useState<File | null>(null); const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState<any>(null); const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [done, setDone] = useState<any>(null);
  const [mappingDirty, setMappingDirty] = useState(false);
  const allowed = useMemo(() => (kind === "PRODUCTS" ? canProducts : canAssets), [kind, canProducts, canAssets]);
  async function run(action: "preview" | "import") {
    if (!file) return; setBusy(true); setMessage("");
    try {
      const form = new FormData(); form.set("kind", kind); form.set("action", action); form.set("file", file); form.set("migrationDate", date);
      if (preview?.mappings) form.set("mapping", JSON.stringify(preview.mappings));
      const response = await fetch(`/api/business/${businessId}/data-migration`, { method: "POST", body: form }); const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Import failed.");
      if (action === "preview") { setPreview(payload); setMappingDirty(false); setDone(null); } else { setDone(payload); setPreview(null); }
    } catch (e) { setMessage(e instanceof Error ? e.message : "Import failed."); } finally { setBusy(false); }
  }
  function downloadErrors(errors: Issue[]) {
    const csv = ["Row Number,Code,Field,Value,Error", ...errors.map((x) => [x.rowNumber, x.code, x.field, x.value, x.error].map((v) => { const text = String(v); const safe = /^[=+@\t]/.test(text) || /^-(?!\d)/.test(text) ? `'${text}` : text; return `"${safe.replaceAll('"', '""')}"`; }).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); const a = document.createElement("a"); a.href = url; a.download = "migration-errors.csv"; a.click(); URL.revokeObjectURL(url);
  }
  return <div className="space-y-6">
    <div className="grid gap-3 sm:grid-cols-2">
      {canProducts && <button onClick={() => { setKind("PRODUCTS"); setPreview(null); setDone(null); setMappingDirty(false); }} className={`rounded border p-4 text-left ${kind === "PRODUCTS" ? "border-erp-primary bg-erp-subtle" : "border-erp-border"}`}><strong>Import Products</strong><p className="mt-1 text-sm text-erp-muted">Create products and record opening stock.</p></button>}
      {canAssets && <button onClick={() => { setKind("FIXED_ASSETS"); setPreview(null); setDone(null); setMappingDirty(false); }} className={`rounded border p-4 text-left ${kind === "FIXED_ASSETS" ? "border-erp-primary bg-erp-subtle" : "border-erp-border"}`}><strong>Import Fixed Assets</strong><p className="mt-1 text-sm text-erp-muted">Create the register and opening depreciation balances.</p></button>}
    </div>
    {!allowed ? <p className="rounded border border-erp-warning/30 p-4 text-sm">Your role does not have permission to import this data.</p> : <section className="rounded border border-erp-border p-4 sm:p-6">
      <h2 className="font-semibold">{kind === "PRODUCTS" ? "Product import" : "Fixed asset import"}</h2>
      <p className="mt-1 text-sm text-erp-muted">Upload a .xlsx or .csv file. All valid rows are committed together; rejected rows are reported and left untouched.</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-sm">Opening Balance Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="erp-input mt-1 block w-full" /></label>
        <label className="text-sm">File<input type="file" accept=".xlsx,.csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setDone(null); setMappingDirty(false); }} className="mt-2 block w-full text-sm" /></label>
      </div>
      <div className="mt-4 flex flex-wrap gap-2"><a className="rounded border border-erp-border px-3 py-2 text-sm" href={`/api/business/${businessId}/data-migration/template?kind=${kind}`}>Download Excel template</a><button disabled={!file || busy} onClick={() => run("preview")} className="rounded bg-erp-primary px-4 py-2 text-sm font-medium text-erp-primary-fg disabled:opacity-50">{busy ? "Validating…" : "Validate and preview"}</button></div>
      {message && <p role="alert" className="mt-3 text-sm text-erp-danger">{message}</p>}
      {preview && <div className="mt-6 space-y-4">
        <div><h3 className="font-medium">Column mapping</h3><div className="mt-2 grid gap-2 sm:grid-cols-2">{fields[kind].map((f) => <label key={f} className="text-sm">{labels[f]}<select className="erp-input mt-1 block w-full" value={preview.mappings[f] ?? ""} onChange={(e) => { setPreview({ ...preview, mappings: { ...preview.mappings, [f]: e.target.value } }); setMappingDirty(true); }}><option value="">Not mapped</option>{preview.headers.map((h: string) => <option key={h} value={h}>{h}</option>)}</select></label>)}</div>{mappingDirty && <p className="mt-2 text-sm text-erp-warning">Mapping changed; validate again to refresh the preview before importing.</p>}</div>
        <div className="rounded bg-erp-subtle p-3 text-sm">Rows: {preview.totalRows} · Valid: {preview.validRows.length} · With errors: {new Set(preview.errors.map((e: Issue) => e.rowNumber)).size}</div>
        {preview.errors.length > 0 && <><div className="max-h-64 overflow-auto rounded border border-erp-border"><table className="w-full text-left text-sm"><thead><tr>{["Row", "Code", "Field", "Value", "Error"].map((x) => <th key={x} className="p-2">{x}</th>)}</tr></thead><tbody>{preview.errors.map((e: Issue, i: number) => <tr key={i} className="border-t border-erp-border"><td className="p-2">{e.rowNumber}</td><td className="p-2">{e.code}</td><td className="p-2">{labels[e.field] ?? e.field}</td><td className="p-2">{e.value}</td><td className="p-2">{e.error}</td></tr>)}</tbody></table></div><button onClick={() => downloadErrors(preview.errors)} className="text-sm underline">Download error report</button></>}
        <button disabled={busy || mappingDirty || (!preview.validRows.length && !preview.errors.length)} onClick={() => run("import")} className="rounded bg-erp-primary px-4 py-2 text-sm font-medium text-erp-primary-fg disabled:opacity-50">{busy ? "Importing…" : mappingDirty ? "Validate mapping first" : preview.validRows.length ? `Import ${preview.validRows.length} ${kind === "PRODUCTS" ? "products" : "assets"}` : `Record ${new Set(preview.errors.map((e: Issue) => e.rowNumber)).size} rejected rows`}</button>
      </div>}
      {done && <div className="mt-5 rounded border border-erp-success/30 bg-erp-success/5 p-4"><h3 className="font-semibold">Import completed</h3><p className="mt-2 text-sm">Processed {done.imported + done.rejected} · Imported {done.imported} · Rejected {done.rejected}</p><p className="text-sm">Opening balance value: MWK {Number(done.openingValue).toLocaleString()}</p>{done.errors?.length > 0 && <button className="mt-3 text-sm underline" onClick={() => downloadErrors(done.errors)}>Download error report</button>}<div className="mt-3"><Link href={kind === "PRODUCTS" ? "/inventory" : "/fixed-assets"} className="text-sm underline">View {kind === "PRODUCTS" ? "Inventory" : "Fixed Assets"}</Link></div></div>}
    </section>}
    <section><h2 className="mb-2 font-semibold">Import history</h2><div className="overflow-x-auto rounded border border-erp-border"><table className="w-full text-left text-sm"><thead><tr className="border-b border-erp-border">{["Type", "Imported at", "Opening date", "File", "Rows", "Imported", "Rejected", "Status", "User"].map((x) => <th key={x} className="p-2">{x}</th>)}</tr></thead><tbody>{history.map((h) => <tr key={h.id} className="border-b border-erp-border"><td className="p-2">{h.kind.replace("_", " ")}</td><td className="p-2">{new Date(h.createdAt).toLocaleString()}</td><td className="p-2">{new Date(h.migrationDate).toLocaleDateString()}</td><td className="p-2">{h.filename}</td><td className="p-2">{h.totalRows}</td><td className="p-2">{h.importedRows}</td><td className="p-2">{h.rejectedRows}</td><td className="p-2">{h.status}</td><td className="p-2">{h.user ?? "—"}</td></tr>)}{history.length === 0 && <tr><td colSpan={9} className="p-4 text-erp-muted">No imports yet.</td></tr>}</tbody></table></div></section>
  </div>;
}
