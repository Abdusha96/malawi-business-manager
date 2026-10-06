"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type BranchRow = {
  branchId: string;
  branchName: string;
  quantity: number;
  reorderLevelOverride: number | null;
  // Module 56: dispatched-but-not-yet-confirmed quantities. Both are 0 for
  // the common case of no open transfer touching this branch.
  inTransitIn: number;
  inTransitOut: number;
};

// One row per branch. Each row keeps its own draft value/saving/error state
// so saving one branch's override never disturbs another's in-progress edit
// – same reasoning the reopen-history "Load more" button (Module 52) had
// for keeping per-panel state independent.
function BranchRowForm({
  businessId,
  productId,
  unit,
  productReorderLevel,
  canManage,
  row,
}: {
  businessId: string;
  productId: string;
  unit: string;
  productReorderLevel: number;
  canManage: boolean;
  row: BranchRow;
}) {
  const router = useRouter();
  const [value, setValue] = useState(row.reorderLevelOverride === null ? "" : String(row.reorderLevelOverride));
  const [saved, setSaved] = useState(row.reorderLevelOverride);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const trimmed = value.trim();
  const parsed = trimmed === "" ? null : Number(trimmed);
  const isValid = parsed === null || (Number.isFinite(parsed) && parsed >= 0);
  const dirty = parsed !== saved;

  async function save() {
    if (!isValid) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    const res = await fetch(`/api/business/${businessId}/products/${productId}/branch-reorder-levels`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branchId: row.branchId, reorderLevel: parsed }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setError(data.message ?? data.details?.fieldErrors?.reorderLevel?.[0] ?? "Could not save.");
      return;
    }
    setSaved(parsed);
    setMessage(parsed === null ? "Reverted to the business-wide level." : "Branch reorder level saved.");
    router.refresh();
  }

  const effective = saved ?? productReorderLevel;

  return (
    <tr className="border-t align-top">
      <td className="p-3 font-medium">{row.branchName}</td>
      <td className="p-3">
        {row.quantity} {unit}
        {row.inTransitIn > 0 && (
          <p className="mt-0.5 text-xs font-medium text-erp-warning">
            + {row.inTransitIn} {unit} arriving
          </p>
        )}
        {row.inTransitOut > 0 && (
          <p className="mt-0.5 text-xs text-erp-muted">
            {row.inTransitOut} {unit} departed, not yet confirmed
          </p>
        )}
      </td>
      <td className="p-3">
        <input
          type="number"
          min={0}
          step="0.001"
          placeholder={`${productReorderLevel} (business-wide)`}
          className="erp-input w-36"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={!canManage}
        />
        <p className="mt-1 text-xs text-erp-muted">
          Currently watching against {effective} {unit}
          {saved === null ? " (business-wide)" : " (this branch)"}.
        </p>
        {!isValid && <p className="mt-1 text-xs text-erp-danger">Enter a non-negative number, or leave blank.</p>}
        {error && <p className="mt-1 text-xs text-erp-danger">{error}</p>}
        {message && <p className="mt-1 text-xs text-erp-success">{message}</p>}
      </td>
      <td className="p-3">
        {canManage && (
          <button
            onClick={save}
            disabled={saving || !isValid || !dirty}
            className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </td>
    </tr>
  );
}

export function BranchReorderLevelsForm({
  businessId,
  productId,
  unit,
  productReorderLevel,
  canManage,
  canApplyToAll,
  branches,
}: {
  businessId: string;
  productId: string;
  unit: string;
  productReorderLevel: number;
  canManage: boolean;
  canApplyToAll: boolean;
  branches: BranchRow[];
}) {
  return (
    <div>
      {canApplyToAll && (
        <ApplyToAllForm businessId={businessId} productId={productId} unit={unit} productReorderLevel={productReorderLevel} />
      )}
      <div className="overflow-x-auto"><table className="w-full border-collapse overflow-hidden rounded border bg-erp-surface text-sm">
        <thead className="bg-erp-subtle text-left">
          <tr>
            <th className="p-3">Branch</th>
            <th className="p-3">Quantity</th>
            <th className="p-3">Reorder level override</th>
            <th className="p-3" />
          </tr>
        </thead>
        <tbody>
          {branches.map((row) => (
            <BranchRowForm
              key={row.branchId}
              businessId={businessId}
              productId={productId}
              unit={unit}
              productReorderLevel={productReorderLevel}
              canManage={canManage}
              row={row}
            />
          ))}
        </tbody>
      </table></div>
    </div>
  );
}

// MODULE 60 – closes the KNOWN LIMITATION Module 53 documented from the
// start: the table above only ever set one branch at a time, so
// standardizing a threshold across every branch meant repeating the same
// save N times. Kept as its own small form above the table rather than a
// checkbox bolted onto each row – this is a distinct action (touches every
// branch, needs its own confirmation) not a per-row option. Only rendered
// for an unrestricted Owner/Manager (canApplyToAll), matching the API
// route's own all-or-nothing permission check.
function ApplyToAllForm({
  businessId,
  productId,
  unit,
  productReorderLevel,
}: {
  businessId: string;
  productId: string;
  unit: string;
  productReorderLevel: number;
}) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const trimmed = value.trim();
  const parsed = trimmed === "" ? null : Number(trimmed);
  const isValid = parsed === null || (Number.isFinite(parsed) && parsed >= 0);

  async function apply() {
    if (!isValid) return;
    if (parsed !== null && !window.confirm(`Apply ${parsed} ${unit} as the reorder level for every branch? This overwrites any existing branch overrides.`)) {
      return;
    }
    if (parsed === null && !window.confirm("Clear the reorder-level override on every branch, going back to the business-wide level for all of them?")) {
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    const res = await fetch(`/api/business/${businessId}/products/${productId}/branch-reorder-levels/apply-to-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reorderLevel: parsed }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setError(data.message ?? data.details?.fieldErrors?.reorderLevel?.[0] ?? "Could not apply.");
      return;
    }
    setMessage(data.message ?? "Applied.");
    setValue("");
    router.refresh();
  }

  return (
    <div className="mb-4 flex flex-wrap items-end gap-3 rounded border border-dashed border-erp-border bg-erp-subtle p-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-erp-text">Apply one level to every branch</label>
        <input
          type="number"
          min={0}
          step="0.001"
          placeholder={`${productReorderLevel} (business-wide)`}
          className="erp-input w-36"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <button
        onClick={apply}
        disabled={saving || !isValid}
        className="rounded border border-erp-border bg-erp-surface px-3 py-1.5 text-sm hover:bg-erp-subtle disabled:opacity-60"
      >
        {saving ? "Applying…" : value.trim() === "" ? "Clear all overrides" : "Apply to all branches"}
      </button>
      {!isValid && <p className="text-xs text-erp-danger">Enter a non-negative number, or leave blank to clear.</p>}
      {error && <p className="text-xs text-erp-danger">{error}</p>}
      {message && <p className="text-xs text-erp-success">{message}</p>}
    </div>
  );
}
