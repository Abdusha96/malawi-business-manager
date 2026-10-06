"use client";

import { useEffect, useState } from "react";
import { formatDateIn, formatDateTimeIn } from "@/lib/timezone";

interface PlanDef {
  key: "FREE" | "BUSINESS" | "PROFESSIONAL" | "ENTERPRISE";
  name: string;
  monthlyPriceMWK: number;
  annualPriceMWK: number;
  isCustomPricing: boolean;
  maxUsers: number | null;
  maxBranches: number | null;
  maxSalesPerMonth: number | null;
}

interface Overview {
  subscription: {
    id: string;
    status: string;
    billingCycle: "MONTHLY" | "ANNUAL";
    trialEndsAt: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelledAt: string | null;
  };
  plan: PlanDef;
  effectiveStatus: string;
  daysLeftInTrial: number | null;
  usage: {
    users: { count: number; max: number | null };
    branches: { count: number; max: number | null };
    salesThisMonth: { count: number; max: number | null };
  };
  selfServicePlans: PlanDef[];
  quotes: Record<string, { price: number; credit: number; due: number; remainingDays: number }>;
  cancelAtPeriodEnd: boolean;
  paid: boolean;
}

interface HistoryRow {
  id: string;
  action: string;
  createdAt: string;
  user: { name: string | null } | null;
  metadata: {
    fromPlanKey?: string;
    toPlanKey?: string;
    fromStatus?: string;
    toStatus?: string;
    billingCycle?: string;
    reason?: string | null;
    planKey?: string;
    gateway?: { amountMWK: number; stackedRenewal?: boolean };
  } | null;
}

interface PaymentRow {
  id: string;
  txRef: string;
  planKey: string;
  billingCycle: "MONTHLY" | "ANNUAL";
  amount: number;
  currency: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  createdAt: string;
  appliedAt: string | null;
  failureReason: string | null;
  applyError: string | null;
  checkoutUrl: string | null;
  stale: boolean;
  prorationCredit: number;
  excessAmount: number;
  refundedAmount: number;
  channel: string | null;
  receiptNo: string | null;
}

interface GatewayStatus {
  configured: boolean;
  requirePayment: boolean;
  notConfiguredReason: string | null;
  provider: string;
}

type Notice = { kind: "success" | "info" | "error"; text: string };

const NOTICE_STYLES: Record<Notice["kind"], string> = {
  success: "border-erp-success/40 bg-erp-success/10 text-erp-success",
  info: "border-erp-info/40 bg-erp-info/10 text-erp-text",
  error: "border-erp-danger/40 bg-erp-danger/10 text-erp-danger",
};

function mwk(n: number): string {
  return `MWK ${n.toLocaleString()}`;
}

const STATUS_STYLES: Record<string, string> = {
  TRIAL: "border-erp-warning/40 bg-erp-warning/10 text-erp-warning",
  ACTIVE: "border-erp-success/40 bg-erp-success/10 text-erp-success",
  PAST_DUE: "border-erp-warning/40 bg-erp-warning/10 text-erp-warning",
  EXPIRED: "border-erp-danger/40 bg-erp-danger/10 text-erp-danger",
  CANCELLED: "border-erp-danger/40 bg-erp-danger/10 text-erp-danger",
};

