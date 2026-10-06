import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { disposeFixedAssetSchema } from "@/lib/validation";
import { disposeFixedAsset, FixedAssetError } from "@/lib/fixed-assets";
import { PeriodClosedError } from "@/lib/accounting";

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; assetId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "fixedassets.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = disposeFixedAssetSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await disposeFixedAsset({
      businessId: params.businessId,
      assetId: params.assetId,
      createdById: ctx.userId,
      data: parsed.data,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof FixedAssetError || err instanceof PeriodClosedError) {
      return NextResponse.json({ error: "fixed_asset_error", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
