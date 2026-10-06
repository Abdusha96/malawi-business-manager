import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { NewStockTransferForm } from "./transfer-form";

export default async function NewStockTransferPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const businessId = membership.businessId;

  const [products, branches] = await Promise.all([
    prisma.product.findMany({ where: { businessId, isActive: true, isStocked: true }, orderBy: { name: "asc" } }), // Module 77: services have no stock to transfer
    // Unlike Sale/Purchase's optional branch picker, a transfer always
    // needs BOTH ends named – so, unlike /purchases/new, every member sees
    // the full branch list, not just an unrestricted one. Which end a
    // branch-restricted member is actually allowed to submit is still
    // enforced server-side (see the stock-transfers POST route).
    prisma.branch.findMany({
      where: { businessId, isActive: true },
      orderBy: [{ isHeadOffice: "desc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
  ]);

  if (branches.length < 2) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <h1 className="mb-4 text-2xl font-bold">New Stock Transfer</h1>
        <p className="text-erp-muted">
          You need at least two branches before you can transfer stock between them. Add another branch
          from the Branches page first.
        </p>
      </main>
    );
  }

  if (products.length === 0) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <h1 className="mb-4 text-2xl font-bold">New Stock Transfer</h1>
        <p className="text-erp-muted">You need at least one product before transferring stock. Add one from the Inventory page first.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-6">
      <h1 className="mb-6 text-2xl font-bold">New Stock Transfer</h1>
      <NewStockTransferForm
        businessId={businessId}
        products={products.map((p) => ({ id: p.id, name: p.name, unit: p.unit }))}
        branches={branches}
        ownBranchId={membership.branchId}
      />
    </main>
  );
}