function UsageBar({ label, count, max, linkHref }: { label: string; count: number; max: number | null; linkHref: string }) {
  const pct = max === null ? 0 : Math.min(100, Math.round((count / Math.max(max, 1)) * 100));
  const overCap = max !== null && count >= max;
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <a href={linkHref} className="text-erp-text hover:underline">{label}</a>
        <span className={overCap ? "font-medium text-erp-danger" : "text-erp-muted"}>
          {count} / {max === null ? "Unlimited" : max}
        </span>
      </div>
      {max !== null && (
        <div className="mt-1 h-1.5 w-full rounded-full bg-erp-border">
          <div
            className={`h-1.5 rounded-full ${overCap ? "bg-erp-danger" : "bg-erp-primary"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function BillingClient({ businessId, timeZone }: { businessId: string; timeZone: string }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [cycle, setCycle] = useState<"MONTHLY" | "ANNUAL">("MONTHLY");
  const [switching, setSwitching] = useState<string | null>(null); // planKey being switched to
  const [error, setError] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [gateway, setGateway] = useState<GatewayStatus>({ configured: false, requirePayment: false, notConfiguredReason: null, provider: "PayChangu" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [checking, setChecking] = useState<string | null>(null); // txRef being checked

  async function load() {
    const res = await fetch(`/api/business/${businessId}/subscription`);
    const data = await res.json();
    setOverview(data.overview);
    setHistory(data.history);
    setPayments(data.payments ?? []);
    if (data.gateway) setGateway(data.gateway);
    setCycle(data.overview.subscription.billingCycle);
    setLoading(false);
  }

  // Asks the server whether a payment went through. The server asks the gateway itself, so
  // nothing here (or in the URL the gateway sent the customer back with) is taken on trust.
  async function checkPayment(txRef: string) {
    setChecking(txRef);
    try {
      const res = await fetch(`/api/business/${businessId}/subscription/payments/${encodeURIComponent(txRef)}/check`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({ kind: "error", text: data.message ?? "Couldn't check the payment." });
      } else if (data.outcome === "APPLIED" || (data.outcome === "ALREADY_SETTLED" && data.status === "SUCCEEDED" && !String(data.message).includes("could not be applied"))) {
        setNotice({ kind: "success", text: data.message });
      } else if (data.outcome === "PENDING") {
        setNotice({ kind: "info", text: `Not confirmed yet. ${data.message}` });
      } else {
        setNotice({ kind: "error", text: data.message });
      }
      await load();
    } finally {
      setChecking(null);
    }
  }

  useEffect(() => {
    (async () => {
      // The gateway sends the customer back to /settings/billing?tx_ref=...
      const ref = new URLSearchParams(window.location.search).get("tx_ref");
      await load();
      if (ref) {
        window.history.replaceState(null, "", window.location.pathname);
        await checkPayment(ref);
      }
    })();
  }, [businessId]);

  async function handlePay(planKey: string) {
    setSwitching(planKey);
    setError(null);
    try {
      const res = await fetch(`/api/business/${businessId}/subscription/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planKey, billingCycle: cycle }),
      });
      const data = await res.json();
      if (res.ok && data.coveredByCredit) {
        setNotice({ kind: "success", text: `Done. The unused time on your old plan (${mwk(data.credit)}) covered the new price, so nothing was charged.` });
        setSwitching(null);
        await load();
        return;
      }
      if (!res.ok || !data.checkoutUrl) {
        setError(data.message ?? "Couldn't start the payment.");
        setSwitching(null);
        return;
      }
      window.location.href = data.checkoutUrl; // leave for the gateway's hosted page
    } catch {
      setError("Couldn't reach the server to start the payment.");
      setSwitching(null);
    }
  }

  async function handleSwitch(planKey: string) {
    setSwitching(planKey);
    setError(null);
    try {
      const res = await fetch(`/api/business/${businessId}/subscription`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "change_plan", planKey, billingCycle: cycle }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Couldn't switch plans.");
      } else {
        await load();
      }
    } finally {
      setSwitching(null);
    }
  }

  async function handleCancel() {
    setCancelling(true);
    setError(null);
    try {
      const res = await fetch(`/api/business/${businessId}/subscription`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", reason: cancelReason || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Couldn't cancel subscription.");
      } else {
        setShowCancelConfirm(false);
        setCancelReason("");
        setNotice(
          data.scheduled
            ? { kind: "info", text: "Your subscription is set to end when the period you paid for runs out. You keep full access until then." }
            : { kind: "info", text: "Your subscription has been cancelled." }
        );
        await load();
      }
    } finally {
      setCancelling(false);
    }
  }

  async function handleResume() {
    setError(null);
    const res = await fetch(`/api/business/${businessId}/subscription`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) setError(data.message ?? "Couldn't undo the cancellation.");
    else setNotice({ kind: "success", text: "Cancellation undone. Your plan will carry on." });
    await load();
  }

  if (loading || !overview) {
    return <p className="text-erp-muted">Loading billing information…</p>;
  }

  const { plan, effectiveStatus, daysLeftInTrial, usage, subscription, selfServicePlans } = overview;
  const statusStyle = STATUS_STYLES[effectiveStatus] ?? "border-erp-border bg-erp-subtle text-erp-text";
  const price = cycle === "MONTHLY" ? plan.monthlyPriceMWK : plan.annualPriceMWK;

  return (
    <div className="space-y-8">
      {gateway.configured ? (
        <div className="rounded border border-erp-info/40 bg-erp-info/10 p-4 text-sm text-erp-text">
          <strong>Paid plans are paid for online</strong> through {gateway.provider} (Airtel Money, TNM Mpamba or card). Choosing
          a paid plan takes you to the secure payment page; the plan only changes once the payment is confirmed.
        </div>
      ) : gateway.requirePayment ? (
        <div className="rounded border border-erp-danger/40 bg-erp-danger/10 p-4 text-sm text-erp-danger">
          <strong>Online payment is not set up on this server</strong>, and this deployment requires payment for paid plans, so
          they can't be chosen right now. {gateway.notConfiguredReason}
        </div>
      ) : (
        <div className="rounded border border-erp-warning/40 bg-erp-warning/10 p-4 text-sm text-erp-warning">
          <strong>Online payment is not set up on this server.</strong> Switching plans here takes effect immediately and is
          not billed; settle payment for a paid plan outside this page. {gateway.notConfiguredReason}
        </div>
      )}

      {notice && (
        <div className={`rounded border p-3 text-sm ${NOTICE_STYLES[notice.kind]}`}>{notice.text}</div>
      )}

      {error && (
        <div className="rounded border border-erp-danger/40 bg-erp-danger/10 p-3 text-sm text-erp-danger">{error}</div>
      )}

      <section className={`rounded border p-4 ${statusStyle}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-lg font-semibold">{plan.name} plan</p>
            <p className="text-sm">
              Status: {effectiveStatus}
              {effectiveStatus === "TRIAL" && daysLeftInTrial !== null && (
                <> – {daysLeftInTrial} day{daysLeftInTrial === 1 ? "" : "s"} left in trial</>
              )}
              {effectiveStatus === "EXPIRED" && subscription.status === "TRIAL" && " – your trial has ended"}
            </p>
            {subscription.currentPeriodEnd && effectiveStatus === "ACTIVE" && !overview.cancelAtPeriodEnd && (
              <p className="text-sm">{overview.paid ? "Paid until" : "Renews"} {formatDateIn(subscription.currentPeriodEnd, timeZone)} ({subscription.billingCycle.toLowerCase()})</p>
            )}
            {subscription.currentPeriodEnd && effectiveStatus === "ACTIVE" && overview.cancelAtPeriodEnd && (
              <p className="text-sm">Ends {formatDateIn(subscription.currentPeriodEnd, timeZone)}. You keep full access until then.</p>
            )}
            {effectiveStatus === "PAST_DUE" && (
              <p className="text-sm">Your paid period has ended. Renew below to avoid losing access in a few days.</p>
            )}
          </div>
          {overview.cancelAtPeriodEnd && effectiveStatus === "ACTIVE" && (
            <button onClick={handleResume} className="rounded border border-erp-border px-3 py-1.5 text-sm text-erp-text hover:bg-erp-subtle">
              Keep my subscription
            </button>
          )}
          {effectiveStatus !== "CANCELLED" && !overview.cancelAtPeriodEnd && (
            <button
              onClick={() => setShowCancelConfirm(true)}
              className="rounded border border-erp-border px-3 py-1.5 text-sm text-erp-text hover:bg-erp-subtle"
            >
              Cancel subscription
            </button>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-erp-muted">Usage this period</h2>
        <div className="space-y-4 rounded border border-erp-border p-4">
          <UsageBar label="Team members" count={usage.users.count} max={usage.users.max} linkHref="/team" />
          <UsageBar label="Branches" count={usage.branches.count} max={usage.branches.max} linkHref="/branches" />
          <UsageBar label="Sales this month" count={usage.salesThisMonth.count} max={usage.salesThisMonth.max} linkHref="/sales" />
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-erp-muted">Plans</h2>
          <div className="flex rounded border border-erp-border text-sm">
            <button
              onClick={() => setCycle("MONTHLY")}
              className={`px-3 py-1 ${cycle === "MONTHLY" ? "bg-erp-primary text-erp-primary-fg" : "text-erp-text"}`}
            >
              Monthly
            </button>
            <button
              onClick={() => setCycle("ANNUAL")}
              className={`px-3 py-1 ${cycle === "ANNUAL" ? "bg-erp-primary text-erp-primary-fg" : "text-erp-text"}`}
            >
              Annual (save 15%)
            </button>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          {selfServicePlans.map((p) => {
            const isCurrent = p.key === plan.key && effectiveStatus === "ACTIVE";
            const planPrice = cycle === "MONTHLY" ? p.monthlyPriceMWK : p.annualPriceMWK;
            const quote = overview.quotes?.[`${p.key}:${cycle}`];
            return (
              <div key={p.key} className={`rounded border p-4 ${isCurrent ? "border-erp-primary ring-1 ring-erp-primary" : "border-erp-border"}`}>
                <p className="font-semibold">{p.name}</p>
                <p className="text-lg font-bold">{planPrice === 0 ? "Free" : mwk(planPrice)}
                  {planPrice > 0 && <span className="text-xs font-normal text-erp-muted"> /{cycle === "MONTHLY" ? "mo" : "yr"}</span>}
                </p>
                <ul className="mt-2 space-y-1 text-xs text-erp-muted">
                  <li>{p.maxUsers === null ? "Unlimited" : p.maxUsers} team member{p.maxUsers === 1 ? "" : "s"}</li>
                  <li>{p.maxBranches === null ? "Unlimited" : p.maxBranches} branch{p.maxBranches === 1 ? "" : "es"}</li>
                  <li>{p.maxSalesPerMonth === null ? "Unlimited" : p.maxSalesPerMonth} sales/month</li>
                </ul>
                {(() => {
                  const needsPayment = gateway.configured && planPrice > 0;
                  const credit = quote && !isCurrent ? quote.credit : 0;
                  const due = quote && !isCurrent ? quote.due : planPrice;
                  const blocked = !gateway.configured && gateway.requirePayment && planPrice > 0;
                  const sameCycle = cycle === subscription.billingCycle;
                  // Renewing the plan you are on is only offered when it is paid for online.
                  const canClick = !blocked && switching === null && (!isCurrent || (needsPayment && true));
                  const label = blocked
                    ? "Online payment not set up"
                    : switching === p.key
                    ? needsPayment ? "Opening payment…" : "Switching…"
                    : isCurrent
                    ? needsPayment ? (sameCycle ? `Renew (${mwk(planPrice)})` : `Pay and switch to ${cycle === "MONTHLY" ? "monthly" : "annual"}`) : "Current plan"
                    : needsPayment
                    ? due <= 0 ? "Switch (covered by your credit)" : `Pay ${mwk(due)} and switch`
                    : "Switch to this plan";
                  return (
                    <>
                    {credit > 0 && (
                      <p className="mt-2 text-xs text-erp-success">
                        Credit of {mwk(credit)} for {quote!.remainingDays} unused day{quote!.remainingDays === 1 ? "" : "s"} on your current plan is taken off.
                      </p>
                    )}
                    <button
                      disabled={!canClick}
                      onClick={() => (needsPayment ? handlePay(p.key) : handleSwitch(p.key))}
                      className="mt-3 w-full rounded bg-erp-primary px-3 py-1.5 text-sm text-erp-primary-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {label}
                    </button>
                    </>
                  );
                })()}
              </div>
            );
          })}
        </div>

        <div className="mt-4 rounded border border-erp-border p-4 text-sm text-erp-muted">
          <strong>Enterprise</strong> – custom pricing, unlimited everything, dedicated support. Contact
          your account manager to discuss Enterprise; it isn't a self-service switch here since pricing
          isn't fixed.
        </div>
      </section>

      {showCancelConfirm && (
        <div className="rounded border border-erp-danger/40 bg-erp-danger/10 p-4">
          <p className="mb-2 text-sm font-medium text-erp-danger">
            Cancel your subscription? {overview.paid ? "You keep full access until the end of the period you already paid for, and it will not renew." : "This takes effect immediately."} Paid time is not refunded.
          </p>
          <textarea
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="Reason (optional)"
            className="mb-2 w-full rounded border border-erp-border p-2 text-sm"
            rows={2}
          />
          <div className="flex gap-2">
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="rounded bg-erp-danger px-3 py-1.5 text-sm text-erp-primary-fg hover:opacity-90 disabled:opacity-50"
            >
              {cancelling ? "Cancelling…" : "Yes, cancel"}
            </button>
            <button
              onClick={() => setShowCancelConfirm(false)}
              className="rounded border border-erp-border px-3 py-1.5 text-sm text-erp-text hover:bg-erp-subtle"
            >
              Never mind
            </button>
          </div>
        </div>
      )}

      {payments.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-erp-muted">Payments</h2>
          <div className="overflow-x-auto"><table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-erp-border text-erp-muted">
                <th className="py-2 pr-2">Date</th>
                <th className="py-2 pr-2">Plan</th>
                <th className="py-2 pr-2">Amount</th>
                <th className="py-2 pr-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((pay) => (
                <tr key={pay.id} className="border-b border-erp-border align-top">
                  <td className="py-2 pr-2 text-erp-muted">{formatDateTimeIn(pay.createdAt, timeZone)}</td>
                  <td className="py-2 pr-2">{pay.planKey} ({pay.billingCycle.toLowerCase()})</td>
                  <td className="py-2 pr-2">{mwk(pay.amount)}</td>
                  <td className="py-2 pr-2">
                    {pay.status === "SUCCEEDED" && !pay.applyError && (
                      <span className="text-erp-success">
                        Paid{pay.prorationCredit > 0 ? ` (after ${mwk(pay.prorationCredit)} credit)` : ""}
                        {pay.refundedAmount > 0 && <span className="ml-1 text-erp-muted">· refunded {mwk(pay.refundedAmount)}</span>}
                        <a href={`/api/business/${businessId}/subscription/payments/${pay.txRef}/receipt`} target="_blank" rel="noreferrer" className="ml-2 text-xs text-erp-primary underline">Receipt</a>
                      </span>
                    )}
                    {pay.status === "SUCCEEDED" && pay.applyError && (
                      <span className="text-erp-danger">
                        Paid, but the plan was not changed: {pay.applyError} Contact support with reference {pay.txRef}.
                        <a href={`/api/business/${businessId}/subscription/payments/${pay.txRef}/receipt`} target="_blank" rel="noreferrer" className="ml-2 text-xs text-erp-primary underline">Receipt</a>
                      </span>
                    )}
                    {pay.status === "FAILED" && (
                      <span className="text-erp-danger">Failed{pay.failureReason ? `: ${pay.failureReason}` : ""}</span>
                    )}
                    {pay.status === "PENDING" && (
                      <span className="text-erp-warning">
                        {pay.stale ? "No payment received" : "Waiting for payment"}{" "}
                        <button
                          onClick={() => checkPayment(pay.txRef)}
                          disabled={checking !== null}
                          className="ml-1 rounded border border-erp-border px-2 py-0.5 text-xs text-erp-text hover:bg-erp-subtle disabled:opacity-50"
                        >
                          {checking === pay.txRef ? "Checking…" : "Check status"}
                        </button>
                        {pay.checkoutUrl && !pay.stale && (
                          <a href={pay.checkoutUrl} className="ml-2 text-xs text-erp-primary underline">Continue payment</a>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-erp-muted">History</h2>
        {history.length === 0 ? (
          <p className="text-sm text-erp-muted">No plan changes yet.</p>
        ) : (
          <div className="overflow-x-auto"><table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-erp-border text-erp-muted">
                <th className="py-2 pr-2">Date</th>
                <th className="py-2 pr-2">Change</th>
                <th className="py-2 pr-2">By</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.id} className="border-b border-erp-border">
                  <td className="py-2 pr-2 text-erp-muted">{formatDateTimeIn(row.createdAt, timeZone)}</td>
                  <td className="py-2 pr-2">
                    {row.action === "subscription.plan_changed"
                      ? `${row.metadata?.fromPlanKey ?? "?"} → ${row.metadata?.toPlanKey ?? "?"} (${row.metadata?.billingCycle ?? ""})${row.metadata?.gateway ? ` – paid ${mwk(row.metadata.gateway.amountMWK)}${row.metadata.gateway.stackedRenewal ? ", added to your paid time" : ""}` : ""}`
                      : row.action === "subscription.cancelled"
                      ? `Cancelled${row.metadata?.reason ? `: ${row.metadata.reason}` : ""}`
                      : row.action === "subscription.cancel_scheduled"
                      ? "Cancellation scheduled for the end of the paid period"
                      : row.action === "subscription.cancel_undone"
                      ? "Scheduled cancellation undone"
                      : row.action === "subscription.payment_started"
                      ? `Started paying for ${row.metadata?.planKey ?? "a plan"} (${(row.metadata?.billingCycle ?? "").toLowerCase()})`
                      : row.action === "subscription.payment_failed"
                      ? `Payment did not go through${row.metadata?.reason ? `: ${row.metadata.reason}` : ""}`
                      : row.action === "subscription.payment_apply_failed"
                      ? `Payment received but plan not changed${row.metadata?.reason ? `: ${row.metadata.reason}` : ""}`
                      : row.action}
                  </td>
                  <td className="py-2 pr-2 text-erp-muted">{row.user?.name ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
