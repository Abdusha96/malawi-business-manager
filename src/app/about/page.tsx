import type { Metadata } from "next";
import { InfoPage } from "@/components/landing/info-page";

export const metadata: Metadata = { title: "About", alternates: { canonical: "/about" } };

export default function AboutPage() {
  return (
    <InfoPage eyebrow="About" title="Accounting and business management, built for Malawi." intro="Malawi Business Manager is a web-based platform that brings sales, purchasing, inventory, accounting, payroll, tax and reporting into one system.">
      <section>
        <h2>What it is</h2>
        <p>Every transaction you record posts to the same set of books, so a sale, a purchase or a payroll run is reflected in your ledgers, balances and reports without re-entering it.</p>
      </section>
      <section>
        <h2>Who it is for</h2>
        <p>Small businesses, retailers, wholesalers, service businesses and growing companies that want to replace scattered spreadsheets with one connected system, in Malawi Kwacha, with VAT, withholding tax and PAYE built in.</p>
      </section>
      <section>
        <h2>How it is built</h2>
        <p>Each business's data is kept separate from every other business, access is controlled by role and permission, and financially significant changes are written to an audit log.</p>
      </section>
    </InfoPage>
  );
}
