import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { getDashboardData } from "@/lib/dashboard";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "dashboard.view");
  if (ctx instanceof NextResponse) return ctx;

  const data = await getDashboardData(params.businessId);
  return NextResponse.json(data);
}
