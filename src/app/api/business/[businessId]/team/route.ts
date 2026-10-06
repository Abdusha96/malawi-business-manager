import { NextRequest, NextResponse } from "next/server";
import { requireApiContext } from "@/lib/api-context";
import { inviteMemberSchema } from "@/lib/validation";
import { listTeam, inviteMember, TeamValidationError } from "@/lib/team";
import { PlanRestrictionError } from "@/lib/subscription";
import { sendEmail, TEMPLATE_KEYS } from "@/lib/notifications";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "business.members.manage");
  if (ctx instanceof NextResponse) return ctx;

  const { members, invitations } = await listTeam(params.businessId);
  return NextResponse.json({ members, invitations });
}

export async function POST(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "business.members.manage");
  if (ctx instanceof NextResponse) return ctx;

  const parsed = inviteMemberSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const invitation = await inviteMember({
      businessId: params.businessId,
      invitedByUserId: ctx.userId,
      email: parsed.data.email,
      role: parsed.data.role,
      branchId: parsed.data.branchId,
    });

    const business = await prisma.business.findUnique({ where: { id: params.businessId } });

    // No userId: the invitee usually doesn't have a User row yet – that's
    // the point of the invite.
    await sendEmail({
      businessId: params.businessId,
      to: invitation.email,
      subject: `You've been invited to join ${business?.name ?? "a business"} on Malawi Business Manager`,
      body: `Hi,\n\nYou've been invited to join ${business?.name ?? "a business"} on Malawi Business Manager. Accept the invitation here:\n\n${process.env.NEXTAUTH_URL ?? ""}/accept-invitation?token=${invitation.token}\n\nIf you weren't expecting this, you can ignore this email.`,
      templateKey: TEMPLATE_KEYS.TEAM_INVITATION,
      relatedEntityType: "BusinessInvitation",
      relatedEntityId: invitation.id,
    });

    return NextResponse.json({ invitation }, { status: 201 });
  } catch (err) {
    if (err instanceof TeamValidationError) {
      return NextResponse.json({ error: "validation_error", message: err.message }, { status: 400 });
    }
    if (err instanceof PlanRestrictionError) {
      return NextResponse.json({ error: "plan_restricted", message: err.message }, { status: err.status });
    }
    throw err;
  }
}
