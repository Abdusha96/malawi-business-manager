import Link from "next/link";
import Image from "next/image";
import type { ReactNode } from "react";

/* ---------- Button ---------- */
type ButtonProps = {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary" | "dark" | "light" | "ghost";
  size?: "md" | "lg";
  className?: string;
};

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700";
const buttonVariants: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary: "bg-brand-600 text-white shadow-sm hover:bg-brand-700",
  secondary: "border border-ink-200 bg-white text-ink-800 hover:border-ink-300 hover:bg-ink-50",
  dark: "bg-ink-900 text-white hover:bg-ink-800",
  light: "bg-white text-ink-900 hover:bg-ink-50",
  ghost: "text-ink-700 hover:bg-ink-100",
};
const buttonSizes = { md: "px-4 py-2.5 text-sm", lg: "px-6 py-3.5 text-base" };

export function Button({ href, children, variant = "primary", size = "md", className = "" }: ButtonProps) {
  return (
    <Link href={href} className={`${buttonBase} ${buttonVariants[variant]} ${buttonSizes[size]} ${className}`}>
      {children}
    </Link>
  );
}

/* ---------- Badge ---------- */
export function Badge({ children, tone = "brand" }: { children: ReactNode; tone?: "brand" | "ink" | "amber" | "red" }) {
  const tones = {
    brand: "bg-brand-50 text-brand-800 ring-brand-200",
    ink: "bg-ink-100 text-ink-700 ring-ink-200",
    amber: "bg-amber-50 text-amber-800 ring-amber-200",
    red: "bg-red-50 text-red-700 ring-red-200",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ring-1 ring-inset ${tones[tone]}`}>
      {children}
    </span>
  );
}

/* ---------- Card ---------- */
export function Card({ children, className = "", hover = false }: { children: ReactNode; className?: string; hover?: boolean }) {
  return (
    <div
      className={`rounded-2xl border border-ink-100 bg-white shadow-card ${
        hover ? "transition duration-300 hover:-translate-y-1 hover:shadow-float" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

/* ---------- SectionHeading ---------- */
export function SectionHeading({
  eyebrow,
  title,
  description,
  align = "center",
  invert = false,
  id,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  align?: "center" | "left";
  invert?: boolean;
  id?: string;
}) {
  return (
    <div className={`reveal max-w-3xl ${align === "center" ? "mx-auto text-center" : ""}`}>
      {eyebrow && (
        <p className={`mb-3 text-xs font-bold uppercase tracking-[0.18em] ${invert ? "text-brand-300" : "text-brand-700"}`}>{eyebrow}</p>
      )}
      <h2 id={id} className={`text-3xl font-bold tracking-tight sm:text-4xl ${invert ? "text-white" : "text-ink-900"}`}>
        {title}
      </h2>
      {description && (
        <p className={`mt-4 text-lg leading-relaxed ${invert ? "text-ink-200" : "text-ink-500"}`}>{description}</p>
      )}
    </div>
  );
}

/* ---------- FeatureIcon (inline SVG paths, no icon dependency) ---------- */
const ICONS: Record<string, string> = {
  ledger: "M4 5h16M4 10h16M4 15h10M4 20h7",
  cart: "M3 4h2l2.4 11h10.2L20 7H6.2M9 20a1 1 0 100-2 1 1 0 000 2zm8 0a1 1 0 100-2 1 1 0 000 2z",
  box: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zm0 9l8-4.5M12 12v9M12 12L4 7.5",
  truck: "M3 7h11v9H3zM14 10h4l3 3v3h-7M7 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm10 0a1.5 1.5 0 100-3 1.5 1.5 0 000 3z",
  bank: "M3 9l9-5 9 5M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18",
  users: "M16 19v-1.5a3.5 3.5 0 00-3.5-3.5h-5A3.5 3.5 0 004 17.5V19M10 11a3 3 0 100-6 3 3 0 000 6zm10 8v-1.5a3.5 3.5 0 00-2.5-3.35M15.5 5.2a3 3 0 010 5.6",
  percent: "M19 5L5 19M7.5 9a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm9 9a1.5 1.5 0 100-3 1.5 1.5 0 000 3z",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  shield: "M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6l8-3zM9 12l2 2 4-4",
  lock: "M7 11V8a5 5 0 0110 0v3M6 11h12v9H6z",
  branch: "M6 3v12m0 0a3 3 0 100 6 3 3 0 000-6zm12-6a3 3 0 100-6 3 3 0 000 6zm0 0c0 4-6 3-12 6",
  phone: "M8 3h8a1 1 0 011 1v16a1 1 0 01-1 1H8a1 1 0 01-1-1V4a1 1 0 011-1zm3 16h2",
  doc: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6",
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18zm0-14v5l3 2",
  check: "M5 12.5l4.5 4.5L19 7.5",
  arrow: "M5 12h14m-5-5l5 5-5 5",
  coin: "M12 21a9 9 0 100-18 9 9 0 000 18zm0-12v6m-2.5-4.5h4a1.5 1.5 0 010 3h-3a1.5 1.5 0 000 3H15",
  user: "M12 12a4 4 0 100-8 4 4 0 000 8zm-7 8a7 7 0 0114 0",
  cloud: "M7 18a4 4 0 01-.6-7.95A6 6 0 0118 9.5 4.25 4.25 0 0117 18H7z",
  store: "M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9a2.67 2.67 0 005.33 0 2.67 2.67 0 005.34 0A2.67 2.67 0 0020 9M10 20v-5h4v5",
  wrench: "M14.7 6.3a4 4 0 005 5L21 13l-8 8-3-3 8-8-1.3-1.7zM4 20l4-4",
  trend: "M3 17l6-6 4 4 8-9M15 6h6v6",
};

export function FeatureIcon({ name, className = "", tone = "brand" }: { name: keyof typeof ICONS | string; className?: string; tone?: "brand" | "ink" | "white" }) {
  const toneClass = {
    brand: "bg-brand-50 text-brand-700 ring-brand-100",
    ink: "bg-ink-100 text-ink-700 ring-ink-200",
    white: "bg-white/10 text-white ring-white/20",
  }[tone];
  return (
    <span className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset ${toneClass} ${className}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d={ICONS[name] ?? ICONS.check} />
      </svg>
    </span>
  );
}

export function CheckItem({ children, invert = false }: { children: ReactNode; invert?: boolean }) {
  return (
    <li className="flex items-start gap-2.5">
      <svg viewBox="0 0 24 24" className={`mt-0.5 h-4 w-4 shrink-0 ${invert ? "text-brand-300" : "text-brand-600"}`} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={ICONS.check} />
      </svg>
      <span className={invert ? "text-ink-100" : "text-ink-600"}>{children}</span>
    </li>
  );
}

/* ---------- Logo ---------- */
export function Logo({ invert = false }: { invert?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white" aria-hidden="true">
        <Image
          src="/brand/malawi-business-manager-app-icon.png"
          alt=""
          width={32}
          height={32}
          className="h-8 w-8 rounded-lg object-cover"
        />
      </span>
      <span className={`text-[15px] font-bold tracking-tight ${invert ? "text-white" : "text-ink-900"}`}>Malawi Business Manager</span>
    </span>
  );
}
