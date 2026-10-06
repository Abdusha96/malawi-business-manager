import { getServerSession } from "next-auth";
import { redirect, notFound } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { getDebitablePurchase } from "@/lib/debit-notes";
import { prisma } from "@/lib/prisma";
import { getAccountBalance } from "@/lib/cashbook";
import { DebitNoteForm } from "./debit-note-form";

export default async function NewDebitNotePage(props: { searchParams: Promise<{ purchaseId?: string }> }) {
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
  const canDebit = await hasPermission(membershipCtx, "refunds.manage");
  if (!canDebit) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <p className="text-sm text-erp-danger">Your role does not have permission to issue debit notes.</p>
      </main>
    );
  }

  if (!searchParams.purchaseId) notFound();

  const data = await getDebitablePurchase({ businessId, purchaseId: searchParams.purchaseId, branchLock: membership.branchId });
  if (!data) notFound();

  if (data.blocked) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <h1 className="mb-1 text-2xl font-bold">{data.purchase.purchaseNumber}</h1>
        <p className="mt-4 text-sm text-erp-muted">{data.blocked}</p>
      </main>
    );
  }

  const cashAccounts = await prisma.cashAccount.findMany({ where: { businessId, isActive: true } });
  const accountsWithBalances = await Promise.all(
    cashAccounts.map(async (a) => ({ id: a.id, name: a.name, type: a.type, balance: await getAccountBalance(a.id) }))
  );

  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-6">
      <h1 className="mb-1 text-2xl font-bold">Issue Debit Note</h1>
      <p className="mb-6 text-sm text-erp-muted">
        {data.purchase.purchaseNumber} – {data.purchase.supplier.name}. MWK{" "}
        {(Number(data.purchase.total) - data.debitedTotal).toLocaleString()} of MWK {Number(data.purchase.total).toLocaleString()} is
        left to debit.
      </p>
      <DebitNoteForm
        businessId={businessId}
        purchaseId={data.purchase.id}
        purchase={{
          subtotal: Number(data.purchase.subtotal),
          total: Number(data.purchase.total),
          balance: Number(data.purchase.balance),
        }}
        debitedTotal={data.debitedTotal}
        items={data.items.map((i) => ({
          id: i.id,
          productName: i.productName,
          vatCategory: i.vatCategory,
          unitCost: i.unitCost,
          isStocked: i.isStocked,
          poolQuantity: i.pool.quantity,
          poolNet: i.pool.net,
          poolVat: i.pool.vatAmount,
        }))}
        cashAccounts={accountsWithBalances}
      />
    </main>
  );
}
