import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { allowRequest, clientKey } from "@/lib/rate-limit";
import { InvoicePaymentError, getPublicInvoice, startInvoiceCheckout } from "@/lib/invoice-payments";

// Module 74 – PUBLIC. No session: the unguessable token in the path is the only credential and it only
// ever opens one invoice. Outside src/proxy.ts's matcher on purpose. POST is rate limited per
// client and token so a script can't turn this page into a stream of gateway calls.
const startSchema = z.object({ email: z.string().max(200).optional().nullable(), name: z.string().max(100).optional().nullable() });

export async function GET(_req: NextRequest, props: { params: Promise<{ token: string }> }) {
  const params = await props.params;
  const invoice = await getPublicInvoice(params.token);
  if (!invoice) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(invoice);
}

export async function POST(req: NextRequest, props: { params: Promise<{ token: string }> }) {
  const params = await props.params;
  if (!allowRequest(clientKey(req.headers.get("x-forwarded-for"), params.token), 10, 60_000)) {
    return NextResponse.json({ error: "rate_limited", message: "Too many attempts. Please wait a minute." }, { status: 429 });
  }
  const parsed = startSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "validation_error" }, { status: 400 });
  try {
    const r = await startInvoiceCheckout({ token: params.token, email: parsed.data.email, name: parsed.data.name });
    return NextResponse.json({ checkoutUrl: r.checkoutUrl, txRef: r.txRef });
  } catch (err) {
    if (err instanceof InvoicePaymentError) return NextResponse.json({ error: "pay_error", message: err.message }, { status: err.status });
    throw err;
  }
}
