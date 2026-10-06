"use client";

import { useState } from "react";
import Link from "next/link";
import { PLAN_DEFINITIONS, TRIAL_LENGTH_DAYS } from "@/lib/plans";
import { BillingToggle } from "./client";
import { CheckItem, SectionHeading } from "./ui";

// Prices come from the same plan definitions the billing system seeds from, so
// the landing page can never drift from what a customer is actually charged.
const COPY: Record<string, { tagline: string; features: string[]; cta: string; href: string; featured?: boolean }> = {
  FREE: {
    tagline: "For small businesses getting organized.",
    features: ["1 user and 1 branch", "Up to 50 sales per month", "Inventory, customers and expenses", "Core financial records"],
    cta: "Start Free",
    href: "/register",
  },
  BUSINESS: {
    tagline: "For growing businesses that need more control.",
    features: ["Unlimited sales", "Unlimited users", "Suppliers and purchasing", "1 branch"],
    cta: "Start Free",
    href: "/register",
  },
  PROFESSIONAL: {
    tagline: "For businesses running payroll, tax and several branches.",
    features: ["Everything in Business", "Multiple branches", "Payroll with PAYE and pension", "Tax calculations and calendar", "Advanced reports", "Mobi Accountant AI assistant"],
    cta: "Start Free",
    href: "/register",
    featured: true,
  },
  ENTERPRISE: {
    tagline: "For larger businesses with bespoke needs.",
    features: ["Everything in Professional", "Custom pricing", "Plan and limits agreed with you"],
    cta: "Talk to Us",
    href: "/contact",
  },
};

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

export function PricingSection() {
  const [annual, setAnnual] = useState(false);
  return (
    <section id="pricing" className="scroll-mt-20 py-20 sm:py-28" aria-labelledby="pricing-title">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <SectionHeading eyebrow="Pricing" id="pricing-title" title="Simple plans that grow with you." description={`Every new business starts with a ${TRIAL_LENGTH_DAYS}-day trial of the Professional plan. Prices are in Malawi Kwacha.`} />
        <div className="mt-8 flex justify-center">
          <BillingToggle annual={annual} onChange={setAnnual} />
        </div>

        <div className="mt-12 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          {PLAN_DEFINITIONS.map((p) => {
            const c = COPY[p.key];
            const perMonth = annual ? p.annualPriceMWK / 12 : p.monthlyPriceMWK;
            return (
              <div key={p.key} className={`relative flex flex-col rounded-2xl border p-7 ${c.featured ? "border-brand-600 bg-ink-900 text-white shadow-float" : "border-ink-100 bg-white shadow-card"}`}>
                {c.featured && <span className="absolute -top-3 left-7 rounded-full bg-brand-600 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-white">Most complete</span>}
                <h3 className="text-lg font-bold">{p.name}</h3>
                <p className={`mt-1 min-h-[2.5rem] text-sm ${c.featured ? "text-ink-200" : "text-ink-500"}`}>{c.tagline}</p>
                <div className="mt-5">
                  {p.isCustomPricing ? (
                    <p className="text-3xl font-extrabold">Custom</p>
                  ) : p.monthlyPriceMWK === 0 ? (
                    <p className="text-3xl font-extrabold">MWK 0</p>
                  ) : (
                    <p className="whitespace-nowrap text-2xl font-extrabold tabular-nums 2xl:text-3xl">
                      MWK {fmt(perMonth)}
                      <span className={`ml-1 whitespace-nowrap text-sm font-medium ${c.featured ? "text-ink-300" : "text-ink-400"}`}>/ month</span>
                    </p>
                  )}
                  <p className={`mt-1 h-5 text-xs ${c.featured ? "text-ink-300" : "text-ink-400"}`}>
                    {annual && p.annualPriceMWK > 0 ? `Billed MWK ${fmt(p.annualPriceMWK)} yearly` : p.monthlyPriceMWK > 0 ? "Billed monthly" : ""}
                  </p>
                </div>
                <ul className="mt-5 flex-1 space-y-2.5 text-sm">
                  {c.features.map((f) => <CheckItem key={f} invert={c.featured}>{f}</CheckItem>)}
                </ul>
                <Link href={c.href} className={`mt-7 rounded-lg px-4 py-3 text-center text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700 ${c.featured ? "bg-brand-600 text-white hover:bg-brand-500" : "border border-ink-200 text-ink-800 hover:bg-ink-50"}`}>
                  {c.cta}
                </Link>
              </div>
            );
          })}
        </div>
        <p className="mt-6 text-center text-xs text-ink-400">Plan limits and prices are managed in the billing system and may change. Your current plan is always shown in Settings → Billing.</p>
      </div>
    </section>
  );
}
