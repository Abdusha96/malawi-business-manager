import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { getAccountBalance } from "@/lib/cashbook";
import { FxAdjustmentForm } from "./fx-adjustment-form";
import { resolveTimeZone } from "@/lib/timezone";

export default async function NewFxAdjustmentPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;
  const canManage = await hasPermission(
    { businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId },
    "forex.manage"
  );
  if (!canManage) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <p className="text-sm text-erp-danger">Your role does not have permission to record foreign exchange adjustments.</p>
      </main>
    );
  }

  const cashAccounts = await prisma.cashAccount.findMany({ where: { businessId, isActive: true }, orderBy: { createdAt: "asc" } });
  const accounts = await Promise.all(
    cashAccounts.map(async (a) => ({ id: a.id, name: a.name, type: a.type as string, balance: await getAccountBalance(a.id) }))
  );

  return (
    <main className="mx-auto max-w-lg p-4 sm:p-6">
      <h1 className="mb-1 text-2xl font-bold">Record an Exchange Gain or Loss</h1>
      <p className="mb-6 text-sm text-erp-muted">
        Use this when the exchange rate has changed the {membership.business.currency} value of foreign currency held in one
        of your accounts. It adjusts that account's balance and books the difference to the exchange gain/loss account.
      </p>
      <FxAdjustmentForm
        businessId={businessId}
        currency={membership.business.currency}
        cashAccounts={accounts}
        timeZone={resolveTimeZone(membership.business.timezone)}
      />
    </main>
  );
}
