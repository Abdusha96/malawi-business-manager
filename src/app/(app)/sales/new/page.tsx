import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { getVatConfig } from "@/lib/vat";
import { NewSaleForm } from "./sale-form";
import { PageHeader } from "@/components/erp/display";

export default async function NewSalePage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;

  const [products, customers, salesByCustomer, branches, vatConfig, cashAccounts] = await Promise.all([
    prisma.product.findMany({
      where: { businessId, isActive: true },
      orderBy: { name: "asc" },
    }),
    prisma.customer.findMany({
      where: { businessId, isActive: true },
      orderBy: { name: "asc" },
    }),
    prisma.sale.groupBy({
      by: ["customerId"],
      where: { businessId, customerId: { not: null }, status: { in: ["PARTIAL", "CREDIT"] }, balance: { gt: 0 } },
      _sum: { balance: true },
    }),
    // A branch-restricted member has nothing to pick – their sale is always
    // attributed to their own branch server-side (see resolveBranchScope in
    // tenant.ts). Only show the picker to an unrestricted member, and only
    // when there's more than the default Head Office branch to choose from.
    membership.branchId
      ? Promise.resolve([])
      : prisma.branch.findMany({
          where: { businessId, isActive: true },
          orderBy: [{ isHeadOffice: "desc" }, { name: "asc" }],
          select: { id: true, name: true },
        }),
    getVatConfig(businessId),
    prisma.cashAccount.findMany({
      where: { businessId, isActive: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }, { name: "asc" }],
      select: { id: true, name: true, type: true },
    }),
  ]);
  const outstandingByCustomerId = new Map(
    salesByCustomer.map((sale) => [sale.customerId, Number(sale._sum.balance ?? 0)])
  );

  if (products.length === 0) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <PageHeader title="New Sale" />
        <p className="text-erp-muted">
          You need at least one product before you can record a sale. Add one from the Inventory page first.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <PageHeader title="New Sale" />
      <NewSaleForm
        businessId={businessId}
        products={products.map((p) => ({
          id: p.id,
          name: p.name,
          sellingPrice: Number(p.sellingPrice),
          quantity: Number(p.quantity),
          isStocked: p.isStocked, // Module 77
          unit: p.unit,
          vatCategory: p.vatCategory,
        }))}
        customers={customers.map((c) => ({
          id: c.id,
          name: c.name,
          creditLimit: Number(c.creditLimit),
          outstanding: outstandingByCustomerId.get(c.id) ?? 0,
        }))}
        branches={branches.length > 1 ? branches : []}
        vatConfig={{ vatRegistered: vatConfig.vatRegistered, vatRate: vatConfig.vatRate }}
        cashAccounts={cashAccounts}
      />
    </main>
  );
}
