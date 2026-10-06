import { nanoid } from "nanoid";
import { prisma } from "./prisma";
import { hashPassword } from "./password";
import { normalizePhone } from "./auth";
import { normalizePhoneNumber } from "./phone";
import { requirePlanCapacity, requirePlanFeature, PlanRestrictionError } from "./subscription";
import { BusinessRole } from "@prisma/client";

const INVITATION_TTL_DAYS = 7;

export class TeamValidationError extends Error {}

/**
 * Active members plus outstanding (unaccepted, unrevoked, unexpired)
 * invitations, combined into one list – the Team page shows both so an
 * Owner can see who's pending without hunting through two screens.
 */
export async function listTeam(businessId: string) {
  const [members, invitations] = await Promise.all([
    prisma.businessMember.findMany({
      where: { businessId },
      include: { user: { select: { id: true, name: true, email: true, phone: true } }, branch: { select: { id: true, name: true } } },
      orderBy: [{ role: "asc" }, { invitedAt: "asc" }],
    }),
    prisma.businessInvitation.findMany({
      where: { businessId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      include: { branch: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return { members, invitations };
}

/**
 * Creates (or replaces) an outstanding invitation for an email address.
 * Doesn't create the User or BusinessMember yet – that happens on accept,
 * see acceptInvitation() below – because the invitee may not have an
 * account at all.
 */
export async function inviteMember(params: {
  businessId: string;
  invitedByUserId: string;
  email: string;
  role: Exclude<BusinessRole, "OWNER">;
  branchId?: string | null;
}) {
  const email = params.email.toLowerCase();

  const existingMember = await prisma.businessMember.findFirst({
    where: { businessId: params.businessId, isActive: true, user: { email } },
  });
  if (existingMember) {
    throw new TeamValidationError("This person is already a member of your business.");
  }

  if (params.branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: params.branchId } });
    if (!branch || branch.businessId !== params.businessId) {
      throw new TeamValidationError("That branch doesn't belong to this business.");
    }
  }

  // multiUser gates whether a business can have any team beyond the Owner
  // at all (Free plan can't); maxUsers is the numeric ceiling above that.
  // Both existed on PlanDefinition since Module 1 with nothing checking
  // them until now.
  await requirePlanFeature(params.businessId, "multiUser");
  const [activeMemberCount, pendingInvitationCount] = await Promise.all([
    prisma.businessMember.count({ where: { businessId: params.businessId, isActive: true } }),
    prisma.businessInvitation.count({
      where: { businessId: params.businessId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    }),
  ]);
  await requirePlanCapacity(params.businessId, "users", activeMemberCount + pendingInvitationCount);

  // Superseding an unaccepted invite to the same email keeps the list clean
  // – re-inviting someone (e.g. after a typo or role change) shouldn't
  // leave two live tokens for the same person.
  await prisma.businessInvitation.updateMany({
    where: { businessId: params.businessId, email, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  const token = nanoid(48);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);

  const invitation = await prisma.businessInvitation.create({
    data: {
      businessId: params.businessId,
      email,
      role: params.role,
      branchId: params.branchId ?? undefined,
      token,
      invitedByUserId: params.invitedByUserId,
      expiresAt,
    },
  });

  return invitation;
}

export async function revokeInvitation(businessId: string, invitationId: string) {
  const invitation = await prisma.businessInvitation.findUnique({ where: { id: invitationId } });
  if (!invitation || invitation.businessId !== businessId) {
    throw new TeamValidationError("Invitation not found.");
  }
  if (invitation.acceptedAt) {
    throw new TeamValidationError("This invitation has already been accepted.");
  }
  return prisma.businessInvitation.update({ where: { id: invitationId }, data: { revokedAt: new Date() } });
}

export async function getInvitationByToken(token: string) {
  const invitation = await prisma.businessInvitation.findUnique({
    where: { token },
    include: { business: { select: { name: true } }, branch: { select: { name: true } } },
  });
  if (!invitation) return { ok: false as const, reason: "invalid" as const };
  if (invitation.revokedAt) return { ok: false as const, reason: "revoked" as const };
  if (invitation.acceptedAt) return { ok: false as const, reason: "already_used" as const };
  if (invitation.expiresAt < new Date()) return { ok: false as const, reason: "expired" as const };

  const existingUser = await prisma.user.findUnique({ where: { email: invitation.email } });
  return { ok: true as const, invitation, hasExistingAccount: Boolean(existingUser) };
}

/**
 * Accepts an invitation. If the invited email already has a User account,
 * `password`/`name`/`phone` are ignored and the existing account is used –
 * the person just needs to log in afterwards. If not, this creates the
 * account (matching the fields registerSchema requires elsewhere) in the
 * same transaction as the BusinessMember, so a half-created account can't
 * exist without a membership.
 */
export async function acceptInvitation(params: {
  token: string;
  name?: string;
  phone?: string;
  password?: string;
}) {
  const invitation = await prisma.businessInvitation.findUnique({ where: { token: params.token } });
  if (!invitation) throw new TeamValidationError("This invitation link is invalid.");
  if (invitation.revokedAt) throw new TeamValidationError("This invitation has been revoked.");
  if (invitation.acceptedAt) throw new TeamValidationError("This invitation has already been accepted.");
  if (invitation.expiresAt < new Date()) throw new TeamValidationError("This invitation has expired.");

  const existingUser = await prisma.user.findUnique({ where: { email: invitation.email } });

  // Module 72: a phone that was typed is checked before the account is created,
  // so the number stored can be texted and found at login.
  if (!existingUser && params.phone && params.phone.trim() !== "") {
    const phone = normalizePhoneNumber(params.phone);
    if (!phone.ok) throw new TeamValidationError(phone.reason);
  }

  if (!existingUser && (!params.name || !params.password)) {
    throw new TeamValidationError("Name and password are required to create your account.");
  }

  const result = await prisma.$transaction(async (tx) => {
    let userId: string;

    if (existingUser) {
      userId = existingUser.id;
    } else {
      const passwordHash = await hashPassword(params.password!);
      const user = await tx.user.create({
        data: {
          name: params.name!,
          email: invitation.email,
          phone: params.phone ? normalizePhone(params.phone) : undefined,
          passwordHash,
          emailVerifiedAt: new Date(), // accepting a business-issued invite counts as proof of ownership
        },
      });
      userId = user.id;
    }

    // Guards against a stale double-submit racing past the plan check that
    // ran when the invite was created – re-checked here inside the
    // transaction against the current count, not the one at invite time.
    const activeMemberCount = await tx.businessMember.count({
      where: { businessId: invitation.businessId, isActive: true },
    });
    await requirePlanCapacity(invitation.businessId, "users", activeMemberCount);

    const member = await tx.businessMember.upsert({
      where: { businessId_userId: { businessId: invitation.businessId, userId } },
      create: {
        businessId: invitation.businessId,
        userId,
        role: invitation.role,
        branchId: invitation.branchId,
        acceptedAt: new Date(),
      },
      update: {
        role: invitation.role,
        branchId: invitation.branchId,
        isActive: true,
        acceptedAt: new Date(),
      },
    });

    await tx.businessInvitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } });

    return { userId, member };
  });

  return result;
}

export async function updateMember(
  businessId: string,
  memberId: string,
  data: { role?: Exclude<BusinessRole, "OWNER">; branchId?: string | null; isActive?: boolean }
) {
  const member = await prisma.businessMember.findUnique({ where: { id: memberId } });
  if (!member || member.businessId !== businessId) {
    throw new TeamValidationError("Team member not found.");
  }
  if (member.role === "OWNER") {
    throw new TeamValidationError("The business owner's role can't be changed here.");
  }

  if (data.branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: data.branchId } });
    if (!branch || branch.businessId !== businessId) {
      throw new TeamValidationError("That branch doesn't belong to this business.");
    }
  }

  return prisma.businessMember.update({
    where: { id: memberId },
    data: {
      ...(data.role !== undefined ? { role: data.role } : {}),
      ...(data.branchId !== undefined ? { branchId: data.branchId } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    },
  });
}

export { PlanRestrictionError };
