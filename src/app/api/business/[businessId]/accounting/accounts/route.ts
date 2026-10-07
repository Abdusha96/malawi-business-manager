import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { accountCreateSchema } from "@/lib/validation";
import { createAccount, AccountAdminError } from "@/lib/account-admin";

// Module 41: adding a custom account. accounting.manage (Owner + Accountant), the same permission that
// posts journal entries – a custom account is only ever reachable from one.
export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "accounting.manage");
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.membership.role !== "OWNER" && ctx.membership.branchId) {
    return NextResponse.json({ error: "forbidden", message: "Chart of Accounts is managed at business level." }, { status: 403 });
  }

  const parsed = accountCreateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const account = await createAccount({ businessId: params.businessId, userId: ctx.userId, input: parsed.data });
    return NextResponse.json({ account }, { status: 201 });
  } catch (err) {
    if (err instanceof AccountAdminError) {
      return NextResponse.json({ error: "account_failed", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
