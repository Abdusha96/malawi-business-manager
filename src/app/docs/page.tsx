import type { Metadata } from "next";
import Link from "next/link";
import { InfoPage } from "@/components/landing/info-page";

export const metadata: Metadata = {
  title: "Product Documentation",
  description: "Learn what Malawi Business Manager does and how its main workflows fit together.",
  alternates: { canonical: "/docs" },
};

export default function DocsPage() {
  return (
    <InfoPage eyebrow="Documentation" title="How the workspace fits together." intro="A practical map of the main records and workflows in Malawi Business Manager.">
      <section>
        <h2>Set up your business</h2>
        <p>Create your workspace, choose your business time zone and add team members with the roles they need. The Owner manages settings, billing and access.</p>
      </section>
      <section>
        <h2>Record day-to-day activity</h2>
        <p>Add products and services, customers and suppliers. Record sales, purchases, expenses and money received or paid. Transactions update the relevant cashbook, inventory and accounting records together.</p>
      </section>
      <section>
        <h2>Review and reconcile</h2>
        <p>Use reports to review balances and performance. Bank reconciliation compares imported or manually entered statement lines with recorded transactions; imports remain unmatched until reviewed.</p>
      </section>
      <section>
        <h2>More detail</h2>
        <ul>
          <li><Link href="/guides">Step-by-step guides</Link> for the first setup and common workflows.</li>
          <li><Link href="/help">Help Centre</Link> for common questions and contact information.</li>
          <li><Link href="/security">Security overview</Link> for how access and business data are handled.</li>
        </ul>
      </section>
    </InfoPage>
  );
}
