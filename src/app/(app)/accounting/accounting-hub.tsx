"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { WITHHOLDING_TAX_CATEGORIES, WITHHOLDING_TAX_CATEGORY_LABELS } from "@/lib/validation";
import { todayYmd, firstOfMonthYmd, lastOfMonthYmd } from "@/lib/date-range";
import { formatDateIn } from "@/lib/timezone";

// Module 35: the business's time zone, provided once by AccountingHub so every tab's date
// defaults and date display use the business's calendar, not the browser's.
const TimeZoneContext = createContext<string>("Africa/Blantyre");
function useTimeZone(): string {
  return useContext(TimeZoneContext);
}

type Tab =
  | "chart"
  | "trial-balance"
  | "profit-loss"
  | "balance-sheet"
  | "cash-flow"
  | "vat-return"
  | "withholding-tax-return"
  | "corporate-tax"
  | "tax-calendar"
  | "ledger";

const TABS: { key: Tab; label: string }[] = [
  { key: "chart", label: "Chart of Accounts" },
  { key: "trial-balance", label: "Trial Balance" },
  { key: "profit-loss", label: "Profit & Loss" },
  { key: "balance-sheet", label: "Balance Sheet" },
  { key: "cash-flow", label: "Cash Flow" },
  { key: "vat-return", label: "VAT Return" },
  { key: "withholding-tax-return", label: "Withholding Tax" },
  { key: "corporate-tax", label: "Corporate Tax" },
  { key: "tax-calendar", label: "Tax Calendar" },
  { key: "ledger", label: "General Ledger" },
];

export function AccountingHub({ businessId, timeZone, canRecordTaxPayments = false, canManageAccounts = false }: { businessId: string; timeZone: string; canRecordTaxPayments?: boolean; canManageAccounts?: boolean }) {
  const [active, setActive] = useState<Tab>("trial-balance");

  return (
    <TimeZoneContext.Provider value={timeZone}>
    <div>
      <div className="mb-6 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActive(t.key)}
            className={active === t.key ? "rounded bg-erp-primary px-3 py-1.5 text-sm text-erp-primary-fg" : "rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle"}
          >
            {t.label}
          </button>
        ))}
      </div>

      {active === "chart" && <ChartOfAccountsView businessId={businessId} canManage={canManageAccounts} />}
      {active === "trial-balance" && <TrialBalanceView businessId={businessId} />}
      {active === "profit-loss" && <ProfitLossView businessId={businessId} />}
      {active === "balance-sheet" && <BalanceSheetView businessId={businessId} />}
      {active === "cash-flow" && <CashFlowView businessId={businessId} />}
      {active === "vat-return" && <VatReturnView businessId={businessId} />}
      {active === "withholding-tax-return" && <WithholdingTaxReturnView businessId={businessId} />}
      {active === "corporate-tax" && <CorporateTaxView businessId={businessId} />}
      {active === "tax-calendar" && <TaxCalendarView businessId={businessId} canRecordTaxPayments={canRecordTaxPayments} />}
      {active === "ledger" && <GeneralLedgerView businessId={businessId} />}
    </div>
    </TimeZoneContext.Provider>
  );
}

function fmt(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Module 34/35: defaults come from calendar fields in the BUSINESS'S zone (todayYmd/firstOfMonthYmd).
// This used `new Date(...).toISOString().slice(0, 10)`, which converts to UTC
// first – in Malawi (UTC+2) the "From" picker opened on the LAST DAY OF THE
// PREVIOUS MONTH, and "To"/"As of" showed yesterday between 00:00 and 02:00.
function useDateRange() {
  const tz = useTimeZone();
  const [from, setFrom] = useState(function () { return firstOfMonthYmd(tz); });
  const [to, setTo] = useState(function () { return todayYmd(tz); });
  return { from: from, setFrom: setFrom, to: to, setTo: setTo };
}

function DateRangePicker(props: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void }) {
  return (
    <div className="mb-4 flex gap-3">
      <div>
        <label className="mb-1 block text-xs text-erp-muted">From</label>
        <input type="date" value={props.from} onChange={(e) => props.setFrom(e.target.value)} className="erp-input" />
      </div>
      <div>
        <label className="mb-1 block text-xs text-erp-muted">To</label>
        <input type="date" value={props.to} onChange={(e) => props.setTo(e.target.value)} className="erp-input" />
      </div>
    </div>
  );
}

