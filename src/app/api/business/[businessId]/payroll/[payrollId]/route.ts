import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; payrollId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "payroll.view");
  if (ctx instanceof NextResponse) return ctx;

  const run = await prisma.payroll.findUnique({
    where: { id: params.payrollId },
    include: { employee: true, business: true },
  });

  if (!run || run.businessId !== params.businessId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ run });
}
