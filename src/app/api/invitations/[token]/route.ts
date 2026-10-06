import { NextRequest, NextResponse } from "next/server";
import { getInvitationByToken } from "@/lib/team";

export async function GET(req: NextRequest, props: { params: Promise<{ token: string }> }) {
  const params = await props.params;
  const result = await getInvitationByToken(params.token);
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 404 });
  }

  const { invitation, hasExistingAccount } = result;
  return NextResponse.json({
    businessName: invitation.business.name,
    email: invitation.email,
    role: invitation.role,
    branchName: invitation.branch?.name ?? null,
    hasExistingAccount,
  });
}
