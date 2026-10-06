"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { NotificationBell } from "@/app/(app)/dashboard/notification-bell";
import { PermissionProvider } from "./permission-gate";
import { findActive, visibleNav, type NavGroup } from "./nav-config";

export type ShellContext = {
  businessId: string;
  businessName: string;
  businessCount: number;
  branchLabel: string;
  periodLabel: string;
  currency: string;
  timeZone: string;
  userName: string;
  role: string;
  planLabel: string | null;
  granted: string[];
  canViewNotifications: boolean;
  unreadCount: number;
  /** Saved choice from the `mbm.theme` cookie, read on the server so there is no light flash. */
  theme: "light" | "dark";
};

const COLLAPSE_KEY = "mbm.sidebar.collapsed";
const THEME_COOKIE = "mbm.theme";

export function AppShell({ ctx, children }: { ctx: ShellContext; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const granted = useMemo(() => new Set(ctx.granted), [ctx.granted]);
  const nav = useMemo(() => visibleNav(granted), [granted]);
  const active = findActive(pathname);

  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [dark, setDark] = useState(ctx.theme === "dark");

  // A cookie (not localStorage) so the server layout can render the saved theme on the first paint.
  function toggleTheme() {
    setDark((d) => {
      try {
        document.cookie = `${THEME_COOKIE}=${d ? "light" : "dark"}; path=/; max-age=31536000; SameSite=Lax`;
      } catch {}
      return !d;
    });
    setUserMenu(false);
  }

  // Restore the sidebar state after hydration (reading storage during render
  // would mismatch the server HTML). Storage can be blocked – never throw.
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {}
  }, []);
  function toggleCollapsed() {
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {}
      return !c;
    });
  }

  // The group holding the current page is open by default; others stay as the user left them.
  useEffect(() => {
    if (active.group) setOpenGroups((o) => ({ ...o, [active.group!.id]: true }));
    setMobileOpen(false);
    setUserMenu(false);
  }, [pathname]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
        setMobileOpen(false);
        setUserMenu(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const crumbs = [
    { label: "Home", href: "/dashboard" },
    ...(active.group && active.group.id !== "dashboard" ? [{ label: active.group.label, href: active.group.href }] : []),
    ...(active.item ? [{ label: active.item.label, href: undefined as string | undefined }] : []),
  ];

  const sidebar = (compact: boolean) => (
    <nav aria-label="Main navigation" className="flex-1 overflow-y-auto py-2">
      {nav.map((g) => (
        <SidebarGroup
          key={g.id}
          group={g}
          compact={compact}
          isActiveGroup={active.group?.id === g.id}
          activeHref={active.item?.href ?? active.group?.href}
          open={!!openGroups[g.id]}
          onToggle={() => setOpenGroups((o) => ({ ...o, [g.id]: !o[g.id] }))}
        />
      ))}
    </nav>
  );

  return (
    <PermissionProvider granted={ctx.granted}>
      <div className={`erp-root flex h-screen flex-col bg-erp-bg text-erp-text ${dark ? "dark" : ""}`}>
        {/* TOP HEADER */}
        <header className="erp-chrome flex h-12 shrink-0 items-center gap-2 border-b border-erp-border bg-erp-surface px-2 sm:px-3">
          <button
            type="button"
            aria-label="Open navigation"
            className="rounded p-2 text-erp-muted hover:bg-erp-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-erp-primary lg:hidden"
            onClick={() => setMobileOpen(true)}
          >
            ☰
          </button>
          <button
            type="button"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="hidden rounded p-2 text-erp-muted hover:bg-erp-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-erp-primary lg:block"
            onClick={toggleCollapsed}
          >
            ☰
          </button>
          <Link href="/dashboard" className="hidden text-sm font-semibold text-erp-primary sm:block">
            Malawi Business Manager
          </Link>
          <span className="hidden h-5 w-px bg-erp-border sm:block" />
          <div className="min-w-0 leading-tight" title={ctx.businessCount > 1 ? `${ctx.businessCount} businesses on this login – the first is active` : undefined}>
            <p className="truncate text-sm font-medium">{ctx.businessName}</p>
            <p className="hidden truncate text-[11px] text-erp-muted md:block">
              {ctx.branchLabel} · {ctx.periodLabel}
            </p>
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex items-center gap-2 rounded border border-erp-border bg-erp-bg px-2.5 py-1.5 text-xs text-erp-muted hover:border-erp-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-erp-primary"
            aria-label="Search pages (Ctrl+K)"
          >
            <span aria-hidden>⌕</span>
            <span className="hidden sm:inline">Go to page…</span>
            <kbd className="hidden rounded border border-erp-border px-1 text-[10px] sm:inline">Ctrl K</kbd>
          </button>
          {ctx.canViewNotifications && (
            <NotificationBell businessId={ctx.businessId} initialNotifications={[]} initialUnreadCount={ctx.unreadCount} />
          )}
          <div className="relative">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={userMenu}
              onClick={() => setUserMenu((o) => !o)}
              className="flex items-center gap-2 rounded px-2 py-1 text-left hover:bg-erp-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-erp-primary"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-erp-primary text-xs font-semibold text-erp-primary-fg">
                {(ctx.userName || "?").trim().charAt(0).toUpperCase()}
              </span>
              <span className="hidden leading-tight md:block">
                <span className="block text-xs font-medium">{ctx.userName}</span>
                <span className="block text-[10px] uppercase tracking-wide text-erp-muted">{ctx.role}</span>
              </span>
            </button>
            {userMenu && (
              <div role="menu" className="absolute right-0 z-50 mt-1 w-48 rounded border border-erp-border bg-erp-surface py-1 text-sm shadow-lg">
                {granted.has("business.subscription.manage") && (
                  <Link role="menuitem" href="/settings/billing" className="block px-3 py-1.5 hover:bg-erp-subtle">Billing</Link>
                )}
                {granted.has("business.settings.manage") && (
                  <Link role="menuitem" href="/settings/general" className="block px-3 py-1.5 hover:bg-erp-subtle">Business settings</Link>
                )}
                <Link role="menuitem" href="/help" className="block px-3 py-1.5 hover:bg-erp-subtle">Help</Link>
                <button role="menuitem" type="button" onClick={toggleTheme} className="block w-full px-3 py-1.5 text-left hover:bg-erp-subtle">
                  {dark ? "Light mode" : "Dark mode"}
                </button>
                <button role="menuitem" type="button" onClick={() => signOut({ callbackUrl: "/login" })} className="block w-full px-3 py-1.5 text-left text-erp-danger hover:bg-erp-subtle">
                  Sign out
                </button>
              </div>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* DESKTOP SIDEBAR */}
          <aside className={`erp-chrome hidden shrink-0 flex-col bg-erp-nav text-erp-nav-text lg:flex ${collapsed ? "w-14" : "w-60"}`}>
            {sidebar(collapsed)}
          </aside>

          {/* MOBILE DRAWER */}
          {mobileOpen && (
            <div className="erp-chrome fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
              <button type="button" aria-label="Close navigation" className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
              <aside className="relative flex h-full w-72 max-w-[85%] flex-col bg-erp-nav text-erp-nav-text">
                <div className="flex items-center justify-between border-b border-white/10 px-3 py-3 text-sm font-semibold text-white">
                  Malawi Business Manager
                  <button type="button" aria-label="Close navigation" onClick={() => setMobileOpen(false)} className="px-2">✕</button>
                </div>
                {sidebar(false)}
              </aside>
            </div>
          )}

          {/* WORKSPACE */}
          <div className="erp-workspace flex min-w-0 flex-1 flex-col overflow-y-auto">
            <nav aria-label="Breadcrumb" className="erp-chrome flex items-center gap-1.5 overflow-x-auto whitespace-nowrap border-b border-erp-border bg-erp-surface px-4 py-1.5 text-xs text-erp-muted">
              {crumbs.map((c, i) => (
                <span key={i} className="flex items-center gap-1.5">
                  {i > 0 && <span aria-hidden>/</span>}
                  {c.href && i < crumbs.length - 1 ? (
                    <Link href={c.href} className="hover:text-erp-primary hover:underline">{c.label}</Link>
                  ) : (
                    <span className={i === crumbs.length - 1 ? "font-medium text-erp-text" : ""}>{c.label}</span>
                  )}
                </span>
              ))}
            </nav>
            <div className="flex-1">{children}</div>
          </div>
        </div>

        {/* STATUS BAR */}
        <footer className="erp-chrome flex h-6 shrink-0 items-center gap-4 border-t border-erp-border bg-erp-surface px-3 text-[11px] text-erp-muted">
          <span className="truncate">{ctx.businessName}</span>
          <span className="hidden sm:inline">{ctx.branchLabel}</span>
          <span className="hidden sm:inline">{ctx.periodLabel}</span>
          <span>{ctx.currency}</span>
          <span className="hidden md:inline">{ctx.timeZone}</span>
          <span className="flex-1" />
          {ctx.planLabel && <span className="hidden sm:inline">{ctx.planLabel}</span>}
          <span className="text-erp-success">● Online</span>
        </footer>

        {paletteOpen && <Palette nav={nav} onClose={() => setPaletteOpen(false)} onGo={(href) => { setPaletteOpen(false); router.push(href); }} />}
      </div>
    </PermissionProvider>
  );
}

function SidebarGroup({ group, compact, isActiveGroup, activeHref, open, onToggle }: {
  group: NavGroup; compact: boolean; isActiveGroup: boolean; activeHref?: string; open: boolean; onToggle: () => void;
}) {
  const base = "flex w-full items-center gap-3 px-4 py-2 text-sm hover:bg-erp-nav-active focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white";
  const activeCls = isActiveGroup ? "bg-erp-nav-active text-white" : "";
  const icon = <span aria-hidden className="w-4 shrink-0 text-center">{group.icon}</span>;

  if (group.href) {
    return (
      <Link href={group.href} title={compact ? group.label : undefined} aria-current={activeHref === group.href ? "page" : undefined} className={`${base} ${activeCls}`}>
        {icon}
        {!compact && <span className="truncate">{group.label}</span>}
      </Link>
    );
  }
  // Collapsed rail: a group icon jumps to its first page; the tooltip names the group.
  if (compact) {
    return (
      <Link href={group.items[0].href} title={group.label} className={`${base} ${activeCls}`}>
        {icon}
      </Link>
    );
  }
  return (
    <div>
      <button type="button" onClick={onToggle} aria-expanded={open} className={`${base} ${activeCls}`}>
        {icon}
        <span className="flex-1 truncate text-left">{group.label}</span>
        <span aria-hidden className={`text-[10px] transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
      </button>
      {open && (
        <ul className="pb-1">
          {group.items.map((i) => (
            <li key={i.href}>
              <Link
                href={i.href}
                aria-current={activeHref === i.href ? "page" : undefined}
                className={`block truncate py-1.5 pl-11 pr-3 text-[13px] hover:bg-erp-nav-active hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white ${activeHref === i.href ? "bg-erp-nav-active font-medium text-white" : ""}`}
              >
                {i.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Ctrl+K – jumps to any page the member can see. Searching records (invoices,
// customers, journals…) needs a tenant-scoped search API that does not exist
// yet; this palette is intentionally page navigation only.
function Palette({ nav, onClose, onGo }: { nav: NavGroup[]; onClose: () => void; onGo: (href: string) => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const entries = useMemo(() => {
    const all = nav.flatMap((g) => (g.href ? [{ label: g.label, group: "", href: g.href }] : g.items.map((i) => ({ label: i.label, group: g.label, href: i.href }))));
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((e) => `${e.group} ${e.label}`.toLowerCase().includes(needle)) : all;
  }, [nav, q]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, entries.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter" && entries[sel]) { e.preventDefault(); onGo(entries[sel].href); }
  }

  return (
    <div className="erp-chrome fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Go to page" onMouseDown={onClose}>
      <div className="w-full max-w-lg rounded border border-erp-border bg-erp-surface shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={onKeyDown}
          placeholder="Go to page… (type, ↑ ↓, Enter)"
          aria-label="Search pages"
          className="w-full rounded-t border-b border-erp-border bg-transparent px-3 py-2.5 text-sm outline-none"
        />
        <ul className="max-h-72 overflow-y-auto py-1" role="listbox">
          {entries.length === 0 && <li className="px-3 py-3 text-sm text-erp-muted">No matching page.</li>}
          {entries.map((e, i) => (
            <li key={e.href} role="option" aria-selected={i === sel}>
              <button type="button" onClick={() => onGo(e.href)} onMouseEnter={() => setSel(i)} className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm ${i === sel ? "bg-erp-subtle" : ""}`}>
                <span>{e.label}</span>
                <span className="text-xs text-erp-muted">{e.group}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
