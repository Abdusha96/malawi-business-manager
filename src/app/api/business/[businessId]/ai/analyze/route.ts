import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { runTransactionAnalysis, saveAnalysisRun } from "@/lib/ai-analysis";
import { requirePlanFeature, PlanRestrictionError } from "@/lib/subscription";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "ai.use");
  if (ctx instanceof NextResponse) return ctx;

  const runs = await prisma.aIAnalysis.findMany({
    where: { businessId: params.businessId },
    orderBy: { runAt: "desc" },
    take: 10,
  });

  return NextResponse.json({ runs });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "ai.use");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  try {
    await requirePlanFeature(params.businessId, "aiAssistant");
  } catch (err) {
    if (err instanceof PlanRestrictionError) {
      return NextResponse.json({ error: "plan_restricted", message: err.message }, { status: err.status });
    }
    throw err;
  }

  const findings = await runTransactionAnalysis(params.businessId);
  const run = await saveAnalysisRun(params.businessId, findings, userId);

  return NextResponse.json({ run });
}
