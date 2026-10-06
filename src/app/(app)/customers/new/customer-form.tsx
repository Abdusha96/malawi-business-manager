"use client";

import { useState } from "react";
import { PhoneHint } from "@/components/phone-hint";
import { useRouter } from "next/navigation";
import { CUSTOMER_TYPES } from "@/lib/validation";
import { Field, FormCard } from "@/components/erp/display";

export function NewCustomerForm({ businessId }: { businessId: string }) {
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
      customerType: form.get("customerType"),
      phone: form.get("phone") || null,
      email: form.get("email") || null,
      address: form.get("address") || null,
      creditLimit: Number(form.get("creditLimit") || 0),
    };

    const res = await fetch(`/api/business/${businessId}/customers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Could not save customer.");
      return;
    }

    router.push(`/customers/${data.customer.id}`);
  }

  return (
    <FormCard>
      <form onSubmit={handleSubmit} className="space-y-3">
        {error && <p role="alert" className="rounded border border-erp-danger/30 bg-erp-danger/10 p-2.5 text-sm text-erp-danger">{error}</p>}

        <Field label="Customer name" htmlFor="c-name" required>
          <input id="c-name" name="name" required autoFocus className="erp-input" />
        </Field>
        <Field label="Type" htmlFor="c-type">
          <select id="c-type" name="customerType" defaultValue="INDIVIDUAL" className="erp-input">
            {CUSTOMER_TYPES.map((t) => (
              <option key={t} value={t}>{t === "INDIVIDUAL" ? "Individual" : "Business"}</option>
            ))}
          </select>
        </Field>
        <Field label="Phone" htmlFor="c-phone">
          <input id="c-phone" name="phone" className="erp-input" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <PhoneHint value={phone} />
        </Field>
        <Field label="Email" htmlFor="c-email">
          <input id="c-email" name="email" type="email" className="erp-input" />
        </Field>
        <Field label="Address" htmlFor="c-address">
          <input id="c-address" name="address" className="erp-input" />
        </Field>
        <Field label="Credit limit (MWK)" htmlFor="c-limit" hint="Leave blank for no limit.">
          <input id="c-limit" name="creditLimit" type="number" min="0" step="0.01" className="erp-input" />
        </Field>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded bg-erp-primary py-2 text-sm font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60"
        >
          {loading ? "Saving..." : "Add Customer"}
        </button>
      </form>
    </FormCard>
  );
}
