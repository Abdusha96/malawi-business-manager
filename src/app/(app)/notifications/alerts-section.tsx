"use client";

import { useState } from "react";
import Link from "next/link";

type Severity = "INFO" | "WARNING" | "URGENT";

type AlertNotification = {
  id: string;
  type: string;
  severity: Severity;
  title: string;
  body: string;
  linkHref: string | null;
  isRead: boolean;
  dismissedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
};

const SEVERITY_STYLE: Record<Severity, string> = {
  URGENT: "border-erp-danger/40 bg-erp-danger/10 text-erp-danger",
  WARNING: "border-erp-warning/40 bg-erp-warning/10 text-erp-warning",
  INFO: "border-erp-border bg-erp-subtle text-erp-muted",
};

const TYPE_LABEL: Record<string, string> = {
  LOW_STOCK: "Low stock",
  TAX_DUE: "Tax due",
  TRIAL_ENDING: "Trial ending",
  STALE_TRANSFER: "Stale transfer",
  SUBSCRIPTION_RENEWAL: "Plan renewal",
  SERVICE_COST_CLEARING: "Service cost clearing",
};

// Module 25 – the full-history counterpart to the dashboard bell
// (src/app/dashboard/notification-bell.tsx). Same read/dismiss actions,
// but shows resolved/dismissed rows too (greyed out) instead of hiding
// them, since this page is the audit trail for alerts the same way the
// section below it is the audit trail for email/SMS sends.
export function AlertsSection({
  businessId,
  initialNotifications,
}: {
  businessId: string;
  initialNotifications: AlertNotification[];
}) {
  const [notifications, setNotifications] = useState<AlertNotification[]>(initialNotifications);
  const [showInactive, setShowInactive] = useState(false);

  async function act(id: string, action: "read" | "dismiss") {
    const res = await fetch(`/api/business/${businessId}/notifications/in-app/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) return;
    const { notification } = await res.json();
    setNotifications((prev) =>
      prev.map((n) =>
        n.id === id
          ? { ...n, isRead: notification.isRead, dismissedAt: notification.dismissedAt }
          : n
      )
    );
  }

  const active = notifications.filter((n) => !n.dismissedAt && !n.resolvedAt);
  const inactive = notifications.filter((n) => n.dismissedAt || n.resolvedAt);
  const visible = showInactive ? notifications : active;

  return (
    <div className="rounded border border-erp-border bg-erp-surface">
      {active.length === 0 && !showInactive ? (
        <p className="p-3 text-sm text-erp-muted">Nothing needs your attention right now.</p>
      ) : (
        visible.map((n) => {
          const closed = Boolean(n.dismissedAt || n.resolvedAt);
          return (
            <div
              key={n.id}
              className={`border-b border-erp-border p-3 text-sm last:border-b-0 ${closed ? "opacity-60" : n.isRead ? "" : "bg-erp-primary/5"}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-erp-subtle px-1.5 py-0.5 text-[10px] font-semibold uppercase text-erp-muted">
                    {TYPE_LABEL[n.type] ?? n.type}
                  </span>
                  <p className="font-medium">{n.title}</p>
                </div>
                <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${SEVERITY_STYLE[n.severity]}`}>
                  {n.severity}
                </span>
              </div>
              <p className="mt-1 text-erp-muted">{n.body}</p>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                {n.linkHref && !closed && (
                  <Link href={n.linkHref} className="text-erp-primary underline">
                    View
                  </Link>
                )}
                {!closed && !n.isRead && (
                  <button onClick={() => act(n.id, "read")} className="text-erp-muted underline">
                    Mark read
                  </button>
                )}
                {!closed && (
                  <button onClick={() => act(n.id, "dismiss")} className="text-erp-muted underline">
                    Dismiss
                  </button>
                )}
                {n.resolvedAt && <span className="text-erp-muted">Resolved automatically</span>}
                {n.dismissedAt && !n.resolvedAt && <span className="text-erp-muted">Dismissed</span>}
              </div>
            </div>
          );
        })
      )}
      {inactive.length > 0 && (
        <button
          onClick={() => setShowInactive((v) => !v)}
          className="w-full border-t border-erp-border p-2 text-center text-xs text-erp-primary underline"
        >
          {showInactive ? "Hide" : `Show ${inactive.length} resolved/dismissed alert${inactive.length === 1 ? "" : "s"}`}
        </button>
      )}
    </div>
  );
}
