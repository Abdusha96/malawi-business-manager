"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PhoneHint } from "@/components/phone-hint";
import { Field } from "@/components/erp/display";

type BranchOption = { id: string; name: string };

export function NewEmployeeForm({
  businessId,
  branches = [],
}: {
  businessId: string;
  branches?: BranchOption[];
}) {
  const router = useRouter();
  const [branchId, setBranchId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [phone, setPhone] = useState("");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(e.currentTarget);
    const startDateValue = form.get("startDate") as string;
    const payload = {
      name: form.get("name"),
      phone: form.get("phone") || null,
      email: form.get("email") || null,
      position: form.get("position"),
      department: form.get("department") || null,
      monthlySalary: Number(form.get("monthlySalary")),
      startDate: new Date(startDateValue).toISOString(),
      bankName: form.get("bankName") || null,
      bankAccountNumber: form.get("bankAccountNumber") || null,
      taxpayerId: form.get("taxpayerId") || null,
      branchId: branchId || null,
    };

    const res = await fetch(`/api/business/${businessId}/employees`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Could not save employee.");
      return;
    }

    router.push(`/employees/${data.employee.id}`);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <p role="alert" className="rounded border border-erp-danger/40 bg-erp-danger/10 p-3 text-sm text-erp-danger">{error}</p>}

      <Field label="Full name" htmlFor="emp-name" required>
        <input id="emp-name" name="name" required className="erp-input" />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Phone" htmlFor="emp-phone" hint="Optional">
          <input id="emp-phone" name="phone" className="erp-input" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <PhoneHint value={phone} />
        </Field>
        <Field label="Email" htmlFor="emp-email" hint="Optional">
          <input id="emp-email" name="email" type="email" className="erp-input" />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Position" htmlFor="emp-position" required>
          <input id="emp-position" name="position" required className="erp-input" />
        </Field>
        <Field label="Department" htmlFor="emp-department" hint="Optional">
          <input id="emp-department" name="department" className="erp-input" />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Monthly salary (MWK)" htmlFor="emp-salary" required>
          <input id="emp-salary" name="monthlySalary" type="number" min="0" step="0.01" required className="erp-input" />
        </Field>
        <Field label="Start date" htmlFor="emp-start" required>
          <input id="emp-start" name="startDate" type="date" required className="erp-input" />
        </Field>
      </div>

      {branches.length > 0 && (
        <Field label="Branch" htmlFor="emp-branch">
          <select id="emp-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)} className="erp-input">
            <option value="">Not attributed to a branch</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </Field>
      )}

      <fieldset className="space-y-3 rounded border border-erp-border p-4">
        <legend className="px-1 text-sm font-semibold text-erp-text">Bank &amp; Tax (optional)</legend>
        <Field label="Bank name" htmlFor="emp-bank">
          <input id="emp-bank" name="bankName" className="erp-input" />
        </Field>
        <Field label="Bank account number" htmlFor="emp-account">
          <input id="emp-account" name="bankAccountNumber" className="erp-input" />
        </Field>
        <Field label="TIN" htmlFor="emp-tin">
          <input id="emp-tin" name="taxpayerId" className="erp-input" />
        </Field>
      </fieldset>

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded bg-erp-primary py-2 font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60 sm:w-auto sm:px-6"
      >
        {loading ? "Saving..." : "Add Employee"}
      </button>
    </form>
  );
}
