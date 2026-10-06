import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { retryNotificationByPerson } from "@/lib/notification-retry-run";
import { logAudit } from "@/lib/audit";

// Module 75 – a person re-sends one FAILED email/SMS from the Notifications page. No new permission
// (so no re-seed): whoever may SEE the log (notifications.view) may retry a row of it, and a retry
// only repeats a message the system already tried to send.
export async function POST(
  _req: NextRequest,
  props: { params: Promise<{ businessId: string; logId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "notifications.view");
  if (ctx instanceof NextResponse) return ctx;

  const outcome = await retryNotificationByPerson({
    businessId: params.businessId,
    logId: params.logId,
    userId: ctx.userId,
  });

  if (!outcome.ok) {
    const status = outcome.code === "not_found" ? 404 : outcome.code === "already_taken" ? 409 : 400;
    return NextResponse.json({ error: outcome.code, message: outcome.message }, { status });
  }

  await logAudit({
    businessId: params.businessId,
    userId: ctx.userId,
    action: "notification.retry",
    entityType: "NotificationLog",
    entityId: params.logId,
    metadata: { resultStatus: outcome.status, newLogId: outcome.logId },
  });

  const message =
    outcome.status === "SENT"
      ? "Sent again."
      : outcome.status === "LOGGED"
      ? "No provider is configured, so the message was only logged."
      : "The retry failed too. See the newer attempt for the reason.";
  return NextResponse.json({ status: outcome.status, message, logId: outcome.logId });
}
