"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BUSINESS_TYPES, MALAWI_DISTRICTS } from "@/lib/validation";

// Functional but intentionally plain – real visual design (spec section 30)
// is a separate module. This exists to prove the register API end-to-end.
export default function RegisterPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(e.currentTarget);
    const payload = {
      ownerName: form.get("ownerName"),
      email: form.get("email"),
      phone: form.get("phone"),
      password: form.get("password"),
      businessName: form.get("businessName"),
      businessType: form.get("businessType"),
      district: form.get("district"),
      city: form.get("city"),
      physicalAddress: form.get("physicalAddress") || undefined,
      taxpayerId: form.get("taxpayerId") || undefined,
      currency: "MWK",
      financialYearStartMonth: 1,
      numberOfEmployees: Number(form.get("numberOfEmployees") || 0),
    };

    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Registration failed. Please check your details.");
      return;
    }

    router.push("/login?registered=1");
  }

  return (
    <main className="mx-auto max-w-lg p-8">
      <h1 className="mb-6 text-2xl font-bold">Create your business account</h1>
      {error && <p className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <form onSubmit={handleSubmit} className="space-y-4">
        <fieldset className="space-y-3 rounded-md border p-4">
          <legend className="px-1 text-sm font-semibold">Your account</legend>
          <input name="ownerName" placeholder="Your full name" required className="input" />
          <input name="email" type="email" placeholder="Email" required className="input" />
          <input name="phone" placeholder="Phone e.g. 0991234567" required className="input" />
          <input name="password" type="password" placeholder="Password" required className="input" />
        </fieldset>

        <fieldset className="space-y-3 rounded-md border p-4">
          <legend className="px-1 text-sm font-semibold">Your business</legend>
          <input name="businessName" placeholder="Business name" required className="input" />
          <select name="businessType" required className="input">
            <option value="">Select business type</option>
            {BUSINESS_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <select name="district" required className="input">
            <option value="">Select district</option>
            {MALAWI_DISTRICTS.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <input name="city" placeholder="City/Town" required className="input" />
          <input name="physicalAddress" placeholder="Physical address (optional)" className="input" />
          <input name="taxpayerId" placeholder="TIN (optional)" className="input" />
          <input name="numberOfEmployees" type="number" min={0} placeholder="Number of employees" className="input" />
        </fieldset>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-brand-600 py-2.5 font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {loading ? "Creating account..." : "Start Free 14-day Professional trial"}
        </button>
      </form>
    </main>
  );
}
