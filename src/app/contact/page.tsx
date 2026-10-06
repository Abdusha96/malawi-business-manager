import type { Metadata } from "next";
import Link from "next/link";
import { ContactLine, InfoPage } from "@/components/landing/info-page";

export const metadata: Metadata = { title: "Contact", alternates: { canonical: "/contact" } };

export default function ContactPage() {
  return (
    <InfoPage eyebrow="Contact" title="Talk to us." intro="Questions about plans, branches, onboarding or anything else.">
      <section>
        <h2>Email</h2>
        <p>Write to <ContactLine />. Please include your business name and, if you already have an account, the email you log in with.</p>
      </section>
      <section>
        <h2>Already a customer?</h2>
        <p>Plan and billing details are under Settings → Billing after you <Link href="/login">log in</Link>. If you cannot log in, <Link href="/forgot-password">reset your password</Link>.</p>
      </section>
    </InfoPage>
  );
}
