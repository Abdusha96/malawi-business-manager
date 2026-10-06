"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { todayYmd } from "@/lib/date-range";

interface Option { key: string; label: string }
interface CashAccountOption { id: string; name: string; type: string; balance: number }

const MONTHLY = ["VAT", "PAYE", "WITHHOLDING_TAX"];

export function TaxPaymentForm({
  businessId,
  types,
  initialType,
  initialPeriod,
  defaultMonth,
  incomeTaxOptions,
  cashAccounts,
  timeZone,
}: {
  timeZone: string;
  businessId: string;
  types: { value: string; label: string }[];
  initialType: string;
  initialPeriod: string | null;
  defaultMonth: string;
  incomeTaxOptions: { annual: Option[]; quarterly: Option[] };
  cashAccounts: CashAccountOption[];
}) {
  const router = useRouter();
  const [taxType, setTaxType] = useState(initialType);
  // One period state per erp-input kind, so switching type doesn't lose the others.
  const [month, setMonth] = useState(MONTHLY.includes(initialType) && initialPeriod ? initialPeriod : defaultMonth);
  const [quarter, setQuarter] = useState(initialType === "PROVISIONAL_TAX" && initialPeriod ? initialPeriod : incomeTaxOptions.quarterly[1]?.key ?? incomeTaxOptions.quarterly[0]?.key ?? "");
  const [annual, setAnnual] = useState(initialType === "ANNUAL_INCOME_TAX" && initialPeriod ? initialPeriod : incomeTaxOptions.annual[1]?.key ?? incomeTaxOptions.annual[0]?.key ?? "");

  const periodKey = MONTHLY.includes(taxType) ? month : taxType === "PROVISIONAL_TAX" ? quarter : annual;

  const [preview, setPreview] = useState<any>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [principal, setPrincipal] = useState("");
  const [penalty, setPenalty] = useState("0");
  const [cashAccountId, setCashAccountId] = useState(cashAccounts[0]?.id ?? "");
  const [paymentDate, setPaymentDate] = useState(todayYmd(timeZone));
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [partial, setPartial] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!periodKey) return;
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    fetch(`/api/business/${businessId}/tax-payments/preview?taxType=${taxType}&periodKey=${encodeURIComponent(periodKey)}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.preview) {
          setPreview(d.preview);
          // Module 67: with something already paid, suggest only what's still owed.
          const inst = d.preview.installments;
          setPrincipal(
            inst && inst.count > 0 && inst.remaining > 0
              ? String(inst.remaining)
              : d.preview.suggestedPrincipal > 0
                ? String(d.preview.suggestedPrincipal)
                : ""
          );
          setPartial(false);
        } else {
          setPreviewError(d.message ?? "Could not load this period.");
        }
      })
      .catch(() => !cancelled && setPreviewError("Could not load this period."));
    return () => {
      cancelled = true;
    };
  }, [businessId, taxType, periodKey]);

  const isVat = taxType === "VAT";
  const isRefund = isVat && !!preview?.isRefund;
  const principalNumber = isVat ? preview?.suggestedPrincipal ?? 0 : Number(principal || 0);
  const total = principalNumber + (isRefund ? 0 : Number(penalty || 0));
  const account = cashAccounts.find((a) => a.id === cashAccountId);
  const blocked =
    !preview || !preview.periodEnded || !preview.vatApplicable || !!preview.alreadyRecorded || (isVat && preview.suggestedPrincipal <= 0);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const res = await fetch(`/api/business/${businessId}/tax-payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taxType,
        periodKey,
        paymentDate: paymentDate ? new Date(paymentDate).toISOString() : null,
        cashAccountId,
        principalAmount: isVat ? null : Number(principal),
        penaltyAmount: isRefund ? 0 : Number(penalty || 0),
        partial: !isVat && partial,
        reference: reference || null,
        notes: notes || null,
      }),
    });
    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.message ?? "Could not record this payment.");
      return;
    }
    router.push(`/tax-payments/${data.payment.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 text-sm">
      {error && <p className="rounded border border-erp-danger/40 bg-erp-danger/10 p-2 text-erp-danger">{error}</p>}

      <div>
        <label className="mb-1 block text-xs font-medium text-erp-muted">Tax</label>
        <select value={taxType} onChange={(e) => setTaxType(e.target.value)} className="erp-input">
          {types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-erp-muted">Period</label>
        {MONTHLY.includes(taxType) ? (
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="erp-input" required />
        ) : taxType === "PROVISIONAL_TAX" ? (
          <select value={quarter} onChange={(e) => setQuarter(e.target.value)} className="erp-input">
            {incomeTaxOptions.quarterly.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        ) : (
          <select value={annual} onChange={(e) => setAnnual(e.target.value)} className="erp-input">
            {incomeTaxOptions.annual.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        )}
      </div>

      {previewError && <p className="rounded border border-erp-danger/40 bg-erp-danger/10 p-2 text-erp-danger">{previewError}</p>}
      {preview && (
        <div className="space-y-1 rounded border border-erp-border bg-erp-subtle p-3 text-xs text-erp-muted">
          {!preview.periodEnded && <p className="font-medium text-erp-danger">{preview.periodLabel} hasn't ended yet – record this once the period is over.</p>}
          {preview.alreadyRecorded && <p className="font-medium text-erp-danger">{preview.alreadyRecorded.paymentNumber} is already recorded for this period.</p>}
          {!preview.vatApplicable && <p className="font-medium text-erp-danger">This business isn't VAT-registered.</p>}
          {preview.vat && (
            <p>
              Output VAT MWK {preview.vat.outputVat.toLocaleString()} − reclaimable erp-input VAT MWK {preview.vat.inputVat.toLocaleString()} = this period&apos;s own net MWK {Math.abs(preview.vat.netPayable).toLocaleString()} {preview.vat.netPayable >= 0 ? "payable" : "refundable"}
              {Math.abs(preview.vat.netPayable) <= 0.01 && " (nothing owed or due back for this period alone)"}.
              {!!preview.vat.irrecoverableInputVat && (
                <> MWK {preview.vat.irrecoverableInputVat.toLocaleString()} of this period&apos;s erp-input VAT isn&apos;t reclaimable (exempt sales) – write it off separately by manual journal entry.</>
              )}
            </p>
          )}
          {preview.vat?.carryForward && (
            <p className="text-erp-warning">
              Plus MWK {Math.abs(preview.vat.carryForward.amount).toLocaleString()} carried forward from{" "}
              {preview.vat.carryForward.fromPeriodKey === preview.vat.carryForward.toPeriodKey
                ? preview.vat.carryForward.fromPeriodKey
                : `${preview.vat.carryForward.fromPeriodKey} to ${preview.vat.carryForward.toPeriodKey}`}{" "}
              ({preview.vat.carryForward.amount >= 0 ? "still owed to the MRA" : "a credit owed to the business"}) – never recorded at the time, so this payment clears it too.
              {preview.vat.carryForward.truncated && " Only the most recent months of that gap are included; older unaddressed months need catching up by hand."}
            </p>
          )}
          {preview.vat && (
            <p>
              Combined net {isRefund ? "refundable" : "payable"}: MWK {Math.abs(preview.vat.adjustedNetPayable).toLocaleString()}.
            </p>
          )}
          {preview.canPayInInstallments && preview.installments.count > 0 && (
            <p className="text-erp-warning">
              MWK {preview.installments.paid.toLocaleString()} already paid for this period in {preview.installments.count} payment
              {preview.installments.count === 1 ? "" : "s"} ({preview.installments.payments.map((p: any) => p.paymentNumber).join(", ")}).
              {preview.installments.remaining > 0 ? ` MWK ${preview.installments.remaining.toLocaleString()} is still to pay.` : ""}
            </p>
          )}
          {preview.liabilityBalance !== null && <p>The books currently show MWK {preview.liabilityBalance.toLocaleString()} owed in total for this tax.</p>}
          {preview.provisionalAlreadyPaid !== null && preview.provisionalAlreadyPaid > 0 && (
            <p>Provisional tax already recorded for this year: MWK {preview.provisionalAlreadyPaid.toLocaleString()} (deducted from the suggestion).</p>
          )}
          <p>
            Working estimate for this period: MWK {preview.suggestedPrincipal.toLocaleString()}{isRefund ? " refundable" : ""}.
            {preview.isExample && " Based on example tax rates – review Tax Settings."} Use the amount on the MRA's receipt.
          </p>
          {isRefund && (
            <p className="text-erp-warning">
              This records the MRA actually paying the refund out. If the business is instead carrying this credit
              forward, don&apos;t record anything here – it will automatically net off whichever future VAT period is
              recorded next.
            </p>
          )}
        </div>
      )}

      {!isVat && (
        <div>
          <label className="mb-1 block text-xs font-medium text-erp-muted">Tax paid (MWK)</label>
          <input type="number" min="0.01" step="0.01" value={principal} onChange={(e) => setPrincipal(e.target.value)} className="erp-input" required />
        </div>
      )}
      {!isVat && preview?.canPayInInstallments && !preview.alreadyRecorded && (
        <label className="flex items-start gap-2 text-xs text-erp-muted">
          <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} className="mt-0.5" />
          <span>
            This is a part-payment - more will be paid for this period later. The period stays open on the Tax Calendar until the
            payments add up to what is owed (or you record a payment that isn&apos;t marked as a part-payment).
          </span>
        </label>
      )}
      {isVat && preview && (
        <p className="text-xs text-erp-muted">
          {isRefund
            ? `The refund amount is fixed to the period's net refundable amount (MWK ${preview.suggestedPrincipal.toLocaleString()}).`
            : `The VAT amount is fixed to the period's net payable (MWK ${preview.suggestedPrincipal.toLocaleString()}).`}
        </p>
      )}

      {!isRefund && (
        <div>
          <label className="mb-1 block text-xs font-medium text-erp-muted">Penalty / interest charged (MWK, 0 if none)</label>
          <input type="number" min="0" step="0.01" value={penalty} onChange={(e) => setPenalty(e.target.value)} className="erp-input" />
        </div>
      )}

      <div>
        <label className="mb-1 block text-xs font-medium text-erp-muted">{isRefund ? "Received into" : "Paid from"}</label>
        {cashAccounts.length === 0 ? (
          <p className="text-xs text-erp-danger">No active cash accounts found – set one up in Cashbook first.</p>
        ) : (
          <select value={cashAccountId} onChange={(e) => setCashAccountId(e.target.value)} className="erp-input">
            {cashAccounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name} ({a.type.replace("_", " ")}) – MWK {a.balance.toLocaleString()}</option>
            ))}
          </select>
        )}
        {!isRefund && account && total > account.balance && (
          <p className="mt-1 text-xs text-erp-danger">{account.name} only holds MWK {account.balance.toLocaleString()}.</p>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-erp-muted">{isRefund ? "Refund date" : "Payment date"}</label>
          <input type="date" value={paymentDate} max={todayYmd(timeZone)} onChange={(e) => setPaymentDate(e.target.value)} className="erp-input" required />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-erp-muted">MRA receipt / reference</label>
          <input value={reference} onChange={(e) => setReference(e.target.value)} className="erp-input" maxLength={100} />
        </div>
      </div>

      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="erp-input" rows={2} placeholder="Notes (optional)" />

      <p className="text-sm font-medium">{isRefund ? "Total received into the account" : "Total leaving the account"}: MWK {total.toLocaleString()}</p>

      <button type="submit" disabled={loading || blocked || !cashAccountId} className="rounded bg-erp-primary px-4 py-2 text-erp-primary-fg hover:opacity-90 disabled:opacity-60">
        {loading ? "Recording..." : isRefund ? "Record Refund" : "Record Payment"}
      </button>
    </form>
  );
}
