import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "./auth";
import { requireBusinessMember, requirePermission, TenantAccessError, ResolvedMembership } from "./tenant";
import { PermissionKey } from "./permissions";

/**
 * Standard entry point for every /api/business/[businessId]/... route.
 * Resolves: is there a session? -> does this user belong to this business?
 * -> does their role have the required permission?
 *
 * Returns either the resolved membership (proceed with your query, always
 * filtering by membership.businessId) or a NextResponse you should return
 * immediately. This is the ONLY sanctioned way to authorize a business-scoped
 * route – see src/lib/tenant.ts for why.
 *
 * Usage:
 *   const ctx = await requireApiContext(businessId, "inventory.manage");
 *   if (ctx instanceof NextResponse) return ctx;
 *   const { membership } = ctx;
 */
export async function requireApiContext(
  businessId: string,
  permission?: PermissionKey
): Promise<{ membership: ResolvedMembership; userId: string } | NextResponse> {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  try {
    const membership = await requireBusinessMember(session.user.id, businessId);

    if (permission) {
      await requirePermission(membership, permission);
    }

    return { membership, userId: session.user.id };
  } catch (err) {
    if (err instanceof TenantAccessError) {
      return NextResponse.json({ error: "forbidden", message: err.message }, { status: err.status });
    }
    throw err;
  }
}
