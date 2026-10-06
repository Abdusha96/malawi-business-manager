import type { Metadata } from "next";
import { ContactLine, InfoPage } from "@/components/landing/info-page";

export const metadata: Metadata = { title: "Terms", alternates: { canonical: "/terms" } };

export default function TermsPage() {
  return (
    <InfoPage draftNotice eyebrow="Terms" title="Terms of use." intro="The basics of using Malawi Business Manager.">
      <section>
        <h2>Your account</h2>
        <p>You are responsible for the people you invite, the roles you give them and keeping your login details private.</p>
      </section>
      <section>
        <h2>Your data and your responsibilities</h2>
        <p>You own the records you enter. The platform helps you prepare and track accounting and tax information; you remain responsible for the accuracy of your records, for filing returns, and for meeting your own legal obligations. It does not file returns on your behalf.</p>
      </section>
      <section>
        <h2>Plans and payment</h2>
        <p>New businesses start with a 14-day trial of the Professional plan. Paid plans are billed monthly or annually at the prices shown in Settings → Billing, which can change.</p>
      </section>
      <section>
        <h2>Acceptable use</h2>
        <p>Do not misuse the service, attempt to access another business's data, or interfere with its operation.</p>
      </section>
      <section>
        <h2>Questions</h2>
        <p>Contact <ContactLine />.</p>
      </section>
    </InfoPage>
  );
}
