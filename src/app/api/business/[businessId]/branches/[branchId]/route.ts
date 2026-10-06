import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { branchUpdateSchema } from "@/lib/validation";
import { getBranch, getBranchStats, updateBranch, BranchValidationError } from "@/lib/branches";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; branchId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "branches.manage");
  if (ctx instanceof NextResponse) return ctx;

  const branch = await getBranch(params.businessId, params.branchId);
  if (!branch) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const stats = await getBranchStats(params.businessId, params.branchId);
  return NextResponse.json({ branch, stats });
}

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; branchId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "branches.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = branchUpdateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const branch = await updateBranch(params.businessId, params.branchId, parsed.data);
    return NextResponse.json({ branch });
  } catch (err) {
    if (err instanceof BranchValidationError) {
      return NextResponse.json({ error: "validation_error", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
