import { redirect } from "next/navigation";
import { isValidTxRef } from "@/lib/payment-gateway";

// Module 74 – where PayChangu sends the customer's BROWSER after paying (`callback_url`) or after
// cancelling/failing (`return_url`). It appends `tx_ref` and `status` as a query string itself, so the
// reference travels in this page's PATH. Module 73 pointed `callback_url` at the POST-only webhook, so
// a customer who paid landed on a 405 error page. This page does no checking itself: it hands over to
// Billing, which asks the server to verify the payment with the gateway.
export default async function BillingReturnPage(props: { params: Promise<{ txRef: string }> }) {
  const params = await props.params;
  if (!isValidTxRef(params.txRef)) redirect("/settings/billing");
  redirect(`/settings/billing?tx_ref=${encodeURIComponent(params.txRef)}`);
}
