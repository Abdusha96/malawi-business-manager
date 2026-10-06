"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Field, FormCard } from "@/components/erp/display";
import { PhoneHint } from "@/components/phone-hint";

interface SupplierValues {
  name: string;
  phone: string;
  email: string;
  address: string;
  isActive: boolean;
}

export function EditSupplierForm({ businessId, supplierId, initial }: { businessId: string; supplierId: string; initial: SupplierValues }) {
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
      const response = await fetch(`/api/business/${businessId}/suppliers/${supplierId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          phone: form.get("phone") || null,
          email: form.get("email") || null,
          address: form.get("address") || null,
          isActive: form.get("isActive") === "on",
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.message ?? "Could not update supplier. Check the values and try again.");
        return;
      }
      router.push(`/suppliers/${supplierId}`);
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
        <Field label="Supplier name" htmlFor="edit-s-name" required>
          <input id="edit-s-name" name="name" defaultValue={initial.name} required autoFocus className="erp-input" />
        </Field>
        <Field label="Phone" htmlFor="edit-s-phone">
          <input id="edit-s-phone" name="phone" className="erp-input" value={phone} onChange={(event) => setPhone(event.target.value)} />
          <PhoneHint value={phone} />
        </Field>
        <Field label="Email" htmlFor="edit-s-email">
          <input id="edit-s-email" name="email" type="email" defaultValue={initial.email} className="erp-input" />
        </Field>
        <Field label="Address" htmlFor="edit-s-address">
          <input id="edit-s-address" name="address" defaultValue={initial.address} className="erp-input" />
        </Field>
        <label className="flex items-center gap-2 text-sm text-erp-text">
          <input name="isActive" type="checkbox" defaultChecked={initial.isActive} className="size-4 accent-erp-primary" />
          Active supplier (inactive suppliers can’t be selected for new purchases)
        </label>
        <div className="flex gap-2">
          <button type="submit" disabled={saving} className="flex-1 rounded bg-erp-primary py-2 text-sm font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60">
            {saving ? "Saving…" : "Save changes"}
          </button>
          <Link href={`/suppliers/${supplierId}`} className="rounded border border-erp-border px-4 py-2 text-sm text-erp-text hover:bg-erp-subtle">Cancel</Link>
        </div>
      </form>
    </FormCard>
  );
}
