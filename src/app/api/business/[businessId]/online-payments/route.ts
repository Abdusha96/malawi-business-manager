import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireApiContext } from "@/lib/api-context";
import { InvoicePaymentError, getOnlinePaymentsStatus, removeOnlinePaymentsConfig, saveOnlinePaymentsConfig } from "@/lib/invoice-payments";

// Module 74 – the business's own PayChangu credentials. Owner-level (business.settings.manage): these
// keys decide where customers' money goes. GET never returns a secret, only whether one is saved and its
// last four characters; PUT replaces both secrets; DELETE removes them (existing pay links stop working).
const saveSchema = z.object({
  secretKey: z.string().min(8).max(200),
  webhookSecret: z.string().max(200).optional().nullable(),
});

export async function GET(_req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "business.settings.manage");
  if (ctx instanceof NextResponse) return ctx;
  return NextResponse.json(await getOnlinePaymentsStatus(params.businessId));
}

export async function PUT(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "business.settings.manage");
  if (ctx instanceof NextResponse) return ctx;
  const parsed = saveSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  try {
    await saveOnlinePaymentsConfig({ businessId: params.businessId, userId: ctx.userId, ...parsed.data });
    return NextResponse.json(await getOnlinePaymentsStatus(params.businessId));
  } catch (err) {
    if (err instanceof InvoicePaymentError) return NextResponse.json({ error: "online_payments_error", message: err.message }, { status: err.status });
    throw err;
  }
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "business.settings.manage");
  if (ctx instanceof NextResponse) return ctx;
  await removeOnlinePaymentsConfig({ businessId: params.businessId, userId: ctx.userId });
  return NextResponse.json(await getOnlinePaymentsStatus(params.businessId));
}
