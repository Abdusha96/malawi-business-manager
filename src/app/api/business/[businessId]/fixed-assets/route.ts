import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { readDateParamOrResponse } from "@/lib/date-range-api";
import { resolveBranchScope, TenantAccessError } from "@/lib/tenant";
import { fixedAssetSchema } from "@/lib/validation";
import { logAudit } from "@/lib/audit";
import { createFixedAsset, getFixedAssetRegister, FixedAssetError } from "@/lib/fixed-assets";
import { PeriodClosedError } from "@/lib/accounting";
import { prisma } from "@/lib/prisma";
import { getBusinessTimeZone } from "@/lib/business-timezone";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "fixedassets.view");
  if (ctx instanceof NextResponse) return ctx;
  const tz = await getBusinessTimeZone(params.businessId);

  const { searchParams } = new URL(req.url);
  // Module 34: "as of 2026-03-31" includes everything posted on the 31st.
  const asOf = readDateParamOrResponse(searchParams, "asOf", "end", tz);
  if (asOf instanceof NextResponse) return asOf;

  let branchId: string | null;
  try {
    branchId = resolveBranchScope(ctx.membership, searchParams.get("branchId"));
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: "forbidden" }, { status: err.status });
    throw err;
  }

  const register = await getFixedAssetRegister(params.businessId, asOf);
  const filtered = branchId ? register.filter((a) => a.branchId === branchId) : register;

  return NextResponse.json({ assets: filtered });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "fixedassets.manage");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const parsed = fixedAssetSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  let branchId: string | null;
  try {
    branchId = resolveBranchScope(ctx.membership, data.branchId ?? null);
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: "forbidden" }, { status: err.status });
    throw err;
  }
  if (branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch || branch.businessId !== params.businessId) {
      return NextResponse.json({ error: "invalid_branch" }, { status: 400 });
    }
  }

  if (data.supplierId) {
    const supplier = await prisma.supplier.findUnique({ where: { id: data.supplierId } });
    if (!supplier || supplier.businessId !== params.businessId) {
      return NextResponse.json({ error: "invalid_supplier" }, { status: 400 });
    }
  }

  try {
    const asset = await createFixedAsset({
      businessId: params.businessId,
      createdById: userId,
      data: { ...data, branchId },
    });

    await logAudit({
      businessId: params.businessId,
      userId,
      action: "fixedasset.create",
      entityType: "FixedAsset",
      entityId: asset.id,
      metadata: { name: asset.name, cost: Number(asset.cost), category: asset.category },
    });

    return NextResponse.json({ asset }, { status: 201 });
  } catch (err) {
    if (err instanceof FixedAssetError || err instanceof PeriodClosedError) {
      return NextResponse.json({ error: "fixed_asset_error", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
