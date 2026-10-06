import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { businessMaxReopensSchema } from "@/lib/validation";
import { MIN_MAX_REOPENS, MAX_MAX_REOPENS } from "@/lib/reopen-constants";
import { logAudit } from "@/lib/audit";

// Module 51 – how many times a completed Bank Reconciliation/Stock Take can
// be reopened before reopenBankReconciliation()/reopenStockTake() point at a
// manual journal instead (see src/lib/reopen-audit.ts). Readable by any
// member (both workspace pages show it); changing it needs
// business.settings.manage – the same permission Module 48/49 already
// require to reopen a completed record in the first place.
export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId);
  if (ctx instanceof NextResponse) return ctx;

  const business = await prisma.business.findUniqueOrThrow({ where: { id: params.businessId }, select: { maxReopens: true } });
  return NextResponse.json({ maxReopens: business.maxReopens, min: MIN_MAX_REOPENS, max: MAX_MAX_REOPENS });
}

export async function PUT(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "business.settings.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = businessMaxReopensSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  const before = await prisma.business.findUniqueOrThrow({ where: { id: params.businessId }, select: { maxReopens: true } });
  if (before.maxReopens === parsed.data.maxReopens) {
    return NextResponse.json({ maxReopens: before.maxReopens });
  }

  await prisma.$transaction(async (tx) => {
    await tx.business.update({ where: { id: params.businessId }, data: { maxReopens: parsed.data.maxReopens } });
    // Lowering it below a record's current reopen count doesn't touch that
    // record – the cap only ever gates the NEXT reopen attempt (see
    // reopenBankReconciliation/reopenStockTake) – but it's worth an audit
    // row either way, same reasoning as the time zone change (Module 35).
    await logAudit({
      tx,
      businessId: params.businessId,
      userId: ctx.userId,
      action: "business.max_reopens_changed",
      entityType: "Business",
      entityId: params.businessId,
      metadata: { from: before.maxReopens, to: parsed.data.maxReopens },
    });
  });

  return NextResponse.json({ maxReopens: parsed.data.maxReopens });
}
