import { nanoid } from "nanoid";
import { prisma } from "./prisma";

const EMAIL_VERIFICATION_TTL_HOURS = 24;
const PASSWORD_RESET_TTL_MINUTES = 30;

export async function createEmailVerificationToken(userId: string) {
  const token = nanoid(48);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_HOURS * 60 * 60 * 1000);

  await prisma.verificationToken.create({
    data: { userId, token, type: "EMAIL", expiresAt },
  });

  return { token, expiresAt };
}

export async function createPasswordResetToken(userId: string) {
  const token = nanoid(48);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000);

  await prisma.passwordResetToken.create({
    data: { userId, token, expiresAt },
  });

  return { token, expiresAt };
}

export async function consumeEmailVerificationToken(token: string) {
  const record = await prisma.verificationToken.findUnique({ where: { token } });

  if (!record || record.type !== "EMAIL") return { ok: false as const, reason: "invalid" as const };
  if (record.usedAt) return { ok: false as const, reason: "already_used" as const };
  if (record.expiresAt < new Date()) return { ok: false as const, reason: "expired" as const };

  await prisma.$transaction([
    prisma.verificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } }),
  ]);

  return { ok: true as const, userId: record.userId };
}

export async function consumePasswordResetToken(token: string) {
  const record = await prisma.passwordResetToken.findUnique({ where: { token } });

  if (!record) return { ok: false as const, reason: "invalid" as const };
  if (record.usedAt) return { ok: false as const, reason: "already_used" as const };
  if (record.expiresAt < new Date()) return { ok: false as const, reason: "expired" as const };

  return { ok: true as const, userId: record.userId, tokenId: record.id };
}

export async function markPasswordResetTokenUsed(tokenId: string) {
  await prisma.passwordResetToken.update({ where: { id: tokenId }, data: { usedAt: new Date() } });
}
