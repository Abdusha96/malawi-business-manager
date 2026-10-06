import type { Metadata } from "next";
import Link from "next/link";
import { InfoPage } from "@/components/landing/info-page";

export const metadata: Metadata = {
  title: "Getting Started Guides",
  description: "Follow practical steps to set up your business and start recording activity.",
  alternates: { canonical: "/guides" },
};

export default function GuidesPage() {
  return (
    <InfoPage eyebrow="Guides" title="Get your first business workflows running." intro="Start with a small, complete setup. You can add more detail as your team gets comfortable.">
      <section>
        <h2>1. Create your workspace</h2>
        <ol className="list-decimal space-y-2 pl-5">
          <li><Link href="/register">Register your business</Link> and confirm your account.</li>
          <li>Open business settings and check the business name, currency, time zone and tax settings.</li>
          <li>Invite teammates and assign only the roles and permissions they need.</li>
        </ol>
      </section>
      <section>
        <h2>2. Add the records you use</h2>
        <p>Add products or services, customer records and supplier records before recording transactions. Enter opening stock carefully so the inventory quantity agrees with your physical count.</p>
      </section>
      <section>
        <h2>3. Record a sale or purchase</h2>
        <p>Create a sale for goods or services supplied to a customer, or a purchase for items or services bought from a supplier. Record any payment against the transaction so its outstanding balance stays clear.</p>
      </section>
      <section>
        <h2>4. Reconcile a bank statement</h2>
        <p>Open Bank Reconciliation, create a statement for the account and period, then add lines manually or upload a CSV, OFX or QFX statement. Review the preview and warnings before importing. Match each statement line to the corresponding recorded transaction, then complete the reconciliation when the difference is zero.</p>
      </section>
      <section>
        <h2>5. Review your books</h2>
        <p>Use the reports and accounting views to review balances, cash movement, sales, purchases and tax estimates. Check the underlying transactions before relying on a report for a filing or business decision.</p>
      </section>
      <section>
        <h2>Need help?</h2>
        <p>See the <Link href="/docs">product documentation</Link> or browse the <Link href="/help">Help Centre</Link>.</p>
      </section>
    </InfoPage>
  );
}
