"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Logo } from "./ui";

/* Marks the document and reveals `.reveal` elements as they scroll in.
   Without JS (or with reduced motion) everything is simply visible. */
export function RevealController() {
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !("IntersectionObserver" in window)) return;
    const els = Array.from(document.querySelectorAll<HTMLElement>(".reveal"));
    document.documentElement.classList.add("js-reveal");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("is-visible");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    els.forEach((el) => io.observe(el));
    return () => {
      io.disconnect();
      document.documentElement.classList.remove("js-reveal");
    };
  }, []);
  return null;
}

/* Counts up once when scrolled into view. Server-rendered with the final
   value so crawlers and no-JS visitors see the real number. */
export function Counter({ value, prefix = "", suffix = "" }: { value: number; prefix?: string; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(value);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    let raf = 0;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        const start = performance.now();
        const dur = 1100;
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / dur);
          setShown(Math.round(value * (1 - Math.pow(1 - t, 3))));
          if (t < 1) raf = requestAnimationFrame(tick);
        };
        setShown(0);
        raf = requestAnimationFrame(tick);
      },
      { threshold: 0.4 }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [value]);

  return (
    <span ref={ref}>
      {prefix}
      {shown.toLocaleString("en-US")}
      {suffix}
    </span>
  );
}

const NAV = [
  { href: "/#product", label: "Product" },
  { href: "/#solutions", label: "Solutions" },
  { href: "/#features", label: "Features" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/#resources", label: "Resources" },
];

export function LandingNavbar() {
  const [compact, setCompact] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setCompact(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header
      className={`sticky top-0 z-50 border-b transition-all duration-300 ${
        compact ? "border-ink-100 bg-white/90 py-2 shadow-sm backdrop-blur" : "border-transparent bg-white/70 py-4 backdrop-blur-sm"
      }`}
    >
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:shadow"
      >
        Skip to content
      </a>
      <nav aria-label="Main" className="mx-auto flex max-w-7xl items-center justify-between px-5 sm:px-8">
        <Link href="/" aria-label="Malawi Business Manager home" className="rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-700">
          <Logo />
        </Link>

        <ul className="hidden items-center gap-1 lg:flex">
          {NAV.map((n) => (
            <li key={n.href}>
              <a href={n.href} className="rounded-md px-3.5 py-2 text-sm font-medium text-ink-600 transition hover:bg-ink-100 hover:text-ink-900">
                {n.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="hidden items-center gap-2 lg:flex">
          <Link href="/login" className="rounded-lg px-4 py-2 text-sm font-semibold text-ink-700 transition hover:bg-ink-100">
            Log in
          </Link>
          <Link href="/register" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700">
            Start Free
          </Link>
        </div>

        <button
          type="button"
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-ink-800 hover:bg-ink-100 lg:hidden"
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((o) => !o)}
        >
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
      </nav>

      {open && (
        <div id="mobile-menu" className="border-t border-ink-100 bg-white px-5 pb-5 pt-3 lg:hidden">
          <ul className="space-y-1">
            {NAV.map((n) => (
              <li key={n.href}>
                <a href={n.href} onClick={() => setOpen(false)} className="block rounded-md px-3 py-3 text-base font-medium text-ink-700 hover:bg-ink-50">
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Link href="/login" className="rounded-lg border border-ink-200 px-4 py-3 text-center text-sm font-semibold text-ink-800">
              Log in
            </Link>
            <Link href="/register" className="rounded-lg bg-brand-600 px-4 py-3 text-center text-sm font-semibold text-white">
              Start Free
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}

/* Monthly / annual toggle; owns only the billing-cycle state. */
export function BillingToggle({ annual, onChange }: { annual: boolean; onChange: (v: boolean) => void }) {
  return (
    <div role="group" aria-label="Billing period" className="inline-flex rounded-full border border-ink-200 bg-white p-1 text-sm font-semibold">
      {[
        { label: "Monthly", v: false },
        { label: "Annual", v: true },
      ].map((o) => (
        <button
          key={o.label}
          type="button"
          aria-pressed={annual === o.v}
          onClick={() => onChange(o.v)}
          className={`rounded-full px-5 py-2 transition ${annual === o.v ? "bg-ink-900 text-white" : "text-ink-600 hover:text-ink-900"}`}
        >
          {o.label}
          {o.v && <span className={`ml-2 text-xs ${annual ? "text-brand-300" : "text-brand-700"}`}>Save 15%</span>}
        </button>
      ))}
    </div>
  );
}
