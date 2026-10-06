import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { normalBalanceForType } from "./chart-of-accounts";
import { logAudit } from "./audit";
import type { AccountCreateInput, AccountUpdateInput } from "./validation";

/**
 * Chart of accounts administration – Module 41.
 *
 * The chart of accounts was read-only: 30-odd system accounts seeded at
 * registration and no way to add "Owner's Drawings", "Bank Loan" or "Prepaid
 * Rent". Manual journal entries are only as useful as the accounts they can name,
 * and the Account model has said since Module 11 that code and name "can be
 * renamed freely without breaking the posting engine" – with no route to do it.
 *
 * RULES, stated plainly:
 *
 * 1. A created account is NEVER a system account: no systemKey, isSystemAccount
 *    false. The posting engine finds accounts by systemKey only, so nothing in the
 *    app ever posts to a custom account automatically – it is only reachable from a
 *    manual journal entry.
 *
 * 2. Type is fixed at creation and never editable. Changing an account's type
 *    would silently move its whole history between the Balance Sheet and the P&L.
 *    The normal balance is derived from the type (normalBalanceForType), never
 *    typed in.
 *
 * 3. Code and name are editable on ANY account (system accounts too), as the
 *    schema comment has always promised; systemKey and type are never touched.
 *    The P&L labels its non-operating lines from fixed text, not the account
 *    name, so a rename can't mislabel a report.
 *
 * 4. Deactivating is allowed only for a custom account that has NEVER been posted
 *    to. getAllAccountBalances / getProfitAndLoss read active accounts only, so
 *    deactivating an account with history would make its balance vanish from the
 *    Trial Balance and Balance Sheet (which would then stop balancing) and drop its
 *    past activity from old P&Ls. An account with history is left active; there is
 *    no delete (Account -> JournalLine is onDelete: Restrict).
 *
 * 5. All custom EXPENSE accounts read as operating expenses and all custom REVENUE
 *    accounts as revenue on the P&L – non-operating classification is by systemKey
 *    (src/lib/pnl-layout.ts) and custom accounts have none. KNOWN LIMITATION.
 */

export class AccountAdminError extends Error {}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export async function createAccount(params: { businessId: string; userId: string; input: AccountCreateInput }) {
  const { businessId, userId, input } = params;

  const duplicateName = await prisma.account.findFirst({
    where: { businessId, isActive: true, name: { equals: input.name, mode: "insensitive" } },
    select: { code: true },
  });
  if (duplicateName) throw new AccountAdminError(`An account named "${input.name}" already exists (${duplicateName.code}).`);

  try {
    return await prisma.$transaction(async (tx) => {
      const account = await tx.account.create({
        data: {
          businessId,
          code: input.code,
          name: input.name,
          type: input.type,
          normalBalance: normalBalanceForType(input.type),
          systemKey: null,
          isSystemAccount: false,
          isActive: true,
        },
      });
      await logAudit({
        tx,
        businessId,
        userId,
        action: "account.create",
        entityType: "Account",
        entityId: account.id,
        metadata: { code: account.code, name: account.name, type: account.type },
      });
      return account;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AccountAdminError(`Account code ${input.code} is already in use.`);
    throw err;
  }
}

export async function updateAccount(params: { businessId: string; accountId: string; userId: string; input: AccountUpdateInput }) {
  const { businessId, accountId, userId, input } = params;

  const account = await prisma.account.findFirst({ where: { id: accountId, businessId } });
  if (!account) throw new AccountAdminError("Account not found.");

  const deactivating = input.isActive === false && account.isActive;
  if (deactivating && account.isSystemAccount) {
    throw new AccountAdminError("System accounts can't be deactivated – the app posts to them automatically.");
  }

  if (input.name !== undefined && input.name.toLowerCase() !== account.name.toLowerCase()) {
    const duplicateName = await prisma.account.findFirst({
      where: { businessId, isActive: true, id: { not: accountId }, name: { equals: input.name, mode: "insensitive" } },
      select: { code: true },
    });
    if (duplicateName) throw new AccountAdminError(`An account named "${input.name}" already exists (${duplicateName.code}).`);
  }

  try {
    return await prisma.$transaction(async (tx) => {
      if (deactivating) {
        // Take the same account-row lock used by postJournalEntry() before
        // checking history. A posting that got the lock first finishes before
        // this count; a posting that arrives after this deactivation sees the
        // account as inactive and is refused.
        const claimed = await tx.account.updateMany({
          where: { id: accountId, businessId, isActive: true },
          data: { isActive: true },
        });
        if (claimed.count === 0) throw new AccountAdminError("This account has changed. Reload it and try again.");
        if ((await tx.journalLine.count({ where: { accountId } })) > 0) {
          throw new AccountAdminError(
            "This account has been posted to, so it can't be deactivated: its balance and history would disappear from the Trial Balance, Balance Sheet and past Profit & Loss reports."
          );
        }
      }
      const updated = await tx.account.update({
        where: { id: accountId },
        data: {
          ...(input.code !== undefined ? { code: input.code } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });
      await logAudit({
        tx,
        businessId,
        userId,
        action: "account.update",
        entityType: "Account",
        entityId: accountId,
        metadata: {
          before: { code: account.code, name: account.name, isActive: account.isActive },
          after: { code: updated.code, name: updated.name, isActive: updated.isActive },
        },
      });
      return updated;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AccountAdminError(`Account code ${input.code} is already in use.`);
    throw err;
  }
}
