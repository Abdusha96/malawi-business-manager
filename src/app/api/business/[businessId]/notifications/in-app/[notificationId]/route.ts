import { NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { markInAppNotificationRead, dismissInAppNotification, InAppNotificationError } from "@/lib/in-app-notifications";

// Same "one dispatch endpoint per action" shape as the bank statement line
// route – each action here is a single cheap state transition, so the
// dispatch itself carries no business logic.
const ACTIONS = ["read", "dismiss"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(
  req: Request,
  props: { params: Promise<{ businessId: string; notificationId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "notifications.view");
  if (ctx instanceof NextResponse) return ctx;

  const body = await req.json().catch(() => ({}));
  const action = body?.action as Action | undefined;
  if (!action || !ACTIONS.includes(action)) {
    return NextResponse.json({ error: "validation_error", message: `action must be one of: ${ACTIONS.join(", ")}` }, { status: 400 });
  }

  try {
    const notification =
      action === "read"
        ? await markInAppNotificationRead({ businessId: params.businessId, notificationId: params.notificationId, userId: ctx.userId })
        : await dismissInAppNotification({ businessId: params.businessId, notificationId: params.notificationId, userId: ctx.userId });
    return NextResponse.json({ notification });
  } catch (err) {
    if (err instanceof InAppNotificationError) {
      return NextResponse.json({ error: "in_app_notification_error", message: err.message }, { status: 404 });
    }
    throw err;
  }
}
