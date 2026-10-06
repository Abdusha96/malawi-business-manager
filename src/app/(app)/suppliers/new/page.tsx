import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/tenant";
import { PageHeader } from "@/components/erp/display";
import { NewSupplierForm } from "./supplier-form";

export default async function NewSupplierPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  return (
    <main className="mx-auto max-w-lg p-4 sm:p-6">
      <PageHeader title="Add Supplier" description="Required fields are marked with *." />
      <NewSupplierForm businessId={memberships[0].businessId} />
    </main>
  );
}
