import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { requirePermission, TenantAccessError } from "@/lib/tenant";
import { redeemCreditSchema } from "@/lib/validation";
import { redeemCustomerCredit, redeemSupplierCredit, CreditError } from "@/lib/credits";

/**
 * Manual counterpart to the automatic sweep in createSale()/createPurchase()
 * (see src/lib/credits.ts) – an operator explicitly spending a customer's or
 * supplier's standing credit against their open balance, e.g. from the
 * profile page's "Apply Credit" button. Gated the same way as
 * src/app/api/business/[businessId]/payments/route.ts: customer-side is
 * payments.record, supplier-side is the stricter suppliers.manage (Cashier
 * doesn't get to move money on the supplier side).
 */
export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "payments.record");
  if (ctx instanceof NextResponse) return ctx;
  const { userId, membership } = ctx;

  const parsed = redeemCreditSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  if (data.supplierId) {
    try {
      await requirePermission(membership, "suppliers.manage");
    } catch (err) {
      if (err instanceof TenantAccessError) {
        return NextResponse.json({ error: "forbidden", message: err.message }, { status: err.status });
      }
      throw err;
    }
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      if (data.supplierId) {
        const supplier = await tx.supplier.findUnique({ where: { id: data.supplierId! } });
        if (!supplier || supplier.businessId !== params.businessId) {
          throw new Error("not_found:Supplier not found in this business.");
        }
        return redeemSupplierCredit({
          tx,
          businessId: params.businessId,
          supplierId: data.supplierId!,
          amount: data.amount,
          createdById: userId,
        });
      }

      const customer = await tx.customer.findUnique({ where: { id: data.customerId! } });
      if (!customer || customer.businessId !== params.businessId) {
        throw new Error("not_found:Customer not found in this business.");
      }
      return redeemCustomerCredit({
        tx,
        businessId: params.businessId,
        customerId: data.customerId!,
        amount: data.amount,
        createdById: userId,
      });
    });

    if (result.totalApplied <= 0) {
      return NextResponse.json(
        { error: "nothing_to_apply", message: "No standing credit is available to apply right now." },
        { status: 400 }
      );
    }

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof CreditError) {
      return NextResponse.json({ error: "credit_error", message: err.message }, { status: 400 });
    }
    if (err instanceof Error && err.message.startsWith("not_found:")) {
      return NextResponse.json({ error: "not_found", message: err.message.split(":")[1] }, { status: 404 });
    }
    throw err;
  }
}
