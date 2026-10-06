import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { forgotPasswordSchema } from "@/lib/validation";
import { createPasswordResetToken } from "@/lib/tokens";
import { sendEmail, TEMPLATE_KEYS } from "@/lib/notifications";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = forgotPasswordSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email.toLowerCase() },
  });

  // Always return a generic success message, whether or not the account
  // exists – prevents account enumeration via this endpoint.
  if (user) {
    const { token } = await createPasswordResetToken(user.id);
    // No businessId: a user can belong to more than one business, so a
    // password reset isn't scoped to any single one of them – the same
    // reason this event never gets an AuditLog row either.
    await sendEmail({
      userId: user.id,
      to: user.email,
      subject: "Reset your password – Malawi Business Manager",
      body: `Hi ${user.name},\n\nSomeone requested a password reset for this account. Reset it here:\n\n${process.env.NEXTAUTH_URL ?? ""}/reset-password?token=${token}\n\nIf this wasn't you, you can ignore this email – your password won't change.`,
      templateKey: TEMPLATE_KEYS.PASSWORD_RESET,
      relatedEntityType: "User",
      relatedEntityId: user.id,
    });
  }

  return NextResponse.json({
    message: "If an account exists with that email, a password reset link has been sent.",
  });
}
