import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { askAssistantSchema } from "@/lib/validation";
import { buildBusinessContext } from "@/lib/ai-context";
import { askMobiAccountant, AIAssistantError } from "@/lib/ai-assistant";
import { requirePlanFeature, PlanRestrictionError } from "@/lib/subscription";
import { logAudit } from "@/lib/audit";

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

  const parsed = askAssistantSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  const business = await prisma.business.findUniqueOrThrow({ where: { id: params.businessId } });

  try {
    // Context is built from tenant-scoped functions ONLY – see the
    // security-boundary comment in src/lib/ai-context.ts. This business's
    // data is all the assistant will ever see.
    const context = await buildBusinessContext(params.businessId);
    const answer = await askMobiAccountant({
      businessName: business.name,
      context,
      question: parsed.data.question,
    });

    await logAudit({
      businessId: params.businessId,
      userId,
      action: "ai.query",
      entityType: "AIQuery",
      entityId: params.businessId,
      metadata: { question: parsed.data.question },
    });

    return NextResponse.json({ answer });
  } catch (err) {
    if (err instanceof AIAssistantError) {
      return NextResponse.json({ error: "ai_error", message: err.message }, { status: 503 });
    }
    throw err;
  }
}
