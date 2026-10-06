import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resetPasswordSchema } from "@/lib/validation";
import { hashPassword } from "@/lib/password";
import { consumePasswordResetToken, markPasswordResetTokenUsed } from "@/lib/tokens";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = resetPasswordSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const result = await consumePasswordResetToken(parsed.data.token);

  if (!result.ok) {
    const messages: Record<string, string> = {
      invalid: "This reset link is invalid.",
      already_used: "This reset link has already been used.",
      expired: "This reset link has expired. Please request a new one.",
    };
    return NextResponse.json(
      { error: result.reason, message: messages[result.reason] },
      { status: 400 }
    );
  }

  const passwordHash = await hashPassword(parsed.data.password);

  await prisma.$transaction([
    prisma.user.update({ where: { id: result.userId }, data: { passwordHash } }),
    prisma.session.deleteMany({ where: { userId: result.userId } }), // force re-login everywhere
  ]);

  await markPasswordResetTokenUsed(result.tokenId);

  return NextResponse.json({ message: "Password reset successfully. Please log in." });
}
