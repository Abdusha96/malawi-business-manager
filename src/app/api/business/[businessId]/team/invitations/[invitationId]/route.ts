import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { revokeInvitation, TeamValidationError } from "@/lib/team";

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ businessId: string; invitationId: string }> }
) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "business.members.manage");
  if (ctx instanceof NextResponse) return ctx;

  try {
    const invitation = await revokeInvitation(params.businessId, params.invitationId);
    return NextResponse.json({ invitation });
  } catch (err) {
    if (err instanceof TeamValidationError) {
      return NextResponse.json({ error: "validation_error", message: err.message }, { status: 400 });
    }
    throw err;
  }
}
