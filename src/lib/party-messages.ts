/**
 * Module 72: the wording of the two SMS notices sent to a business's suppliers
 * and employees. Pure and import-free so a plain-Node script can verify the text
 * (same split as phone.ts / sms-delivery.ts).
 *
 * Both are sent ONLY when a person with the right permission presses a button on
 * the record; nothing in the app texts a supplier or an employee on its own.
 */

function mwk(n: number): string {
  return `MWK ${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** "Hello Shoprite Ltd, Mzuzu Traders has paid you MWK 50,000 by MOBILE MONEY on 30 Sep 2026 (ref MM123). MWK 20,000 is still owed to you." */
export function buildSupplierPaymentMessage(params: {
  supplierName: string;
  businessName: string;
  amount: number;
  method: string; // e.g. "MOBILE_MONEY"
  dateText: string; // already formatted in the business's time zone
  reference?: string | null;
  balanceOwed: number;
}): string {
  const method = params.method.replace(/_/g, " ").toLowerCase();
  const ref = params.reference && params.reference.trim() !== "" ? ` (ref ${params.reference.trim()})` : "";
  const balance =
    params.balanceOwed > 0
      ? `${mwk(params.balanceOwed)} is still owed to you.`
      : "Nothing further is owed to you.";
  return (
    `Hello ${params.supplierName}, ${params.businessName} has paid you ${mwk(params.amount)} ` +
    `by ${method} on ${params.dateText}${ref}. ${balance}`
  );
}

/** "Hello Grace Banda, your pay for 2026-09 from Mzuzu Traders has been paid by mobile money: net MWK 180,000." */
export function buildEmployeePayMessage(params: {
  employeeName: string;
  businessName: string;
  payPeriod: string; // "YYYY-MM"
  netSalary: number;
  method?: string | null;
}): string {
  const via = params.method ? ` by ${params.method.replace(/_/g, " ").toLowerCase()}` : "";
  return (
    `Hello ${params.employeeName}, your pay for ${params.payPeriod} from ${params.businessName} ` +
    `has been paid${via}: net ${mwk(params.netSalary)}.`
  );
}
