import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { listNotificationLogs, getNotificationProviderStatus } from "@/lib/notifications";
import { NotificationChannel, NotificationStatus } from "@prisma/client";

// Read-only – notifications are a byproduct of other actions (registering,
// inviting a teammate, sending a debt reminder), never created directly
// through this route.
export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "notifications.view");
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);
  const channelParam = searchParams.get("channel");
  const statusParam = searchParams.get("status");

  const channel =
    channelParam && channelParam in NotificationChannel
      ? (channelParam as NotificationChannel)
      : undefined;
  const status =
    statusParam && statusParam in NotificationStatus ? (statusParam as NotificationStatus) : undefined;

  const [logs, providerStatus] = await Promise.all([
    listNotificationLogs(params.businessId, { channel, status }),
    Promise.resolve(getNotificationProviderStatus()),
  ]);

  return NextResponse.json({ logs, providerStatus });
}
