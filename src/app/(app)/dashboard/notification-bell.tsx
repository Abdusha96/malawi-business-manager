"use client";

import { useState } from "react";
import Link from "next/link";

type Severity = "INFO" | "WARNING" | "URGENT";

export type BellNotification = {
  id: string;
  type: string;
  severity: Severity;
  title: string;
  body: string;
  linkHref: string | null;
  isRead: boolean;
  createdAt: string;
};

const SEVERITY_STYLE: Record<Severity, string> = {
  URGENT: "border-erp-danger/40 bg-erp-danger/10 text-erp-danger",
  WARNING: "border-erp-warning/40 bg-erp-warning/10 text-erp-warning",
  INFO: "border-erp-border bg-erp-subtle text-erp-muted",
};

// Module 25 – the notification bell. Server-rendered with an already-synced
// initial list/count (see the dashboard page), then self-contained from
// here: reopening refetches for freshness, and read/dismiss/mark-all-read
// each hit their API route and update local state optimistically rather
// than forcing a full page reload.
export function NotificationBell({
  businessId,
  initialNotifications,
  initialUnreadCount,
}: {
  businessId: string;
  initialNotifications: BellNotification[];
  initialUnreadCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<BellNotification[]>(initialNotifications);
  const [unreadCount, setUnreadCount] = useState(initialUnreadCount);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch(`/api/business/${businessId}/notifications/in-app`);
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications);
        setUnreadCount(data.unreadCount);
      }
    } finally {
      setLoading(false);
    }
  }

  async function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next) await refresh();
  }

  async function act(id: string, action: "read" | "dismiss") {
    const target = notifications.find((n) => n.id === id);
    const res = await fetch(`/api/business/${businessId}/notifications/in-app/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) return;

    if (action === "dismiss") {
      setNotifications((prev) => prev.filter((n) => n.id !== id));
      if (target && !target.isRead) setUnreadCount((prev) => Math.max(0, prev - 1));
    } else {
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
      if (target && !target.isRead) setUnreadCount((prev) => Math.max(0, prev - 1));
    }
  }

  async function markAllRead() {
    const res = await fetch(`/api/business/${businessId}/notifications/in-app`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mark_all_read" }),
    });
    if (res.ok) {
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
      setUnreadCount(0);
    }
  }

  return (
    <div className="relative">
      <button
        onClick={toggleOpen}
        aria-label="Notifications"
        className="relative rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle"
      >
        🔔
        {unreadCount > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-erp-danger px-1 text-[10px] font-bold text-erp-primary-fg">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-x-2 top-14 z-50 rounded border sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:z-20 sm:mt-2 sm:w-80 border border-erp-border bg-erp-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-erp-border px-3 py-2">
            <span className="text-sm font-semibold">Alerts</span>
            <div className="flex items-center gap-3">
              {notifications.some((n) => !n.isRead) && (
                <button onClick={markAllRead} className="text-xs text-erp-primary underline">
                  Mark all read
                </button>
              )}
              <Link href="/notifications" className="text-xs text-erp-primary underline" onClick={() => setOpen(false)}>
                View all
              </Link>
            </div>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {loading && <p className="p-3 text-sm text-erp-muted">Loading…</p>}
            {!loading && notifications.length === 0 && (
              <p className="p-3 text-sm text-erp-muted">Nothing needs your attention right now.</p>
            )}
            {!loading &&
              notifications.map((n) => (
                <div key={n.id} className={`border-b border-erp-border p-3 text-sm ${n.isRead ? "" : "bg-erp-primary/5"}`}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium">{n.title}</p>
                    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${SEVERITY_STYLE[n.severity]}`}>
                      {n.severity}
                    </span>
                  </div>
                  <p className="mt-1 text-erp-muted">{n.body}</p>
                  <div className="mt-2 flex gap-3 text-xs">
                    {n.linkHref && (
                      <Link
                        href={n.linkHref}
                        onClick={() => {
                          setOpen(false);
                          if (!n.isRead) void act(n.id, "read");
                        }}
                        className="text-erp-primary underline"
                      >
                        View
                      </Link>
                    )}
                    {!n.isRead && (
                      <button onClick={() => act(n.id, "read")} className="text-erp-muted underline">
                        Mark read
                      </button>
                    )}
                    <button onClick={() => act(n.id, "dismiss")} className="text-erp-muted underline">
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
