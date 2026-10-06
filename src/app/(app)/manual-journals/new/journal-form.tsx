"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { todayYmd } from "@/lib/date-range";
import { isDayClosed, dayAfter } from "@/lib/period-lock";
import { checkManualJournal, formatTambala, MANUAL_JOURNAL_TEMPLATES, MAX_MANUAL_JOURNAL_LINES } from "@/lib/manual-journal-rules";

interface AccountOption { id: string; code: string; name: string; type: string; systemKey: string | null }
interface BlockedOption { id: string; code: string; name: string; reason: string }
interface Row { accountId: string; debit: string; credit: string; memo: string }

const emptyRow = (): Row => ({ accountId: "", debit: "", credit: "", memo: "" });

export function JournalForm({
  businessId,
  currency,
  accounts,
  blocked,
  timeZone,
  closedThrough,
}: {
  businessId: string;
  currency: string;
  accounts: AccountOption[];
  blocked: BlockedOption[];
  timeZone: string;
  closedThrough: string | null;
}) {
  const router = useRouter();
  const [entryDate, setEntryDate] = useState(todayYmd(timeZone));
  const [description, setDescription] = useState("");
  const [documentRef, setDocumentRef] = useState("");
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState<Row[]>([emptyRow(), emptyRow()]);
  const [problems, setProblems] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [showBlocked, setShowBlocked] = useState(false);
  // Module 42: the server is the authority; this only warns before the round trip.
  const dateClosed = isDayClosed(closedThrough, entryDate);

  function update(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  // Entering a debit clears the credit on that line and vice versa: one side per line.
  function setDebit(i: number, v: string) { update(i, { debit: v, credit: v ? "" : rows[i].credit }); }
  function setCredit(i: number, v: string) { update(i, { credit: v, debit: v ? "" : rows[i].debit }); }

  function applyTemplate(key: string) {
    const t = MANUAL_JOURNAL_TEMPLATES.find((x) => x.key === key);
    if (!t) return;
    const next = t.lines.map((l) => {
      const account = accounts.find((a) => a.systemKey === l.systemKey);
      return { ...emptyRow(), accountId: account?.id ?? "", memo: l.memo };
    });
    setRows(next);
    if (!description) setDescription(t.label);
  }

  // The same rules the server runs (src/lib/manual-journal-rules.ts). The server re-checks and is the authority.
  const toNum = (s: string) => (s.trim() === "" ? null : Number(s));
  const checked = checkManualJournal(
    rows.map((r) => ({ accountId: r.accountId, debit: toNum(r.debit), credit: toNum(r.credit), memo: r.memo })),
    accounts.map((a) => ({ id: a.id, code: a.code, name: a.name, isActive: true, systemKey: a.systemKey }))
  );
  const balanced = checked.totalDebit === checked.totalCredit && checked.totalDebit > 0;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setProblems([]);
    if (!checked.ok) {
      setProblems(checked.errors);
      return;
    }
    setLoading(true);
    const res = await fetch(`/api/business/${businessId}/manual-journals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entryDate,
        description,
        documentRef: documentRef || null,
        notes: notes || null,
        lines: rows.map((r) => ({ accountId: r.accountId, debit: toNum(r.debit), credit: toNum(r.credit), memo: r.memo || null })),
      }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setProblems(data.problems?.length ? data.problems : [data.message ?? "Could not post this entry."]);
      return;
    }
    router.push(`/manual-journals/${data.journal.id}`);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {problems.length > 0 && (
        <ul className="list-disc space-y-1 rounded bg-erp-danger/10 p-3 pl-6 text-sm text-erp-danger">
          {problems.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}

      <div>
        <label className="mb-1 block text-xs text-erp-muted">Start from</label>
        <select className="erp-input" value="" onChange={(e) => applyTemplate(e.target.value)}>
          <option value="">Blank entry</option>
          {MANUAL_JOURNAL_TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs text-erp-muted">Date</label>
          <input type="date" className="erp-input" value={entryDate} max={todayYmd(timeZone)} min={closedThrough ? dayAfter(closedThrough) : undefined} onChange={(e) => setEntryDate(e.target.value)} required />
          {dateClosed && <p className="mt-1 text-xs text-erp-danger">The books are closed through {closedThrough}. Pick a later date.</p>}
        </div>
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs text-erp-muted">Narration (what is this and why)</label>
          <input className="erp-input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} required />
        </div>
        <div>
          <label className="mb-1 block text-xs text-erp-muted">Supporting document (optional)</label>
          <input className="erp-input" value={documentRef} onChange={(e) => setDocumentRef(e.target.value)} maxLength={100} placeholder="Voucher, assessment or advice no." />
        </div>
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs text-erp-muted">Notes (optional)</label>
          <input className="erp-input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-erp-subtle text-left">
            <tr>
              <th className="p-2">Account</th>
              <th className="p-2 text-right">Debit ({currency})</th>
              <th className="p-2 text-right">Credit ({currency})</th>
              <th className="p-2">Line note</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t align-top">
                <td className="p-2">
                  <select className="erp-input" value={r.accountId} onChange={(e) => update(i, { accountId: e.target.value })} required>
                    <option value="">Choose account</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                  </select>
                </td>
                <td className="p-2"><input type="number" step="0.01" min="0" className="erp-input text-right" value={r.debit} onChange={(e) => setDebit(i, e.target.value)} /></td>
                <td className="p-2"><input type="number" step="0.01" min="0" className="erp-input text-right" value={r.credit} onChange={(e) => setCredit(i, e.target.value)} /></td>
                <td className="p-2"><input className="erp-input" value={r.memo} maxLength={200} onChange={(e) => update(i, { memo: e.target.value })} /></td>
                <td className="p-2">
                  {rows.length > 2 && (
                    <button type="button" onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))} className="text-erp-danger underline">Remove</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 font-semibold">
              <td className="p-2">Totals</td>
              <td className="p-2 text-right">{formatTambala(checked.totalDebit)}</td>
              <td className="p-2 text-right">{formatTambala(checked.totalCredit)}</td>
              <td className={`p-2 ${balanced ? "text-erp-success" : "text-erp-danger"}`} colSpan={2}>
                {balanced ? "Balanced" : `Difference ${formatTambala(Math.abs(checked.difference))}`}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={rows.length >= MAX_MANUAL_JOURNAL_LINES}
          onClick={() => setRows((rs) => [...rs, emptyRow()])}
          className="rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle"
        >
          + Add line
        </button>
        <button type="button" onClick={() => setShowBlocked((v) => !v)} className="text-sm text-erp-muted underline">
          {showBlocked ? "Hide" : "Why can't I pick cash, receivables or inventory?"}
        </button>
      </div>

      {showBlocked && (
        <div className="rounded border bg-erp-subtle p-3 text-xs text-erp-muted">
          <p className="mb-2">The app computes these accounts from its own records, so a manual line would put the ledger out of step with them:</p>
          <ul className="space-y-1">
            {blocked.map((b) => <li key={b.id}><span className="font-medium">{b.code} {b.name}.</span> {b.reason}</li>)}
          </ul>
        </div>
      )}

      <div className="flex gap-3">
        <button type="submit" disabled={loading || !balanced || dateClosed} className="rounded bg-erp-primary px-4 py-2 text-erp-primary-fg hover:opacity-90 disabled:opacity-60">
          {loading ? "Posting..." : "Post Journal Entry"}
        </button>
        <button type="button" onClick={() => router.push("/manual-journals")} className="text-erp-muted underline">Cancel</button>
      </div>
    </form>
  );
}
