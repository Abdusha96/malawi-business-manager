import type { Metadata } from "next";
import { ContactLine, InfoPage } from "@/components/landing/info-page";

export const metadata: Metadata = { title: "Privacy", alternates: { canonical: "/privacy" } };

export default function PrivacyPage() {
  return (
    <InfoPage draftNotice eyebrow="Privacy" title="How we handle your information." intro="What the platform stores, who processes it, and how to reach us.">
      <section>
        <h2>What we store</h2>
        <ul>
          <li>Account details: name, email, phone number and a hashed password.</li>
          <li>Business records you enter: sales, purchases, inventory, customers, suppliers, employees, payroll, tax settings and accounting entries.</li>
          <li>An audit log of financially significant changes, with the user who made them.</li>
        </ul>
      </section>
      <section>
        <h2>Who processes data for us</h2>
        <ul>
          <li>Email notifications are sent through Resend.</li>
          <li>SMS notifications are sent through Africa's Talking.</li>
          <li>Online payments are processed by PayChangu.</li>
          <li>If you use the Mobi Accountant assistant, your question and the business figures needed to answer it are sent to Anthropic's API.</li>
        </ul>
      </section>
      <section>
        <h2>Separation between businesses</h2>
        <p>Records belong to the business that created them. Team members see only the businesses they belong to, and only what their role permits.</p>
      </section>
      <section>
        <h2>Your choices</h2>
        <p>You can ask us to correct or delete your account information. Accounting records may need to be kept for your own legal and tax purposes. Contact <ContactLine />.</p>
      </section>
    </InfoPage>
  );
}
