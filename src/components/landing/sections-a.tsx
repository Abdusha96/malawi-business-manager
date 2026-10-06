import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, Button, Card, CheckItem, FeatureIcon, SectionHeading } from "./ui";
import { DashboardPreview, FlowSteps, MiniTable, ProductPreview, ChartPreview, DashboardWidget } from "./previews";

/* ------------------------------------------------------------------ */
export function HeroSection() {
  return (
    <section className="relative overflow-hidden" aria-labelledby="hero-title">
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-brand-50/70 via-white to-white" aria-hidden="true" />
      <div className="grid-bg absolute inset-0 -z-10" aria-hidden="true" />
      <div className="absolute -right-24 top-10 -z-10 h-[460px] w-[460px] rounded-full bg-brand-200/40 blur-3xl" aria-hidden="true" />

      <div className="mx-auto grid max-w-7xl items-center gap-12 px-5 pb-20 pt-12 sm:px-8 lg:grid-cols-[1.05fr_1fr] lg:pb-28 lg:pt-20">
        <div className="animate-rise">
          <span className="inline-flex rounded-full border border-brand-200 bg-white px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-brand-800">
            Accounting • Finance • Business Management
          </span>
          <h1 id="hero-title" className="mt-6 text-4xl font-extrabold leading-[1.08] tracking-tight text-ink-900 sm:text-5xl lg:text-[3.1rem] xl:text-[3.4rem]">
            Run Your Business.
            <br />
            Know Your Numbers.
            <br />
            <span className="text-brand-600">Grow With Confidence.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-500">
            One powerful platform for accounting, sales, inventory, purchasing, payroll, tax, banking and everyday business management.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button href="/register" size="lg">Start Free</Button>
            <Button href="#product" variant="secondary" size="lg">Explore the Platform</Button>
          </div>
          <p className="mt-5 text-sm text-ink-400">No complicated setup. No spreadsheets everywhere. One connected business system.</p>
        </div>

        <div className="relative min-w-0 animate-rise [animation-delay:150ms]">
          <div className="animate-float">
            <DashboardPreview />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
const CATEGORIES = [
  { icon: "ledger", label: "Accounting" },
  { icon: "cart", label: "Sales" },
  { icon: "truck", label: "Purchasing" },
  { icon: "box", label: "Inventory" },
  { icon: "users", label: "Payroll" },
  { icon: "percent", label: "Tax" },
  { icon: "bank", label: "Banking" },
  { icon: "chart", label: "Reports" },
];

export function TrustBar() {
  return (
    <section aria-labelledby="trust-title" className="border-y border-ink-100 bg-white">
      <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8">
        <h2 id="trust-title" className="reveal text-center text-lg font-semibold text-ink-700">Everything your business needs to stay in control.</h2>
        <ul className="reveal mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          {CATEGORIES.map((c) => (
            <li key={c.label} className="flex flex-col items-center gap-2 rounded-xl border border-ink-100 bg-ink-50/60 px-3 py-4 text-center transition hover:border-brand-200 hover:bg-brand-50/60">
              <FeatureIcon name={c.icon} />
              <span className="text-sm font-semibold text-ink-700">{c.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
const PROBLEMS = [
  "Spreadsheets scattered across different computers",
  "Difficult-to-track customer balances",
  "Unclear cash position",
  "Manual invoice preparation",
  "Stock discrepancies",
  "Complicated reporting",
  "Tax compliance challenges",
  "Information spread across multiple systems",
];

export function ProblemSection() {
  return (
    <section className="bg-ink-50/70 py-20 sm:py-24" aria-labelledby="problem-title">
      <div className="mx-auto grid max-w-7xl items-center gap-12 px-5 sm:px-8 lg:grid-cols-2">
        <div className="reveal relative mx-auto w-full max-w-md" aria-hidden="true">
          {/* Illustration: scattered, mismatched sheets */}
          <div className="relative h-[340px]">
            {[
              { r: "-rotate-6", x: "left-0 top-6", t: "stock_final_v3.xlsx", v: "Qty: 42 ?" },
              { r: "rotate-3", x: "right-0 top-0", t: "customers_OLD.xlsx", v: "Owes: ???" },
              { r: "-rotate-2", x: "left-10 top-40", t: "sales_oct (copy).xlsx", v: "Total ≠ cash" },
              { r: "rotate-6", x: "right-2 top-44", t: "invoices_manual.docx", v: "INV-?? duplicate" },
            ].map((s) => (
              <div key={s.t} className={`absolute ${s.x} ${s.r} w-52 rounded-lg border border-ink-200 bg-white p-3 shadow-card`}>
                <p className="truncate text-[11px] font-semibold text-ink-500">{s.t}</p>
                <div className="mt-2 space-y-1.5">
                  <div className="h-1.5 w-full rounded bg-ink-100" />
                  <div className="h-1.5 w-4/5 rounded bg-ink-100" />
                  <div className="h-1.5 w-3/5 rounded bg-ink-100" />
                </div>
                <p className="mt-2 text-xs font-bold text-red-600">{s.v}</p>
              </div>
            ))}
          </div>
        </div>

        <div>
          <SectionHeading align="left" eyebrow="The problem" id="problem-title" title="Business management shouldn't be this complicated." description="When records live in different places, every answer takes longer than it should, and every number needs a second check." />
          <ul className="reveal mt-8 grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {PROBLEMS.map((p) => (
              <li key={p} className="flex items-start gap-2.5 text-ink-600">
                <svg viewBox="0 0 24 24" className="mt-1 h-4 w-4 shrink-0 text-red-500" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                {p}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
const MODULES = [
  { label: "Accounting", icon: "ledger" },
  { label: "Sales", icon: "cart" },
  { label: "Purchasing", icon: "truck" },
  { label: "Inventory", icon: "box" },
  { label: "Customers", icon: "user" },
  { label: "Suppliers", icon: "store" },
  { label: "Banking", icon: "bank" },
  { label: "Payroll", icon: "users" },
  { label: "Tax", icon: "percent" },
  { label: "Reports", icon: "chart" },
];

export function SolutionSection() {
  return (
    <section id="product" className="scroll-mt-20 bg-ink-900 py-20 text-white sm:py-24" aria-labelledby="solution-title">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <SectionHeading invert eyebrow="The platform" id="solution-title" title="One connected system for your entire business." description="Every module posts to the same books, so a sale, a purchase or a payroll run shows up everywhere it should." />

        {/* Hub diagram (desktop): central platform, modules around it */}
        <div className="reveal mx-auto mt-14 hidden max-w-4xl lg:block">
          <div className="relative h-[430px]">
            <svg viewBox="0 0 800 430" className="absolute inset-0 h-full w-full" aria-hidden="true">
              {MODULES.map((_, i) => {
                const pos = hubPos(i);
                return <line key={i} x1="400" y1="215" x2={pos.x} y2={pos.y} stroke="#4ade80" strokeOpacity="0.35" strokeWidth="1.5" strokeDasharray="4 5" />;
              })}
              <circle cx="400" cy="215" r="92" fill="none" stroke="#4ade80" strokeOpacity="0.15" />
            </svg>
            <div className="absolute left-1/2 top-1/2 flex h-36 w-36 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full bg-brand-600 text-center shadow-float ring-8 ring-brand-600/20">
              <span className="text-[10px] font-bold uppercase tracking-widest text-brand-100">Platform</span>
              <span className="mt-1 px-3 text-sm font-bold leading-tight">Malawi Business Manager</span>
            </div>
            {MODULES.map((m, i) => {
              const pos = hubPos(i);
              return (
                <div key={m.label} className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-2.5 rounded-xl border border-white/10 bg-ink-800 px-3.5 py-2.5 shadow-card" style={{ left: `${(pos.x / 800) * 100}%`, top: `${(pos.y / 430) * 100}%` }}>
                  <FeatureIcon name={m.icon} tone="white" className="!h-8 !w-8" />
                  <span className="text-sm font-semibold">{m.label}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Grid fallback (mobile/tablet) */}
        <ul className="mt-12 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:hidden">
          {MODULES.map((m) => (
            <li key={m.label} className="flex items-center gap-3 rounded-xl border border-white/10 bg-ink-800 px-4 py-3">
              <FeatureIcon name={m.icon} tone="white" className="!h-9 !w-9" />
              <span className="text-sm font-semibold">{m.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function hubPos(i: number) {
  const top = [{ x: 140, y: 40 }, { x: 320, y: 28 }, { x: 480, y: 28 }, { x: 660, y: 40 }];
  const mid = [{ x: 80, y: 215 }, { x: 720, y: 215 }];
  const bottom = [{ x: 140, y: 390 }, { x: 320, y: 402 }, { x: 480, y: 402 }, { x: 660, y: 390 }];
  return [...top, mid[0], mid[1], ...bottom][i];
}

/* ------------------------------------------------------------------ */
function FeatureRow({ id, eyebrow, icon, title, description, features, cta, flip, children, flow }: {
  id: string; eyebrow: string; icon: string; title: string; description: string; features: string[]; cta?: string; flip?: boolean; children: ReactNode; flow?: string[];
}) {
  return (
    <div id={id} className="scroll-mt-24 grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
      <div className={`reveal min-w-0 ${flip ? "lg:order-2" : ""}`}>
        <div className="flex items-center gap-3">
          <FeatureIcon name={icon} />
          <Badge tone="ink">{eyebrow}</Badge>
        </div>
        <h3 className="mt-5 text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">{title}</h3>
        <p className="mt-4 text-lg leading-relaxed text-ink-500">{description}</p>
        {flow && <div className="mt-5"><FlowSteps steps={flow} /></div>}
        <ul className="mt-6 grid gap-2.5 text-[15px] sm:grid-cols-2">
          {features.map((f) => <CheckItem key={f}>{f}</CheckItem>)}
        </ul>
        {cta && (
          <Link href="/register" className="mt-7 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700 hover:text-brand-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-700">
            {cta} <span aria-hidden="true">→</span>
          </Link>
        )}
      </div>
      <div className={`reveal min-w-0 ${flip ? "lg:order-1" : ""}`}>{children}</div>
    </div>
  );
}

export function FeatureSection() {
  return (
    <section id="features" className="scroll-mt-20 py-20 sm:py-28" aria-labelledby="features-title">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <SectionHeading eyebrow="Features" id="features-title" title="Every part of your finances, in one place." description="Capabilities below are part of the application today. Sample figures are for illustration." />
        <div className="mt-16 space-y-24 sm:space-y-32">
          <FeatureRow id="accounting" eyebrow="Accounting" icon="ledger" title="Accounting that keeps everything connected." description="Manage your chart of accounts, journals, ledgers, trial balance, financial statements and accounting periods from one system." features={["General ledger", "Manual journal entries", "Trial balance", "Income statement", "Balance sheet", "Cash flow statement", "Period close and locking", "Audit log of financial changes"]} cta="Explore Accounting">
            <ProductPreview title="Accounting · Trial balance · Sample data">
              <MiniTable head={["Code", "Account", "Debit", "Credit"]} right={[2, 3]} rows={[
                ["1000", "Cash on Hand", "4,120,000", ""],
                ["1100", "Accounts Receivable", "18,450,000", ""],
                ["1200", "Inventory", "26,730,000", ""],
                ["2000", "Accounts Payable", "", "11,240,000"],
                ["4000", "Sales Revenue", "", "84,520,000"],
                ["5000", "Cost of Goods Sold", "41,380,000", ""],
              ]} />
              <div className="mt-3 flex items-center justify-between rounded-lg bg-brand-50 px-3 py-2 text-xs font-semibold text-brand-800">
                <span>Debits equal credits</span><span>Balanced ✓</span>
              </div>
            </ProductPreview>
          </FeatureRow>

          <FeatureRow flip id="sales" eyebrow="Sales" icon="cart" title="Turn sales into a complete financial workflow." description="Every quotation, invoice and payment is recorded against the customer and posted to the ledger automatically." flow={["Quotation", "Invoice", "Payment", "Receipt", "General Ledger"]} features={["Quotations that convert to sales", "Invoice and receipt PDFs", "Customer payments", "Credit and debit notes", "Customer balances and debts", "Refunds for voided sales"]} cta="Explore Sales">
            <ProductPreview title="Sales · Invoice · Sample data">
              <div className="flex items-start justify-between">
                <div><p className="text-sm font-bold text-ink-900">Invoice INV-01482</p><p className="text-[11px] text-ink-400">Chikondi Traders · Due 16 Oct</p></div>
                <Badge tone="amber">Part paid</Badge>
              </div>
              <div className="mt-3"><MiniTable head={["Item", "Qty", "Amount"]} right={[1, 2]} rows={[["Cooking oil 5L", "40", "680,000"], ["Maize flour 50kg", "12", "420,000"], ["Delivery", "1", "140,000"]]} /></div>
              <dl className="mt-3 space-y-1 border-t border-ink-100 pt-3 text-xs">
                <div className="flex justify-between"><dt className="text-ink-500">Total</dt><dd className="font-semibold tabular-nums">MWK 1,240,000</dd></div>
                <div className="flex justify-between"><dt className="text-ink-500">Paid</dt><dd className="font-semibold tabular-nums text-brand-700">MWK 740,000</dd></div>
                <div className="flex justify-between"><dt className="text-ink-500">Balance</dt><dd className="font-bold tabular-nums">MWK 500,000</dd></div>
              </dl>
            </ProductPreview>
          </FeatureRow>

          <FeatureRow id="inventory" eyebrow="Inventory" icon="box" title="Know what you have. Where it is. What it's worth." description="Track stock across branches with reorder levels, transfers and counts, valued automatically as stock moves." features={["Stock by branch", "Stock transfers with in-transit tracking", "Stock adjustments", "Stock counts", "Goods received through purchases", "Per-branch reorder levels", "Inventory valuation report", "Service items that are not stocked"]} cta="Explore Inventory">
            <ProductPreview title="Inventory · Stock levels · Sample data">
              <MiniTable head={["Product", "SKU", "Branch", "On hand", "Reorder", "Value"]} right={[3, 4, 5]} rows={[
                ["Cooking oil 5L", "OIL-005", "Blantyre", "186", "60", "1.9M"],
                ["Maize flour 50kg", "MFL-050", "Lilongwe", "42", "50", <span key="a" className="font-semibold text-red-600">0.9M</span>],
                ["Sugar 2kg", "SUG-002", "Blantyre", "320", "100", "2.4M"],
                ["Rice 25kg", "RIC-025", "Mzuzu", "95", "40", "3.1M"],
              ]} />
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">1 product at or below its reorder level</p>
            </ProductPreview>
          </FeatureRow>

          <FeatureRow flip id="purchasing" eyebrow="Purchasing" icon="truck" title="Control purchasing from supplier to payment." description="Record purchases, receive stock into the right branch, and keep a clear view of what you owe each supplier." flow={["Supplier", "Purchase", "Stock received", "Supplier balance", "Payment"]} features={["Supplier records", "Purchases that restock inventory", "Supplier payments", "Supplier balances and debts", "Debit notes", "Void and refund handling"]} cta="Explore Purchasing">
            <ProductPreview title="Purchasing · Supplier balances · Sample data">
              <MiniTable head={["Supplier", "Billed", "Paid", "Owed"]} right={[1, 2, 3]} rows={[
                ["Shire Wholesalers", "4,200,000", "3,340,000", "860,000"],
                ["Lakeview Packaging", "1,780,000", "1,780,000", "0"],
                ["Mulanje Fresh Produce", "2,950,000", "1,100,000", "1,850,000"],
              ]} />
              <p className="mt-3 text-[11px] text-ink-400">Payments post to the cash or bank account you choose.</p>
            </ProductPreview>
          </FeatureRow>

          <FeatureRow id="banking" eyebrow="Banking" icon="bank" title="Keep your books and bank transactions aligned." description="Reconcile each account against its statement, import statements from CSV, and keep a record of every reconciliation." features={["Bank and cash accounts", "Transfers between accounts", "Bank reconciliation", "Statement import from CSV", "Reconciliation history", "Cashbook"]} cta="Explore Banking">
            <ProductPreview title="Banking · Reconciliation · Sample data">
              <div className="grid grid-cols-3 gap-2">
                <DashboardWidget label="Statement" value="MWK 12.84M" />
                <DashboardWidget label="Book" value="MWK 12.61M" tone="ink" />
                <DashboardWidget label="Difference" value="MWK 230,000" tone="red" delta="2 unmatched" />
              </div>
              <div className="mt-3"><MiniTable head={["Date", "Description", "Amount", "Status"]} right={[2]} rows={[
                ["28 Sep", "Deposit · Chikondi Traders", "1,240,000", <Badge key="1">Matched</Badge>],
                ["29 Sep", "Transfer · Head Office", "−450,000", <Badge key="2">Matched</Badge>],
                ["30 Sep", "Bank charges", "−30,000", <Badge key="3" tone="amber">Unmatched</Badge>],
              ]} /></div>
            </ProductPreview>
          </FeatureRow>

          <FeatureRow flip id="payroll" eyebrow="Payroll" icon="users" title="Payroll without the spreadsheet headache." description="Keep employee records, run payroll with PAYE and pension calculated from the bands and rates you configure, and produce payslips." features={["Employee records", "Payroll runs", "Payslips", "PAYE from configurable bands", "Employee and employer pension", "Payroll posted to the ledger"]} cta="Explore Payroll">
            <ProductPreview title="Payroll · October run · Sample data">
              <MiniTable head={["Employee", "Gross", "PAYE", "Pension", "Net"]} right={[1, 2, 3, 4]} rows={[
                ["Grace Banda", "650,000", "98,500", "32,500", "519,000"],
                ["Peter Phiri", "480,000", "64,200", "24,000", "391,800"],
                ["Mercy Chirwa", "820,000", "139,000", "41,000", "640,000"],
              ]} />
              <p className="mt-3 text-[11px] text-ink-400">Illustrative amounts. Tax bands and pension rates are set by your business.</p>
            </ProductPreview>
          </FeatureRow>

          <FeatureRow id="tax" eyebrow="Tax" icon="percent" title="Stay on top of your tax obligations." description="Configure VAT, withholding tax and PAYE, see what is due, and keep records of tax payments, with reminders as deadlines approach." features={["VAT with partial exemption", "Withholding tax and certificates", "PAYE through payroll", "Tax payment records and installments", "Tax calendar and due alerts", "Corporate tax estimate"]} cta="Explore Tax">
            <ProductPreview title="Tax · Calendar · Sample data">
              <MiniTable head={["Obligation", "Due", "Amount"]} right={[2]} rows={[
                ["VAT return, September", "18 Oct", "2,310,000"],
                ["PAYE, September", "14 Oct", "1,450,000"],
                ["Withholding tax", "14 Oct", "186,000"],
              ]} />
              <p className="mt-3 text-[11px] text-ink-400">The platform supports your tax workflow. It does not file returns on your behalf.</p>
            </ProductPreview>
          </FeatureRow>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
export function DashboardShowcase() {
  return (
    <section className="bg-gradient-to-b from-ink-50/70 to-white py-20 sm:py-28" aria-labelledby="dash-title">
      <div className="mx-auto max-w-5xl px-5 sm:px-8">
        <SectionHeading eyebrow="Dashboard" id="dash-title" title="See your business clearly." description="Turn transactions into information you can use to understand your business and make informed decisions." />
        <div className="reveal mt-12"><DashboardPreview large /></div>
      </div>
    </section>
  );
}
