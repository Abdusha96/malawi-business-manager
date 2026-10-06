import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/erp/display";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { listNotificationLogs, getNotificationProviderStatus } from "@/lib/notifications";
import { listInAppNotifications } from "@/lib/in-app-notifications";
import { NotificationChannel, NotificationStatus, NotificationDeliveryState } from "@prisma/client";
import { AlertsSection } from "./alerts-section";
import { formatDateIn, resolveTimeZone, formatDateTimeIn } from "@/lib/timezone";
import { describeRetryState, checkManualRetry } from "@/lib/notification-retry";
import { RetryButton } from "./retry-button";
import { describeDeliveryState } from "@/lib/sms-delivery-report";

const STATUS_STYLE: Record<NotificationStatus, string> = {
  SENT: "bg-erp-success/10 text-erp-success",
  FAILED: "bg-erp-danger/10 text-erp-danger",
  LOGGED: "bg-erp-subtle text-erp-text",
};

// Module 76 – colours for the "what the network said" line under an SMS row.
const DELIVERY_TONE: Record<"good" | "info" | "bad" | "warn" | "muted", string> = {
  good: "text-erp-success",
  info: "text-erp-text",
  bad: "text-erp-danger",
  warn: "text-erp-warning",
  muted: "text-erp-muted",
};

const TEMPLATE_LABEL: Record<string, string> = {
  email_verification: "Email verification",
  password_reset: "Password reset",
  team_invitation: "Team invitation",
  customer_debt_reminder: "Customer debt reminder",
  supplier_payment_notice: "Supplier payment notice",
  employee_pay_notice: "Employee pay notice",
  subscription_renewal_reminder: "Plan renewal reminder",
  subscription_receipt: "Subscription receipt",
};

