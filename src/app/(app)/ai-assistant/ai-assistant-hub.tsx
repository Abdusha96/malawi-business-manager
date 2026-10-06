"use client";

import { useState } from "react";

const EXAMPLE_QUESTIONS = [
  "Why did my profit decrease this month?",
  "Which products make the most profit?",
  "Who owes me the most money?",
  "What are my biggest expenses?",
  "How much did I sell this month?",
  "What should I investigate in my accounts?",
];

interface ChatTurn {
  question: string;
  answer?: string;
  error?: string;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: "border-erp-danger/40 bg-erp-danger/10 text-erp-danger",
  warning: "border-erp-warning/40 bg-erp-warning/10 text-erp-warning",
  info: "border-erp-info/40 bg-erp-info/10 text-erp-text",
};

export function AIAssistantHub({ businessId }: { businessId: string }) {
  const [tab, setTab] = useState<"ask" | "analysis">("ask");

  return (
    <div>
      <div className="mb-6 flex gap-2">
        <button
          onClick={() => setTab("ask")}
          className={tab === "ask" ? "rounded bg-erp-primary px-3 py-1.5 text-sm text-erp-primary-fg" : "rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle"}
        >
          Ask Mobi Accountant
        </button>
        <button
          onClick={() => setTab("analysis")}
          className={tab === "analysis" ? "rounded bg-erp-primary px-3 py-1.5 text-sm text-erp-primary-fg" : "rounded border border-erp-border px-3 py-1.5 text-sm hover:bg-erp-subtle"}
        >
          Transaction Analysis
        </button>
      </div>

      {tab === "ask" ? <AskView businessId={businessId} /> : <AnalysisView businessId={businessId} />}
    </div>
  );
}

function AskView({ businessId }: { businessId: string }) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [loading, setLoading] = useState(false);

  async function ask(q: string) {
    if (!q.trim()) return;
    setLoading(true);
    setQuestion("");

    const turnIndex = turns.length;
    setTurns(function (prev) { return prev.concat([{ question: q }]); });

    const res = await fetch("/api/business/" + businessId + "/ai/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q }),
    });
    const data = await res.json();
    setLoading(false);

    setTurns(function (prev) {
      return prev.map(function (t, i) {
        if (i === turnIndex) {
          return { question: t.question, answer: data.answer, error: !res.ok ? data.message : undefined };
        }
        return t;
      });
    });
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        {EXAMPLE_QUESTIONS.map(function (q) {
          return (
            <button key={q} onClick={() => ask(q)} className="rounded-full border border-erp-border px-3 py-1 text-xs hover:bg-erp-subtle">
              {q}
            </button>
          );
        })}
      </div>

      <div className="mb-4 space-y-4">
        {turns.map(function (t, i) {
          return (
            <div key={i} className="rounded border bg-erp-surface p-4">
              <p className="mb-2 font-medium text-erp-text">{t.question}</p>
              {t.error ? (
                <p className="text-sm text-erp-danger">{t.error}</p>
              ) : t.answer ? (
                <p className="whitespace-pre-wrap text-sm text-erp-text">{t.answer}</p>
              ) : (
                <p className="text-sm text-erp-muted">Thinking...</p>
              )}
            </div>
          );
        })}
      </div>

      <form
        onSubmit={function (e) {
          e.preventDefault();
          ask(question);
        }}
        className="flex gap-2"
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about your sales, expenses, debts, or profit..."
          className="erp-input flex-1"
        />
        <button type="submit" disabled={loading} className="rounded bg-erp-primary px-5 py-2 text-erp-primary-fg hover:opacity-90 disabled:opacity-60">
          {loading ? "..." : "Ask"}
        </button>
      </form>

      <p className="mt-3 text-xs text-erp-muted">
        Mobi Accountant answers using your business's own data only. It labels [Data] (facts from your records),
        [Guidance] (general suggestions), and [Professional advice needed] (things to confirm with an accountant or
        tax professional) – it is not a substitute for either.
      </p>
    </div>
  );
}

function AnalysisView({ businessId }: { businessId: string }) {
  const [findings, setFindings] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runAnalysis() {
    setLoading(true);
    setError(null);
    const res = await fetch("/api/business/" + businessId + "/ai/analyze", { method: "POST" });
    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message || "Could not run analysis.");
      return;
    }
    setFindings(data.run.findings);
  }

  return (
    <div>
      <button onClick={runAnalysis} disabled={loading} className="mb-4 rounded bg-erp-primary px-5 py-2.5 text-erp-primary-fg hover:opacity-90 disabled:opacity-60">
        {loading ? "Analyzing..." : "Run Analysis Now"}
      </button>

      {error && <p className="mb-4 rounded bg-erp-danger/10 p-3 text-sm text-erp-danger">{error}</p>}

      {findings && findings.length === 0 && (
        <p className="text-sm text-erp-muted">No issues found – your accounts look healthy.</p>
      )}

      {findings && findings.length > 0 && (
        <div className="space-y-2">
          {findings.map(function (f: any, i: number) {
            return (
              <div key={i} className={"rounded border p-3 text-sm " + (SEVERITY_COLOR[f.severity] || "border-erp-border bg-erp-subtle")}>
                <span className="mr-2 font-semibold uppercase">{f.severity}</span>
                {f.message}
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-4 text-xs text-erp-muted">
        These checks are calculated directly from your records – expense trends, profit margins, overdue debts,
        possible duplicate entries – not guessed by AI. Review flagged items before acting on them.
      </p>
    </div>
  );
}
