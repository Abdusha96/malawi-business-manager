import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { businessStaleTransferAlertDaysSchema } from "@/lib/validation";
import { MIN_STALE_TRANSFER_ALERT_DAYS, MAX_STALE_TRANSFER_ALERT_DAYS } from "@/lib/stale-transfer";
import { logAudit } from "@/lib/audit";

// Module 58 – how many days an IN_TRANSIT Stock Transfer can sit unconfirmed
// before syncStaleTransferAlerts() (src/lib/in-app-notifications.ts) and the
// Stock Transfers list/detail pages call it stale. Readable by any member
// (both pages need it to compute staleness client/server-side); changing it
// needs business.settings.manage – the same permission Module 51's
// max-reopens route requires, mirrored here field for field.
export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId);
  if (ctx instanceof NextResponse) return ctx;

  const business = await prisma.business.findUniqueOrThrow({
    where: { id: params.businessId },
    select: { staleTransferAlertDays: true },
  });
  return NextResponse.json({
    staleTransferAlertDays: business.staleTransferAlertDays,
    min: MIN_STALE_TRANSFER_ALERT_DAYS,
    max: MAX_STALE_TRANSFER_ALERT_DAYS,
  });
}

export async function PUT(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "business.settings.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = businessStaleTransferAlertDaysSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  const before = await prisma.business.findUniqueOrThrow({
    where: { id: params.businessId },
    select: { staleTransferAlertDays: true },
  });
  if (before.staleTransferAlertDays === parsed.data.staleTransferAlertDays) {
    return NextResponse.json({ staleTransferAlertDays: before.staleTransferAlertDays });
  }

  await prisma.$transaction(async (tx) => {
    await tx.business.update({
      where: { id: params.businessId },
      data: { staleTransferAlertDays: parsed.data.staleTransferAlertDays },
    });
    await logAudit({
      tx,
      businessId: params.businessId,
      userId: ctx.userId,
      action: "business.stale_transfer_threshold_changed",
      entityType: "Business",
      entityId: params.businessId,
      metadata: { from: before.staleTransferAlertDays, to: parsed.data.staleTransferAlertDays },
    });
  });

  return NextResponse.json({ staleTransferAlertDays: parsed.data.staleTransferAlertDays });
}
