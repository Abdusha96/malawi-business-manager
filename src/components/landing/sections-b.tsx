import Link from "next/link";
import { Button, Card, CheckItem, FeatureIcon, Logo, SectionHeading } from "./ui";
import { MiniTable, ProductPreview, AgingBars, ChartPreview } from "./previews";

export const CONTACT_HREF = "/contact";

/* ------------------------------------------------------------------ */
const REPORTS = [
  { t: "Balance Sheet", i: "ledger" }, { t: "Income Statement", i: "trend" }, { t: "Cash Flow Statement", i: "coin" },
  { t: "Trial Balance", i: "ledger" }, { t: "General Ledger", i: "doc" }, { t: "Sales Report", i: "cart" },
  { t: "Expenses Report", i: "wrench" }, { t: "Inventory Valuation", i: "box" }, { t: "Customer Debt", i: "user" },
  { t: "Supplier Debt", i: "store" }, { t: "Product Profitability", i: "chart" }, { t: "Tax Records", i: "percent" },
];

export function ReportingSection() {
  return (
    <section className="bg-ink-50/70 py-20 sm:py-28" aria-labelledby="reports-title">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <SectionHeading eyebrow="Reporting" id="reports-title" title="Reports that answer real business questions." description="Financial statements and operational reports, ready for any date range. Export operational reports to CSV and download invoices, receipts and notes as PDF." />
        <div className="mt-14 grid items-start gap-8 lg:grid-cols-[1fr_1.1fr]">
          <ul className="reveal grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3">
            {REPORTS.map((r) => (
              <li key={r.t}>
                <Card hover className="flex h-full flex-col items-start gap-3 p-4">
                  <FeatureIcon name={r.i} />
                  <span className="text-sm font-semibold text-ink-800">{r.t}</span>
                </Card>
              </li>
            ))}
          </ul>
          <div className="reveal min-w-0">
            <ProductPreview title="Reports · Income statement · Sample data">
              <div className="flex items-start justify-between">
                <div><p className="text-sm font-bold text-ink-900">Income Statement</p><p className="text-[11px] text-ink-400">1 Jul – 30 Sep 2026</p></div>
                <span className="flex gap-1.5 text-[11px] font-semibold"><span className="rounded border border-ink-200 px-2 py-1 text-ink-600">CSV</span><span className="rounded border border-ink-200 px-2 py-1 text-ink-600">PDF</span></span>
              </div>
              <div className="mt-3"><MiniTable head={["", "MWK"]} right={[1]} rows={[
                ["Sales revenue", "84,520,000"], ["Cost of goods sold", "(41,380,000)"],
                [<strong key="g">Gross profit</strong>, <strong key="gp">43,140,000</strong>],
                ["Operating expenses", "(10,800,000)"],
                [<strong key="n" className="text-brand-700">Net profit</strong>, <strong key="np" className="text-brand-700">32,340,000</strong>],
              ]} /></div>
            </ProductPreview>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
export function MultiBranchSection() {
  const branches = ["Head Office", "Blantyre Branch", "Lilongwe Branch", "Mzuzu Branch"];
  return (
    <section className="py-20 sm:py-28" aria-labelledby="branch-title">
      <div className="mx-auto grid max-w-7xl items-center gap-12 px-5 sm:px-8 lg:grid-cols-2">
        <div>
          <SectionHeading align="left" eyebrow="Branches" id="branch-title" title="One platform. Multiple businesses. Multiple branches." description="Manage branches from one secure platform. Each business keeps its own records, and branch-level stock, sales and reports can be viewed per branch. Multiple branches are available on the Professional plan." />
          <ul className="reveal mt-6 space-y-2.5">
            <CheckItem>Business records are kept separate from every other business</CheckItem>
            <CheckItem>Assign team members to a branch</CheckItem>
            <CheckItem>Transfer stock between branches with in-transit tracking</CheckItem>
            <CheckItem>Switch the dashboard between branches</CheckItem>
          </ul>
        </div>
        <Card className="reveal p-7">
          <div className="flex items-center gap-3 rounded-xl bg-ink-900 px-4 py-3 text-white">
            <FeatureIcon name="store" tone="white" className="!h-9 !w-9" />
            <div><p className="text-sm font-bold">Your Business</p><p className="text-[11px] text-ink-300">Sample structure</p></div>
          </div>
          <ul className="ml-5 mt-1 border-l-2 border-ink-100 pl-6">
            {branches.map((b, i) => (
              <li key={b} className="relative py-2.5">
                <span className="absolute -left-6 top-1/2 h-0.5 w-6 bg-ink-100" aria-hidden="true" />
                <div className="flex items-center justify-between rounded-lg border border-ink-100 bg-white px-4 py-3 shadow-card">
                  <span className="flex items-center gap-2.5 text-sm font-semibold text-ink-800"><FeatureIcon name="branch" className="!h-8 !w-8" />{b}</span>
                  <span className="text-xs font-semibold tabular-nums text-ink-400">{["MWK 31.2M", "MWK 24.6M", "MWK 19.8M", "MWK 8.9M"][i]}</span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
const CONTROLS = [
  { i: "users", t: "Role-based access", d: "Owner, Manager, Cashier and Accountant roles with different permissions." },
  { i: "doc", t: "Audit log", d: "Financially significant changes are recorded with who made them and when." },
  { i: "shield", t: "Business isolation", d: "Each business's data is separated from every other business." },
  { i: "lock", t: "Fine-grained permissions", d: "Access to reports, settings, payroll and more is controlled by permission." },
  { i: "user", t: "Team invitations", d: "Invite people by email and set their role and branch." },
  { i: "clock", t: "Period locking", d: "Close an accounting period so closed figures cannot be changed by accident." },
];

export function SecuritySection() {
  return (
    <section className="bg-ink-900 py-20 text-white sm:py-28" aria-labelledby="security-title">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <SectionHeading invert eyebrow="Control" id="security-title" title="Built for financial control." description="Give people the access they need and nothing more, and keep a record of what changed." />
        <ul className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CONTROLS.map((c) => (
            <li key={c.t} className="reveal rounded-2xl border border-white/10 bg-ink-800 p-6 transition hover:border-brand-500/50">
              <FeatureIcon name={c.i} tone="white" />
              <h3 className="mt-4 text-base font-bold">{c.t}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-200">{c.d}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
export function WhyMalawiSection() {
  const items = [
    { i: "coin", t: "MWK-first", d: "Built around Malawi Kwacha. Foreign-currency transactions are supported with exchange gains and losses recorded." },
    { i: "percent", t: "Local tax workflows", d: "VAT, withholding tax and PAYE with a tax calendar, with bands and rates you configure." },
    { i: "store", t: "Local businesses", d: "Suitable for SMEs, retailers, wholesalers, service businesses and growing companies." },
    { i: "cloud", t: "Web-based", d: "Open it in a browser wherever you work. Nothing to install." },
  ];
  return (
    <section className="py-20 sm:py-28" aria-labelledby="why-title">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <SectionHeading eyebrow="Why Malawi Business Manager" id="why-title" title="Built with Malawi businesses in mind." />
        <ul className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((x) => (
            <li key={x.t} className="reveal">
              <Card hover className="h-full p-6">
                <FeatureIcon name={x.i} />
                <h3 className="mt-4 text-lg font-bold text-ink-900">{x.t}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-500">{x.d}</p>
              </Card>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
const WHO = [
  { i: "store", t: "Small Businesses", d: "Keep finances, sales and expenses organized." },
  { i: "cart", t: "Retailers", d: "Manage products, stock, sales and customers." },
  { i: "truck", t: "Wholesalers", d: "Control purchasing, inventory and customer balances." },
  { i: "wrench", t: "Service Businesses", d: "Manage customers, invoices and financial records." },
  { i: "trend", t: "Growing Companies", d: "Manage branches, users, accounting and reporting." },
];

export function IndustrySection() {
  return (
    <section id="solutions" className="scroll-mt-20 bg-ink-50/70 py-20 sm:py-28" aria-labelledby="who-title">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <SectionHeading eyebrow="Solutions" id="who-title" title="Made for the way you do business." />
        <ul className="mt-14 flex snap-x gap-4 overflow-x-auto pb-4 lg:grid lg:grid-cols-5 lg:overflow-visible lg:pb-0">
          {WHO.map((w) => (
            <li key={w.t} className="w-64 shrink-0 snap-start lg:w-auto">
              <Card hover className="h-full p-6">
                <FeatureIcon name={w.i} />
                <h3 className="mt-4 text-base font-bold text-ink-900">{w.t}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-500">{w.d}</p>
              </Card>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
function WorkflowColumn({ title, steps }: { title: string; steps: { t: string; d: string }[] }) {
  return (
    <div className="reveal rounded-2xl border border-white/10 bg-ink-800 p-7">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-300">{title}</p>
      <ol className="mt-6">
        {steps.map((s, i) => (
          <li key={s.t} className="relative flex gap-4 pb-6 last:pb-0">
            {i < steps.length - 1 && <span className="absolute left-[15px] top-8 h-[calc(100%-1.5rem)] w-px bg-brand-500/40" aria-hidden="true" />}
            <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-bold">{i + 1}</span>
            <div><p className="font-semibold">{s.t}</p><p className="text-sm text-ink-300">{s.d}</p></div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function WorkflowDiagram() {
  return (
    <section className="bg-ink-900 pb-20 text-white sm:pb-28" aria-labelledby="flow-title">
      <div className="mx-auto max-w-7xl px-5 pt-0 sm:px-8">
        <div className="border-t border-white/10 pt-20 sm:pt-28">
          <SectionHeading invert eyebrow="How it fits together" id="flow-title" title="One transaction, followed all the way through." description="Each step updates the books, so reports are always working from the same numbers." />
        </div>
        <div className="mt-14 grid gap-5 lg:grid-cols-2">
          <WorkflowColumn title="Sale" steps={[
            { t: "Customer", d: "Choose or add the customer" },
            { t: "Quotation", d: "Optional: quote first, then convert to a sale" },
            { t: "Invoice", d: "Stock is deducted, PDF is ready to share" },
            { t: "Payment", d: "Cash, mobile money or bank, in full or in part" },
            { t: "Accounting", d: "Revenue, receivables, stock and tax post to the ledger" },
            { t: "Financial report", d: "Appears in the income statement and balance sheet" },
          ]} />
          <WorkflowColumn title="Purchase" steps={[
            { t: "Supplier", d: "Choose or add the supplier" },
            { t: "Purchase", d: "Record what you bought and where it goes" },
            { t: "Stock received", d: "Inventory and its value update in the chosen branch" },
            { t: "Supplier balance", d: "Anything unpaid is tracked as a payable" },
            { t: "Payment", d: "Pay from a cash or bank account" },
            { t: "Accounting", d: "Every step posts to the ledger" },
          ]} />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
function Phone({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="w-44 shrink-0 rounded-[1.75rem] border-[5px] border-ink-800 bg-white p-2.5 shadow-float sm:w-52">
      <div className="mx-auto mb-2 h-1 w-12 rounded-full bg-ink-200" aria-hidden="true" />
      <p className="mb-2 text-[11px] font-bold text-ink-900">{title}</p>
      {children}
    </div>
  );
}

export function MobileSection() {
  return (
    <section className="overflow-hidden py-20 sm:py-28" aria-labelledby="mobile-title">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <SectionHeading eyebrow="Anywhere" id="mobile-title" title="Your business doesn't stop when you leave the office." description="Malawi Business Manager is a web application that adapts to desktop, tablet and phone screens. Open it in your browser; there is no separate mobile app." />
        <div className="reveal mt-14 flex items-end justify-center gap-5" aria-label="Sample screens on phone and tablet sizes" role="img">
          <Phone title="Dashboard">
            <div className="rounded-lg bg-brand-50 p-2"><p className="text-[9px] text-ink-500">Net profit</p><p className="text-sm font-bold tabular-nums text-ink-900">MWK 32.3M</p></div>
            <div className="mt-2"><ChartPreview a={[52, 61, 58, 70, 76, 85]} b={[38, 41, 44, 47, 50, 52]} height={70} /></div>
          </Phone>
          <div className="hidden w-[22rem] shrink-0 rounded-[1.5rem] border-[6px] border-ink-800 bg-white p-4 shadow-float md:block">
            <p className="mb-2 text-xs font-bold text-ink-900">Inventory</p>
            <MiniTable head={["Product", "On hand", "Value"]} right={[1, 2]} rows={[["Cooking oil 5L", "186", "1.9M"], ["Sugar 2kg", "320", "2.4M"], ["Rice 25kg", "95", "3.1M"]]} />
          </div>
          <Phone title="Invoice INV-01482">
            <p className="text-[10px] text-ink-500">Chikondi Traders</p>
            <p className="mt-1 text-sm font-bold tabular-nums">MWK 1,240,000</p>
            <div className="mt-2"><AgingBars rows={[{ label: "Paid", value: "60%", pct: 60 }]} /></div>
            <p className="mt-3 rounded-md bg-brand-600 py-1.5 text-center text-[10px] font-semibold text-white">Record payment</p>
          </Phone>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
export function CTASection() {
  return (
    <section id="contact" className="scroll-mt-20 px-5 pb-20 sm:px-8 sm:pb-28" aria-labelledby="cta-title">
      <div className="reveal relative mx-auto max-w-6xl overflow-hidden rounded-3xl bg-gradient-to-br from-ink-900 via-ink-800 to-brand-900 px-6 py-16 text-center text-white sm:px-12 sm:py-20">
        <div className="absolute -right-20 -top-20 h-72 w-72 rounded-full bg-brand-500/20 blur-3xl" aria-hidden="true" />
        <h2 id="cta-title" className="relative text-3xl font-bold tracking-tight sm:text-4xl">Take control of your business finances.</h2>
        <p className="relative mx-auto mt-4 max-w-2xl text-lg text-ink-200">Bring accounting, sales, inventory, purchasing and reporting together in one platform.</p>
        <div className="relative mt-9 flex flex-wrap justify-center gap-3">
          <Button href="/register" variant="primary" size="lg">Start Free</Button>
          <Button href={CONTACT_HREF} variant="light" size="lg">Talk to Us</Button>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
export const FAQS = [
  { q: "Is Malawi Business Manager suitable for small businesses?", a: "Yes. The Free plan covers one user and one branch with up to 50 sales a month, and the Business plan removes the sales and user limits. New businesses also get a 14-day trial of the Professional plan." },
  { q: "Can I manage multiple branches?", a: "Yes, on the Professional plan. You can create branches, assign team members to them, view the dashboard per branch and transfer stock between branches." },
  { q: "Can I manage inventory?", a: "Yes. Track stock by branch, set reorder levels, transfer stock, adjust it, run stock counts and see inventory valuation. Service items that are not stocked are supported too." },
  { q: "Can I create invoices?", a: "Yes. Create quotations and convert them to sales, issue invoices and receipts as PDFs, record payments, and issue credit and debit notes." },
  { q: "Does it support accounting reports?", a: "Yes. The income statement, balance sheet, cash flow statement, trial balance and general ledger are included, along with sales, expense, inventory, customer debt and supplier debt reports." },
  { q: "Can I export reports?", a: "Operational reports can be exported to CSV, and invoices, receipts, quotations and credit and debit notes can be downloaded as PDF." },
  { q: "Can multiple users access the system?", a: "Yes, on the Business plan and above. Invite team members and give them an Owner, Manager, Cashier or Accountant role." },
  { q: "Can I manage payroll?", a: "Yes, on the Professional plan. Keep employee records, run payroll with PAYE and pension, and produce payslips." },
  { q: "Does it support tax workflows?", a: "Yes. Configure VAT, withholding tax and PAYE, follow a tax calendar, and record tax payments. The platform helps you prepare and track; it does not file returns for you." },
  { q: "Can I use MWK?", a: "Yes. Malawi Kwacha is the default currency, and foreign-currency transactions are supported with exchange gains and losses recorded." },
];

export function FAQSection() {
  return (
    <section id="faq" className="scroll-mt-20 bg-ink-50/70 py-20 sm:py-28" aria-labelledby="faq-title">
      <div className="mx-auto max-w-3xl px-5 sm:px-8">
        <SectionHeading eyebrow="FAQ" id="faq-title" title="Questions, answered." />
        <div className="reveal mt-12 divide-y divide-ink-200 rounded-2xl border border-ink-100 bg-white shadow-card">
          {FAQS.map((f) => (
            <details key={f.q} className="group px-6 py-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-md text-left text-base font-semibold text-ink-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-700 [&::-webkit-details-marker]:hidden">
                {f.q}
                <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-ink-400 transition group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
              </summary>
              <p className="mt-3 leading-relaxed text-ink-500">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
export function Footer() {
  const col = "text-sm text-ink-300 transition hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400";
  return (
    <footer id="resources" className="scroll-mt-20 bg-ink-900 text-white">
      <div className="mx-auto max-w-7xl px-5 py-16 sm:px-8">
        <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Logo invert />
            <p className="mt-4 max-w-xs text-sm text-ink-300">Accounting and business management for growing businesses in Malawi.</p>
          </div>
          <nav aria-label="Product">
            <h3 className="text-xs font-bold uppercase tracking-widest text-ink-400">Product</h3>
            <ul className="mt-4 space-y-2.5">
              {[["/#features", "Features"], ["/#accounting", "Accounting"], ["/#sales", "Sales"], ["/#inventory", "Inventory"], ["/#purchasing", "Purchasing"], ["/#pricing", "Pricing"]].map(([h, l]) => (
                <li key={h}><a className={col} href={h}>{l}</a></li>
              ))}
            </ul>
          </nav>
          <nav aria-label="Account">
            <h3 className="text-xs font-bold uppercase tracking-widest text-ink-400">Account</h3>
            <ul className="mt-4 space-y-2.5">
              <li><Link className={col} href="/login">Log in</Link></li>
              <li><Link className={col} href="/register">Start Free</Link></li>
              <li><Link className={col} href="/forgot-password">Reset password</Link></li>
            </ul>
          </nav>
          <nav aria-label="Company and legal">
            <h3 className="text-xs font-bold uppercase tracking-widest text-ink-400">Company</h3>
            <ul className="mt-4 space-y-2.5">
              <li><Link className={col} href="/about">About</Link></li>
              <li><Link className={col} href="/contact">Contact</Link></li>
              <li><Link className={col} href="/help">Help Centre</Link></li>
              <li><Link className={col} href="/docs">Documentation</Link></li>
              <li><Link className={col} href="/guides">Guides</Link></li>
              <li><Link className={col} href="/privacy">Privacy</Link></li>
              <li><Link className={col} href="/terms">Terms</Link></li>
              <li><Link className={col} href="/security">Security</Link></li>
            </ul>
          </nav>
        </div>
        <div className="mt-12 flex flex-col justify-between gap-2 border-t border-white/10 pt-6 text-sm text-ink-400 sm:flex-row">
          <p>© 2026 Malawi Business Manager</p>
          <p>Built for businesses. Designed for growth.</p>
        </div>
      </div>
    </footer>
  );
}
