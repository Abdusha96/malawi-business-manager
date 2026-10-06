import { notFound } from "next/navigation";
import { getPublicInvoice } from "@/lib/invoice-payments";
import { PayClient } from "./pay-client";

// Module 74 – the PUBLIC page a customer opens from a pay link. No login. Shows only the business name,
// the invoice number and the amount due. Outside the auth middleware (which only guards /api/business).
export const dynamic = "force-dynamic";

export default async function PayPage(props: { params: Promise<{ token: string }> }) {
  const params = await props.params;
  const invoice = await getPublicInvoice(params.token);
  if (!invoice) notFound();
  return (
    <main className="mx-auto max-w-md p-6 sm:p-10">
      <p className="text-sm text-gray-500">{invoice.businessName}</p>
      <h1 className="mb-1 text-2xl font-bold">Invoice {invoice.saleNumber}</h1>
      <p className="mb-6 text-lg">Amount due: <strong>MWK {invoice.chargeMWK.toLocaleString()}</strong></p>
      {invoice.canPay ? <PayClient token={params.token} amount={invoice.chargeMWK} /> : <p className="rounded-md border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">{invoice.reason}</p>}
    </main>
  );
}
