import { monthEndEntryDate } from "./date-range";
import { getBusinessTimeZone } from "./business-timezone";
import { endOfDayIn, zonedDate } from "./timezone";
import { prisma } from "./prisma";
import { FixedAssetStatus } from "@prisma/client";
import {
  postJournalEntryForFixedAssetAcquisition,
  reverseJournalEntryForFixedAssetAcquisition,
  postJournalEntryForDepreciation,
  postJournalEntryForFixedAssetDisposal,
} from "./accounting-integrations";
import { postCashTransactionForFixedAsset, postCashTransactionForFixedAssetDisposal } from "./cashbook";
import { reverseCashTransactionsForReference } from "./cashbook";
import { logAudit } from "./audit";
import { FixedAssetInput, DisposeFixedAssetInput } from "./validation";
import { assertRecordDateOpen } from "./period-close";
import { checkRecordDate } from "./period-lock";
import { PeriodClosedError } from "./accounting";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export class FixedAssetError extends Error {}

/**
 * Records a new fixed asset and posts its acquisition to both ledgers in
 * one transaction – same "create row, then post Cashbook, then post GL"
 * sequence every other module in this app follows (see the Expense route
 * for the canonical example). CREDIT is rejected here, not just at the
 * validation layer, since a future call site (a bulk import, say)
 * shouldn't be able to bypass the check by skipping the Zod schema.
 */
export async function createFixedAsset(params: {
  businessId: string;
  createdById: string;
  data: FixedAssetInput;
}) {
  const { businessId, createdById, data } = params;

  if ((data.paymentMethod as string) === "CREDIT") {
    throw new FixedAssetError(
      "Fixed assets can't be recorded as bought on credit – this app has no financed-asset ledger yet. Record it once paid, or use a manual journal entry."
    );
  }

  return prisma.$transaction(async (tx) => {
    // Module 42: an acquisition date in a closed period would change a period that is already
    // filed (the register and depreciation read acquisitionDate). An omitted date means today.
    await assertRecordDateOpen({
      tx,
      businessId,
      instant: data.acquisitionDate ? new Date(data.acquisitionDate) : null,
      what: "this asset's acquisition",
      mode: "date",
    });

    const asset = await tx.fixedAsset.create({
      data: {
        businessId,
        branchId: data.branchId ?? undefined,
        supplierId: data.supplierId ?? undefined,
        name: data.name,
        category: data.category,
        description: data.description ?? undefined,
        acquisitionDate: data.acquisitionDate ? new Date(data.acquisitionDate) : new Date(),
        cost: data.cost,
        residualValue: data.residualValue,
        usefulLifeYears: data.category === "LAND" ? null : data.usefulLifeYears,
        paymentMethod: data.paymentMethod as any,
        notes: data.notes ?? undefined,
        recordedById: createdById,
      },
    });

    await postCashTransactionForFixedAsset({
      tx,
      businessId,
      assetId: asset.id,
      cost: Number(asset.cost),
      paymentMethod: asset.paymentMethod,
      createdById,
    });

    await postJournalEntryForFixedAssetAcquisition({
      tx,
      businessId,
      assetId: asset.id,
      assetName: asset.name,
      cost: Number(asset.cost),
      paymentMethod: asset.paymentMethod,
      createdById,
    });

    return asset;
  });
}

/**
 * Deletes a fixed asset – only permitted while it's ACTIVE and has never
 * had a depreciation entry posted against it (checked by looking for any
 * JournalEntry with referenceType "Depreciation" whose referenceId starts
 * with "<assetId>:", the same prefix scheme postJournalEntryForDepreciation
 * writes). Once depreciation exists, the register entry is part of the
 * accounting history – use disposeFixedAsset() instead, the same way a
 * Sale/Purchase gets voided rather than deleted once it's touched the
 * ledger for real.
 */