export default async function NotificationsPage(
  props: {
    searchParams: Promise<{ channel?: string; status?: string; delivery?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const tz = resolveTimeZone(membership.business.timezone);
  const membershipCtx = {
    businessId: membership.businessId,
    userId: session.user.id,
    role: membership.role,
    branchId: membership.branchId,
  };

  const canView = await hasPermission(membershipCtx, "notifications.view");
  if (!canView) {
    return (
      <main className="mx-auto max-w-6xl p-4 sm:p-6">
        <PageHeader title="Notifications" />
        <p className="text-sm text-erp-muted">Your role ({membership.role}) doesn&apos;t have access to notification history.</p>
      </main>
    );
  }

  const channel =
    searchParams.channel && searchParams.channel in NotificationChannel
      ? (searchParams.channel as NotificationChannel)
      : undefined;
  const status =
    searchParams.status && searchParams.status in NotificationStatus
      ? (searchParams.status as NotificationStatus)
      : undefined;

  // Module 76: only UNDELIVERED is offered as a filter (the one a person acts on).
  const deliveryState = searchParams.delivery === "UNDELIVERED" ? NotificationDeliveryState.UNDELIVERED : undefined;
  const now = new Date();

  const [logs, providerStatus, alertHistory] = await Promise.all([
    listNotificationLogs(membership.businessId, { channel, status, deliveryState }),
    Promise.resolve(getNotificationProviderStatus()),
    // Module 25 – includeInactive:true so this page (unlike the bell) also
    // shows resolved/dismissed alerts, as a full history to match the
    // email/SMS log below it.
    listInAppNotifications(membership.businessId, { includeInactive: true }),
  ]);
  const alertHistoryForClient = alertHistory.map((n) => ({
    id: n.id,
    type: n.type,
    severity: n.severity,
    title: n.title,
    body: n.body,
    linkHref: n.linkHref,
    isRead: n.isRead,
    dismissedAt: n.dismissedAt ? n.dismissedAt.toISOString() : null,
    resolvedAt: n.resolvedAt ? n.resolvedAt.toISOString() : null,
    createdAt: n.createdAt.toISOString(),
  }));

  const filterLink = (next: { channel?: string; status?: string; delivery?: string }) => {
    const params = new URLSearchParams();
    const c = "channel" in next ? next.channel : searchParams.channel;
    const s = "status" in next ? next.status : searchParams.status;
    const d = "delivery" in next ? next.delivery : searchParams.delivery;
    if (c) params.set("channel", c);
    if (s) params.set("status", s);
    if (d) params.set("delivery", d);
    const qs = params.toString();
    return qs ? `/notifications?${qs}` : "/notifications";
  };

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader title="Notifications" description="In-app alerts and the email and SMS delivery log." />

      {/* Module 25 – in-app alerts (low stock, tax due, trial ending).
          Full history here (active + resolved + dismissed); the bell on
          the dashboard only ever shows the active ones. */}
      <section className="mb-8">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-erp-muted">Alerts</h2>
        <AlertsSection businessId={membership.businessId} initialNotifications={alertHistoryForClient} />
      </section>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-erp-muted">Email &amp; SMS Delivery Log</h2>

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <div className="rounded border border-erp-border bg-erp-surface p-3 text-sm shadow-sm">
          <p className="font-medium">Email delivery</p>
          <p className="text-erp-muted">
            {providerStatus.email === "resend"
              ? "Live – sending via Resend."
              : "Console-only – set EMAIL_PROVIDER_API_KEY and EMAIL_FROM to send real emails."}
          </p>
        </div>
        <div className="rounded border border-erp-border bg-erp-surface p-3 text-sm shadow-sm">
          <p className="font-medium">SMS delivery</p>
          <p className="text-erp-muted">
            {providerStatus.sms === "africastalking"
              ? "Live – sending via Africa's Talking."
              : "Console-only – set SMS_PROVIDER_API_KEY and SMS_PROVIDER_USERNAME to send real SMS."}
          </p>
          {providerStatus.sms === "africastalking" && (
            <p className="mt-1 text-xs text-erp-muted">
              {providerStatus.smsDeliveryReports
                ? "Delivery reports are on: each text below shows whether it reached the handset."
                : "Delivery reports are off, so \"Sent\" only means the gateway accepted the text. Set AT_DELIVERY_REPORT_SECRET and give Africa's Talking the callback URL /api/webhooks/africastalking/delivery?token=<that secret>."}
            </p>
          )}
        </div>
      </div>

      <p className="mb-4 text-xs text-erp-muted">
        This is the delivery log for every email and SMS the system has attempted – registration verification,
        password resets, team invitations, reminders and receipts. "Console-only" means no provider is
        configured yet, so the message was logged rather than actually delivered; that's expected on a fresh
        setup and doesn't mean anything is broken. A message that failed because the provider had a temporary
        problem is retried automatically (a few times, then it stops); every attempt is its own row below.
      </p>

      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        <Link
          href={filterLink({ channel: undefined })}
          className={`rounded-full px-3 py-1 ${!channel ? "bg-erp-primary text-erp-primary-fg" : "border border-erp-border text-erp-muted hover:bg-erp-subtle"}`}
        >
          All channels
        </Link>
        <Link
          href={filterLink({ channel: "EMAIL" })}
          className={`rounded-full px-3 py-1 ${channel === "EMAIL" ? "bg-erp-primary text-erp-primary-fg" : "border border-erp-border text-erp-muted hover:bg-erp-subtle"}`}
        >
          Email
        </Link>
        <Link
          href={filterLink({ channel: "SMS" })}
          className={`rounded-full px-3 py-1 ${channel === "SMS" ? "bg-erp-primary text-erp-primary-fg" : "border border-erp-border text-erp-muted hover:bg-erp-subtle"}`}
        >
          SMS
        </Link>
        <span className="mx-1 text-erp-border">|</span>
        <Link
          href={filterLink({ status: undefined })}
          className={`rounded-full px-3 py-1 ${!status ? "bg-erp-primary text-erp-primary-fg" : "border border-erp-border text-erp-muted hover:bg-erp-subtle"}`}
        >
          All statuses
        </Link>
        <Link
          href={filterLink({ status: "SENT" })}
          className={`rounded-full px-3 py-1 ${status === "SENT" ? "bg-erp-primary text-erp-primary-fg" : "border border-erp-border text-erp-muted hover:bg-erp-subtle"}`}
        >
          Sent
        </Link>
        <Link
          href={filterLink({ status: "FAILED" })}
          className={`rounded-full px-3 py-1 ${status === "FAILED" ? "bg-erp-primary text-erp-primary-fg" : "border border-erp-border text-erp-muted hover:bg-erp-subtle"}`}
        >
          Failed
        </Link>
        <Link
          href={filterLink({ status: "LOGGED" })}
          className={`rounded-full px-3 py-1 ${status === "LOGGED" ? "bg-erp-primary text-erp-primary-fg" : "border border-erp-border text-erp-muted hover:bg-erp-subtle"}`}
        >
          Logged only
        </Link>
        <span className="mx-1 text-erp-border">|</span>
        <Link
          href={filterLink({ delivery: deliveryState ? undefined : "UNDELIVERED" })}
          className={`rounded-full px-3 py-1 ${deliveryState ? "bg-erp-primary text-erp-primary-fg" : "border border-erp-border text-erp-muted hover:bg-erp-subtle"}`}
        >
          Not delivered
        </Link>
      </div>

      {logs.length === 0 ? (
        <p className="text-sm text-erp-muted">No notifications match this filter.</p>
      ) : (
        <div className="overflow-auto rounded border border-erp-border bg-erp-surface shadow-sm">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-erp-subtle text-left text-[11px] uppercase tracking-wide text-erp-muted">
            <tr>
              <th className="p-3">When</th>
              <th className="p-3">Channel</th>
              <th className="p-3">Type</th>
              <th className="p-3">To</th>
              <th className="p-3">Status</th>
              <th className="p-3">Provider</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id} className="border-t border-erp-border align-top hover:bg-erp-subtle/60">
                <td className="p-3 whitespace-nowrap text-erp-muted">
                  {formatDateTimeIn(log.createdAt, tz)}
                </td>
                <td className="p-3 text-erp-muted">{log.channel}</td>
                <td className="p-3 text-erp-muted">{TEMPLATE_LABEL[log.templateKey] ?? log.templateKey}</td>
                <td className="p-3 text-erp-muted">{log.recipientAddress}</td>
                <td className="p-3">
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${STATUS_STYLE[log.status]}`}>
                    {log.status}
                  </span>
                  {log.status === "FAILED" && log.errorMessage && (
                    <p className="mt-1 text-xs text-erp-danger">{log.errorMessage}</p>
                  )}
                  {log.status === "SENT" && log.errorMessage && (
                    <p className="mt-1 text-xs text-erp-warning">{log.errorMessage}</p>
                  )}
                  {log.attempt > 1 && (
                    <p className="mt-1 text-xs text-erp-muted">Attempt {log.attempt}</p>
                  )}
                  {(() => {
                    const state = describeRetryState(log);
                    if (!state) return null;
                    if (state.kind === "QUEUED")
                      return (
                        <p className="mt-1 text-xs text-erp-text">
                          Will be retried automatically after {formatDateTimeIn(state.at, tz)}.
                        </p>
                      );
                    return <p className="mt-1 text-xs text-erp-muted">{state.text}</p>;
                  })()}
                  {(() => {
                    // Module 76: what the network said about an accepted text, from its delivery report.
                    const view = describeDeliveryState(log, { reportsEnabled: providerStatus.smsDeliveryReports, now });
                    if (!view) return null;
                    return (
                      <p className={`mt-1 text-xs ${DELIVERY_TONE[view.tone]}`}>
                        {view.text}
                        {view.at ? ` (${formatDateTimeIn(view.at, tz)})` : ""}
                      </p>
                    );
                  })()}
                  {!log.retriedAt &&
                    (log.status === "FAILED" || (log.status === "SENT" && log.deliveryState === "UNDELIVERED")) &&
                    checkManualRetry(log).ok && <RetryButton businessId={membership.businessId} logId={log.id} />}
                </td>
                <td className="p-3 text-erp-muted">{log.providerName}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </main>
  );
}
