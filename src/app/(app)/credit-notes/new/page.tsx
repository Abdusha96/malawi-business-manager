import { getServerSession } from "next-auth";
import { redirect, notFound } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { getCreditableSale } from "@/lib/credit-notes";
import { prisma } from "@/lib/prisma";
import { getAccountBalance } from "@/lib/cashbook";
import { CreditNoteForm } from "./credit-note-form";

export default async function NewCreditNotePage(props: { searchParams: Promise<{ saleId?: string }> }) {
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
  const canCredit = await hasPermission(membershipCtx, "refunds.manage");
  if (!canCredit) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <p className="text-sm text-erp-danger">Your role does not have permission to issue credit notes.</p>
      </main>
    );
  }

  if (!searchParams.saleId) notFound();

  const data = await getCreditableSale({ businessId, saleId: searchParams.saleId, branchLock: membership.branchId });
  if (!data) notFound();

  if (data.blocked) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <h1 className="mb-1 text-2xl font-bold">{data.sale.saleNumber}</h1>
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
      <h1 className="mb-1 text-2xl font-bold">Issue Credit Note</h1>
      <p className="mb-6 text-sm text-erp-muted">
        {data.sale.saleNumber} – {data.sale.customer?.name ?? "Walk-in customer"}. MWK{" "}
        {(Number(data.sale.total) - data.creditedTotal).toLocaleString()} of MWK {Number(data.sale.total).toLocaleString()} is
        left to credit.
      </p>
      <CreditNoteForm
        businessId={businessId}
        saleId={data.sale.id}
        sale={{
          subtotal: Number(data.sale.subtotal),
          discount: Number(data.sale.discount),
          total: Number(data.sale.total),
          balance: Number(data.sale.balance),
        }}
        creditedTotal={data.creditedTotal}
        creditedDiscountShare={data.creditedDiscountShare}
        hasCustomer={!!data.sale.customerId}
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
