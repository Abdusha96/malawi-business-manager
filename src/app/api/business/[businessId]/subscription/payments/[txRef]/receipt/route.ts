import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { isValidTxRef, receiptNumberFor } from "@/lib/payment-gateway";
import { readPlatformSeller, renderSubscriptionReceiptPdf } from "@/lib/subscription-receipt";
import { getBusinessTimeZone } from "@/lib/business-timezone";
import { readGatewayConfig } from "@/lib/payment-gateway";

// Module 74 – PDF receipt for a CONFIRMED subscription payment. Same permission as the Billing
// page; a payment of another business, or one the gateway never confirmed, is a 404.
export async function GET(
  _req: NextRequest,
  props: { params: Promise<{ businessId: string; txRef: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "business.subscription.manage");
  if (ctx instanceof NextResponse) return ctx;
  if (!isValidTxRef(params.txRef)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const payment = await prisma.gatewayPayment.findUnique({ where: { txRef: params.txRef } });
  if (!payment || payment.businessId !== params.businessId || payment.status !== "SUCCEEDED") {
    return NextResponse.json({ error: "not_found", message: "No confirmed payment with that reference." }, { status: 404 });
  }

  const [business, payer, timeZone] = await Promise.all([
    prisma.business.findUnique({ where: { id: params.businessId }, select: { name: true } }),
    prisma.user.findUnique({ where: { id: payment.initiatedById }, select: { name: true, email: true, phone: true } }),
    getBusinessTimeZone(params.businessId),
  ]);

  const pdf = await renderSubscriptionReceiptPdf({
    data: {
      txRef: payment.txRef,
      businessName: business?.name ?? "Business",
      planKey: payment.planKey,
      billingCycle: payment.billingCycle,
      amount: Number(payment.amount),
      prorationCredit: Number(payment.prorationCredit),
      paidAt: payment.completedAt ?? payment.createdAt,
      applied: !!payment.appliedAt,
      applyError: payment.applyError,
      appUrl: readGatewayConfig(process.env).appUrl,
    },
    seller: readPlatformSeller(process.env),
    timeZone,
    payer: { name: payer?.name ?? "Customer", email: payer?.email ?? null, phone: payer?.phone ?? null },
    channel: payment.channel,
    refundedAmount: Number(payment.refundedAmount),
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${receiptNumberFor(payment.txRef)}.pdf"`,
    },
  });
}
