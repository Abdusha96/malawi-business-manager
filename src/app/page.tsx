import type { Metadata } from "next";
import { LandingNavbar, RevealController } from "@/components/landing/client";
import { PricingSection } from "@/components/landing/pricing";
import {
  DashboardShowcase,
  FeatureSection,
  HeroSection,
  ProblemSection,
  SolutionSection,
  TrustBar,
} from "@/components/landing/sections-a";
import {
  CTASection,
  FAQS,
  FAQSection,
  Footer,
  IndustrySection,
  MobileSection,
  MultiBranchSection,
  ReportingSection,
  SecuritySection,
  WhyMalawiSection,
  WorkflowDiagram,
} from "@/components/landing/sections-b";

const TITLE = "Malawi Business Manager | Accounting & Business Management Software";
const DESCRIPTION =
  "Manage accounting, sales, inventory, purchasing, payroll, tax and business operations in one powerful platform built for growing businesses.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Malawi Business Manager",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_MW",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

// Server component: the page ships as static HTML. Only the navbar, the
// pricing toggle, the number counters and the scroll-reveal observer are
// client components.
export default function LandingPage() {
  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Malawi Business Manager",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      description: DESCRIPTION,
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: FAQS.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    },
  ];

  return (
    <>
      <RevealController />
      <LandingNavbar />
      <main id="main">
        <HeroSection />
        <TrustBar />
        <ProblemSection />
        <SolutionSection />
        <FeatureSection />
        <DashboardShowcase />
        <ReportingSection />
        <MultiBranchSection />
        <SecuritySection />
        <WhyMalawiSection />
        <IndustrySection />
        <WorkflowDiagram />
        <MobileSection />
        <PricingSection />
        <FAQSection />
        <CTASection />
      </main>
      <Footer />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  );
}
