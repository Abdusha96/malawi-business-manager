import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { updateMemberSchema } from "@/lib/validation";
import { updateMember, TeamValidationError } from "@/lib/team";

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; memberId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "business.members.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = updateMemberSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const member = await updateMember(params.businessId, params.memberId, parsed.data);
    return NextResponse.json({ member });
  } catch (err) {
    if (err instanceof TeamValidationError) {
      return NextResponse.json({ error: "validation_error", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
