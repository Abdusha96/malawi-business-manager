import type { ReactNode } from "react";
import Link from "next/link";
import { Footer } from "./sections-b";
import { LandingNavbar } from "./client";

export const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? "";

/** Shared shell for the small public pages linked from the landing footer. */
export function InfoPage({ eyebrow, title, intro, children, draftNotice = false }: {
  eyebrow: string; title: string; intro?: string; children: ReactNode; draftNotice?: boolean;
}) {
  return (
    <>
      <LandingNavbar />
      <main id="main" className="mx-auto max-w-3xl px-5 py-16 sm:px-8 sm:py-24">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-700">{eyebrow}</p>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-ink-900 sm:text-4xl">{title}</h1>
        {intro && <p className="mt-4 text-lg leading-relaxed text-ink-500">{intro}</p>}
        {draftNotice && (
          <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            This page is a plain-language description of how the product works. It has not yet been reviewed by a lawyer and may be updated.
          </p>
        )}
        <div className="mt-10 space-y-8 leading-relaxed text-ink-600 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:text-ink-900 [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1.5 [&_a]:font-medium [&_a]:text-brand-700 [&_a]:underline">
          {children}
        </div>
        <p className="mt-14 text-sm"><Link href="/" className="font-semibold text-brand-700">← Back to home</Link></p>
      </main>
      <Footer />
    </>
  );
}

export function ContactLine() {
  return CONTACT_EMAIL ? (
    <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
  ) : (
    <span>the contact address shown on your account's billing receipts</span>
  );
}
