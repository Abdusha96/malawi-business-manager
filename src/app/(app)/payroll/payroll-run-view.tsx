"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PAYMENT_METHODS } from "@/lib/validation";
import { monthKey } from "@/lib/tax-period";
import { SendNoticeButton } from "@/components/send-notice-button";
import { Field, KpiCard, StatusBadge } from "@/components/erp/display";
import { formatAmount, formatMoney } from "@/lib/erp/format";

interface Employee {
  id: string;
  name: string;
  employeeCode: string;
  monthlySalary: number;
}

interface PayrollRun {
  id: string;
  employeeId: string;
  payPeriod: string;
  grossSalary: number;
  allowances: number;
  paye: number;
  pensionEmployee: number;
  otherDeductions: number;
  netSalary: number;
  status: "DRAFT" | "PAID";
}

// Module 35: the current month in the BUSINESS'S zone, not the browser's.
function currentPeriod(timeZone: string): string {
  return monthKey(new Date(), timeZone);
}

export function PayrollRunView({
  businessId,
  employees,
  timeZone,
  isExampleTaxConfig,
}: {
  businessId: string;
  employees: Employee[];
  isExampleTaxConfig: boolean;
  timeZone: string;
}) {
  const [period, setPeriod] = useState(currentPeriod(timeZone));
  const [runs, setRuns] = useState<Record<string, PayrollRun>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadRuns() {
    setLoading(true);
    const res = await fetch(`/api/business/${businessId}/payroll?payPeriod=${period}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Phase 12: a failed load used to look like "no runs yet"; say so instead.
      setError(data.message ?? "Could not load payroll for this period.");
      setRuns({});
      setLoading(false);
      return;
    }
    const byEmployee: Record<string, PayrollRun> = {};
    for (const run of data.runs ?? []) byEmployee[run.employeeId] = run;
    setRuns(byEmployee);
    setLoading(false);
  }

  useEffect(() => {
    loadRuns();
  }, [period, businessId]);

  async function calculate(employeeId: string) {
    setError(null);
    const res = await fetch(`/api/business/${businessId}/payroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeId, payPeriod: period, allowances: 0, otherDeductions: 0 }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.message ?? "Could not calculate payroll.");
      return;
    }
    loadRuns();
  }

  const calculated = Object.values(runs);
  const sum = (f: (r: PayrollRun) => number) => calculated.reduce((t, r) => t + f(r), 0);
  const paidCount = calculated.filter((r) => r.status === "PAID").length;

  return (
    <div>
      {isExampleTaxConfig && (
        <div className="mb-4 rounded border border-erp-warning/40 bg-erp-warning/10 p-4 text-sm text-erp-text">
          <strong>Using example tax rates.</strong> These are placeholder PAYE bands and pension rates, not
          verified figures from the Malawi Revenue Authority. Review and confirm them in{" "}
          <Link href="/settings/tax" className="underline">Tax Settings</Link> before paying real employees.
        </div>
      )}

      <div className="mb-4 w-48">
        <Field label="Pay Period" htmlFor="pay-period">
          <input id="pay-period" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="erp-input" />
        </Field>
      </div>

      {error && <p role="alert" className="mb-4 rounded border border-erp-danger/40 bg-erp-danger/10 p-3 text-sm text-erp-danger">{error}</p>}

      {loading ? (
        <p className="text-sm text-erp-muted">Loading...</p>
      ) : (
        <>
          {calculated.length > 0 && (
            <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <KpiCard label="Gross" value={formatMoney(sum((r) => r.grossSalary))} note={`${calculated.length} of ${employees.length} calculated`} />
              <KpiCard label="PAYE" value={formatMoney(sum((r) => r.paye))} />
              <KpiCard label="Pension (employee)" value={formatMoney(sum((r) => r.pensionEmployee))} />
              <KpiCard label="Net pay" value={formatMoney(sum((r) => r.netSalary))} note={`${paidCount} paid`} />
            </div>
          )}

          <div className="space-y-2">
            {employees.map((emp) => {
              const run = runs[emp.id];
              return (
                <div key={emp.id} className="rounded border border-erp-border bg-erp-surface p-3 shadow-sm">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium text-erp-text">
                        {emp.name}
                        {run && <span className="ml-2 align-middle"><StatusBadge tone={run.status === "PAID" ? "success" : "warning"}>{run.status === "PAID" ? "Paid" : "Draft"}</StatusBadge></span>}
                      </p>
                      <p className="text-xs text-erp-muted">{emp.employeeCode} · Gross {formatMoney(emp.monthlySalary)}</p>
                    </div>
                    {!run && (
                      <button onClick={() => calculate(emp.id)} className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle">
                        Calculate
                      </button>
                    )}
                    {run?.status === "DRAFT" && (
                      <PayButton businessId={businessId} payrollId={run.id} onPaid={loadRuns} />
                    )}
                    {run?.status === "PAID" && (
                      <div className="flex items-start gap-3">
                        <SendNoticeButton
                          url={`/api/business/${businessId}/payroll/${run.id}/notify`}
                          label="Text employee"
                          confirmText={`Text ${emp.name} that their pay has been paid? The message includes the net amount.`}
                        />
                        <Link href={`/payroll/${run.id}/payslip`} className="text-sm text-erp-primary underline">
                          View Payslip
                        </Link>
                      </div>
                    )}
                  </div>

                  {run && (
                    <dl className="grid grid-cols-2 gap-2 text-xs text-erp-muted sm:grid-cols-5">
                      <div><dt>Gross</dt><dd className="tabular text-erp-text">{formatAmount(run.grossSalary)}</dd></div>
                      <div><dt>PAYE</dt><dd className="tabular text-erp-text">{formatAmount(run.paye)}</dd></div>
                      <div><dt>Pension</dt><dd className="tabular text-erp-text">{formatAmount(run.pensionEmployee)}</dd></div>
                      <div><dt>Deductions</dt><dd className="tabular text-erp-text">{formatAmount(run.otherDeductions)}</dd></div>
                      <div><dt>Net</dt><dd className="tabular font-semibold text-erp-text">{formatAmount(run.netSalary)}</dd></div>
                    </dl>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function PayButton({ businessId, payrollId, onPaid }: { businessId: string; payrollId: string; onPaid: () => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePay(method: string) {
    setLoading(true);
    setError(null);
    const res = await fetch(`/api/business/${businessId}/payroll/${payrollId}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentMethod: method }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.message ?? "Could not pay.");
      return;
    }
    setOpen(false);
    onPaid();
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded bg-erp-primary px-3 py-1.5 text-sm text-erp-primary-fg hover:opacity-90">
        Pay
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-erp-danger">{error}</span>}
      <select onChange={(e) => handlePay(e.target.value)} disabled={loading} defaultValue="" className="erp-input text-sm">
        <option value="" disabled>Pay via...</option>
        {PAYMENT_METHODS.filter((m) => m !== "CREDIT").map((m) => (
          <option key={m} value={m}>{m.replace("_", " ")}</option>
        ))}
      </select>
    </div>
  );
}
