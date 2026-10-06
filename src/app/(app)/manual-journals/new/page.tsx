import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { listAccountsForManualJournal } from "@/lib/manual-journal";
import { resolveTimeZone } from "@/lib/timezone";
import { JournalForm } from "./journal-form";

export default async function NewManualJournalPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const canManage = await hasPermission(
    { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId },
    "accounting.manage"
  );
  if (!canManage || membership.branchId) {
    return (
      <main className="mx-auto max-w-lg p-4 sm:p-6">
        <p className="text-sm text-erp-danger">
          {membership.branchId
            ? "Journal entries post to the whole business's books, so a branch-restricted member can't post one."
            : "Your role does not have permission to post journal entries."}
        </p>
      </main>
    );
  }

  const { accounts, blocked } = await listAccountsForManualJournal(membership.businessId);

  return (
    <main className="mx-auto max-w-4xl p-6 sm:p-4 sm:p-6">
      <Link href="/manual-journals" className="text-sm text-erp-primary underline">← Journal Entries</Link>
      <h1 className="mb-1 mt-2 text-2xl font-bold">New Journal Entry</h1>
      <p className="mb-6 text-sm text-erp-muted">
        Total debits must equal total credits. The entry posts to the ledger immediately and can't be edited afterwards, only voided.
      </p>
      <JournalForm
        businessId={membership.businessId}
        currency={membership.business.currency}
        accounts={accounts}
        blocked={blocked}
        timeZone={resolveTimeZone(membership.business.timezone)}
        closedThrough={membership.business.booksClosedThrough ?? null}
      />
    </main>
  );
}
