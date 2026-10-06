import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { preparePhoneForSave } from "@/lib/phone";
import { customerUpdateSchema } from "@/lib/validation";
import { getCustomerSummary } from "@/lib/customers";
import { logAudit } from "@/lib/audit";

async function loadOwnedCustomer(businessId: string, customerId: string) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer || customer.businessId !== businessId) return null;
  return customer;
}

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; customerId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "customers.view");
  if (ctx instanceof NextResponse) return ctx;

  const customer = await loadOwnedCustomer(params.businessId, params.customerId);
  if (!customer) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const [summary, sales, payments] = await Promise.all([
    getCustomerSummary(params.businessId, params.customerId),
    prisma.sale.findMany({
      where: { businessId: params.businessId, customerId: params.customerId },
      orderBy: { saleDate: "desc" },
      take: 50,
    }),
    prisma.payment.findMany({
      where: { businessId: params.businessId, customerId: params.customerId },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  return NextResponse.json({ customer, summary, sales, payments });
}

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; customerId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "customers.manage");
  if (ctx instanceof NextResponse) return ctx;

  const existing = await loadOwnedCustomer(params.businessId, params.customerId);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = customerUpdateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  const phone = data.phone !== undefined ? preparePhoneForSave(data.phone, existing.phone) : null;
  if (phone && !phone.ok) {
    return NextResponse.json({ error: "invalid_phone", message: phone.reason }, { status: 400 });
  }

  const customer = await prisma.$transaction(async (tx) => {
    const updated = await tx.customer.update({
      where: { id: params.customerId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.customerType !== undefined ? { customerType: data.customerType } : {}),
        ...(phone && phone.ok ? { phone: phone.value } : {}),
        ...(data.email !== undefined ? { email: data.email || null } : {}),
        ...(data.address !== undefined ? { address: data.address } : {}),
        ...(data.creditLimit !== undefined ? { creditLimit: data.creditLimit } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });
    const activeChanged = data.isActive !== undefined && data.isActive !== existing.isActive;
    await logAudit({
      tx,
      businessId: params.businessId,
      userId: ctx.userId,
      action: activeChanged ? (data.isActive ? "customer.activate" : "customer.deactivate") : "customer.update",
      entityType: "Customer",
      entityId: updated.id,
      metadata: { changedFields: Object.keys(data) },
    });
    return updated;
  });

  return NextResponse.json({ customer });
}
