import { prisma } from "./prisma";
import { Prisma } from "@prisma/client";

/**
 * Per spec section 41 ("maintain an audit trail for important financial
 * changes"), any create/edit/delete of a financially-significant record
 * (expenses, and later payroll, tax config, journal entries, etc.) should
 * call this rather than being silently unlogged. Not every mutation in the
 * app needs an audit row – CRUD on a Product's description doesn't – but
 * anything that moves money or could be disputed later does.
 */
export async function logAudit(params: {
  tx?: Prisma.TransactionClient;
  businessId: string;
  userId: string;
  action: string; // e.g. "expense.create", "expense.update", "expense.delete"
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
}) {
  const db = params.tx ?? prisma;
  await db.auditLog.create({
    data: {
      businessId: params.businessId,
      userId: params.userId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      metadata: params.metadata as Prisma.InputJsonValue | undefined,
    },
  });
}
