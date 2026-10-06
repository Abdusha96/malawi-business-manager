import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { businessTimeZoneSchema } from "@/lib/validation";
import { resolveTimeZone, SUPPORTED_TIME_ZONES } from "@/lib/timezone";
import { logAudit } from "@/lib/audit";

// Module 35 – the business's calendar time zone. Readable by any member (every screen's
// "today" depends on it, and it is not sensitive); changing it needs
// business.settings.manage (Owner), since it moves every report's day/month boundary.
export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId);
  if (ctx instanceof NextResponse) return ctx;

  const business = await prisma.business.findUniqueOrThrow({ where: { id: params.businessId }, select: { timezone: true } });
  return NextResponse.json({ timezone: resolveTimeZone(business.timezone), options: SUPPORTED_TIME_ZONES });
}

export async function PUT(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "business.settings.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = businessTimeZoneSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  const before = await prisma.business.findUniqueOrThrow({ where: { id: params.businessId }, select: { timezone: true } });
  if (before.timezone === parsed.data.timezone) {
    return NextResponse.json({ timezone: before.timezone });
  }

  await prisma.$transaction(async (tx) => {
    await tx.business.update({ where: { id: params.businessId }, data: { timezone: parsed.data.timezone } });
    // A date-range/period boundary moves with this – worth an audit row for anyone asking
    // later why a month's figures changed.
    await logAudit({
      tx,
      businessId: params.businessId,
      userId: ctx.userId,
      action: "business.timezone_changed",
      entityType: "Business",
      entityId: params.businessId,
      metadata: { from: before.timezone, to: parsed.data.timezone },
    });
  });

  return NextResponse.json({ timezone: parsed.data.timezone });
}
