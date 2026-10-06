"use client";

import { useRouter } from "next/navigation";

export function BranchSwitcher({
  branches,
  selectedBranchId,
}: {
  branches: { id: string; name: string }[];
  selectedBranchId: string | null;
}) {
  const router = useRouter();

  return (
    <div className="mb-4 flex items-center gap-2 text-sm">
      <label htmlFor="branch-switcher" className="text-erp-muted">Viewing:</label>
      <select
        id="branch-switcher"
        value={selectedBranchId ?? ""}
        onChange={(e) => {
          const value = e.target.value;
          router.push(value ? `/dashboard?branchId=${value}` : "/dashboard");
        }}
        className="rounded border border-erp-border px-2 py-1"
      >
        <option value="">All Branches</option>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>{b.name}</option>
        ))}
      </select>
    </div>
  );
}
