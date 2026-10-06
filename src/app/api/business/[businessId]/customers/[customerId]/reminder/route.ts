import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { getCustomerSummary, buildReminderMessage } from "@/lib/customers";
import { logAudit } from "@/lib/audit";
import { sendSms, TEMPLATE_KEYS } from "@/lib/notifications";
import { PHONE_CHECK_PROVIDER } from "@/lib/phone";

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; customerId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "customers.manage");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const [customer, business, summary] = await Promise.all([
    prisma.customer.findUnique({ where: { id: params.customerId } }),
    prisma.business.findUnique({ where: { id: params.businessId } }),
    getCustomerSummary(params.businessId, params.customerId),
  ]);

  if (!customer || customer.businessId !== params.businessId || !business) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (summary.outstandingBalance <= 0) {
    return NextResponse.json(
      { error: "no_balance", message: "This customer has no outstanding balance." },
      { status: 400 }
    );
  }

  const message = buildReminderMessage({
    customerName: customer.name,
    businessName: business.name,
    outstandingBalance: summary.outstandingBalance,
  });

  let deliveryNote: string;
  let sentTo: string | null = customer.phone;
  if (customer.phone) {
    const result = await sendSms({
      businessId: params.businessId,
      to: customer.phone,
      body: message,
      templateKey: TEMPLATE_KEYS.CUSTOMER_DEBT_REMINDER,
      relatedEntityType: "Customer",
      relatedEntityId: customer.id,
    });
    sentTo = result.dialedTo;
    deliveryNote =
      result.providerName === PHONE_CHECK_PROVIDER
        ? `Reminder not sent: ${result.errorMessage} Fix the number on the customer record.`
        : result.status === "SENT"
        ? result.errorMessage
          ? "Reminder handed to the SMS provider, but delivery could not be confirmed – see Notifications."
          : "Reminder sent."
        : result.status === "FAILED"
          ? "Reminder logged, but the SMS was not delivered – see Notifications for the reason."
          : "Reminder logged (no SMS provider configured yet – see Notifications).";
  } else {
    deliveryNote = "This customer has no phone number on file – reminder was not sendable.";
  }

  await logAudit({
    businessId: params.businessId,
    userId,
    action: "customer.reminder_sent",
    entityType: "Customer",
    entityId: customer.id,
    metadata: { message, outstandingBalance: summary.outstandingBalance },
  });

  return NextResponse.json({
    message,
    sentTo,
    note: deliveryNote,
  });
}
