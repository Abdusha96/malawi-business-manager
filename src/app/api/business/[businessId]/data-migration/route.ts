import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { prisma } from "@/lib/prisma";
import { commitMigration, readXlsxMigrationFile, suggestMappings, validateMigration } from "@/lib/data-migration";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const { businessId } = await props.params;
  const ctx = await requireApiContext(businessId);
  if (ctx instanceof NextResponse) return ctx;
  const history = await prisma.importBatch.findMany({ where: { businessId }, include: { user: { select: { name: true, email: true } } }, orderBy: { createdAt: "desc" }, take: 50 });
  return NextResponse.json({ history });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const { businessId } = await props.params;
  const form = await req.formData();
  const kind = String(form.get("kind") ?? "");
  const action = String(form.get("action") ?? "preview");
  const permission = kind === "PRODUCTS" ? "inventory.manage" : kind === "FIXED_ASSETS" ? "fixedassets.manage" : undefined;
  if (!permission) return NextResponse.json({ error: "Invalid import type." }, { status: 400 });
  const ctx = await requireApiContext(businessId, permission);
  if (ctx instanceof NextResponse) return ctx;
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose an Excel or CSV file." }, { status: 400 });
  try {
    const { headers, rows } = await readXlsxMigrationFile(Buffer.from(await file.arrayBuffer()), file.name);
    const mappings = form.get("mapping") ? JSON.parse(String(form.get("mapping"))) : suggestMappings(headers, kind as "PRODUCTS" | "FIXED_ASSETS");
    const validated = await validateMigration({ businessId, kind: kind as "PRODUCTS" | "FIXED_ASSETS", rows, mapping: mappings, membership: ctx.membership });
    if (action === "preview") return NextResponse.json({ ...validated, headers, mappings, preview: rows.slice(0, 8) });
    const migrationDateValue = String(form.get("migrationDate") ?? "");
    const migrationDate = new Date(`${migrationDateValue}T12:00:00`);
    if (!migrationDateValue || Number.isNaN(migrationDate.getTime())) return NextResponse.json({ error: "Select a valid opening balance date." }, { status: 400 });
    const result = await commitMigration({ businessId, userId: ctx.userId, membership: ctx.membership, kind: kind as "PRODUCTS" | "FIXED_ASSETS", filename: file.name, migrationDate, rows: validated.validRows as Record<string, any>[], errors: validated.errors });
    return NextResponse.json({ ...result, errors: validated.errors });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "The import could not be processed." }, { status: 400 });
  }
}
