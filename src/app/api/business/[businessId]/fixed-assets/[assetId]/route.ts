import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { fixedAssetUpdateSchema } from "@/lib/validation";
import { logAudit } from "@/lib/audit";
import { deleteFixedAsset, getAccumulatedDepreciation, computeAnnualDepreciation, computeMonthlyDepreciation, FixedAssetError } from "@/lib/fixed-assets";
import { PeriodClosedError } from "@/lib/accounting";

async function loadOwnedAsset(businessId: string, assetId: string) {
  const asset = await prisma.fixedAsset.findUnique({
    where: { id: assetId },
    include: { branch: { select: { name: true } }, supplier: { select: { name: true } } },
  });
  if (!asset || asset.businessId !== businessId) return null;
  return asset;
}

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; assetId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "fixedassets.view");
  if (ctx instanceof NextResponse) return ctx;

  const asset = await loadOwnedAsset(params.businessId, params.assetId);
  if (!asset) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const accumulatedDepreciation = await getAccumulatedDepreciation(params.businessId, params.assetId);
  const netBookValue = Math.round((Number(asset.cost) - accumulatedDepreciation) * 100) / 100;

  const depreciationHistory = await prisma.journalEntry.findMany({
    where: { businessId: params.businessId, referenceType: "Depreciation", referenceId: { startsWith: `${params.assetId}:` } },
    include: { lines: true },
    orderBy: { entryDate: "asc" },
  });

  return NextResponse.json({
    asset: {
      ...asset,
      cost: Number(asset.cost),
      residualValue: Number(asset.residualValue),
      disposalProceeds: asset.disposalProceeds !== null ? Number(asset.disposalProceeds) : null,
      annualDepreciation: computeAnnualDepreciation(asset),
      monthlyDepreciation: computeMonthlyDepreciation(asset),
      accumulatedDepreciation,
      netBookValue,
    },
    depreciationHistory: depreciationHistory.map((e) => ({
      entryNumber: e.entryNumber,
      entryDate: e.entryDate,
      period: e.referenceId?.split(":")[1],
      amount: Number(e.lines.find((l) => Number(l.debit) > 0)?.debit ?? 0),
    })),
  });
}

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; assetId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "fixedassets.manage");
  if (ctx instanceof NextResponse) return ctx;

  const existing = await loadOwnedAsset(params.businessId, params.assetId);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = fixedAssetUpdateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  if (data.branchId !== undefined && data.branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: data.branchId } });
    if (!branch || branch.businessId !== params.businessId) {
      return NextResponse.json({ error: "invalid_branch" }, { status: 400 });
    }
  }

  const asset = await prisma.fixedAsset.update({
    where: { id: params.assetId },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.category !== undefined ? { category: data.category, usefulLifeYears: data.category === "LAND" ? null : undefined } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.residualValue !== undefined ? { residualValue: data.residualValue } : {}),
      ...(data.usefulLifeYears !== undefined ? { usefulLifeYears: data.usefulLifeYears } : {}),
      ...(data.supplierId !== undefined ? { supplierId: data.supplierId } : {}),
      ...(data.branchId !== undefined ? { branchId: data.branchId } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
    },
  });

  await logAudit({
    businessId: params.businessId,
    userId: ctx.userId,
    action: "fixedasset.update",
    entityType: "FixedAsset",
    entityId: asset.id,
    metadata: data as Record<string, unknown>,
  });

  return NextResponse.json({ asset });
}

export async function DELETE(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; assetId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "fixedassets.manage");
  if (ctx instanceof NextResponse) return ctx;

  const existing = await loadOwnedAsset(params.businessId, params.assetId);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    await deleteFixedAsset({ businessId: params.businessId, assetId: params.assetId, deletedById: ctx.userId });
    return NextResponse.json({ message: "Fixed asset deleted." });
  } catch (err) {
    if (err instanceof FixedAssetError || err instanceof PeriodClosedError) {
      return NextResponse.json({ error: "fixed_asset_error", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
