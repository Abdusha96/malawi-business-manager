import { NextRequest, NextResponse } from "next/server";
import { acceptInvitationSchema } from "@/lib/validation";
import { acceptInvitation, TeamValidationError } from "@/lib/team";
import { PlanRestrictionError } from "@/lib/subscription";

export async function POST(req: NextRequest) {
  const parsed = acceptInvitationSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await acceptInvitation(parsed.data);
    return NextResponse.json({ userId: result.userId }, { status: 200 });
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
