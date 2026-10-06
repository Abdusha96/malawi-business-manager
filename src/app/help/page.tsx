import type { Metadata } from "next";
import Link from "next/link";
import { FAQS } from "@/components/landing/sections-b";
import { ContactLine, InfoPage } from "@/components/landing/info-page";

export const metadata: Metadata = { title: "Help Centre", alternates: { canonical: "/help" } };

export default function HelpPage() {
  return (
    <InfoPage eyebrow="Help Centre" title="Answers to common questions." intro="Here is what the platform does today. For anything else, get in touch.">
      {FAQS.map((f) => (
        <section key={f.q}>
          <h2>{f.q}</h2>
          <p>{f.a}</p>
        </section>
      ))}
      <section>
        <h2>Getting started</h2>
        <ul>
          <li><Link href="/register">Create a business</Link> and start the 14-day trial.</li>
          <li>Add products, customers and suppliers, then record your first sale or purchase.</li>
        </ul>
        <p className="mt-3">Still stuck? Email <ContactLine />.</p>
      </section>
    </InfoPage>
  );
}
