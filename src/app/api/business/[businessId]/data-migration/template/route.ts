import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { makeTemplate } from "@/lib/data-migration";

export const runtime = "nodejs";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const { businessId } = await props.params;
  const kind = req.nextUrl.searchParams.get("kind");
  const permission = kind === "PRODUCTS" ? "inventory.manage" : kind === "FIXED_ASSETS" ? "fixedassets.manage" : undefined;
  if (!permission) return NextResponse.json({ error: "Invalid import type." }, { status: 400 });
  const ctx = await requireApiContext(businessId, permission);
  if (ctx instanceof NextResponse) return ctx;
  const importKind = kind as "PRODUCTS" | "FIXED_ASSETS";
  const bytes = await makeTemplate(importKind);
  return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${importKind.toLowerCase()}-import-template.xlsx"` } });
}
