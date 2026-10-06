import { notFound } from "next/navigation";
import { isValidInvoiceTxRef, isValidPayToken } from "@/lib/payment-gateway";
import { ReturnClient } from "./return-client";

// Module 74 – where the gateway sends the customer's browser afterwards (success or cancel). The
// reference is in the PATH because PayChangu appends its own query string. It does no checking here:
// the client asks the server, which asks the gateway.
export const dynamic = "force-dynamic";

export default async function PayReturnPage(props: { params: Promise<{ token: string; txRef: string }> }) {
  const params = await props.params;
  if (!isValidPayToken(params.token) || !isValidInvoiceTxRef(params.txRef)) notFound();
  return (
    <main className="mx-auto max-w-md p-6 sm:p-10">
      <h1 className="mb-4 text-2xl font-bold">Payment</h1>
      <ReturnClient token={params.token} txRef={params.txRef} />
    </main>
  );
}
