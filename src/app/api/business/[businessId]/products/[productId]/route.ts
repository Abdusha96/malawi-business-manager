import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { productUpdateSchema } from "@/lib/validation";
import { checkKindChange, validateProductKind } from "@/lib/product-kind";

async function loadOwnedProduct(businessId: string, productId: string) {
  const product = await prisma.product.findUnique({ where: { id: productId }, include: { category: true } });
  if (!product || product.businessId !== businessId) return null;
  return product;
}

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; productId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "inventory.view");
  if (ctx instanceof NextResponse) return ctx;

  const product = await loadOwnedProduct(params.businessId, params.productId);
  if (!product) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const movements = await prisma.inventoryMovement.findMany({
    where: { productId: product.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return NextResponse.json({ product, movements });
}

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; productId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "inventory.manage");
  if (ctx instanceof NextResponse) return ctx;

  const existing = await loadOwnedProduct(params.businessId, params.productId);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = productUpdateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  if (data.categoryId) {
    const category = await prisma.category.findUnique({ where: { id: data.categoryId } });
    if (!category || category.businessId !== params.businessId) {
      return NextResponse.json({ error: "invalid_category" }, { status: 400 });
    }
  }

  // Module 77: changing between stocked and service. Becoming a service needs every stock figure at zero and
  // nothing in flight. The stock-only fields are cleared on the way, and a service can't be given any later.
  const nextIsStocked = data.isStocked ?? existing.isStocked;
  const becomingService = existing.isStocked && !nextIsStocked;
  if (data.isStocked !== undefined && data.isStocked !== existing.isStocked) {
    const [nonZeroBranchLevels, inTransitLines, openStockTakeLines] = await Promise.all([
      prisma.stockLevel.count({ where: { productId: existing.id, quantity: { not: 0 } } }),
      prisma.stockTransferLine.count({ where: { productId: existing.id, transfer: { status: "IN_TRANSIT" } } }),
      prisma.stockTakeLine.count({ where: { productId: existing.id, stockTake: { status: "IN_PROGRESS" } } }),
    ]);
    const changeProblem = checkKindChange(existing.isStocked, nextIsStocked, {
      quantity: Number(existing.quantity),
      nonZeroBranchLevels,
      inTransitLines,
      openStockTakeLines,
    });
    if (changeProblem) {
      return NextResponse.json({ error: "invalid_product_kind", message: changeProblem }, { status: 400 });
    }
  }
  const kindProblem = validateProductKind({
    isStocked: nextIsStocked,
    reorderLevel: becomingService ? 0 : data.reorderLevel ?? Number(existing.reorderLevel),
    expiryDate: becomingService ? null : data.expiryDate !== undefined ? data.expiryDate : existing.expiryDate?.toISOString() ?? null,
  });
  if (kindProblem) {
    return NextResponse.json({ error: "invalid_product_kind", message: kindProblem }, { status: 400 });
  }

  try {
    const product = await prisma.$transaction(async (tx) => {
      if (becomingService) {
        // Every level is zero (checked above); the rows only carry per-branch reorder overrides, which would
        // otherwise raise "out of stock" alerts for something that has no stock.
        await tx.stockLevel.deleteMany({ where: { productId: existing.id } });
      }
      return tx.product.update({
      where: { id: params.productId },
      data: {
        ...(data.isStocked !== undefined ? { isStocked: data.isStocked } : {}),
        ...(becomingService ? { reorderLevel: 0, expiryDate: null } : {}),
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.categoryId !== undefined ? { categoryId: data.categoryId } : {}),
        ...(data.sku !== undefined ? { sku: data.sku } : {}),
        ...(data.barcode !== undefined ? { barcode: data.barcode } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.purchasePrice !== undefined ? { purchasePrice: data.purchasePrice } : {}),
        ...(data.sellingPrice !== undefined ? { sellingPrice: data.sellingPrice } : {}),
        ...(data.unit !== undefined ? { unit: data.unit } : {}),
        ...(data.reorderLevel !== undefined && !becomingService ? { reorderLevel: data.reorderLevel } : {}),
        ...(data.expiryDate !== undefined && !becomingService
          ? { expiryDate: data.expiryDate ? new Date(data.expiryDate) : null }
          : {}),
        ...(data.imageUrl !== undefined ? { imageUrl: data.imageUrl } : {}),
        ...(data.vatCategory !== undefined ? { vatCategory: data.vatCategory } : {}),
      },
      });
    });

    return NextResponse.json({ product });
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

// Soft delete only – a hard delete would orphan InventoryMovement/SaleItem
// history. Deactivated products drop out of POS/product lists but stay
// queryable for historical reports.
export async function DELETE(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; productId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "inventory.manage");
  if (ctx instanceof NextResponse) return ctx;

  const existing = await loadOwnedProduct(params.businessId, params.productId);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await prisma.product.update({ where: { id: params.productId }, data: { isActive: false } });

  return NextResponse.json({ message: "Product deactivated." });
}
