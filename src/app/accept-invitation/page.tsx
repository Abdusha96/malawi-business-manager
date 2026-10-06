"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";

type InvitationInfo = {
  businessName: string;
  email: string;
  role: string;
  branchName: string | null;
  hasExistingAccount: boolean;
};

function AcceptInvitationPageInner() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") ?? "";

  const [info, setInfo] = useState<InvitationInfo | null>(null);
  const [notFoundReason, setNotFoundReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setNotFoundReason("invalid");
      return;
    }
    fetch(`/api/invitations/${token}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) {
          setNotFoundReason(data.error ?? "invalid");
          return;
        }
        setInfo(data);
      })
      .catch(() => setNotFoundReason("invalid"));
  }, [token]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(e.currentTarget);
    const payload: Record<string, unknown> = { token };
    if (!info?.hasExistingAccount) {
      payload.name = form.get("name");
      payload.password = form.get("password");
      payload.phone = form.get("phone") || undefined;
    }

    const res = await fetch("/api/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Could not accept this invitation.");
      return;
    }

    router.push("/login?invited=1");
  }

  if (notFoundReason) {
    const messages: Record<string, string> = {
      invalid: "This invitation link isn't valid.",
      revoked: "This invitation has been revoked by the business.",
      already_used: "This invitation has already been accepted.",
      expired: "This invitation has expired. Ask the business to send a new one.",
    };
    return (
      <main className="mx-auto max-w-md p-8">
        <h1 className="mb-4 text-2xl font-bold">Invitation</h1>
        <p className="text-gray-600">{messages[notFoundReason] ?? messages.invalid}</p>
        <Link href="/login" className="mt-4 inline-block text-brand-700 underline">Go to login</Link>
      </main>
    );
  }

  if (!info) {
    return (
      <main className="mx-auto max-w-md p-8">
        <p className="text-gray-500">Loading invitation...</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="mb-2 text-2xl font-bold">Join {info.businessName}</h1>
      <p className="mb-6 text-gray-600">
        You've been invited as <strong>{info.role}</strong>
        {info.branchName ? ` at ${info.branchName}` : ""} – signing in as {info.email}.
      </p>

      {error && <p className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <form onSubmit={handleSubmit} className="space-y-4">
        {info.hasExistingAccount ? (
          <p className="text-sm text-gray-500">
            You already have an account with this email. Accept below, then log in as usual.
          </p>
        ) : (
          <>
            <input name="name" placeholder="Your full name" required className="input" />
            <input name="phone" placeholder="Phone (optional)" className="input" />
            <input name="password" type="password" placeholder="Choose a password" required className="input" />
            <p className="text-xs text-gray-400">At least 8 characters, with an uppercase letter, lowercase letter, and a number.</p>
          </>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-brand-600 py-2.5 font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {loading ? "Joining..." : info.hasExistingAccount ? "Accept Invitation" : "Create Account & Join"}
        </button>
      </form>
    </main>
  );
}

// useSearchParams() needs a Suspense boundary or `next build` fails while prerendering this page.
export default function AcceptInvitationPage() {
  return (
    <Suspense fallback={null}>
      <AcceptInvitationPageInner />
    </Suspense>
  );
}
