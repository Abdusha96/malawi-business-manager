import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { preparePhoneForSave } from "@/lib/phone";
import { supplierUpdateSchema } from "@/lib/validation";
import { getSupplierSummary } from "@/lib/suppliers";
import { logAudit } from "@/lib/audit";

async function loadOwnedSupplier(businessId: string, supplierId: string) {
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier || supplier.businessId !== businessId) return null;
  return supplier;
}

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; supplierId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "suppliers.view");
  if (ctx instanceof NextResponse) return ctx;

  const supplier = await loadOwnedSupplier(params.businessId, params.supplierId);
  if (!supplier) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const [summary, purchases, payments] = await Promise.all([
    getSupplierSummary(params.businessId, params.supplierId),
    prisma.purchase.findMany({
      where: { businessId: params.businessId, supplierId: params.supplierId },
      orderBy: { purchaseDate: "desc" },
      take: 50,
    }),
    prisma.payment.findMany({
      where: { businessId: params.businessId, supplierId: params.supplierId },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  return NextResponse.json({ supplier, summary, purchases, payments });
}

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; supplierId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "suppliers.manage");
  if (ctx instanceof NextResponse) return ctx;

  const existing = await loadOwnedSupplier(params.businessId, params.supplierId);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = supplierUpdateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  const phone = data.phone !== undefined ? preparePhoneForSave(data.phone, existing.phone) : null;
  if (phone && !phone.ok) {
    return NextResponse.json({ error: "invalid_phone", message: phone.reason }, { status: 400 });
  }

  const supplier = await prisma.$transaction(async (tx) => {
    const updated = await tx.supplier.update({
      where: { id: params.supplierId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(phone && phone.ok ? { phone: phone.value } : {}),
        ...(data.email !== undefined ? { email: data.email || null } : {}),
        ...(data.address !== undefined ? { address: data.address } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });
    const activeChanged = data.isActive !== undefined && data.isActive !== existing.isActive;
    await logAudit({
      tx,
      businessId: params.businessId,
      userId: ctx.userId,
      action: activeChanged ? (data.isActive ? "supplier.activate" : "supplier.deactivate") : "supplier.update",
      entityType: "Supplier",
      entityId: updated.id,
      metadata: { changedFields: Object.keys(data) },
    });
    return updated;
  });

  return NextResponse.json({ supplier });
}
