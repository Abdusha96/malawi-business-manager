import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { resolveBranchScope, TenantAccessError } from "@/lib/tenant";
import { productSchema } from "@/lib/validation";
import { recordInventoryMovement } from "@/lib/inventory";
import { validateProductKind } from "@/lib/product-kind";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "inventory.view");
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);
  const filter = searchParams.get("filter"); // "low_stock" | "out_of_stock" | null
  const search = searchParams.get("search");
  const categoryId = searchParams.get("categoryId");

  const products = await prisma.product.findMany({
    where: {
      businessId: params.businessId,
      isActive: true,
      ...(categoryId ? { categoryId } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { sku: { contains: search, mode: "insensitive" } },
              { barcode: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    include: { category: true },
    orderBy: { name: "asc" },
  });

  // low_stock/out_of_stock compare two columns on the same row, which isn't
  // portable as a Prisma `where` filter – see src/lib/inventory.ts for the
  // same tradeoff. Fine at SME catalog sizes.
  // Module 77: a service has no stock, so neither stock filter ever returns one.
  const filtered =
    filter === "low_stock"
      ? products.filter((p) => p.isStocked && Number(p.quantity) <= Number(p.reorderLevel))
      : filter === "out_of_stock"
      ? products.filter((p) => p.isStocked && Number(p.quantity) <= 0)
      : products;

  return NextResponse.json({ products: filtered });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "inventory.manage");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const parsed = productSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  const kindProblem = validateProductKind({
    isStocked: data.isStocked,
    openingQuantity: data.openingQuantity,
    reorderLevel: data.reorderLevel,
    expiryDate: data.expiryDate,
  });
  if (kindProblem) {
    return NextResponse.json({ error: "invalid_product_kind", message: kindProblem }, { status: 400 });
  }

  if (data.categoryId) {
    const category = await prisma.category.findUnique({ where: { id: data.categoryId } });
    if (!category || category.businessId !== params.businessId) {
      return NextResponse.json({ error: "invalid_category" }, { status: 400 });
    }
  }

  // Module 28: same resolveBranchScope() lock as opening a Sale/Purchase –
  // a branch-restricted member can only attribute opening stock to their
  // own branch.
  let branchId: string | null;
  try {
    branchId = resolveBranchScope(ctx.membership, data.branchId ?? null);
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: "forbidden" }, { status: err.status });
    throw err;
  }

  try {
    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          businessId: params.businessId,
          categoryId: data.categoryId ?? undefined,
          name: data.name,
          sku: data.sku ?? undefined,
          barcode: data.barcode ?? undefined,
          description: data.description ?? undefined,
          purchasePrice: data.purchasePrice,
          sellingPrice: data.sellingPrice,
          unit: data.unit,
          reorderLevel: data.reorderLevel,
          expiryDate: data.expiryDate ? new Date(data.expiryDate) : undefined,
          imageUrl: data.imageUrl ?? undefined,
          vatCategory: data.vatCategory,
          isStocked: data.isStocked, // Module 77
          quantity: 0, // set via the movement below so the audit trail is complete
        },
      });

      if (data.isStocked && data.openingQuantity > 0) {
        await recordInventoryMovement({
          tx,
          businessId: params.businessId,
          productId: created.id,
          type: "OPENING_STOCK",
          delta: data.openingQuantity,
          branchId,
          reason: "Opening stock at product creation",
          createdById: userId,
        });
      }

      return tx.product.findUniqueOrThrow({ where: { id: created.id } });
    });

    return NextResponse.json({ product }, { status: 201 });
  } catch (err: any) {
    if (err.code === "P2002") {
      return NextResponse.json(
        { error: "duplicate", message: "A product with this SKU or barcode already exists." },
        { status: 409 }
      );
    }
    throw err;
  }
}
