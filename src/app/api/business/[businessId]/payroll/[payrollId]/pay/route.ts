import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { payPayrollSchema } from "@/lib/validation";
import { payPayrollRun, PayrollError } from "@/lib/payroll";

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; payrollId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "payroll.manage");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const parsed = payPayrollSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const run = await payPayrollRun({
      businessId: params.businessId,
      payrollId: params.payrollId,
      paymentMethod: parsed.data.paymentMethod,
      userId,
    });
    return NextResponse.json({ run, message: "Payroll paid and posted to the cashbook." });
  } catch (err) {
    if (err instanceof PayrollError) {
      return NextResponse.json({ error: "pay_failed", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
