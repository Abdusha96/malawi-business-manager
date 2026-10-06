import { prisma } from "./prisma";
import { Prisma } from "@prisma/client";

/**
 * Audit trail reader (Module 82, Phase 15). Read-only: rows are written by logAudit() in audit.ts
 * (and a few direct creates) and are never edited or deleted here.
 *
 * Scope, stated honestly:
 * - Only this business's rows (businessId is always in the filter). Rows with no business
 *   (sign-in events and the like) are not shown.
 * - `ai.*` actions are left out: their metadata is the question a member typed to Mobi
 *   Accountant, which is that member's own text, not a financial change.
 * - At most AUDIT_TRAIL_LIMIT rows (newest first) per query. Narrow with a date range, area
 *   or person to see older activity; there is no "next page".
 */
export const AUDIT_TRAIL_LIMIT = 500;

const AREA_LABELS: Record<string, string> = {
  account: "Cash accounts",
  bankrecon: "Bank reconciliation",
  business: "Business settings",
  creditnote: "Credit notes",
  customer: "Customers",
  debitnote: "Debit notes",
  employee: "Employees",
  expense: "Expenses",
  fixedasset: "Fixed assets",
  forex: "Foreign exchange",
  invoice: "Invoices",
  manual_journal: "Manual journals",
  member: "Team",
  notification: "Notifications",
  online_payments: "Online payments",
  payment: "Payments",
  payroll: "Payroll",
  period: "Period close",
  product: "Products",
  purchase: "Purchases",
  refund: "Refunds",
  sale: "Sales",
  service_cost: "Service cost clearing",
  stocktake: "Stock take",
  stocktransfer: "Stock transfers",
  subscription: "Subscription",
  tax: "Tax",
  taxpayment: "Tax payments",
};

/** "fixedasset.depreciation_run" -> "fixedasset". An action with no dot is its own area. */
export function auditArea(action: string): string {
  const i = action.indexOf(".");
  return i === -1 ? action : action.slice(0, i);
}

export function auditAreaLabel(area: string): string {
  return AREA_LABELS[area] ?? area.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** "manual_journal.void" -> "Void". The area column already says what it was done to. */
export function auditVerbLabel(action: string): string {
  const i = action.indexOf(".");
  const verb = i === -1 ? action : action.slice(i + 1);
  return verb.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

const MAX_VALUE_CHARS = 80;
const MAX_SUMMARY_CHARS = 240;

function shortValue(v: unknown): string {
  if (v === null || v === undefined) return "–";
  if (typeof v === "string") return v.length > MAX_VALUE_CHARS ? `${v.slice(0, MAX_VALUE_CHARS)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const j = JSON.stringify(v);
  return j.length > MAX_VALUE_CHARS ? `${j.slice(0, MAX_VALUE_CHARS)}…` : j;
}

/** One line of "key: value" pairs from the stored metadata, capped so a long blob cannot flood a row. */
export function summariseMetadata(metadata: unknown): string {
  if (metadata === null || metadata === undefined) return "";
  if (typeof metadata !== "object" || Array.isArray(metadata)) return shortValue(metadata);
  const parts = Object.entries(metadata as Record<string, unknown>).map(([k, v]) => `${k}: ${shortValue(v)}`);
  const text = parts.join(" · ");
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS)}…` : text;
}

export type AuditTrailFilter = { from?: Date; to?: Date; area?: string; userId?: string };

export async function listAuditTrail(businessId: string, f: AuditTrailFilter) {
  const where: Prisma.AuditLogWhereInput = {
    businessId,
    NOT: { action: { startsWith: "ai." } },
    ...(f.area ? { action: { startsWith: `${f.area}.` } } : {}),
    ...(f.userId ? { userId: f.userId } : {}),
    ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
  };
  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: AUDIT_TRAIL_LIMIT + 1,
    include: { user: { select: { name: true, email: true } } },
  });
  return { rows: rows.slice(0, AUDIT_TRAIL_LIMIT), capped: rows.length > AUDIT_TRAIL_LIMIT };
}

/** Distinct areas that have at least one row for this business, for the filter dropdown. */
export async function listAuditAreas(businessId: string): Promise<{ value: string; label: string }[]> {
  const groups = await prisma.auditLog.groupBy({ by: ["action"], where: { businessId, NOT: { action: { startsWith: "ai." } } } });
  const areas = Array.from(new Set(groups.map((g) => auditArea(g.action))));
  return areas.map((a) => ({ value: a, label: auditAreaLabel(a) })).sort((a, b) => a.label.localeCompare(b.label));
}
