"use client";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { EXPENSE_CATEGORY_LABELS } from "@/lib/validation";

// Theme-aware chart chrome: CSS variables, so the charts follow the light/dark switch.
const TICK = { fill: "rgb(var(--erp-muted))" };
const TOOLTIP = {
  backgroundColor: "rgb(var(--erp-surface))",
  border: "1px solid rgb(var(--erp-border))",
  color: "rgb(var(--erp-text))",
};

const COLORS = ["#16a34a", "#0ea5e9", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];

// Recharts v3's Tooltip formatter type is stricter about the value type
// (ValueType | undefined) than a plain `(v: number) => string` satisfies –
// this permissive wrapper is what actually type-checks against it.
function formatCurrency(value: unknown): string {
  const num = typeof value === "number" ? value : Number(value ?? 0);
  return `MWK ${num.toLocaleString()}`;
}

export function SalesByDayChart({ data }: { data: { date: string; total: number }[] }) {
  const formatted = data.map((d) => ({ ...d, label: d.date.slice(5) })); // MM-DD
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={formatted}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--erp-border))" />
        <XAxis dataKey="label" fontSize={11} tick={TICK} stroke="rgb(var(--erp-border))" />
        <YAxis fontSize={11} tick={TICK} stroke="rgb(var(--erp-border))" />
        <Tooltip formatter={formatCurrency} contentStyle={TOOLTIP} labelStyle={{ color: "rgb(var(--erp-text))" }} />
        <Line type="monotone" dataKey="total" stroke="#16a34a" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function ExpensesByCategoryChart({ data }: { data: { category: string; total: number }[] }) {
  const formatted = data.map((d) => ({
    name: EXPENSE_CATEGORY_LABELS[d.category as keyof typeof EXPENSE_CATEGORY_LABELS] ?? d.category,
    value: d.total,
  }));

  if (formatted.length === 0) {
    return <p className="py-8 text-center text-sm text-erp-muted">No expenses recorded this month yet.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie data={formatted} dataKey="value" nameKey="name" outerRadius={80} label={(entry) => entry.name} labelLine={false} style={{ fill: "rgb(var(--erp-text))" }}>
          {formatted.map((_, i) => (
            <Cell key={i} fill={COLORS[i % COLORS.length]} />
          ))}
        </Pie>
        <Tooltip formatter={formatCurrency} contentStyle={TOOLTIP} labelStyle={{ color: "rgb(var(--erp-text))" }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function TopProductsChart({ data }: { data: { name: string; revenue: number }[] }) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-erp-muted">No sales recorded this month yet.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} layout="vertical" margin={{ left: 24 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--erp-border))" />
        <XAxis type="number" fontSize={11} tick={TICK} stroke="rgb(var(--erp-border))" />
        <YAxis type="category" dataKey="name" width={110} fontSize={11} tick={TICK} stroke="rgb(var(--erp-border))" />
        <Tooltip formatter={formatCurrency} contentStyle={TOOLTIP} labelStyle={{ color: "rgb(var(--erp-text))" }} />
        <Bar dataKey="revenue" fill="#16a34a" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function PaymentMethodChart({ data }: { data: { method: string; total: number }[] }) {
  const formatted = data.map((d) => ({ name: d.method.replace("_", " "), value: d.total }));

  if (formatted.length === 0) {
    return <p className="py-8 text-center text-sm text-erp-muted">No sales recorded this month yet.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie data={formatted} dataKey="value" nameKey="name" outerRadius={80} label={(entry) => entry.name} labelLine={false} style={{ fill: "rgb(var(--erp-text))" }}>
          {formatted.map((_, i) => (
            <Cell key={i} fill={COLORS[i % COLORS.length]} />
          ))}
        </Pie>
        <Tooltip formatter={formatCurrency} contentStyle={TOOLTIP} labelStyle={{ color: "rgb(var(--erp-text))" }} />
      </PieChart>
    </ResponsiveContainer>
  );
}