export async function deleteFixedAsset(params: { businessId: string; assetId: string; deletedById: string }) {
  const { businessId, assetId, deletedById } = params;

  const asset = await prisma.fixedAsset.findFirst({ where: { id: assetId, businessId } });
  if (!asset) throw new FixedAssetError("Fixed asset not found.");
  if (asset.status !== "ACTIVE") {
    throw new FixedAssetError("A disposed asset can't be deleted – it's part of the accounting history.");
  }

  const depreciationEntries = await prisma.journalEntry.findFirst({
    where: { businessId, referenceType: "Depreciation", referenceId: { startsWith: `${assetId}:` } },
  });
  if (depreciationEntries) {
    throw new FixedAssetError(
      "This asset already has depreciation posted against it – dispose of it instead of deleting it."
    );
  }

  await prisma.$transaction(async (tx) => {
    // Module 42: deleting reverses the acquisition and erases the row. Not allowed once its date is closed.
    await assertRecordDateOpen({ tx, businessId, instant: asset.acquisitionDate, what: `the acquisition of "${asset.name}"`, mode: "change" });
    await reverseCashTransactionsForReference({
      tx,
      businessId,
      referenceType: "FixedAssetAcquisition",
      referenceId: assetId,
      createdById: deletedById,
      reason: `Fixed asset "${asset.name}" deleted`,
    });
    await reverseJournalEntryForFixedAssetAcquisition({
      tx,
      businessId,
      assetId,
      assetName: asset.name,
      createdById: deletedById,
    });
    await tx.fixedAsset.delete({ where: { id: assetId } });
  });

  await logAudit({
    businessId,
    userId: deletedById,
    action: "fixedasset.delete",
    entityType: "FixedAsset",
    entityId: assetId,
    metadata: { name: asset.name, cost: Number(asset.cost) },
  });
}

// Accepts `any` for cost/residualValue rather than a Prisma.Decimal type
// import – every other lib file in this app (payroll.ts, vat.ts, ...)
// converts a Decimal field with Number(...) at the call site instead of
// typing against Prisma's Decimal directly, so this follows that same
// convention. Callers pass either a raw Prisma row (Decimal fields) or an
// already-Number()'d object; Number() is idempotent on a plain number.
interface DepreciableAsset {
  cost: any;
  residualValue: any;
  usefulLifeYears: number | null;
}

/** Straight-line annual depreciation – the only method this app implements (see DepreciationMethod in the schema). Zero for a non-depreciable asset (no usefulLifeYears, e.g. Land). */
export function computeAnnualDepreciation(asset: DepreciableAsset): number {
  if (!asset.usefulLifeYears || asset.usefulLifeYears <= 0) return 0;
  const depreciableAmount = round2(Number(asset.cost) - Number(asset.residualValue));
  if (depreciableAmount <= 0) return 0;
  return round2(depreciableAmount / asset.usefulLifeYears);
}

export function computeMonthlyDepreciation(asset: DepreciableAsset): number {
  return round2(computeAnnualDepreciation(asset) / 12);
}

/**
 * How much has actually been posted to ACCUMULATED_DEPRECIATION for one
 * asset – summed live from JournalLine, never a stored running total (see
 * the schema comment on FixedAsset for why). The "<assetId>:" prefix match
 * on JournalEntry.referenceId is what scopes a shared GL account's
 * postings back down to a single asset, since Accumulated Depreciation
 * itself is one account for the whole business, not one per asset.
 */
export async function getAccumulatedDepreciation(businessId: string, assetId: string, asOf?: Date): Promise<number> {
  const agg = await prisma.journalLine.aggregate({
    where: {
      journalEntry: {
        businessId,
        referenceType: "Depreciation",
        referenceId: { startsWith: `${assetId}:` },
        ...(asOf ? { entryDate: { lte: asOf } } : {}),
      },
    },
    _sum: { credit: true, debit: true },
  });
  return round2(Number(agg._sum.credit ?? 0) - Number(agg._sum.debit ?? 0));
}

/**
 * The Fixed Asset Register – every asset (active and disposed) with its
 * accumulated depreciation and net book value computed live from the GL,
 * the same "computed-never-stored" treatment Customer/Supplier balances
 * get. This is what the /fixed-assets page and a future Balance Sheet
 * drill-down would both read from.
 */
