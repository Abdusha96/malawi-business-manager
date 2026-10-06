import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { PageHeader, FormCard } from "@/components/erp/display";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { getAccountBalance } from "@/lib/cashbook";
import { buildIncomeTaxPeriodOptions } from "@/lib/tax-payments";
import { TAX_PAYMENT_TYPES, TAX_PAYMENT_TYPE_LABELS, monthKey } from "@/lib/tax-period";
import { TaxPaymentForm } from "./tax-payment-form";
import { resolveTimeZone, startOfMonthIn } from "@/lib/timezone";

export default async function NewTaxPaymentPage(props: { searchParams: Promise<{ type?: string; period?: string }> }) {
  const searchParams = await props.searchParams;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;
  const canManage = await hasPermission(
    { businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId },
    "taxpayments.manage"
  );
  if (!canManage) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <p className="text-sm text-erp-danger">Your role does not have permission to record tax payments.</p>
      </main>
    );
  }

  const [business, cashAccounts] = await Promise.all([
    prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { vatRegistered: true, financialYearStartMonth: true, timezone: true } }),
    prisma.cashAccount.findMany({ where: { businessId, isActive: true }, orderBy: { createdAt: "asc" } }),
  ]);
  const accounts = await Promise.all(
    cashAccounts.map(async (a) => ({ id: a.id, name: a.name, type: a.type as string, balance: await getAccountBalance(a.id) }))
  );

  const tz = resolveTimeZone(business.timezone);
  const previousMonth = monthKey(startOfMonthIn(new Date(), tz, -1), tz);
  const types = TAX_PAYMENT_TYPES.filter((t) => t !== "VAT" || business.vatRegistered).map((t) => ({ value: t, label: TAX_PAYMENT_TYPE_LABELS[t] }));
  const initialType = types.some((t) => t.value === searchParams.type) ? (searchParams.type as string) : types[0].value;

  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-6">
      <PageHeader
        title="Record a Tax Payment"
        description="Record money you've already paid the MRA. It's taken out of the account you choose and clears the matching tax liability on your books."
      />
      <FormCard>
      <TaxPaymentForm
        businessId={businessId}
        types={types}
        initialType={initialType}
        initialPeriod={searchParams.period ?? null}
        defaultMonth={previousMonth}
        incomeTaxOptions={buildIncomeTaxPeriodOptions(business.financialYearStartMonth, tz)}
        cashAccounts={accounts}
        timeZone={tz}
      />
      </FormCard>
    </main>
  );
}
