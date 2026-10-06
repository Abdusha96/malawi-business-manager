import type { ReactNode } from "react";
import { Badge } from "./ui";
import { Counter } from "./client";

/* Preview components are illustrative, static renderings of the app's real
   screens. Figures are sample data, labelled as such where shown. */

export function DashboardWidget({ label, value, delta, tone = "brand", counter }: { label: string; value: string; delta?: string; tone?: "brand" | "red" | "ink"; counter?: { value: number; prefix?: string } }) {
  const color = tone === "red" ? "text-red-600" : tone === "ink" ? "text-ink-500" : "text-brand-700";
  return (
    <div className="rounded-xl border border-ink-100 bg-white p-3.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{label}</p>
      <p className="mt-1 whitespace-nowrap text-[15px] font-bold tabular-nums text-ink-900 sm:text-base">
        {counter ? <Counter value={counter.value} prefix={counter.prefix} /> : value}
      </p>
      {delta && <p className={`mt-0.5 text-[11px] font-semibold ${color}`}>{delta}</p>}
    </div>
  );
}

/* Simple bar/line chart rendered as SVG. */
export function ChartPreview({ kind = "bars", a, b, labels, height = 120 }: { kind?: "bars" | "line"; a: number[]; b?: number[]; labels?: string[]; height?: number }) {
  const w = 300;
  const max = Math.max(...a, ...(b ?? [0])) * 1.1;
  const n = a.length;
  const step = w / n;
  const y = (v: number) => height - (v / max) * (height - 8) - 4;
  if (kind === "line") {
    const pts = (arr: number[]) => arr.map((v, i) => `${i * (w / (n - 1))},${y(v)}`).join(" ");
    const area = `0,${height} ${pts(a)} ${w},${height}`;
    return (
      <svg viewBox={`0 0 ${w} ${height}`} className="h-auto w-full" role="img" aria-label="Cash flow trend, sample data">
        <defs>
          <linearGradient id="cf" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#16a34a" stopOpacity="0.25" />
            <stop offset="1" stopColor="#16a34a" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1="0" x2={w} y1={height * g} y2={height * g} stroke="#eaeff1" />
        ))}
        <polygon points={area} fill="url(#cf)" />
        <polyline points={pts(a)} fill="none" stroke="#16a34a" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox={`0 0 ${w} ${height + 14}`} className="h-auto w-full" role="img" aria-label="Revenue versus expenses, sample data">
      {[0.25, 0.5, 0.75].map((g) => (
        <line key={g} x1="0" x2={w} y1={height * g} y2={height * g} stroke="#eaeff1" />
      ))}
      {a.map((v, i) => {
        const bw = step * 0.28;
        const x = i * step + step * 0.18;
        return (
          <g key={i}>
            <rect x={x} y={y(v)} width={bw} height={height - y(v)} rx="2" fill="#16a34a" />
            {b && <rect x={x + bw + 2} y={y(b[i])} width={bw} height={height - y(b[i])} rx="2" fill="#a9b8bf" />}
            {labels && (
              <text x={x + bw} y={height + 11} textAnchor="middle" fontSize="8" fill="#6f838d">
                {labels[i]}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function AgingBars({ rows }: { rows: { label: string; value: string; pct: number; tone?: string }[] }) {
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.label} className="flex items-center gap-3 text-[11px]">
          <span className="w-14 shrink-0 text-ink-500">{r.label}</span>
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-ink-100">
            <span className={`block h-full rounded-full ${r.tone ?? "bg-brand-600"}`} style={{ width: `${r.pct}%` }} />
          </span>
          <span className="w-20 text-right font-semibold tabular-nums text-ink-700">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}

/* Browser-style window frame used around every product preview. */
export function ProductPreview({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-float ${className}`}>
      <div className="flex items-center gap-2 border-b border-ink-100 bg-ink-50 px-4 py-2.5">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-ink-200" />
          <span className="h-2.5 w-2.5 rounded-full bg-ink-200" />
          <span className="h-2.5 w-2.5 rounded-full bg-ink-200" />
        </span>
        <span className="ml-2 truncate text-[11px] font-medium text-ink-400">{title}</span>
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </div>
  );
}

const TX = [
  { d: "02 Oct", t: "Invoice INV-01482 · Chikondi Traders", a: "+ MWK 1,240,000", g: true },
  { d: "02 Oct", t: "Supplier payment · Shire Wholesalers", a: "− MWK 860,000", g: false },
  { d: "01 Oct", t: "Sale RCT-20931 · Blantyre Branch", a: "+ MWK 312,500", g: true },
  { d: "30 Sep", t: "Expense · Rent, Lilongwe Branch", a: "− MWK 450,000", g: false },
];

export function RecentTransactions({ rows = TX }: { rows?: typeof TX }) {
  return (
    <ul className="divide-y divide-ink-100">
      {rows.map((r, i) => (
        <li key={i} className="flex items-center justify-between gap-3 py-2 text-[11px] sm:text-xs">
          <span className="w-12 shrink-0 text-ink-400">{r.d}</span>
          <span className="min-w-0 flex-1 truncate text-ink-700">{r.t}</span>
          <span className={`shrink-0 font-semibold tabular-nums ${r.g ? "text-brand-700" : "text-ink-700"}`}>{r.a}</span>
        </li>
      ))}
    </ul>
  );
}

const MONTHS = ["May", "Jun", "Jul", "Aug", "Sep", "Oct"];

/* The hero / showcase dashboard. `large` adds the aging panels. */
export function DashboardPreview({ large = false }: { large?: boolean }) {
  return (
    <ProductPreview title="Malawi Business Manager · Dashboard · Sample data">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-sm font-bold text-ink-900">Business overview</p>
          <p className="text-[11px] text-ink-400">October 2026 · All branches</p>
        </div>
        <Badge>Sample data</Badge>
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <DashboardWidget label="Revenue" value="" counter={{ value: 84520000, prefix: "MWK " }} delta="▲ 12.4% vs last month" />
        <DashboardWidget label="Expenses" value="" counter={{ value: 52180000, prefix: "MWK " }} delta="▲ 5.1% vs last month" tone="ink" />
        <DashboardWidget label="Net profit" value="" counter={{ value: 32340000, prefix: "MWK " }} delta="▲ 27.8% vs last month" />
        <DashboardWidget label="Cash position" value="MWK 41,970,000" delta="3 bank and cash accounts" tone="ink" />
        <DashboardWidget label="Receivables" value="MWK 18,450,000" delta="MWK 2,310,000 overdue" tone="red" />
        <DashboardWidget label="Payables" value="MWK 11,240,000" delta="Next due 07 Oct" tone="ink" />
      </div>
      <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
        <div className="rounded-xl border border-ink-100 p-3">
          <div className="mb-2 flex items-center justify-between text-[11px]">
            <span className="font-semibold text-ink-700">Revenue vs expenses</span>
            <span className="flex gap-3 text-ink-400">
              <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm bg-brand-600" />Revenue</span>
              <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm bg-ink-300" />Expenses</span>
            </span>
          </div>
          <ChartPreview a={[52, 61, 58, 70, 76, 85]} b={[38, 41, 44, 47, 50, 52]} labels={MONTHS} />
        </div>
        <div className="rounded-xl border border-ink-100 p-3">
          <p className="mb-2 text-[11px] font-semibold text-ink-700">Cash flow</p>
          <ChartPreview kind="line" a={[12, 18, 15, 24, 28, 26, 34, 41]} height={110} />
        </div>
      </div>
      {large && (
        <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
          <div className="rounded-xl border border-ink-100 p-3">
            <p className="mb-2 text-[11px] font-semibold text-ink-700">Receivables aging</p>
            <AgingBars rows={[
              { label: "Current", value: "9.8M", pct: 80 },
              { label: "1–30", value: "4.2M", pct: 42 },
              { label: "31–60", value: "2.1M", pct: 24, tone: "bg-amber-500" },
              { label: "60+", value: "2.3M", pct: 26, tone: "bg-red-500" },
            ]} />
          </div>
          <div className="rounded-xl border border-ink-100 p-3">
            <p className="mb-2 text-[11px] font-semibold text-ink-700">Payables aging</p>
            <AgingBars rows={[
              { label: "Current", value: "6.4M", pct: 70 },
              { label: "1–30", value: "3.1M", pct: 38 },
              { label: "31–60", value: "1.0M", pct: 14, tone: "bg-amber-500" },
              { label: "60+", value: "0.7M", pct: 9, tone: "bg-red-500" },
            ]} />
          </div>
        </div>
      )}
      <div className="mt-2.5 rounded-xl border border-ink-100 p-3">
        <p className="mb-1 text-[11px] font-semibold text-ink-700">Recent transactions</p>
        <RecentTransactions />
      </div>
    </ProductPreview>
  );
}

/* Generic small table used inside feature previews. */
export function MiniTable({ head, rows, right = [] }: { head: string[]; rows: (string | ReactNode)[][]; right?: number[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[340px] text-left text-[11px] sm:text-xs">
        <thead>
          <tr className="border-b border-ink-100 text-ink-400">
            {head.map((h, i) => (
              <th key={h} scope="col" className={`py-2 pr-3 font-semibold uppercase tracking-wide ${right.includes(i) ? "text-right" : ""}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100 text-ink-700">
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className={`py-2 pr-3 ${right.includes(j) ? "text-right tabular-nums" : ""}`}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FlowSteps({ steps }: { steps: string[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
      {steps.map((s, i) => (
        <li key={s} className="flex items-center gap-1.5">
          <span className="rounded-md bg-ink-900 px-2.5 py-1 text-[11px] font-semibold text-white">{s}</span>
          {i < steps.length - 1 && <span className="text-ink-300" aria-hidden="true">→</span>}
        </li>
      ))}
    </ol>
  );
}
