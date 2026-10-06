import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { preparePhoneForSave } from "@/lib/phone";
import { supplierSchema } from "@/lib/validation";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "suppliers.view");
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search");

  const [suppliers, purchasesBySupplier] = await Promise.all([
    prisma.supplier.findMany({
      where: {
        businessId: params.businessId,
        isActive: true,
        ...(search
          ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { phone: { contains: search } }] }
          : {}),
      },
      orderBy: { name: "asc" },
    }),
    prisma.purchase.groupBy({
      by: ["supplierId"],
      where: { businessId: params.businessId, status: { not: "VOIDED" } },
      _sum: { total: true, balance: true },
    }),
  ]);

  const summaryBySupplierId = new Map(
    purchasesBySupplier.map((p) => [
      p.supplierId,
      { totalPurchases: Number(p._sum.total ?? 0), outstandingBalance: Number(p._sum.balance ?? 0) },
    ])
  );

  return NextResponse.json({
    suppliers: suppliers.map((s) => ({
      ...s,
      totalPurchases: summaryBySupplierId.get(s.id)?.totalPurchases ?? 0,
      outstandingBalance: summaryBySupplierId.get(s.id)?.outstandingBalance ?? 0,
    })),
  });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "suppliers.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = supplierSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  const phone = preparePhoneForSave(parsed.data.phone);
  if (!phone.ok) {
    return NextResponse.json({ error: "invalid_phone", message: phone.reason }, { status: 400 });
  }

  const supplier = await prisma.supplier.create({
    data: {
      businessId: params.businessId,
      name: parsed.data.name,
      phone: phone.value ?? undefined,
      email: parsed.data.email || undefined,
      address: parsed.data.address || undefined,
    },
  });

  return NextResponse.json({ supplier }, { status: 201 });
}
