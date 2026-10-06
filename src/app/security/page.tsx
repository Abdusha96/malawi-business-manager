import type { Metadata } from "next";
import { ContactLine, InfoPage } from "@/components/landing/info-page";

export const metadata: Metadata = { title: "Security", alternates: { canonical: "/security" } };

export default function SecurityPage() {
  return (
    <InfoPage eyebrow="Security" title="Built for financial control." intro="What the application does to protect your records. This page does not claim any external certification.">
      <section>
        <h2>Access control</h2>
        <ul>
          <li>Owner, Manager, Cashier and Accountant roles with configurable permissions.</li>
          <li>Passwords are stored hashed, never in plain text.</li>
          <li>Sessions expire after 30 days.</li>
          <li>Repeated failed sign-in attempts are temporarily throttled. This basic safeguard does not replace edge protection against distributed attempts.</li>
        </ul>
      </section>
      <section>
        <h2>Data separation and integrity</h2>
        <ul>
          <li>Each business's records are scoped to that business.</li>
          <li>Financially significant changes are recorded in an audit log.</li>
          <li>Closed accounting periods are locked against accidental change.</li>
          <li>Payment-gateway keys that businesses enter are stored encrypted.</li>
        </ul>
      </section>
      <section>
        <h2>Reporting a problem</h2>
        <p>If you believe you have found a security issue, email <ContactLine /> with the details.</p>
      </section>
    </InfoPage>
  );
}
