import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { categorySchema } from "@/lib/validation";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "inventory.view");
  if (ctx instanceof NextResponse) return ctx;

  const categories = await prisma.category.findMany({
    where: { businessId: params.businessId },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({ categories });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "inventory.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = categorySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  const existing = await prisma.category.findUnique({
    where: { businessId_name: { businessId: params.businessId, name: parsed.data.name } },
  });
  if (existing) {
    return NextResponse.json({ error: "duplicate", message: "A category with this name already exists." }, { status: 409 });
  }

  const category = await prisma.category.create({
    data: { businessId: params.businessId, name: parsed.data.name },
  });

  return NextResponse.json({ category }, { status: 201 });
}
