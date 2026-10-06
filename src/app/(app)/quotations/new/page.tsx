import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { getVatConfig } from "@/lib/vat";
import { NewQuotationForm } from "./quotation-form";

export default async function NewQuotationPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;

  const [products, customers, branches, vatConfig] = await Promise.all([
    prisma.product.findMany({ where: { businessId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.customer.findMany({ where: { businessId, isActive: true }, orderBy: { name: "asc" } }),
    membership.branchId
      ? Promise.resolve([])
      : prisma.branch.findMany({
          where: { businessId, isActive: true },
          orderBy: [{ isHeadOffice: "desc" }, { name: "asc" }],
          select: { id: true, name: true },
        }),
    getVatConfig(businessId),
  ]);

  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-6">
      <h1 className="mb-6 text-2xl font-bold">New Quotation</h1>
      <NewQuotationForm
        businessId={businessId}
        products={products.map((p) => ({ id: p.id, name: p.name, sellingPrice: Number(p.sellingPrice), unit: p.unit, vatCategory: p.vatCategory }))}
        customers={customers.map((c) => ({ id: c.id, name: c.name }))}
        branches={branches.length > 1 ? branches : []}
        vatConfig={{ vatRegistered: vatConfig.vatRegistered, vatRate: vatConfig.vatRate }}
      />
    </main>
  );
}
