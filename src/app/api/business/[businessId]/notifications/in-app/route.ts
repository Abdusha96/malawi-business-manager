import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { listInAppNotifications, markAllInAppNotificationsRead } from "@/lib/in-app-notifications";

// GET syncs the three alert conditions (see src/lib/in-app-notifications.ts)
// and returns the current bell list. ?all=1 also returns resolved/dismissed
// history, for the "Alerts" section on /notifications.
export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "notifications.view");
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);
  const includeInactive = searchParams.get("all") === "1";

  const notifications = await listInAppNotifications(params.businessId, { includeInactive });
  const unreadCount = notifications.filter((n) => !n.isRead && !n.resolvedAt && !n.dismissedAt).length;

  return NextResponse.json({ notifications, unreadCount });
}

// One action today ("mark_all_read") – a dispatch body rather than a
// dedicated sub-route, the same call it would be if a second bulk action
// ever needed one (see the per-notification route for the equivalent
// single-item dispatch).
export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "notifications.view");
  if (ctx instanceof NextResponse) return ctx;

  const body = await req.json().catch(() => ({}));
  if (body?.action !== "mark_all_read") {
    return NextResponse.json({ error: "validation_error", message: "action must be 'mark_all_read'" }, { status: 400 });
  }

  await markAllInAppNotificationsRead({ businessId: params.businessId, userId: ctx.userId });
  return NextResponse.json({ ok: true });
}
