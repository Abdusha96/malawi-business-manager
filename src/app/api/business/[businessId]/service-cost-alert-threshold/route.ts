import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { businessServiceCostAlertDaysSchema } from "@/lib/validation";
import { MIN_SERVICE_COST_ALERT_DAYS, MAX_SERVICE_COST_ALERT_DAYS } from "@/lib/service-cost-clearing";
import { logAudit } from "@/lib/audit";

// Module 80 - how many days a service's leftover in Service Cost Clearing can sit untouched before the bell and
// the Service Cost Clearing page call it aged. Mirrors Module 58's stale-transfer-threshold route field for field:
// any member may read it, changing it needs business.settings.manage. No new permission, so no re-seed.
export async function GET(_req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId);
  if (ctx instanceof NextResponse) return ctx;

  const business = await prisma.business.findUniqueOrThrow({
    where: { id: params.businessId },
    select: { serviceCostAlertDays: true },
  });
  return NextResponse.json({
    serviceCostAlertDays: business.serviceCostAlertDays,
    min: MIN_SERVICE_COST_ALERT_DAYS,
    max: MAX_SERVICE_COST_ALERT_DAYS,
  });
}

export async function PUT(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "business.settings.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = businessServiceCostAlertDaysSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  const before = await prisma.business.findUniqueOrThrow({
    where: { id: params.businessId },
    select: { serviceCostAlertDays: true },
  });
  if (before.serviceCostAlertDays === parsed.data.serviceCostAlertDays) {
    return NextResponse.json({ serviceCostAlertDays: before.serviceCostAlertDays });
  }

  await prisma.$transaction(async (tx) => {
    await tx.business.update({
      where: { id: params.businessId },
      data: { serviceCostAlertDays: parsed.data.serviceCostAlertDays },
    });
    await logAudit({
      tx,
      businessId: params.businessId,
      userId: ctx.userId,
      action: "business.service_cost_alert_threshold_changed",
      entityType: "Business",
      entityId: params.businessId,
      metadata: { from: before.serviceCostAlertDays, to: parsed.data.serviceCostAlertDays },
    });
  });

  return NextResponse.json({ serviceCostAlertDays: parsed.data.serviceCostAlertDays });
}