function WithholdingTaxReturnView({ businessId }: { businessId: string }) {
  const range = useDateRange();
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch("/api/business/" + businessId + "/accounting/withholding-tax-return?from=" + range.from + "&to=" + range.to)
      .then(function (r) { return r.json(); })
      .then(setData);
  }, [businessId, range.from, range.to]);

  return (
    <div>
      <DateRangePicker from={range.from} to={range.to} setFrom={range.setFrom} setTo={range.setTo} />
      {!data ? (
        <p className="text-sm text-erp-muted">Loading...</p>
      ) : (
        <div className="space-y-4">
          <div className="rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-xs text-erp-warning">
            This is a working summary of tax withheld from payments over this period, for transcribing onto the
            relevant MRA withholding tax return – not a filing itself. This app has no connection to MRA systems.
            {data.isExample && <span className="ml-1 font-medium">Also: your withholding tax rates are still placeholders – review them in Tax Settings.</span>}
          </div>

          <div className="rounded border bg-erp-surface p-4 text-sm">
            <h3 className="mb-2 font-semibold">By payment type</h3>
            {WITHHOLDING_TAX_CATEGORIES.map((category) => {
              const bucket = data.byCategory[category];
              return (
                <div key={category} className="flex justify-between border-t py-1 first:border-t-0">
                  <span>
                    {WITHHOLDING_TAX_CATEGORY_LABELS[category]}
                    <span className="ml-1 text-xs text-erp-muted">({bucket.count} payment{bucket.count === 1 ? "" : "s"}, {data.rates[category]}%)</span>
                  </span>
                  <span className="text-right">
                    <span className="block text-erp-muted">Gross {fmt(bucket.grossPayments)}</span>
                    <span className="block font-medium">Withheld {fmt(bucket.taxWithheld)}</span>
                  </span>
                </div>
              );
            })}
          </div>

          <div className="rounded border bg-erp-subtle p-4 text-sm">
            <div className="flex justify-between text-base font-semibold text-erp-danger">
              <span>Total withheld – owed to MRA</span>
              <span>{fmt(data.totalWithheld)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


// Module 20 (Corporate Tax) – a working estimate for an Accountant to sanity-check
// against a real add-back/capital-allowance computation before filing, not a
// filing itself (see src/lib/corporate-tax.ts's own comment on this).
function CorporateTaxView({ businessId }: { businessId: string }) {
  const range = useDateRange();
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch("/api/business/" + businessId + "/accounting/corporate-tax-estimate?from=" + range.from + "&to=" + range.to)
      .then(function (r) { return r.json(); })
      .then(setData);
  }, [businessId, range.from, range.to]);

  return (
    <div>
      <DateRangePicker from={range.from} to={range.to} setFrom={range.setFrom} setTo={range.setTo} />
      {!data ? (
        <p className="text-sm text-erp-muted">Loading...</p>
      ) : (
        <div className="space-y-4">
          <div className="rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-xs text-erp-warning">
            This is a rough estimate from your accounting Profit &amp; Loss for this period – it does NOT add back
            disallowed expenses or apply capital allowances the way a real MRA company income tax computation would.
            Have an Accountant adjust this before filing or paying anything. This app has no connection to MRA
            systems.
            {data.isExample && <span className="ml-1 font-medium">Also: your corporate tax rate is still a placeholder – review it in Tax Settings.</span>}
          </div>

          <div className="rounded border bg-erp-surface p-4 text-sm">
            <div className="flex justify-between py-0.5"><span>Profit before tax for period</span><span>{fmt(data.accountingProfit)}</span></div>
            {data.penaltiesAddedBack > 0 && (
              <div className="flex justify-between py-0.5"><span>Add back: tax penalties &amp; interest (not deductible)</span><span>{fmt(data.penaltiesAddedBack)}</span></div>
            )}
            <div className="flex justify-between border-t py-1 font-medium"><span>Corporate tax rate</span><span>{data.corporateTaxRate}%</span></div>
            {data.incomeTaxBooked > 0 && (
              <div className="flex justify-between border-t py-1 text-erp-muted"><span>Income tax already booked in the ledger for this period</span><span>{fmt(data.incomeTaxBooked)}</span></div>
            )}
          </div>

          <div className="rounded border bg-erp-subtle p-4 text-sm">
            <div className="flex justify-between text-base font-semibold text-erp-danger">
              <span>Estimated corporate tax</span>
              <span>{fmt(data.estimatedTax)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const TAX_CALENDAR_TYPE_LABELS: Record<string, string> = {
  PAYE: "PAYE",
  WITHHOLDING_TAX: "Withholding Tax",
  VAT: "VAT",
  PROVISIONAL_TAX: "Provisional Tax",
  ANNUAL_INCOME_TAX: "Annual Income Tax",
};

// Module 20 (Tax Calendar) – a computed list of upcoming/overdue MRA
// filing deadlines. Module 33: an entry with a recorded payment shows as
// Paid (a payment tracker, not a filing tracker – see src/lib/tax-calendar.ts).
function TaxCalendarView({ businessId, canRecordTaxPayments }: { businessId: string; canRecordTaxPayments: boolean }) {
  const tz = useTimeZone();
  const [monthsAhead, setMonthsAhead] = useState(3);
  // Module 34: the window used to start at the first of the CURRENT month, so
  // an obligation more than about one cycle overdue never appeared here at all
  // (Module 33 documented this). Default is now a quarter back; the selector
  // reaches a year. Periods before the business existed are never generated.
  const [lookbackMonths, setLookbackMonths] = useState(3);
  const [unpaidOnly, setUnpaidOnly] = useState(false);
  const [entries, setEntries] = useState<any[] | null>(null);

  useEffect(() => {
    const now = new Date();
    const from = firstOfMonthYmd(tz, now, -lookbackMonths);
    const to = lastOfMonthYmd(tz, now, monthsAhead - 1);
    setEntries(null);
    fetch("/api/business/" + businessId + "/accounting/tax-calendar?from=" + from + "&to=" + to)
      .then(function (r) { return r.json(); })
      .then(function (d) { setEntries(d.entries || []); });
  }, [businessId, monthsAhead, lookbackMonths]);

  const visibleEntries = entries ? entries.filter(function (e: any) { return !unpaidOnly || e.status !== "paid"; }) : null;

  return (
    <div>
      <div className="mb-4 flex items-center gap-2 text-sm">
        <label className="text-erp-muted">Show deadlines through:</label>
        <select value={monthsAhead} onChange={(e) => setMonthsAhead(Number(e.target.value))} className="erp-input w-auto">
          <option value={3}>3 months out</option>
          <option value={6}>6 months out</option>
          <option value={12}>12 months out</option>
        </select>
        <label className="ml-3 text-erp-muted">Look back:</label>
        <select value={lookbackMonths} onChange={(e) => setLookbackMonths(Number(e.target.value))} className="erp-input w-auto">
          <option value={0}>This month onward</option>
          <option value={3}>3 months</option>
          <option value={6}>6 months</option>
          <option value={12}>12 months</option>
        </select>
        <label className="ml-3 flex items-center gap-1 text-erp-muted">
          <input type="checkbox" checked={unpaidOnly} onChange={(e) => setUnpaidOnly(e.target.checked)} />
          Unpaid only
        </label>
      </div>

      <div className="mb-4 rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-xs text-erp-warning">
        Computed reminders based on this business's own PAYE, VAT, withholding tax, and corporate tax figures. An entry
        shows "Paid" once a payment is recorded here – that tracks payments you've logged, not returns filed. Verify
        current due dates with MRA before relying on them, since MRA has granted blanket extensions before.
      </div>

      {!visibleEntries ? (
        <p className="text-sm text-erp-muted">Loading...</p>
      ) : visibleEntries.length === 0 ? (
        <p className="rounded border bg-erp-surface p-4 text-sm text-erp-muted">No deadlines in this window.</p>
      ) : (
        <div className="space-y-2">
          {visibleEntries.map(function (e: any, i: number) {
            const overdue = e.status === "overdue";
            const paid = e.status === "paid";
            const periodEnded = new Date(e.periodEnd).getTime() + 86_400_000 <= Date.now();
            return (
              <div
                key={i}
                className={`flex items-center justify-between rounded border p-3 text-sm ${paid ? "border-erp-success/40 bg-erp-success/10" : overdue ? "border-erp-danger/40 bg-erp-danger/10" : "bg-erp-surface"}`}
              >
                <div>
                  <span className={`mr-2 rounded-full px-2 py-0.5 text-xs font-medium ${overdue ? "bg-erp-danger/15 text-erp-danger" : "bg-erp-subtle text-erp-muted"}`}>
                    {TAX_CALENDAR_TYPE_LABELS[e.type] ?? e.type}
                  </span>
                  <span className="font-medium">{e.label}</span>
                  <span className="ml-1 text-xs text-erp-muted">({e.periodLabel})</span>
                </div>
                <div className="text-right">
                  <span className={`block ${overdue ? "font-semibold text-erp-danger" : ""}`}>
                    Due {formatDateIn(new Date(e.dueDate), tz)}
                  </span>
                  {paid && e.payment ? (
                    <a href={"/tax-payments/" + e.payment.id} className="block text-xs font-medium text-erp-success underline">
                      Paid {formatDateIn(new Date(e.payment.paymentDate), tz)} · {e.payment.paymentNumber}
                    </a>
                  ) : (
                    <>
                      {e.partPaid ? (
                        <>
                          <span className="block text-xs font-medium text-erp-warning">
                            Part-paid: {fmt(e.partPaid.paid)} in {e.partPaid.installmentCount} payment{e.partPaid.installmentCount === 1 ? "" : "s"} · {fmt(e.partPaid.remaining)} left
                          </span>
                          {e.payment && (
                            <a href={"/tax-payments/" + e.payment.id} className="block text-xs text-erp-muted underline">
                              Latest {e.payment.paymentNumber}
                            </a>
                          )}
                        </>
                      ) : (
                        <span className="block text-xs text-erp-muted">Est. {fmt(e.amount)}</span>
                      )}
                      {canRecordTaxPayments && periodEnded && (
                        <a href={"/tax-payments/new?type=" + e.type + "&period=" + encodeURIComponent(e.periodKey)} className="block text-xs text-erp-primary underline">
                          {e.partPaid ? "Record next payment" : "Record payment"}
                        </a>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const ACCOUNT_TYPE_OPTIONS = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"];

// Module 41: the chart is no longer read-only. An Owner/Accountant can add a custom account, rename
// any account, and deactivate a custom account that has never been posted to (src/lib/account-admin.ts).
function ChartOfAccountsView({ businessId, canManage }: { businessId: string; canManage: boolean }) {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("EXPENSE");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editCode, setEditCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    fetch("/api/business/" + businessId + "/accounting/chart-of-accounts" + (showInactive ? "?includeInactive=1" : ""))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        setAccounts(d.accounts || []);
        setLoading(false);
      });
  }

  useEffect(load, [businessId, showInactive]);

  function send(url: string, method: string, body: any, done: () => void) {
    setMessage(null);
    setBusy(true);
    fetch(url, { method: method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        setBusy(false);
        if (!res.ok) {
          setMessage(res.d.message || (res.d.details && JSON.stringify(res.d.details.fieldErrors)) || "Could not save.");
          return;
        }
        done();
        load();
      });
  }

  function addAccount(e: React.FormEvent) {
    e.preventDefault();
    send("/api/business/" + businessId + "/accounting/accounts", "POST", { code: newCode, name: newName, type: newType }, function () {
      setNewCode(""); setNewName(""); setAdding(false);
    });
  }

  function saveEdit(id: string) {
    send("/api/business/" + businessId + "/accounting/accounts/" + id, "PATCH", { code: editCode, name: editName }, function () { setEditingId(null); });
  }

  function setActive(id: string, isActive: boolean) {
    send("/api/business/" + businessId + "/accounting/accounts/" + id, "PATCH", { isActive: isActive }, function () {});
  }

  if (loading) return <p className="text-sm text-erp-muted">Loading...</p>;

  return (
    <div>
      {canManage && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <button onClick={function () { setAdding(!adding); }} className="rounded bg-erp-primary px-3 py-1.5 text-sm text-erp-primary-fg hover:opacity-90">+ New Account</button>
          <label className="flex items-center gap-1 text-sm text-erp-muted">
            <input type="checkbox" checked={showInactive} onChange={function (e) { setShowInactive(e.target.checked); }} /> Show inactive
          </label>
          <a href="/manual-journals" className="ml-auto text-sm text-erp-primary underline">Journal Entries</a>
        </div>
      )}
      {message && <p className="mb-3 rounded bg-erp-danger/10 p-2 text-sm text-erp-danger">{message}</p>}
      {adding && (
        <form onSubmit={addAccount} className="mb-4 flex flex-wrap items-end gap-3 rounded border bg-erp-surface p-3 text-sm">
          <div><label className="mb-1 block text-xs text-erp-muted">Code (4 to 8 digits)</label><input className="erp-input w-28" value={newCode} onChange={function (e) { setNewCode(e.target.value); }} required /></div>
          <div><label className="mb-1 block text-xs text-erp-muted">Name</label><input className="erp-input" value={newName} onChange={function (e) { setNewName(e.target.value); }} required /></div>
          <div>
            <label className="mb-1 block text-xs text-erp-muted">Type (can't be changed later)</label>
            <select className="erp-input" value={newType} onChange={function (e) { setNewType(e.target.value); }}>
              {ACCOUNT_TYPE_OPTIONS.map(function (t) { return <option key={t} value={t}>{t}</option>; })}
            </select>
          </div>
          <button disabled={busy} className="rounded bg-erp-primary px-3 py-1.5 text-erp-primary-fg disabled:opacity-60">Add</button>
        </form>
      )}
      <div className="overflow-x-auto"><table className="w-full border-collapse overflow-hidden rounded border bg-erp-surface text-sm">
        <thead className="bg-erp-subtle text-left">
          <tr><th className="p-2">Code</th><th className="p-2">Name</th><th className="p-2">Type</th><th className="p-2 text-right">Balance</th>{canManage && <th className="p-2"></th>}</tr>
        </thead>
        <tbody>
          {accounts.map(function (a) {
            const editing = editingId === a.id;
            return (
              <tr key={a.id} className={a.isActive ? "border-t" : "border-t text-erp-muted"}>
                <td className="p-2 text-erp-muted">{editing ? <input className="erp-input w-24" value={editCode} onChange={function (e) { setEditCode(e.target.value); }} /> : a.code}</td>
                <td className="p-2">
                  {editing ? <input className="erp-input" value={editName} onChange={function (e) { setEditName(e.target.value); }} /> : a.name}
                  {!a.isSystemAccount && <span className="ml-2 rounded-full bg-erp-subtle px-2 py-0.5 text-xs text-erp-muted">Custom</span>}
                  {!a.isActive && <span className="ml-2 text-xs">Inactive</span>}
                </td>
                <td className="p-2 text-erp-muted">{a.type}</td>
                <td className="p-2 text-right">{fmt(a.balance)}</td>
                {canManage && (
                  <td className="p-2 text-right text-xs">
                    {editing ? (
                      <span>
                        <button onClick={function () { saveEdit(a.id); }} className="text-erp-primary underline">Save</button>{" "}
                        <button onClick={function () { setEditingId(null); }} className="text-erp-muted underline">Cancel</button>
                      </span>
                    ) : (
                      <span>
                        <button onClick={function () { setEditingId(a.id); setEditName(a.name); setEditCode(a.code); }} className="text-erp-primary underline">Rename</button>
                        {!a.isSystemAccount && a.isActive && !a.hasPostings && (
                          <button onClick={function () { setActive(a.id, false); }} className="ml-2 text-erp-danger underline">Deactivate</button>
                        )}
                        {!a.isActive && (
                          <button onClick={function () { setActive(a.id, true); }} className="ml-2 text-erp-primary underline">Reactivate</button>
                        )}
                      </span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table></div>
      <p className="mt-2 text-xs text-erp-muted">
        Codes only sort the list; the app posts to system accounts by their built-in key, so renaming one is safe. An account that has been posted to can't be deactivated.
      </p>
    </div>
  );
}

function TrialBalanceView({ businessId }: { businessId: string }) {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch("/api/business/" + businessId + "/accounting/trial-balance")
      .then(function (r) { return r.json(); })
      .then(setData);
  }, [businessId]);

  if (!data) return <p className="text-sm text-erp-muted">Loading...</p>;

  return (
    <div>
      <div className="overflow-x-auto"><table className="w-full border-collapse overflow-hidden rounded border bg-erp-surface text-sm">
        <thead className="bg-erp-subtle text-left">
          <tr><th className="p-2">Code</th><th className="p-2">Account</th><th className="p-2 text-right">Debit</th><th className="p-2 text-right">Credit</th></tr>
        </thead>
        <tbody>
          {data.rows.map(function (r: any) {
            return (
              <tr key={r.code} className="border-t">
                <td className="p-2 text-erp-muted">{r.code}</td>
                <td className="p-2">{r.name}</td>
                <td className="p-2 text-right">{r.debit > 0 ? fmt(r.debit) : ""}</td>
                <td className="p-2 text-right">{r.credit > 0 ? fmt(r.credit) : ""}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 font-semibold">
            <td className="p-2" colSpan={2}>Total</td>
            <td className="p-2 text-right">{fmt(data.totalDebit)}</td>
            <td className="p-2 text-right">{fmt(data.totalCredit)}</td>
          </tr>
        </tfoot>
      </table></div>
      <p className={data.isBalanced ? "mt-2 text-sm text-erp-success" : "mt-2 text-sm font-semibold text-erp-danger"}>
        {data.isBalanced ? "Balanced" : "Out of balance – this indicates a bug, please report it."}
      </p>
    </div>
  );
}

function ProfitLossView({ businessId }: { businessId: string }) {
  const range = useDateRange();
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch("/api/business/" + businessId + "/accounting/profit-and-loss?from=" + range.from + "&to=" + range.to)
      .then(function (r) { return r.json(); })
      .then(setData);
  }, [businessId, range.from, range.to]);

  return (
    <div>
      <DateRangePicker from={range.from} to={range.to} setFrom={range.setFrom} setTo={range.setTo} />
      {!data ? (
        <p className="text-sm text-erp-muted">Loading...</p>
      ) : (
        <div className="rounded border bg-erp-surface p-4 text-sm">
          <h3 className="mb-2 font-semibold">Revenue</h3>
          {data.revenue.map(function (r: any) {
            return <div key={r.code} className="flex justify-between py-0.5"><span>{r.name}</span><span>{fmt(r.amount)}</span></div>;
          })}
          <div className="flex justify-between border-t py-1 font-medium"><span>Total Revenue</span><span>{fmt(data.totalRevenue)}</span></div>

          <div className="mt-3 flex justify-between py-0.5"><span>Cost of Goods Sold</span><span>{fmt(data.costOfGoodsSold)}</span></div>
          <div className="flex justify-between border-t py-1 font-semibold"><span>Gross Profit</span><span>{fmt(data.grossProfit)}</span></div>

          <h3 className="mb-2 mt-4 font-semibold">Operating Expenses</h3>
          {data.operatingExpenses.map(function (r: any) {
            return <div key={r.code} className="flex justify-between py-0.5"><span>{r.name}</span><span>{fmt(r.amount)}</span></div>;
          })}
          <div className="flex justify-between border-t py-1 font-medium"><span>Total Operating Expenses</span><span>{fmt(data.totalOperatingExpenses)}</span></div>

          <div className="mt-3 flex justify-between border-t-2 pt-2 font-semibold">
            <span>Operating Profit</span><span>{fmt(data.operatingProfit)}</span>
          </div>

          {data.otherIncome && data.otherIncome.length > 0 && (
            <div>
              <h3 className="mb-2 mt-4 font-semibold">Other Income</h3>
              {data.otherIncome.map(function (r: any) {
                return <div key={r.code} className="flex justify-between py-0.5"><span>{r.name}</span><span>{fmt(r.amount)}</span></div>;
              })}
              <div className="flex justify-between border-t py-1 font-medium"><span>Total Other Income</span><span>{fmt(data.totalOtherIncome)}</span></div>
            </div>
          )}

          {data.otherExpenses && data.otherExpenses.length > 0 && (
            <div>
              <h3 className="mb-2 mt-4 font-semibold">Other Expenses</h3>
              {data.otherExpenses.map(function (r: any) {
                return <div key={r.code} className="flex justify-between py-0.5"><span>{r.name}</span><span>{fmt(r.amount)}</span></div>;
              })}
              <div className="flex justify-between border-t py-1 font-medium"><span>Total Other Expenses</span><span>{fmt(data.totalOtherExpenses)}</span></div>
            </div>
          )}

          <div className="mt-3 flex justify-between border-t-2 pt-2 text-base font-bold">
            <span>Profit Before Tax</span><span>{fmt(data.profitBeforeTax)}</span>
          </div>
          {data.incomeTaxExpense !== undefined && data.incomeTaxExpense !== 0 ? (
            <div>
              <div className="flex justify-between py-0.5"><span>Income Tax Expense</span><span>{fmt(data.incomeTaxExpense)}</span></div>
              <div className="mt-1 flex justify-between border-t-2 pt-2 text-base font-bold"><span>Profit After Tax</span><span>{fmt(data.profitAfterTax)}</span></div>
              <p className="mt-1 text-xs text-erp-muted">Income tax booked by journal entry. Profit Before Tax is what the Corporate Tax estimate starts from.</p>
            </div>
          ) : (
            <p className="mt-1 text-xs text-erp-muted">Before corporate tax. See the Corporate Tax tab for an estimate. Book the final tax charge with a journal entry.</p>
          )}
        </div>
      )}
    </div>
  );
}

function BalanceSheetView({ businessId }: { businessId: string }) {
  const tz = useTimeZone();
  const [asOf, setAsOf] = useState(function () { return todayYmd(tz); });
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch("/api/business/" + businessId + "/accounting/balance-sheet?asOf=" + asOf)
      .then(function (r) { return r.json(); })
      .then(setData);
  }, [businessId, asOf]);

  return (
    <div>
      <div className="mb-4">
        <label className="mb-1 block text-xs text-erp-muted">As of</label>
        <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="erp-input w-48" />
      </div>
      {!data ? (
        <p className="text-sm text-erp-muted">Loading...</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded border bg-erp-surface p-4 text-sm">
            <h3 className="mb-2 font-semibold">Assets</h3>
            {data.assets.map(function (a: any) {
              return <div key={a.code} className="flex justify-between py-0.5"><span>{a.name}</span><span>{fmt(a.balance)}</span></div>;
            })}
            <div className="flex justify-between border-t pt-1 font-semibold"><span>Total Assets</span><span>{fmt(data.totalAssets)}</span></div>
          </div>
          <div className="rounded border bg-erp-surface p-4 text-sm">
            <h3 className="mb-2 font-semibold">Liabilities</h3>
            {data.liabilities.map(function (a: any) {
              return <div key={a.code} className="flex justify-between py-0.5"><span>{a.name}</span><span>{fmt(a.balance)}</span></div>;
            })}
            <div className="flex justify-between border-t pt-1 font-medium"><span>Total Liabilities</span><span>{fmt(data.totalLiabilities)}</span></div>

            <h3 className="mb-2 mt-4 font-semibold">Equity</h3>
            {data.equity.map(function (a: any) {
              return <div key={a.code} className="flex justify-between py-0.5"><span>{a.name}</span><span>{fmt(a.balance)}</span></div>;
            })}
            <div className="flex justify-between py-0.5"><span>Retained Earnings</span><span>{fmt(data.retainedEarnings)}</span></div>
            <div className="flex justify-between border-t pt-1 font-medium"><span>Total Equity</span><span>{fmt(data.totalEquity)}</span></div>

            <div className="mt-2 flex justify-between border-t-2 pt-2 font-semibold"><span>Total Liabilities + Equity</span><span>{fmt(data.totalLiabilitiesAndEquity)}</span></div>
          </div>
        </div>
      )}
      {data && (
        <p className={data.isBalanced ? "mt-2 text-sm text-erp-success" : "mt-2 text-sm font-semibold text-erp-danger"}>
          {data.isBalanced ? "Assets = Liabilities + Equity" : "Out of balance – this indicates a bug, please report it."}
        </p>
      )}
    </div>
  );
}

function CashFlowView({ businessId }: { businessId: string }) {
  const range = useDateRange();
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch("/api/business/" + businessId + "/accounting/cash-flow?from=" + range.from + "&to=" + range.to)
      .then(function (r) { return r.json(); })
      .then(setData);
  }, [businessId, range.from, range.to]);

  return (
    <div>
      <DateRangePicker from={range.from} to={range.to} setFrom={range.setFrom} setTo={range.setTo} />
      {!data ? (
        <p className="text-sm text-erp-muted">Loading...</p>
      ) : (
        <div className="rounded border bg-erp-surface p-4 text-sm">
          <div className="mb-3">
            <h3 className="font-semibold">Operating Activities</h3>
            <div className="flex justify-between py-0.5"><span>Cash received</span><span>{fmt(data.operating.inflows)}</span></div>
            <div className="flex justify-between py-0.5"><span>Cash paid</span><span>{fmt(data.operating.outflows)}</span></div>
            <div className="flex justify-between border-t py-1 font-medium"><span>Net Operating Cash Flow</span><span>{fmt(data.operating.net)}</span></div>
          </div>
          <div className="mb-3 text-erp-muted">
            <h3 className="font-semibold text-erp-muted">Investing Activities</h3>
            <p className="text-xs">{data.investing.note}</p>
          </div>
          <div className="mb-3 text-erp-muted">
            <h3 className="font-semibold text-erp-muted">Financing Activities</h3>
            <p className="text-xs">{data.financing.note}</p>
          </div>
          {data.exchangeRateEffect !== 0 && data.exchangeRateEffect !== undefined && (
            <div className="mb-3">
              <h3 className="font-semibold">Effect of Exchange Rate Changes</h3>
              <div className="flex justify-between py-0.5"><span>Foreign exchange gain / (loss) on cash held</span><span>{fmt(data.exchangeRateEffect)}</span></div>
            </div>
          )}
          <div className="flex justify-between border-t-2 pt-2 font-semibold"><span>Net Change in Cash</span><span>{fmt(data.netChangeInCash)}</span></div>
          <div className="mt-2 flex justify-between text-xs text-erp-muted"><span>Opening Cash</span><span>{fmt(data.openingCash)}</span></div>
          <div className="flex justify-between text-xs text-erp-muted"><span>Closing Cash</span><span>{fmt(data.closingCash)}</span></div>
        </div>
      )}
    </div>
  );
}

// Module 18 (VAT) – a working document for an Accountant to transcribe
// onto the real MRA VAT 3 return, not a filing integration (see the
// disclaimer rendered below and src/lib/vat.ts's own comment on this).
function VatReturnView({ businessId }: { businessId: string }) {
  const range = useDateRange();
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch("/api/business/" + businessId + "/accounting/vat-return?from=" + range.from + "&to=" + range.to)
      .then(function (r) { return r.json(); })
      .then(setData);
  }, [businessId, range.from, range.to]);

  return (
    <div>
      <DateRangePicker from={range.from} to={range.to} setFrom={range.setFrom} setTo={range.setTo} />
      {!data ? (
        <p className="text-sm text-erp-muted">Loading...</p>
      ) : !data.vatRegistered ? (
        <p className="rounded border bg-erp-surface p-4 text-sm text-erp-muted">
          This business isn't VAT-registered – turn on VAT registration in Tax Settings to start tracking output and
          erp-input VAT.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-xs text-erp-warning">
            This is a working summary for transcribing onto your MRA VAT 3 return – not a filing itself. This app has
            no connection to MRA systems.
            {data.isExample && <span className="ml-1 font-medium">Also: your VAT rate is still a placeholder – review it in Tax Settings.</span>}
          </div>

          <div className="rounded border bg-erp-surface p-4 text-sm">
            <h3 className="mb-2 font-semibold">Output VAT (on sales)</h3>
            <div className="flex justify-between py-0.5"><span>Standard-rated sales</span><span>{fmt(data.sales.byCategory.STANDARD)}</span></div>
            <div className="flex justify-between py-0.5"><span>Zero-rated sales</span><span>{fmt(data.sales.byCategory.ZERO_RATED)}</span></div>
            <div className="flex justify-between py-0.5"><span>Exempt sales</span><span>{fmt(data.sales.byCategory.EXEMPT)}</span></div>
            <div className="flex justify-between border-t py-1"><span>Output VAT before credit notes</span><span>{fmt(data.sales.grossOutputVat)}</span></div>
            {data.creditNotes.count > 0 && (
              <>
                <div className="flex justify-between py-0.5 text-erp-muted"><span>Less: credit notes issued ({data.creditNotes.count})</span><span>-{fmt(data.creditNotes.vat)}</span></div>
                <div className="flex justify-between py-0.5 text-erp-muted"><span>Standard-rated</span><span>-{fmt(data.creditNotes.byCategory.STANDARD)}</span></div>
                <div className="flex justify-between py-0.5 text-erp-muted"><span>Zero-rated</span><span>-{fmt(data.creditNotes.byCategory.ZERO_RATED)}</span></div>
                <div className="flex justify-between py-0.5 text-erp-muted"><span>Exempt</span><span>-{fmt(data.creditNotes.byCategory.EXEMPT)}</span></div>
              </>
            )}
            <div className="flex justify-between border-t py-1 font-medium"><span>Net Output VAT ({data.vatRate}%)</span><span>{fmt(data.sales.outputVat)}</span></div>
          </div>

          <div className="rounded border bg-erp-surface p-4 text-sm">
            <h3 className="mb-2 font-semibold">Input VAT (on purchases)</h3>
            <div className="flex justify-between py-0.5"><span>Standard-rated purchases</span><span>{fmt(data.purchases.byCategory.STANDARD)}</span></div>
            <div className="flex justify-between py-0.5"><span>Zero-rated purchases</span><span>{fmt(data.purchases.byCategory.ZERO_RATED)}</span></div>
            <div className="flex justify-between py-0.5"><span>Exempt purchases</span><span>{fmt(data.purchases.byCategory.EXEMPT)}</span></div>
            <div className="flex justify-between border-t py-1"><span>Input VAT before debit notes</span><span>{fmt(data.purchases.grossInputVat)}</span></div>
            {data.debitNotes.count > 0 && (
              <>
                <div className="flex justify-between py-0.5 text-erp-muted"><span>Less: debit notes issued ({data.debitNotes.count})</span><span>-{fmt(data.debitNotes.vat)}</span></div>
                <div className="flex justify-between py-0.5 text-erp-muted"><span>Standard-rated</span><span>-{fmt(data.debitNotes.byCategory.STANDARD)}</span></div>
                <div className="flex justify-between py-0.5 text-erp-muted"><span>Zero-rated</span><span>-{fmt(data.debitNotes.byCategory.ZERO_RATED)}</span></div>
                <div className="flex justify-between py-0.5 text-erp-muted"><span>Exempt</span><span>-{fmt(data.debitNotes.byCategory.EXEMPT)}</span></div>
              </>
            )}
            <div className="flex justify-between border-t py-1 font-medium"><span>Net Input VAT ({data.vatRate}%)</span><span>{fmt(data.purchases.inputVat)}</span></div>
            {data.partialExemption.apportioned && (
              <>
                <div className="flex justify-between py-0.5 text-erp-muted">
                  <span>Less: irrecoverable (exempt sales {data.partialExemption.exemptRatioPercent}% of total)</span>
                  <span>-{fmt(data.partialExemption.irrecoverableInputVat)}</span>
                </div>
                <div className="flex justify-between border-t py-1 font-medium">
                  <span>Reclaimable Input VAT ({data.partialExemption.recoveryRatioPercent}% recovery)</span>
                  <span>{fmt(data.partialExemption.recoverableInputVat)}</span>
                </div>
              </>
            )}
          </div>

          {data.partialExemption.apportioned && (
            <div className="rounded border border-erp-warning/40 bg-erp-warning/10 p-3 text-xs text-erp-warning">
              This period&apos;s exempt sales ({data.partialExemption.exemptRatioPercent}%) exceed the de minimis
              threshold in Tax Settings, so erp-input VAT is apportioned by the taxable-vs-exempt sales mix (a
              simplified method – see Tax Settings). MWK {fmt(data.partialExemption.irrecoverableInputVat)} stays in
              VAT Input Receivable until written off by a manual journal entry.
            </div>
          )}

          <div className="rounded border bg-erp-subtle p-4 text-sm">
            <div className={`flex justify-between text-base font-semibold ${data.netPayable >= 0 ? "text-erp-danger" : "text-erp-success"}`}>
              <span>{data.netPayable >= 0 ? "Net VAT payable to MRA" : "Net VAT refundable / carried forward"}</span>
              <span>{fmt(Math.abs(data.netPayable))}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function GeneralLedgerView({ businessId }: { businessId: string }) {
  const tz = useTimeZone();
  const [accounts, setAccounts] = useState<any[]>([]);
  const [accountId, setAccountId] = useState("");
  const [ledger, setLedger] = useState<any>(null);

  useEffect(() => {
    fetch("/api/business/" + businessId + "/accounting/chart-of-accounts")
      .then(function (r) { return r.json(); })
      .then(function (d) { setAccounts(d.accounts || []); });
  }, [businessId]);

  useEffect(() => {
    if (!accountId) return;
    fetch("/api/business/" + businessId + "/accounting/general-ledger?accountId=" + accountId)
      .then(function (r) { return r.json(); })
      .then(setLedger);
  }, [businessId, accountId]);

  return (
    <div>
      <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="erp-input mb-4 w-64">
        <option value="">Select an account</option>
        {accounts.map(function (a) {
          return <option key={a.id} value={a.id}>{a.code} – {a.name}</option>;
        })}
      </select>

      {ledger && (
        <div className="overflow-x-auto"><table className="w-full border-collapse overflow-hidden rounded border bg-erp-surface text-sm">
          <thead className="bg-erp-subtle text-left">
            <tr><th className="p-2">Date</th><th className="p-2">Entry #</th><th className="p-2">Description</th><th className="p-2 text-right">Debit</th><th className="p-2 text-right">Credit</th><th className="p-2 text-right">Balance</th></tr>
          </thead>
          <tbody>
            {ledger.rows.map(function (r: any, i: number) {
              return (
                <tr key={i} className="border-t">
                  <td className="p-2 text-erp-muted">{formatDateIn(new Date(r.date), tz)}</td>
                  <td className="p-2 text-erp-muted">{r.entryNumber}</td>
                  <td className="p-2">{r.description}</td>
                  <td className="p-2 text-right">{r.debit > 0 ? fmt(r.debit) : ""}</td>
                  <td className="p-2 text-right">{r.credit > 0 ? fmt(r.credit) : ""}</td>
                  <td className="p-2 text-right font-medium">{fmt(r.balance)}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
    </div>
  );
}
