import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { getSupplierSummary } from "@/lib/suppliers";
import { logAudit } from "@/lib/audit";
import { sendSms, TEMPLATE_KEYS } from "@/lib/notifications";
import { PHONE_CHECK_PROVIDER } from "@/lib/phone";
import { buildSupplierPaymentMessage } from "@/lib/party-messages";
import { formatDateIn, resolveTimeZone } from "@/lib/timezone";

const bodySchema = z.object({ paymentId: z.string().min(1) });

/**
 * Module 72: text a supplier to say a payment to them was made. Manual only –
 * nothing calls this except the "Text supplier" button beside a payment on the
 * supplier page. Same permission as recording the payment itself.
 */
export async function POST(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; supplierId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "suppliers.manage");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  const [supplier, business, payment] = await Promise.all([
    prisma.supplier.findUnique({ where: { id: params.supplierId } }),
    prisma.business.findUnique({ where: { id: params.businessId } }),
    prisma.payment.findUnique({ where: { id: parsed.data.paymentId } }),
  ]);

  if (!supplier || supplier.businessId !== params.businessId || !business) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // The payment must be one this business made to THIS supplier; an id from
  // another supplier or another business is a 404, not a leak.
  if (!payment || payment.businessId !== params.businessId || payment.supplierId !== supplier.id) {
    return NextResponse.json({ error: "not_found", message: "That payment was not found for this supplier." }, { status: 404 });
  }

  if (!supplier.phone) {
    return NextResponse.json({
      message: null,
      sentTo: null,
      note: "This supplier has no phone number on file – the notice was not sendable.",
    });
  }

  const summary = await getSupplierSummary(params.businessId, supplier.id);
  const tz = resolveTimeZone(business.timezone);
  const message = buildSupplierPaymentMessage({
    supplierName: supplier.name,
    businessName: business.name,
    amount: Number(payment.amount),
    method: payment.method,
    dateText: formatDateIn(payment.createdAt, tz),
    reference: payment.reference,
    balanceOwed: summary.outstandingBalance,
  });

  const result = await sendSms({
    businessId: params.businessId,
    to: supplier.phone,
    body: message,
    templateKey: TEMPLATE_KEYS.SUPPLIER_PAYMENT_NOTICE,
    relatedEntityType: "Supplier",
    relatedEntityId: supplier.id,
  });

  const note =
    result.providerName === PHONE_CHECK_PROVIDER
      ? `Notice not sent: ${result.errorMessage} Fix the number on the supplier record.`
      : result.status === "SENT"
        ? result.errorMessage
          ? "Notice handed to the SMS provider, but delivery could not be confirmed – see Notifications."
          : "Notice sent."
        : result.status === "FAILED"
          ? "Notice logged, but the SMS was not delivered – see Notifications for the reason."
          : "Notice logged (no SMS provider configured yet – see Notifications).";

  await logAudit({
    businessId: params.businessId,
    userId,
    action: "supplier.payment_notice_sent",
    entityType: "Supplier",
    entityId: supplier.id,
    metadata: { paymentId: payment.id, message },
  });

  return NextResponse.json({ message, sentTo: result.dialedTo, note });
}
