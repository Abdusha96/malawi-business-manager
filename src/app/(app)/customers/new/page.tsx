import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { PageHeader } from "@/components/erp/display";
import { NewCustomerForm } from "./customer-form";

export default async function NewCustomerPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  return (
    <main className="mx-auto max-w-lg p-4 sm:p-6">
      <PageHeader title="Add Customer" description="Required fields are marked with *." />
      <NewCustomerForm businessId={memberships[0].businessId} />
    </main>
  );
}
