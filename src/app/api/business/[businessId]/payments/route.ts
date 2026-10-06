import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { requirePermission, TenantAccessError } from "@/lib/tenant";
import { recordPaymentSchema } from "@/lib/validation";
import { applyCustomerPayment } from "@/lib/customers";
import { applySupplierPayment } from "@/lib/suppliers";
import { CashAccountSelectionError, postCashTransactionForPayment } from "@/lib/cashbook";
import { postJournalEntryForPayment } from "@/lib/accounting-integrations";

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "payments.record");
  if (ctx instanceof NextResponse) return ctx;
  const { userId, membership } = ctx;

  const parsed = recordPaymentSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  const isSupplierSide = !!data.purchaseId || !!data.supplierId;
  const isCustomerSide = !!data.saleId || !!data.customerId;

  if (!isSupplierSide && !isCustomerSide) {
    return NextResponse.json(
      { error: "validation_error", message: "A payment must be linked to a sale/customer or a purchase/supplier." },
      { status: 400 }
    );
  }

  // A payment we receive (customer side) uses payments.record. A payment we
  // make (supplier side) is a different trust level – gated on
  // suppliers.manage, which Cashier does not have, matching spec section 1
  // (Cashier only records sales and customer payments).
  if (isSupplierSide) {
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
      if (isSupplierSide) {
        if (data.purchaseId) {
          const purchase = await tx.purchase.findUnique({ where: { id: data.purchaseId } });
          if (!purchase || purchase.businessId !== params.businessId) {
            throw new Error("not_found:Purchase not found in this business.");
          }
          if (purchase.status === "VOIDED") {
            throw new Error("void:Cannot record a payment against a voided purchase.");
          }

          const newAmountPaid = Number(purchase.amountPaid) + data.amount;
          const newBalance = Number(purchase.total) - newAmountPaid;

          if (newBalance < -0.01) {
            throw new Error(
              `overpayment:Payment of ${data.amount} exceeds the outstanding balance of ${Number(purchase.balance)}.`
            );
          }

          await tx.purchase.update({
            where: { id: purchase.id },
            data: {
              amountPaid: newAmountPaid,
              balance: Math.max(0, newBalance),
              status: newBalance <= 0.01 ? "PAID" : "PARTIAL",
            },
          });

          const purchasePayment = await tx.payment.create({
            data: {
              businessId: params.businessId,
              purchaseId: purchase.id,
              supplierId: data.supplierId ?? purchase.supplierId ?? undefined,
              amount: data.amount,
              method: data.method,
              reference: data.reference ?? undefined,
              notes: data.notes ?? undefined,
              recordedById: userId,
            },
          });
          await postCashTransactionForPayment({
            tx,
            businessId: params.businessId,
            paymentId: purchasePayment.id,
            createdById: userId,
          });
          await postJournalEntryForPayment({
            tx,
            businessId: params.businessId,
            paymentId: purchasePayment.id,
            amount: data.amount,
            method: data.method,
            isCustomerSide: false,
            createdById: userId,
          });
          return [purchasePayment];
        }

        const supplier = await tx.supplier.findUnique({ where: { id: data.supplierId! } });
        if (!supplier || supplier.businessId !== params.businessId) {
          throw new Error("not_found:Supplier not found in this business.");
        }

        return applySupplierPayment({
          tx,
          businessId: params.businessId,
          supplierId: data.supplierId!,
          amount: data.amount,
          method: data.method,
          reference: data.reference,
          notes: data.notes,
          recordedById: userId,
        });
      }

      // Customer side (existing behavior)
      if (data.saleId) {
        const sale = await tx.sale.findUnique({ where: { id: data.saleId } });
        if (!sale || sale.businessId !== params.businessId) {
          throw new Error("not_found:Sale not found in this business.");
        }
        if (sale.status === "VOIDED") {
          throw new Error("void:Cannot record a payment against a voided sale.");
        }

        const newAmountPaid = Number(sale.amountPaid) + data.amount;
        const newBalance = Number(sale.total) - newAmountPaid;

        if (newBalance < -0.01) {
          throw new Error(
            `overpayment:Payment of ${data.amount} exceeds the outstanding balance of ${Number(sale.balance)}.`
          );
        }

        await tx.sale.update({
          where: { id: sale.id },
          data: {
            amountPaid: newAmountPaid,
            balance: Math.max(0, newBalance),
            status: newBalance <= 0.01 ? "PAID" : "PARTIAL",
          },
        });

        const salePayment = await tx.payment.create({
          data: {
            businessId: params.businessId,
            saleId: sale.id,
            customerId: data.customerId ?? sale.customerId ?? undefined,
            amount: data.amount,
            method: data.method,
            reference: data.reference ?? undefined,
            notes: data.notes ?? undefined,
            recordedById: userId,
          },
        });
        await postCashTransactionForPayment({
          tx,
          businessId: params.businessId,
          paymentId: salePayment.id,
          createdById: userId,
          cashAccountId: data.cashAccountId,
        });
        await postJournalEntryForPayment({
          tx,
          businessId: params.businessId,
          paymentId: salePayment.id,
          amount: data.amount,
          method: data.method,
          isCustomerSide: true,
          createdById: userId,
        });
        return [salePayment];
      }

      const customer = await tx.customer.findUnique({ where: { id: data.customerId! } });
      if (!customer || customer.businessId !== params.businessId) {
        throw new Error("not_found:Customer not found in this business.");
      }

      return applyCustomerPayment({
        tx,
        businessId: params.businessId,
        customerId: data.customerId!,
        amount: data.amount,
        method: data.method,
        cashAccountId: data.cashAccountId,
        reference: data.reference,
        notes: data.notes,
        recordedById: userId,
      });
    });

    return NextResponse.json({ payments: result }, { status: 201 });
  } catch (err) {
    if (err instanceof CashAccountSelectionError) {
      return NextResponse.json({ error: "invalid_cash_account", message: err.message }, { status: 400 });
    }
    if (err instanceof Error) {
      const [code, message] = err.message.split(":");
      if (["not_found", "void", "overpayment"].includes(code)) {
        return NextResponse.json(
          { error: code, message: message ?? "Could not record payment." },
          { status: code === "not_found" ? 404 : 400 }
        );
      }
    }
    throw err;
  }
}
