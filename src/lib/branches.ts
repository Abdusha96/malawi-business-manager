import { prisma } from "./prisma";
import { requirePlanCapacity } from "./subscription";
import { sumCreditNoteTotal, sumCreditNoteTotalByBranch } from "./credit-note-queries";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Every business gets a "Head Office" branch created at registration (see
 * src/app/api/auth/register/route.ts), so this list is never empty. Sales
 * and Expenses are the only branch-scoped models today – see the note on
 * Branch in prisma/schema.prisma and resolveBranchScope() in tenant.ts.
 */
export async function listBranchesWithStats(businessId: string) {
  const [branches, salesByBranch, expensesByBranch, creditsByBranch] = await Promise.all([
    prisma.branch.findMany({
      where: { businessId },
      orderBy: [{ isHeadOffice: "desc" }, { name: "asc" }],
    }),
    prisma.sale.groupBy({
      by: ["branchId"],
      where: { businessId, status: { not: "VOIDED" } },
      _sum: { total: true },
      _count: true,
    }),
    prisma.expense.groupBy({
      by: ["branchId"],
      where: { businessId },
      _sum: { amount: true },
    }),
    sumCreditNoteTotalByBranch(businessId), // Module 43: totalSales is net of credit notes
  ]);

  const salesByBranchId = new Map(
    salesByBranch
      .filter((s) => s.branchId)
      .map((s) => [s.branchId as string, { total: Number(s._sum.total ?? 0), count: s._count }])
  );
  const expensesByBranchId = new Map(
    expensesByBranch.filter((e) => e.branchId).map((e) => [e.branchId as string, Number(e._sum.amount ?? 0)])
  );

  return branches.map((b) => ({
    ...b,
    totalSales: round2((salesByBranchId.get(b.id)?.total ?? 0) - (creditsByBranch.get(b.id) ?? 0)),
    saleCount: salesByBranchId.get(b.id)?.count ?? 0,
    totalExpenses: round2(expensesByBranchId.get(b.id) ?? 0),
  }));
}

export async function getBranch(businessId: string, branchId: string) {
  const branch = await prisma.branch.findUnique({ where: { id: branchId } });
  if (!branch || branch.businessId !== businessId) return null;
  return branch;
}

export async function getBranchStats(businessId: string, branchId: string) {
  const [salesAgg, expensesAgg, memberCount, creditTotal] = await Promise.all([
    prisma.sale.aggregate({
      where: { businessId, branchId, status: { not: "VOIDED" } },
      _sum: { total: true },
      _count: true,
    }),
    prisma.expense.aggregate({
      where: { businessId, branchId },
      _sum: { amount: true },
    }),
    prisma.businessMember.count({ where: { businessId, branchId, isActive: true } }),
    sumCreditNoteTotal(businessId, { from: new Date(0), to: new Date(), branchId }),
  ]);

  return {
    totalSales: round2(Number(salesAgg._sum.total ?? 0) - creditTotal),
    saleCount: salesAgg._count,
    totalExpenses: round2(Number(expensesAgg._sum.amount ?? 0)),
    assignedMemberCount: memberCount,
  };
}

export class BranchValidationError extends Error {}

export async function createBranch(params: {
  businessId: string;
  name: string;
  district?: string | null;
  city?: string | null;
  address?: string | null;
}) {
  const existingCount = await prisma.branch.count({ where: { businessId: params.businessId } });
  await requirePlanCapacity(params.businessId, "branches", existingCount);

  return prisma.branch.create({
    data: {
      businessId: params.businessId,
      name: params.name,
      district: params.district ?? undefined,
      city: params.city ?? undefined,
      address: params.address ?? undefined,
    },
  });
}

export async function updateBranch(
  businessId: string,
  branchId: string,
  data: {
    name?: string;
    district?: string | null;
    city?: string | null;
    address?: string | null;
    isActive?: boolean;
  }
) {
  const existing = await getBranch(businessId, branchId);
  if (!existing) throw new BranchValidationError("Branch not found in this business.");

  // The head office can be renamed but never deactivated – every business
  // needs at least one branch that's always available as a default, the
  // same reason it's created automatically at registration.
  if (existing.isHeadOffice && data.isActive === false) {
    throw new BranchValidationError("The head office branch cannot be deactivated.");
  }

  return prisma.branch.update({
    where: { id: branchId },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.district !== undefined ? { district: data.district } : {}),
      ...(data.city !== undefined ? { city: data.city } : {}),
      ...(data.address !== undefined ? { address: data.address } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    },
  });
}
