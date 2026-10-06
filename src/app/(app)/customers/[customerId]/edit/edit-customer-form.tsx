"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CUSTOMER_TYPES } from "@/lib/validation";
import { Field, FormCard } from "@/components/erp/display";
import { PhoneHint } from "@/components/phone-hint";

interface CustomerValues {
  name: string;
  customerType: (typeof CUSTOMER_TYPES)[number];
  phone: string;
  email: string;
  address: string;
  creditLimit: number;
  isActive: boolean;
}

export function EditCustomerForm({ businessId, customerId, initial }: { businessId: string; customerId: string; initial: CustomerValues }) {
  const router = useRouter();
  const [phone, setPhone] = useState(initial.phone);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(`/api/business/${businessId}/customers/${customerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          customerType: form.get("customerType"),
          phone: form.get("phone") || null,
          email: form.get("email") || null,
          address: form.get("address") || null,
          creditLimit: Number(form.get("creditLimit") || 0),
          isActive: form.get("isActive") === "on",
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.message ?? "Could not update customer. Check the values and try again.");
        return;
      }
      router.push(`/customers/${customerId}`);
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormCard>
      <form onSubmit={handleSubmit} className="space-y-3">
        {error && <p role="alert" className="rounded border border-erp-danger/30 bg-erp-danger/10 p-2.5 text-sm text-erp-danger">{error}</p>}
        <Field label="Customer name" htmlFor="edit-c-name" required>
          <input id="edit-c-name" name="name" defaultValue={initial.name} required autoFocus className="erp-input" />
        </Field>
        <Field label="Type" htmlFor="edit-c-type">
          <select id="edit-c-type" name="customerType" defaultValue={initial.customerType} className="erp-input">
            {CUSTOMER_TYPES.map((type) => <option key={type} value={type}>{type === "INDIVIDUAL" ? "Individual" : "Business"}</option>)}
          </select>
        </Field>
        <Field label="Phone" htmlFor="edit-c-phone">
          <input id="edit-c-phone" name="phone" className="erp-input" value={phone} onChange={(event) => setPhone(event.target.value)} />
          <PhoneHint value={phone} />
        </Field>
        <Field label="Email" htmlFor="edit-c-email">
          <input id="edit-c-email" name="email" type="email" defaultValue={initial.email} className="erp-input" />
        </Field>
        <Field label="Address" htmlFor="edit-c-address">
          <input id="edit-c-address" name="address" defaultValue={initial.address} className="erp-input" />
        </Field>
        <Field label="Credit limit (MWK)" htmlFor="edit-c-limit" hint="Enter 0 for no limit.">
          <input id="edit-c-limit" name="creditLimit" type="number" min="0" step="0.01" defaultValue={initial.creditLimit} className="erp-input" />
        </Field>
        <label className="flex items-center gap-2 text-sm text-erp-text">
          <input name="isActive" type="checkbox" defaultChecked={initial.isActive} className="size-4 accent-erp-primary" />
          Active customer (inactive customers can’t be selected for new sales)
        </label>
        <div className="flex gap-2">
          <button type="submit" disabled={saving} className="flex-1 rounded bg-erp-primary py-2 text-sm font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60">
            {saving ? "Saving…" : "Save changes"}
          </button>
          <Link href={`/customers/${customerId}`} className="rounded border border-erp-border px-4 py-2 text-sm text-erp-text hover:bg-erp-subtle">Cancel</Link>
        </div>
      </form>
    </FormCard>
  );
}
