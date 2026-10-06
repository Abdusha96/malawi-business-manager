import { PrismaClient } from "@prisma/client";

// Prevents creating a new PrismaClient on every hot-reload in dev, which
// would otherwise exhaust Postgres connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// On Netlify the managed database exposes NETLIFY_DB_URL; an explicit
// DATABASE_URL (e.g. an external Postgres) still takes precedence.
const datasourceUrl = process.env.DATABASE_URL || process.env.NETLIFY_DB_URL || undefined;

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasourceUrl,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
