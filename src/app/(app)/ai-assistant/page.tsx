import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { getPlanDefinition, planHasFeature } from "@/lib/plans";
import { AIAssistantHub } from "./ai-assistant-hub";

export default async function AIAssistantPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const canUse = await hasPermission(
    { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId },
    "ai.use"
  );

  if (!canUse) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <h1 className="mb-2 text-2xl font-bold">Mobi Accountant</h1>
        <p className="text-erp-muted">Your role ({membership.role}) doesn't have access to the AI assistant.</p>
      </main>
    );
  }

  const subscription = await prisma.subscription.findUnique({
    where: { businessId: membership.businessId },
    include: { plan: true },
  });
  const hasAiFeature = subscription ? planHasFeature(getPlanDefinition(subscription.plan.key), "aiAssistant") : false;

  if (!hasAiFeature) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <h1 className="mb-2 text-2xl font-bold">Mobi Accountant</h1>
        <p className="text-erp-muted">
          The AI assistant is available on the Professional plan and above. Your business is currently on the{" "}
          {subscription ? subscription.plan.name : "Free"} plan.
        </p>
      </main>
    );
  }

  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

  return (
    <main className="mx-auto max-w-3xl p-6 sm:p-4 sm:p-6">
      <h1 className="mb-1 text-2xl font-bold">Mobi Accountant</h1>
      <p className="mb-6 text-sm text-erp-muted">Ask questions about your business, or run an automated check for issues.</p>
      {!hasApiKey && (
        <div className="mb-6 rounded border border-erp-warning/40 bg-erp-warning/10 p-4 text-sm text-erp-warning">
          The AI assistant isn't configured yet – an administrator needs to set <code>ANTHROPIC_API_KEY</code> in the
          environment. Transaction Analysis (below) works without it, since it doesn't use the AI model.
        </div>
      )}
      <AIAssistantHub businessId={membership.businessId} />
    </main>
  );
}
