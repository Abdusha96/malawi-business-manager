import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { preparePhoneForSave } from "@/lib/phone";
import { customerSchema } from "@/lib/validation";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "customers.view");
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search");

  const [customers, salesByCustomer] = await Promise.all([
    prisma.customer.findMany({
      where: {
        businessId: params.businessId,
        isActive: true,
        ...(search
          ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { phone: { contains: search } }] }
          : {}),
      },
      orderBy: { name: "asc" },
    }),
    // One grouped query for all customers, instead of N summary queries –
    // matters once a business has more than a handful of customers.
    prisma.sale.groupBy({
      by: ["customerId"],
      where: { businessId: params.businessId, customerId: { not: null }, status: { not: "VOIDED" } },
      _sum: { total: true, balance: true },
    }),
  ]);

  const summaryByCustomerId = new Map(
    salesByCustomer.map((s) => [
      s.customerId as string,
      { totalPurchases: Number(s._sum.total ?? 0), outstandingBalance: Number(s._sum.balance ?? 0) },
    ])
  );

  return NextResponse.json({
    customers: customers.map((c) => ({
      ...c,
      totalPurchases: summaryByCustomerId.get(c.id)?.totalPurchases ?? 0,
      outstandingBalance: summaryByCustomerId.get(c.id)?.outstandingBalance ?? 0,
    })),
  });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "customers.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = customerSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  const phone = preparePhoneForSave(parsed.data.phone);
  if (!phone.ok) {
    return NextResponse.json({ error: "invalid_phone", message: phone.reason }, { status: 400 });
  }

  const customer = await prisma.customer.create({
    data: {
      businessId: params.businessId,
      name: parsed.data.name,
      customerType: parsed.data.customerType,
      phone: phone.value ?? undefined,
      email: parsed.data.email || undefined,
      address: parsed.data.address || undefined,
      creditLimit: parsed.data.creditLimit,
    },
  });

  return NextResponse.json({ customer }, { status: 201 });
}
