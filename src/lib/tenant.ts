import { prisma } from "./prisma";
import { PermissionKey } from "./permissions";
import { BusinessRole } from "@prisma/client";

/**
 * TENANT ISOLATION – READ THIS BEFORE ADDING ANY NEW MODULE.
 *
 * Every table added in later modules (Sale, Product, Customer, Expense,
 * Payroll, etc.) will have a `businessId` column. NO route handler or server
 * action may query those tables directly with a raw `prisma.sale.findMany()`
 * etc. Instead, resolve the caller's membership first with
 * `requireBusinessMember()`, then filter every query by the returned
 * `businessId` explicitly. This function is the single choke point: if
 * membership resolution is correct, every downstream query that uses its
 * result is safe.
 *
 * Section 37 (Testing) requires an explicit test that Business A cannot see
 * Business B's records – that test should call the actual route handlers,
 * not just this helper in isolation, so a future module can't bypass it.
 */

export class TenantAccessError extends Error {
  status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.status = status;
  }
}

export interface ResolvedMembership {
  businessId: string;
  userId: string;
  role: BusinessRole;
  branchId: string | null;
}

/**
 * Confirms the given user is an active member of the given business and
 * returns their membership record. Throws TenantAccessError otherwise –
 * callers should let this propagate into a 403, never swallow it.
 */
export async function requireBusinessMember(
  userId: string,
  businessId: string
): Promise<ResolvedMembership> {
  const membership = await prisma.businessMember.findUnique({
    where: { businessId_userId: { businessId, userId } },
  });

  if (!membership || !membership.isActive) {
    throw new TenantAccessError("You do not have access to this business.");
  }

  return {
    businessId: membership.businessId,
    userId: membership.userId,
    role: membership.role,
    branchId: membership.branchId,
  };
}

/**
 * Loads every business the user belongs to – used for the business
 * switcher UI (a user can own/work at multiple businesses) and for
 * validating a businessId passed in a request without assuming it's theirs.
 */
export async function listUserBusinesses(userId: string) {
  return prisma.businessMember.findMany({
    where: { userId, isActive: true },
    include: { business: true },
    orderBy: { invitedAt: "asc" },
  });
}

// Cache of role -> permission set, loaded once per process. Rebuilt if the
// admin edits RolePermission (call `invalidatePermissionCache()` after that).
let permissionCache: Record<BusinessRole, Set<string>> | null = null;

async function loadPermissionCache() {
  const rolePermissions = await prisma.rolePermission.findMany({
    include: { permission: true },
  });

  const cache: Record<string, Set<string>> = {
    OWNER: new Set(),
    MANAGER: new Set(),
    CASHIER: new Set(),
    ACCOUNTANT: new Set(),
  };

  for (const rp of rolePermissions) {
    cache[rp.role].add(rp.permission.key);
  }

  permissionCache = cache as Record<BusinessRole, Set<string>>;
  return permissionCache;
}

export function invalidatePermissionCache() {
  permissionCache = null;
}

export async function hasPermission(
  membership: ResolvedMembership,
  permission: PermissionKey
): Promise<boolean> {
  // OWNER is documented as the unrestricted business administrator. Keeping
  // this invariant in code also means an existing database doesn't need a
  // re-seed every time a new permission key is introduced.
  if (membership.role === "OWNER") return true;
  const cache = permissionCache ?? (await loadPermissionCache());
  return cache[membership.role]?.has(permission) ?? false;
}

export async function requirePermission(
  membership: ResolvedMembership,
  permission: PermissionKey
): Promise<void> {
  const allowed = await hasPermission(membership, permission);
  if (!allowed) {
    throw new TenantAccessError(
      `Your role (${membership.role}) does not have permission: ${permission}`
    );
  }
}

/**
 * MULTI-BRANCH CHOKE POINT – read this before adding branch filtering to a
 * new route. `BusinessMember.branchId` has existed since Module 1, but until
 * now nothing enforced it: a member with `branchId` set could still read or
 * write another branch's data by passing a different id, because
 * `requireApiContext` only ever checked `businessId`.
 *
 * Every route for a branch-scoped model (Sale, Expense, Quotation,
 * FixedAsset, and – as of Module 27 – Purchase and CashTransaction) must
 * call this with whatever branch the request asked for (a query param on
 * GET, a body field on POST) and use the returned value for
 * filtering/creation instead of the raw request value. It:
 *   - Locks a branch-restricted member (`membership.branchId` set) to their
 *     own branch, throwing if the request asked for a different one.
 *   - Leaves an unrestricted member (Owner/Manager with no branchId) free to
 *     see all branches (returns null) or filter to one they asked for.
 *
 * Do not re-derive this check per route – a subtly different comparison at
 * one call site is exactly how tenant isolation bugs like this start.
 */
export function resolveBranchScope(
  membership: ResolvedMembership,
  requestedBranchId?: string | null
): string | null {
  if (membership.branchId) {
    if (requestedBranchId && requestedBranchId !== membership.branchId) {
      throw new TenantAccessError("You do not have access to that branch.");
    }
    return membership.branchId;
  }
  return requestedBranchId ?? null;
}