export async function getFixedAssetRegister(businessId: string, asOf?: Date) {
  const assets = await prisma.fixedAsset.findMany({
    where: { businessId },
    include: { branch: { select: { name: true } }, supplier: { select: { name: true } } },
    orderBy: { acquisitionDate: "desc" },
  });

  return Promise.all(
    assets.map(async (asset) => {
      const accumulatedDepreciation = await getAccumulatedDepreciation(businessId, asset.id, asOf);
      const netBookValue = round2(Number(asset.cost) - accumulatedDepreciation);
      return {
        ...asset,
        cost: Number(asset.cost),
        residualValue: Number(asset.residualValue),
        annualDepreciation: computeAnnualDepreciation(asset),
        monthlyDepreciation: computeMonthlyDepreciation(asset),
        accumulatedDepreciation,
        netBookValue,
      };
    })
  );
}

/**
 * First and last instant of a "YYYY-MM" period in the business's zone. Module 35: these were
 * UTC bounds, so on any business whose zone isn't UTC an asset bought at 01:00 on 1 April in
 * Malawi (23:00Z on 31 March) was treated as a MARCH acquisition and depreciated a month early.
 */
function periodBounds(period: string, tz: string): { start: Date; end: Date } {
  const [year, month] = period.split("-").map(Number);
  const start = zonedDate(year, month - 1, 1, tz);
  const end = endOfDayIn(zonedDate(year, month, 0, tz), tz);
  return { start, end };
}

/**
 * Runs depreciation for every eligible ACTIVE asset for one period
 * ("YYYY-MM") – the explicit, user-triggered action this app uses instead
 * of a background job (mirrors Payroll's per-period run). Idempotent per
 * asset+period: postJournalEntryForDepreciation's referenceId is
 * "<assetId>:<period>", checked here before posting so re-running the same
 * period is a safe no-op, not a double charge.
 *
 * Skips: assets acquired after the period ends, disposed before the period
 * starts, non-depreciable assets (Land / no usefulLifeYears), and assets
 * already fully depreciated (accumulated >= depreciable amount) – the
 * final period's charge is capped to whatever's left rather than
 * overshooting past (cost - residualValue).
 */
export async function postDepreciationForPeriod(params: { businessId: string; period: string; createdById: string }) {
  const { businessId, period, createdById } = params;
  const tz = await getBusinessTimeZone(businessId);
  const { start, end } = periodBounds(period, tz);

  // Module 42: check the whole period BEFORE the loop. Each asset posts in its own transaction, so
  // without this a closed period would fail on the first asset (postJournalEntry refuses it), but a
  // run that crossed the lock date partway would leave some assets posted and some not.
  const bookState = await prisma.business.findUnique({ where: { id: businessId }, select: { booksClosedThrough: true } });
  const refusal = checkRecordDate({
    closedThrough: bookState?.booksClosedThrough,
    instant: monthEndEntryDate(period, tz),
    tz,
    what: `the depreciation for ${period}`,
    mode: "post",
  });
  if (refusal) throw new PeriodClosedError(refusal);

  const assets = await prisma.fixedAsset.findMany({
    where: {
      businessId,
      status: "ACTIVE",
      acquisitionDate: { lte: end },
    },
  });

  const results: { assetId: string; assetName: string; amount: number; skipped?: string }[] = [];

  for (const asset of assets) {
    const referenceId = `${asset.id}:${period}`;
    const already = await prisma.journalEntry.findFirst({
      where: { businessId, referenceType: "Depreciation", referenceId },
    });
    if (already) {
      results.push({ assetId: asset.id, assetName: asset.name, amount: 0, skipped: "already posted for this period" });
      continue;
    }

    if (!asset.usefulLifeYears || asset.usefulLifeYears <= 0) {
      results.push({ assetId: asset.id, assetName: asset.name, amount: 0, skipped: "not depreciable" });
      continue;
    }

    const depreciableAmount = round2(Number(asset.cost) - Number(asset.residualValue));
    const accumulatedSoFar = await getAccumulatedDepreciation(businessId, asset.id, start);
    const remaining = round2(depreciableAmount - accumulatedSoFar);
    if (remaining <= 0) {
      results.push({ assetId: asset.id, assetName: asset.name, amount: 0, skipped: "fully depreciated" });
      continue;
    }

    const monthly = computeMonthlyDepreciation(asset);
    const amount = Math.min(monthly, remaining);
    if (amount <= 0) {
      results.push({ assetId: asset.id, assetName: asset.name, amount: 0, skipped: "nothing to depreciate" });
      continue;
    }

    await prisma.$transaction(async (tx) => {
      await postJournalEntryForDepreciation({
        tx,
        businessId,
        assetId: asset.id,
        assetName: asset.name,
        period,
        amount,
        createdById,
        // Module 34: dated the period's last day (or today if still open). It used to default to
        // "now", so depreciation for March run in April landed in April's P&L, and the
        // accumulated-as-of-period-start check above couldn't see earlier periods run in the same sitting.
        entryDate: monthEndEntryDate(period, tz),
      });
    });

    results.push({ assetId: asset.id, assetName: asset.name, amount });
  }

  await logAudit({
    businessId,
    userId: createdById,
    action: "fixedasset.depreciation_run",
    entityType: "FixedAsset",
    entityId: period,
    metadata: { period, postedCount: results.filter((r) => r.amount > 0).length },
  });

  return results;
}

