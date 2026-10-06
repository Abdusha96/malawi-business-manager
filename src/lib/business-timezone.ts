import { prisma } from "./prisma";
import type { Prisma } from "@prisma/client";
import { resolveTimeZone } from "./timezone";

/**
 * Module 35 – the ONE server-side way to learn which time zone a business's
 * calendar runs on. Every report route, dashboard query and period calculation
 * calls this (or reads `Business.timezone` itself and passes it through
 * `resolveTimeZone()`), never `new Date().getMonth()`-style runtime-local
 * arithmetic. See src/lib/timezone.ts for the rule and the reasoning.
 *
 * One tiny indexed select per call – deliberately NOT cached in process
 * memory: an Owner changing the zone must take effect on the very next
 * request on every instance, and a stale cache in a multi-instance deployment
 * would silently give two servers two different month boundaries.
 *
 * Falls back to the default zone (Malawi) for a missing business row or an
 * unsupported stored value, via resolveTimeZone(), so a report never errors
 * out over this and never quietly reverts to the server's own clock.
 */
export async function getBusinessTimeZone(
  businessId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<string> {
  const business = await client.business.findUnique({ where: { id: businessId }, select: { timezone: true } });
  return resolveTimeZone(business?.timezone);
}
