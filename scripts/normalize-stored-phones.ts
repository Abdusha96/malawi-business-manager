/**
 * Module 72: rewrites phone numbers already stored in the database into the
 * canonical "+265..." form, so the stored value, the login lookup and the SMS
 * gateway all agree.
 *
 *   npx tsx scripts/normalize-stored-phones.ts            # DRY RUN: prints the plan, changes nothing
 *   npx tsx scripts/normalize-stored-phones.ts --apply    # writes the rewrites
 *   npm run phones:normalize [-- --apply]
 *
 * Covers User, Business, Customer, Supplier and Employee.
 *   - Already-canonical and empty values are left alone.
 *   - A readable value is rewritten (landlines too: they are valid numbers, they
 *     are only refused when a text is sent).
 *   - An UNREADABLE value (two numbers in one field, letters, wrong length) is
 *     REPORTED and never changed or blanked; someone has to look at it.
 *   - User.phone is unique and is the login key. If two users would end up with
 *     the same number, or the canonical number already belongs to another user,
 *     that user is skipped and reported instead of crashing the run.
 * Safe to run more than once: a second run finds nothing left to rewrite.
 * The decisions live in src/lib/phone-backfill.ts (verified by verify:phone).
 */
import { PrismaClient } from "@prisma/client";
import { runPhoneBackfill, PhoneStore } from "../src/lib/phone-backfill";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();

const stores: PhoneStore[] = [
  {
    label: "User",
    unique: true,
    load: () => prisma.user.findMany({ select: { id: true, phone: true } }),
    write: async (id, phone) => void (await prisma.user.update({ where: { id }, data: { phone } })),
  },
  {
    label: "Business",
    load: () => prisma.business.findMany({ select: { id: true, phone: true } }),
    write: async (id, phone) => void (await prisma.business.update({ where: { id }, data: { phone } })),
  },
  {
    label: "Customer",
    load: () => prisma.customer.findMany({ select: { id: true, phone: true } }),
    write: async (id, phone) => void (await prisma.customer.update({ where: { id }, data: { phone } })),
  },
  {
    label: "Supplier",
    load: () => prisma.supplier.findMany({ select: { id: true, phone: true } }),
    write: async (id, phone) => void (await prisma.supplier.update({ where: { id }, data: { phone } })),
  },
  {
    label: "Employee",
    load: () => prisma.employee.findMany({ select: { id: true, phone: true } }),
    write: async (id, phone) => void (await prisma.employee.update({ where: { id }, data: { phone } })),
  },
];

async function main() {
  console.log(APPLY ? "APPLY mode: changes will be written.\n" : "DRY RUN: nothing will be written (add --apply).\n");
  const r = await runPhoneBackfill(stores, APPLY, console.log);
  console.log(
    `\nScanned ${r.scanned}: ${r.alreadyCanonical} already canonical, ${r.empty} empty, ` +
      `${r.rewritten} ${APPLY ? "rewritten" : "to rewrite"}, ${r.skippedCollisions} skipped (collision), ` +
      `${r.unreadable.length} unreadable.`
  );
  if (!APPLY && r.rewritten > 0) console.log("Run again with --apply to write them.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
