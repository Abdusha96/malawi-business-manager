"use client";

import { useState } from "react";
import { PhoneHint } from "@/components/phone-hint";
import { useRouter } from "next/navigation";
import { Field, FormCard } from "@/components/erp/display";

export function NewSupplierForm({ businessId }: { businessId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [phone, setPhone] = useState("");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(e.currentTarget);
    const payload = {
      name: form.get("name"),
      phone: form.get("phone") || null,
      email: form.get("email") || null,
      address: form.get("address") || null,
    };

    const res = await fetch(`/api/business/${businessId}/suppliers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Could not save supplier.");
      return;
    }

    router.push(`/suppliers/${data.supplier.id}`);
  }

  return (
    <FormCard>
      <form onSubmit={handleSubmit} className="space-y-3">
        {error && <p role="alert" className="rounded border border-erp-danger/30 bg-erp-danger/10 p-2.5 text-sm text-erp-danger">{error}</p>}

        <Field label="Supplier name" htmlFor="s-name" required>
          <input id="s-name" name="name" required autoFocus className="erp-input" />
        </Field>
        <Field label="Phone" htmlFor="s-phone">
          <input id="s-phone" name="phone" className="erp-input" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <PhoneHint value={phone} />
        </Field>
        <Field label="Email" htmlFor="s-email">
          <input id="s-email" name="email" type="email" className="erp-input" />
        </Field>
        <Field label="Address" htmlFor="s-address">
          <input id="s-address" name="address" className="erp-input" />
        </Field>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded bg-erp-primary py-2 text-sm font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
        >
          {loading ? "Saving..." : "Add Supplier"}
        </button>
      </form>
    </FormCard>
  );
}
