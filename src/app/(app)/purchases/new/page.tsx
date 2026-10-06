import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { getVatConfig } from "@/lib/vat";
import { NewPurchaseForm } from "./purchase-form";
import { PageHeader } from "@/components/erp/display";

export default async function NewPurchasePage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;

  const [products, suppliers, branches, vatConfig] = await Promise.all([
    prisma.product.findMany({ where: { businessId, isActive: true }, orderBy: { name: "asc" } }), // Module 78: services can be bought too (no stock added)
    prisma.supplier.findMany({ where: { businessId, isActive: true }, orderBy: { name: "asc" } }),
    // Module 27: same "only show the picker to an unrestricted member"
    // pattern as /sales/new – see that page's comment.
    membership.branchId
      ? Promise.resolve([])
      : prisma.branch.findMany({
          where: { businessId, isActive: true },
          orderBy: [{ isHeadOffice: "desc" }, { name: "asc" }],
          select: { id: true, name: true },
        }),
    getVatConfig(businessId),
  ]);

  if (products.length === 0) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <PageHeader title="New Purchase" />
        <p className="text-erp-muted">You need at least one product before recording a purchase. Add one from the Inventory page first.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <PageHeader title="New Purchase" />
      <NewPurchaseForm
        businessId={businessId}
        products={products.map((p) => ({ id: p.id, name: p.name, purchasePrice: Number(p.purchasePrice), unit: p.unit, isStocked: p.isStocked, vatCategory: p.vatCategory }))}
        suppliers={suppliers.map((s) => ({ id: s.id, name: s.name }))}
        branches={branches.length > 1 ? branches : []}
        vatConfig={{ vatRegistered: vatConfig.vatRegistered, vatRate: vatConfig.vatRate }}
      />
    </main>
  );
}
