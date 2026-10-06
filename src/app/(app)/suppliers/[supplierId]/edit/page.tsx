import { getServerSession } from "next-auth";
import { notFound, redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/erp/display";
import { EditSupplierForm } from "./edit-supplier-form";

export default async function EditSupplierPage(props: { params: Promise<{ supplierId: string }> }) {
  const { supplierId } = await props.params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");
  const membership = memberships[0];
  const ctx = { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId };
  if (!(await hasPermission(ctx, "suppliers.manage"))) redirect(`/suppliers/${supplierId}`);

  const supplier = await prisma.supplier.findFirst({ where: { id: supplierId, businessId: membership.businessId } });
  if (!supplier) notFound();

  return (
    <main className="mx-auto max-w-lg p-4 sm:p-6">
      <PageHeader title="Edit Supplier" description="Update this supplier’s contact details." />
      <EditSupplierForm
        businessId={membership.businessId}
        supplierId={supplier.id}
        initial={{ name: supplier.name, phone: supplier.phone ?? "", email: supplier.email ?? "", address: supplier.address ?? "", isActive: supplier.isActive }}
      />
    </main>
  );
}
