import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { accountUpdateSchema } from "@/lib/validation";
import { updateAccount, AccountAdminError } from "@/lib/account-admin";

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; accountId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "accounting.manage");
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.membership.role !== "OWNER" && ctx.membership.branchId) {
    return NextResponse.json({ error: "forbidden", message: "Chart of Accounts is managed at business level." }, { status: 403 });
  }

  const parsed = accountUpdateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const account = await updateAccount({ businessId: params.businessId, accountId: params.accountId, userId: ctx.userId, input: parsed.data });
    return NextResponse.json({ account });
  } catch (err) {
    if (err instanceof AccountAdminError) {
      return NextResponse.json({ error: "account_failed", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
