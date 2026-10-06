import { getServerSession } from "next-auth";
import { redirect, notFound } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { getRefundableAmount } from "@/lib/refunds";
import { getAccountBalance } from "@/lib/cashbook";
import { RefundForm } from "./refund-form";

export default async function NewRefundPage(
  props: {
    searchParams: Promise<{ saleId?: string; purchaseId?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;
  const membershipCtx = {
    businessId,
    userId: session.user.id,
    role: membership.role,
    branchId: membership.branchId,
  };
  const canRefund = await hasPermission(membershipCtx, "refunds.manage");
  if (!canRefund) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <p className="text-sm text-erp-danger">Your role does not have permission to process refunds.</p>
      </main>
    );
  }

  const { saleId, purchaseId } = searchParams;
  if (!!saleId === !!purchaseId) notFound(); // exactly one is required

  let title: string;
  let customerOrSupplier: string;
  let amountPaid: number;

  if (saleId) {
    const sale = await prisma.sale.findUnique({ where: { id: saleId }, include: { customer: true } });
    if (!sale || sale.businessId !== businessId || sale.status !== "VOIDED") notFound();
    title = sale.saleNumber;
    customerOrSupplier = sale.customer?.name ?? "Walk-in";
    amountPaid = Number(sale.amountPaid);
  } else {
    const purchase = await prisma.purchase.findUnique({ where: { id: purchaseId! }, include: { supplier: true } });
    if (!purchase || purchase.businessId !== businessId || purchase.status !== "VOIDED") notFound();
    title = purchase.purchaseNumber;
    customerOrSupplier = purchase.supplier.name;
    amountPaid = Number(purchase.amountPaid);
  }

  const { refundable } = await getRefundableAmount({ businessId, saleId, purchaseId });
  if (refundable <= 0.01) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <p className="text-sm text-erp-success">
          {title} has no unresolved amount left to refund – every kwacha collected on it already has a refund
          decision recorded.
        </p>
      </main>
    );
  }

  const cashAccounts = await prisma.cashAccount.findMany({ where: { businessId, isActive: true } });
  const accountsWithBalances = await Promise.all(
    cashAccounts.map(async (a) => ({ id: a.id, name: a.name, type: a.type, balance: await getAccountBalance(a.id) }))
  );

  return (
    <main className="mx-auto max-w-lg p-4 sm:p-6">
      <h1 className="mb-1 text-2xl font-bold">Process Refund</h1>
      <p className="mb-6 text-sm text-erp-muted">
        {title} – {customerOrSupplier}. MWK {refundable.toLocaleString()} of MWK {amountPaid.toLocaleString()}{" "}
        collected is still unresolved.
      </p>
      <RefundForm
        businessId={businessId}
        saleId={saleId}
        purchaseId={purchaseId}
        kind={saleId ? "SALE" : "PURCHASE"}
        refundable={refundable}
        cashAccounts={accountsWithBalances}
      />
    </main>
  );
}
