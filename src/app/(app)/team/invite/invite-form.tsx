"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function InviteMemberForm({
  businessId,
  branches,
}: {
  businessId: string;
  branches: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(e.currentTarget);
    const payload = {
      email: form.get("email"),
      role: form.get("role"),
      branchId: form.get("branchId") || null,
    };

    const res = await fetch(`/api/business/${businessId}/team`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Could not send invitation.");
      return;
    }

    setSentTo(payload.email as string);
  }

  if (sentTo) {
    return (
      <div className="space-y-4">
        <p className="rounded bg-erp-success/10 p-3 text-sm text-erp-success">
          Invitation sent to {sentTo}. They'll get a link to join your business.
        </p>
        <button
          type="button"
          onClick={() => router.push("/team")}
          className="w-full rounded bg-erp-primary py-2.5 font-medium text-erp-primary-fg hover:opacity-90"
        >
          Back to Team
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <p className="rounded bg-erp-danger/10 p-3 text-sm text-erp-danger">{error}</p>}

      <div>
        <label className="mb-1 block text-sm font-medium">Email address</label>
        <input name="email" type="email" required className="erp-input" placeholder="colleague@example.com" />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">Role</label>
        <select name="role" required className="erp-input" defaultValue="CASHIER">
          <option value="MANAGER">Manager – sales, expenses, inventory, customers</option>
          <option value="CASHIER">Cashier – record sales and payments only</option>
          <option value="ACCOUNTANT">Accountant – accounting, tax, payroll, financial reports</option>
        </select>
      </div>

      {branches.length > 1 && (
        <div>
          <label className="mb-1 block text-sm font-medium">Restrict to a branch (optional)</label>
          <select name="branchId" className="erp-input">
            <option value="">All branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded bg-erp-primary py-2.5 font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
      >
        {loading ? "Sending..." : "Send Invitation"}
      </button>
    </form>
  );
}