/**
 * Records disposal (sale, scrap, write-off – this app doesn't distinguish
 * the reason beyond disposalNotes) and posts the removal from both
 * ledgers. gainLoss = proceeds - netBookValue: positive is a gain
 * (credited to GAIN_LOSS_ON_DISPOSAL_OF_ASSETS), negative is a loss
 * (debited) – see postJournalEntryForFixedAssetDisposal's doc comment for
 * why this always balances. Module 37: the P&L shows a net gain under Other
 * Income and a net loss under Other Expenses (src/lib/pnl-layout.ts).
 */
export async function disposeFixedAsset(params: {
  businessId: string;
  assetId: string;
  createdById: string;
  data: DisposeFixedAssetInput;
}) {
  const { businessId, assetId, createdById, data } = params;

  const asset = await prisma.fixedAsset.findFirst({ where: { id: assetId, businessId } });
  if (!asset) throw new FixedAssetError("Fixed asset not found.");
  if (asset.status !== "ACTIVE") throw new FixedAssetError("This asset has already been disposed of.");

  const disposalDate = data.disposalDate ? new Date(data.disposalDate) : new Date();
  const accumulatedDepreciation = await getAccumulatedDepreciation(businessId, assetId, disposalDate);
  const proceeds = round2(data.disposalProceeds ?? 0);

  // Module 33: keep the account's TYPE, not just the check that it exists –
  // the GL posting needs it to find the right shared cash GL account (see
  // postJournalEntryForFixedAssetDisposal's comment for the bug this fixes).
  let cashAccountType: string | undefined;
  if (proceeds > 0 && data.cashAccountId) {
    const account = await prisma.cashAccount.findUnique({ where: { id: data.cashAccountId } });
    if (!account || account.businessId !== businessId) {
      throw new FixedAssetError("Invalid cash account.");
    }
    cashAccountType = account.type;
  }

  const disposed = await prisma.$transaction(async (tx) => {
    // Module 42: the disposal date is user-supplied and the register reads it. An omitted date means today.
    await assertRecordDateOpen({ tx, businessId, instant: data.disposalDate ? new Date(data.disposalDate) : null, what: "this disposal", mode: "date" });
    await postJournalEntryForFixedAssetDisposal({
      tx,
      businessId,
      assetId,
      assetName: asset.name,
      cost: Number(asset.cost),
      accumulatedDepreciation,
      proceeds,
      cashAccountType: proceeds > 0 ? cashAccountType : undefined,
      createdById,
    });

    if (proceeds > 0 && data.cashAccountId) {
      await postCashTransactionForFixedAssetDisposal({
        tx,
        businessId,
        assetId,
        accountId: data.cashAccountId,
        proceeds,
        createdById,
      });
    }

    return tx.fixedAsset.update({
      where: { id: assetId },
      data: {
        status: "DISPOSED" as FixedAssetStatus,
        disposalDate,
        disposalProceeds: proceeds,
        disposalNotes: data.disposalNotes ?? undefined,
      },
    });
  });

  const netBookValue = round2(Number(asset.cost) - accumulatedDepreciation);
  const gainLoss = round2(proceeds - netBookValue);

  await logAudit({
    businessId,
    userId: createdById,
    action: "fixedasset.dispose",
    entityType: "FixedAsset",
    entityId: assetId,
    metadata: { proceeds, netBookValue, gainLoss },
  });

  return { asset: disposed, netBookValue, gainLoss };
}
