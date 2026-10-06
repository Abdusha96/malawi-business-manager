/**
 * Module 74 – operator tool for gateway payments that need a person. Run by whoever runs the deployment,
 * never exposed to tenants (they don't hold the money, you do).
 *
 *   npm run gateway:payments                          list payments needing attention (read-only)
 *   npm run gateway:payments -- apply <txRef>         apply a paid-but-not-applied subscription payment
 *                                                     (after the business fixed whatever blocked it)
 *   npm run gateway:payments -- refund <txRef> <amount> "<how you paid it back>" --user <userId> [--apply]
 *                                                     record a refund you made from your PayChangu account
 *
 * `apply` and `refund` are dry runs unless --apply is given (nothing is written). Refunding does not move
 * money: PayChangu's hosted checkout has no refund call. Refund from your PayChangu account first,
 * then record it here so the books and the customer's Billing page agree.
 */
import { prisma } from "../src/lib/prisma";
import { applyPaidNotAppliedSubscription, listPaymentsNeedingAttention, recordRefund } from "../src/lib/gateway-payments";
import { validateRefund } from "../src/lib/payment-gateway";

export {};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const apply = rest.includes("--apply");
  const userIdx = rest.indexOf("--user");
  const userId = userIdx >= 0 ? rest[userIdx + 1] : undefined;
  const args = rest.filter((a, i) => a !== "--apply" && a !== "--user" && i !== userIdx + 1);

  if (!cmd || cmd === "list") {
    const items = await listPaymentsNeedingAttention();
    if (items.length === 0) console.log("Nothing needs attention.");
    for (const i of items) {
      console.log(`${i.kind.padEnd(12)} ${i.txRef}  business ${i.businessId}  ${i.reason}  paid MWK ${i.amount}${i.excess ? ` (+${i.excess} excess)` : ""}  ${i.detail}`);
    }
    return;
  }

  if (cmd === "apply") {
    const [txRef] = args;
    if (!txRef) throw new Error("usage: apply <txRef> [--apply]");
    if (!apply) {
      const p = await prisma.gatewayPayment.findUnique({ where: { txRef } });
      console.log(p ? `DRY RUN: would try to apply ${p.planKey}/${p.billingCycle} for business ${p.businessId}. Re-run with --apply.` : "No payment with that reference.");
      return;
    }
    const r = await applyPaidNotAppliedSubscription(txRef);
    console.log(r.ok ? "Applied." : `Not applied: ${r.reason}`);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  if (cmd === "refund") {
    const [txRef, amountText, ...noteParts] = args;
    const amount = Number(amountText);
    const note = noteParts.join(" ");
    if (!txRef || !Number.isFinite(amount) || !note || !userId) throw new Error('usage: refund <txRef> <amount> "<note>" --user <userId> [--apply]');
    if (!apply) {
      const p = (await prisma.gatewayPayment.findUnique({ where: { txRef } })) ?? (await prisma.invoicePayment.findUnique({ where: { txRef } }));
      if (!p) { console.log("No payment with that reference."); return; }
      const c = validateRefund({ status: p.status, amount: Number(p.amount), excessAmount: Number(p.excessAmount), refundedAmount: Number(p.refundedAmount) }, amount);
      console.log(c.ok ? `DRY RUN: would record a refund of MWK ${amount}; MWK ${c.remainingAfter} would remain refundable. Re-run with --apply.` : `Would be refused: ${c.reason}`);
      return;
    }
    const r = await recordRefund({ txRef, amount, note, userId });
    console.log(r.ok ? `Recorded. MWK ${r.remaining} remains refundable.` : `Not recorded: ${r.reason}`);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  throw new Error(`unknown command "${cmd}" (list | apply | refund)`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
