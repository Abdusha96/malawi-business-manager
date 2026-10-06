import { getServerSession } from "next-auth";
import { notFound, redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/erp/display";
import { EditCustomerForm } from "./edit-customer-form";

export default async function EditCustomerPage(props: { params: Promise<{ customerId: string }> }) {
  const { customerId } = await props.params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");
  const membership = memberships[0];
  const ctx = { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId };
  if (!(await hasPermission(ctx, "customers.manage"))) redirect(`/customers/${customerId}`);

  const customer = await prisma.customer.findFirst({ where: { id: customerId, businessId: membership.businessId } });
  if (!customer) notFound();

  return (
    <main className="mx-auto max-w-lg p-4 sm:p-6">
      <PageHeader title="Edit Customer" description="Update this customer’s contact and credit details." />
      <EditCustomerForm
        businessId={membership.businessId}
        customerId={customer.id}
        initial={{
          name: customer.name,
          customerType: customer.customerType,
          phone: customer.phone ?? "",
          email: customer.email ?? "",
          address: customer.address ?? "",
          creditLimit: Number(customer.creditLimit),
          isActive: customer.isActive,
        }}
      />
    </main>
  );
}
