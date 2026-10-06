"use client";

import { useEffect, useState } from "react";
import { CASH_ACCOUNT_TYPES } from "@/lib/validation";
import { formatDateIn } from "@/lib/timezone";
import { KpiCard, Field, FormCard } from "@/components/erp/display";
import { DataTable } from "@/components/erp/data-table";
import { formatMoney } from "@/lib/erp/format";

interface Account {
  id: string;
  name: string;
  type: string;
  isDefault: boolean;
  openingBalance: number;
  balance: number;
}

interface Transaction {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  description: string | null;
  referenceType: string | null;
  createdAt: string;
  relatedAccount?: { name: string } | null;
  // Module 27: null for transfers/adjustments/payroll – see the
  // CashTransaction model comment for why that's expected, not missing data.
  branch?: { name: string } | null;
}

export function CashbookView({ businessId, canManage, timeZone }: { businessId: string; canManage: boolean; timeZone: string }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [showTransfer, setShowTransfer] = useState(false);
  const [showNewAccount, setShowNewAccount] = useState(false);

  async function loadAccounts() {
    setLoading(true);
    const res = await fetch(`/api/business/${businessId}/cashbook/accounts`);
    const data = await res.json();
    setAccounts(data.accounts ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadAccounts();
  }, [businessId]);

  async function toggleExpand(accountId: string) {
    if (expandedId === accountId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(accountId);
    const res = await fetch(`/api/business/${businessId}/cashbook/accounts/${accountId}/transactions`);
    const data = await res.json();
    setTransactions(data.transactions ?? []);
  }

  const totalBalance = accounts.reduce((sum, a) => sum + a.balance, 0);

  const btn = "rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle";

  return (
    <div>
      <div className="mb-4 max-w-xs">
        <KpiCard label="Total Cash Position" value={formatMoney(totalBalance)} tone={totalBalance < 0 ? "bad" : undefined} />
      </div>

      {canManage && (
        <div className="mb-4 flex flex-wrap gap-2">
          <button onClick={() => setShowTransfer((v) => !v)} className={btn}>
            {showTransfer ? "Cancel Transfer" : "Transfer Between Accounts"}
          </button>
          <button onClick={() => setShowNewAccount((v) => !v)} className={btn}>
            {showNewAccount ? "Cancel" : "+ Add Account"}
          </button>
        </div>
      )}

      {showTransfer && (
        <TransferForm
          businessId={businessId}
          accounts={accounts}
          onDone={() => {
            setShowTransfer(false);
            loadAccounts();
          }}
        />
      )}

      {showNewAccount && (
        <NewAccountForm
          businessId={businessId}
          onDone={() => {
            setShowNewAccount(false);
            loadAccounts();
          }}
        />
      )}

      {loading ? (
        <p className="text-sm text-erp-muted" aria-busy="true">Loading...</p>
      ) : accounts.length === 0 ? (
        <p className="text-sm text-erp-muted">No cash accounts yet.</p>
      ) : (
        <div className="space-y-3">
          {accounts.map((a) => (
            <div key={a.id} className="rounded border border-erp-border bg-erp-surface shadow-sm">
              <button
                onClick={() => toggleExpand(a.id)}
                aria-expanded={expandedId === a.id}
                className="flex w-full items-center justify-between gap-3 p-3 text-left hover:bg-erp-subtle/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-erp-primary"
              >
                <div>
                  <p className="font-medium text-erp-text">
                    {a.name}
                    {a.isDefault && <span className="ml-2 rounded bg-erp-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-erp-primary">Default</span>}
                  </p>
                  <p className="text-xs text-erp-muted">{a.type.replace("_", " ")}</p>
                </div>
                <p className={`text-base font-semibold tabular ${a.balance < 0 ? "text-erp-danger" : "text-erp-text"}`}>{formatMoney(a.balance)}</p>
              </button>

              {expandedId === a.id && (
                <div className="border-t border-erp-border p-3">
                  <DataTable
                    exportName={`cashbook-${a.name}`}
                    searchPlaceholder="Search transactions…"
                    pageSize={15}
                    emptyMessage="No transactions yet."
                    columns={[
                      { key: "date", header: "Date", sortKey: "dateSort" },
                      { key: "type", header: "Type" },
                      { key: "description", header: "Description" },
                      { key: "branch", header: "Branch", defaultHidden: true },
                      { key: "amount", header: "Amount", type: "money" },
                      { key: "balanceAfter", header: "Balance", type: "money" },
                    ]}
                    rows={transactions.map((t) => ({
                      id: t.id,
                      date: formatDateIn(t.createdAt, timeZone),
                      dateSort: t.createdAt,
                      type: t.type.replace("_", " "),
                      description: `${t.description ?? t.referenceType ?? ""}${t.relatedAccount ? ` (${t.relatedAccount.name})` : ""}`,
                      branch: t.branch?.name ?? "",
                      amount: t.amount,
                      balanceAfter: t.balanceAfter,
                    }))}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TransferForm({
  businessId,
  accounts,
  onDone,
}: {
  businessId: string;
  accounts: Account[];
  onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(e.currentTarget);
    const res = await fetch(`/api/business/${businessId}/cashbook/transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromAccountId: form.get("fromAccountId"),
        toAccountId: form.get("toAccountId"),
        amount: Number(form.get("amount")),
        description: form.get("description") || null,
      }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Transfer failed.");
      return;
    }

    onDone();
  }

  return (
    <div className="mb-4 max-w-lg">
      <FormCard>
        <form onSubmit={handleSubmit} className="space-y-3">
          {error && <p role="alert" className="rounded border border-erp-danger/30 bg-erp-danger/10 p-2.5 text-sm text-erp-danger">{error}</p>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="From account" htmlFor="t-from" required>
              <select id="t-from" name="fromAccountId" className="erp-input" required>
                <option value="">Select…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </Field>
            <Field label="To account" htmlFor="t-to" required>
              <select id="t-to" name="toAccountId" className="erp-input" required>
                <option value="">Select…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Amount (MWK)" htmlFor="t-amount" required>
            <input id="t-amount" name="amount" type="number" min="0.01" step="0.01" required className="erp-input" />
          </Field>
          <Field label="Note" htmlFor="t-note">
            <input id="t-note" name="description" className="erp-input" />
          </Field>
          <button type="submit" disabled={loading} className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60">
            {loading ? "Transferring..." : "Transfer"}
          </button>
        </form>
      </FormCard>
    </div>
  );
}

function NewAccountForm({ businessId, onDone }: { businessId: string; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(e.currentTarget);
    const res = await fetch(`/api/business/${businessId}/cashbook/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: form.get("type"),
        name: form.get("name"),
        openingBalance: Number(form.get("openingBalance") || 0),
      }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Could not create account.");
      return;
    }

    onDone();
  }

  return (
    <div className="mb-4 max-w-lg">
      <FormCard>
        <form onSubmit={handleSubmit} className="space-y-3">
          {error && <p role="alert" className="rounded border border-erp-danger/30 bg-erp-danger/10 p-2.5 text-sm text-erp-danger">{error}</p>}
          <Field label="Account type" htmlFor="a-type" required>
            <select id="a-type" name="type" className="erp-input" required>
              {CASH_ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>{t.replace("_", " ")}</option>
              ))}
            </select>
          </Field>
          <Field label="Account name" htmlFor="a-name" hint="For example, Standard Bank." required>
            <input id="a-name" name="name" required className="erp-input" />
          </Field>
          <Field label="Opening balance (MWK)" htmlFor="a-open">
            <input id="a-open" name="openingBalance" type="number" step="0.01" className="erp-input" />
          </Field>
          <button type="submit" disabled={loading} className="rounded bg-erp-primary px-3 py-1.5 text-sm font-medium text-erp-primary-fg hover:opacity-90 disabled:opacity-60">
            {loading ? "Saving..." : "Add Account"}
          </button>
        </form>
      </FormCard>
    </div>
  );
}
