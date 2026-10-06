import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { allowRequest, clientKey } from "@/lib/rate-limit";
import { isValidInvoiceTxRef, isValidPayToken } from "@/lib/payment-gateway";
import { publicInvoiceMessage, settleInvoicePayment } from "@/lib/invoice-payments";

// Module 74 – PUBLIC "did my payment go through?" for the page the customer lands on after the gateway.
// The payment must belong to the invoice this token opens (a token never reaches another invoice's
// payments); the answer is the same idempotent settle the webhook runs and uses wording safe to show
// to the payer. Rate limited.
export async function POST(
  req: NextRequest,
  props: { params: Promise<{ token: string; txRef: string }> }
) {
  const params = await props.params;
  if (!isValidPayToken(params.token) || !isValidInvoiceTxRef(params.txRef)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!allowRequest(clientKey(req.headers.get("x-forwarded-for"), `check:${params.token}`), 30, 60_000)) {
    return NextResponse.json({ error: "rate_limited", message: "Too many checks. Please wait a minute." }, { status: 429 });
  }
  const link = await prisma.salePayLink.findUnique({ where: { token: params.token } });
  const payment = link ? await prisma.invoicePayment.findUnique({ where: { txRef: params.txRef } }) : null;
  if (!link || !payment || payment.saleId !== link.saleId) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const result = await settleInvoicePayment({ txRef: params.txRef, businessId: link.businessId });
  const done = result.outcome === "APPLIED" || result.outcome === "PAID_NOT_APPLIED" || result.outcome === "FAILED" || result.outcome === "ALREADY_SETTLED";
  return NextResponse.json({ outcome: result.outcome, done, message: publicInvoiceMessage(result) });
}
