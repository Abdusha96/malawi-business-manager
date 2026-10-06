import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { branchSchema } from "@/lib/validation";
import { listBranchesWithStats, createBranch } from "@/lib/branches";
import { PlanRestrictionError } from "@/lib/subscription";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "branches.manage");
  if (ctx instanceof NextResponse) return ctx;

  const branches = await listBranchesWithStats(params.businessId);
  return NextResponse.json({ branches });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "branches.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = branchSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const branch = await createBranch({ businessId: params.businessId, ...parsed.data });
    return NextResponse.json({ branch }, { status: 201 });
  } catch (err) {
    if (err instanceof PlanRestrictionError) {
      return NextResponse.json({ error: "plan_restricted", message: err.message }, { status: err.status });
    }
    throw err;
  }
}
