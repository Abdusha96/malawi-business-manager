/**
 * Module 72: the decision-making half of scripts/normalize-stored-phones.ts,
 * kept free of Prisma so it is verified with in-memory stores (the script only
 * supplies the real ones). See the script header for what it does and why.
 */
import { planPhoneRewrite } from "./phone";

export interface PhoneStore {
  label: string;
  /** true for a column with a unique index (User.phone): collisions are skipped, not attempted. */
  unique?: boolean;
  load(): Promise<{ id: string; phone: string | null }[]>;
  write(id: string, phone: string): Promise<void>;
}

export interface BackfillReport {
  scanned: number;
  alreadyCanonical: number;
  empty: number;
  rewritten: number; // counted in dry-run too ("would rewrite")
  skippedCollisions: number;
  unreadable: { label: string; id: string; value: string; reason: string }[];
}

export async function runPhoneBackfill(
  stores: PhoneStore[],
  apply: boolean,
  log: (line: string) => void = () => {}
): Promise<BackfillReport> {
  const report: BackfillReport = {
    scanned: 0,
    alreadyCanonical: 0,
    empty: 0,
    rewritten: 0,
    skippedCollisions: 0,
    unreadable: [],
  };

  for (const store of stores) {
    const rows = await store.load();
    // For a unique column: every value currently in use, and the ones this run claims.
    const inUse = new Set(rows.map((r) => r.phone).filter((p): p is string => !!p));
    const claimed = new Set<string>();

    for (const row of rows) {
      report.scanned++;
      const plan = planPhoneRewrite(row.phone);
      if (plan.action === "keep") {
        if (plan.reason === "empty") report.empty++;
        else report.alreadyCanonical++;
        continue;
      }
      if (plan.action === "unreadable") {
        report.unreadable.push({ label: store.label, id: row.id, value: row.phone as string, reason: plan.reason });
        log(`  UNREADABLE ${store.label} ${row.id}: ${JSON.stringify(row.phone)} - ${plan.reason}`);
        continue;
      }
      if (store.unique && (inUse.has(plan.to) || claimed.has(plan.to))) {
        report.skippedCollisions++;
        log(`  SKIPPED ${store.label} ${row.id}: ${row.phone} -> ${plan.to} would collide with another row's phone`);
        continue;
      }
      claimed.add(plan.to);
      log(`  ${store.label} ${row.id}: ${JSON.stringify(row.phone)} -> ${plan.to}`);
      if (apply) await store.write(row.id, plan.to);
      report.rewritten++;
    }
  }
  return report;
}
