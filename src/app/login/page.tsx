"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

function LoginPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(e.currentTarget);
    const result = await signIn("credentials", {
      identifier: form.get("identifier"),
      password: form.get("password"),
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      setError("Invalid email/phone or password.");
      return;
    }

    router.push("/dashboard");
  }

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="mb-6 text-2xl font-bold">Log in</h1>
      {params.get("registered") && (
        <p className="mb-4 rounded-md bg-green-50 p-3 text-sm text-green-700">
          Account created. Log in to continue.
        </p>
      )}
      {params.get("invited") && (
        <p className="mb-4 rounded-md bg-green-50 p-3 text-sm text-green-700">
          You've joined the business. Log in to continue.
        </p>
      )}
      {error && <p className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <form onSubmit={handleSubmit} className="space-y-4">
        <input name="identifier" placeholder="Email or phone" required className="input" />
        <input name="password" type="password" placeholder="Password" required className="input" />
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-brand-600 py-2.5 font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {loading ? "Logging in..." : "Log In"}
        </button>
      </form>
      <p className="mt-4 text-sm text-gray-600">
        Forgot your password? <Link href="/forgot-password" className="text-brand-700 underline">Reset it</Link>
      </p>
    </main>
  );
}

// useSearchParams() needs a Suspense boundary or `next build` fails while prerendering this page.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}
