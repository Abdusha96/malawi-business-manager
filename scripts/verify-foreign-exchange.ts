/**
 * Module 39 – standalone checks for foreign exchange gains & losses. No database,
 * no framework:  npx tsx scripts/verify-foreign-exchange.ts   (npm run verify:fx)
 * Exits non-zero if any check fails.
 *
 * Covers the pure parts: the arithmetic and sign convention (src/lib/fx-calc.ts),
 * the journal-line shapes, the P&L classification (src/lib/pnl-layout.ts), the
 * chart-of-accounts entry, the permission grants and the request schema. It does
 * NOT exercise Postgres or the two-ledger transaction – see the README.
 */
import { computeSettlement, buildSettlementJournalLines, cashAmountForPayment, foreignBalance, computeFxGainLossFromRates, signedFromDirection, buildFxJournalLines, isBusinessCurrency, round2 } from "../src/lib/fx-calc";
import { buildProfitAndLoss, PnlAccountActivity } from "../src/lib/pnl-layout";
import { SYSTEM_ACCOUNTS, normalBalanceForType } from "../src/lib/chart-of-accounts";
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from "../src/lib/permissions";
import { fxAdjustmentSchema, voidFxAdjustmentSchema, saleSchema, purchaseSchema, foreignSettlementSchema } from "../src/lib/validation";
import { summariseAdjustments } from "../src/lib/foreign-exchange";

let failed = 0, total = 0;
function check(name: string, actual: unknown, expected: unknown) {
  total++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}
function throws(name: string, fn: () => unknown) {
  total++;
  try { fn(); failed++; console.error(`FAIL ${name}: expected a throw`); } catch { /* ok */ }
}

// 1. Arithmetic and sign
check("gain when rate rises", computeFxGainLossFromRates({ foreignAmount: 1000, bookRate: 1700, newRate: 1750 }), 50000);
check("loss when rate falls", computeFxGainLossFromRates({ foreignAmount: 1000, bookRate: 1750, newRate: 1700 }), -50000);
check("fractional rates", computeFxGainLossFromRates({ foreignAmount: 2500.5, bookRate: 1700.25, newRate: 1752.4 }), round2(2500.5 * (1752.4 - 1700.25)));
check("same rate is zero", computeFxGainLossFromRates({ foreignAmount: 1000, bookRate: 1700, newRate: 1700 }), 0);
check("sub-tambala difference rounds to zero", computeFxGainLossFromRates({ foreignAmount: 1, bookRate: 1700, newRate: 1700.004 }), 0);
check("symmetric rounding: +0.005 and -0.005 equal magnitude", [round2(0.005), round2(-0.005)], [0.01, -0.01]);
check("gain and loss are exact opposites", computeFxGainLossFromRates({ foreignAmount: 333.33, bookRate: 1701.11, newRate: 1749.99 }), -computeFxGainLossFromRates({ foreignAmount: 333.33, bookRate: 1749.99, newRate: 1701.11 }));
throws("zero foreign amount rejected", () => computeFxGainLossFromRates({ foreignAmount: 0, bookRate: 1, newRate: 2 }));
throws("zero rate rejected", () => computeFxGainLossFromRates({ foreignAmount: 5, bookRate: 0, newRate: 2 }));
throws("negative rate rejected", () => computeFxGainLossFromRates({ foreignAmount: 5, bookRate: 1, newRate: -2 }));
check("direction GAIN", signedFromDirection("GAIN", 120.5), 120.5);
check("direction LOSS", signedFromDirection("LOSS", 120.5), -120.5);
throws("direction with zero amount rejected", () => signedFromDirection("GAIN", 0));

// 2. Journal lines
const g = buildFxJournalLines({ cashGlAccountId: "CASH", fxAccountId: "FX", signedAmount: 500 });
check("gain: Dr cash / Cr FX", g, [{ accountId: "CASH", debit: 500 }, { accountId: "FX", credit: 500 }]);
const l = buildFxJournalLines({ cashGlAccountId: "CASH", fxAccountId: "FX", signedAmount: -500 });
check("loss: Dr FX / Cr cash", l, [{ accountId: "FX", debit: 500 }, { accountId: "CASH", credit: 500 }]);
for (const lines of [g, l]) {
  check("entry balances", round2(lines.reduce((s, x) => s + (x.debit ?? 0), 0)), round2(lines.reduce((s, x) => s + (x.credit ?? 0), 0)));
}
throws("zero adjustment has no entry", () => buildFxJournalLines({ cashGlAccountId: "C", fxAccountId: "F", signedAmount: 0 }));
check("business currency detection", [isBusinessCurrency("mwk", "MWK"), isBusinessCurrency(" USD ", "MWK")], [true, false]);

// 3. Chart of accounts
const acct = SYSTEM_ACCOUNTS.find((a) => a.key === "FOREIGN_EXCHANGE_GAIN_LOSS");
check("account exists as EXPENSE", [acct?.type, acct?.code], ["EXPENSE", "5170"]);
check("account is debit-normal", normalBalanceForType(acct!.type), "DEBIT");
check("account code is unique", SYSTEM_ACCOUNTS.filter((a) => a.code === "5170").length, 1);
check("account key is unique", SYSTEM_ACCOUNTS.filter((a) => a.key === "FOREIGN_EXCHANGE_GAIN_LOSS").length, 1);

// 4. P&L classification
const fx = (d: number, c: number): PnlAccountActivity => ({ code: "5170", name: "Foreign Exchange Gain/Loss", type: "EXPENSE", normalBalance: "DEBIT", systemKey: "FOREIGN_EXCHANGE_GAIN_LOSS", debit: d, credit: c });
const rev: PnlAccountActivity = { code: "4000", name: "Sales Revenue", type: "REVENUE", normalBalance: "CREDIT", systemKey: "SALES_REVENUE", debit: 0, credit: 10000 };
let r = buildProfitAndLoss([rev, fx(0, 500)]);
check("gain is Other Income", r.otherIncome.map((x) => [x.name, x.amount]), [["Foreign Exchange Gain", 500]]);
check("gain not in operating expenses", r.operatingExpenses.length, 0);
check("gain leaves operating profit alone", r.operatingProfit, 10000);
check("gain lifts profit before tax", r.profitBeforeTax, 10500);
r = buildProfitAndLoss([rev, fx(300, 0)]);
check("loss is Other Expenses", r.otherExpenses.map((x) => [x.name, x.amount]), [["Foreign Exchange Loss", 300]]);
check("loss lowers profit before tax", r.profitBeforeTax, 9700);
r = buildProfitAndLoss([rev, fx(300, 500)]);
check("mixed period nets to one gain", [r.otherIncome.map((x) => x.amount), r.otherExpenses.length], [[200], 0]);
r = buildProfitAndLoss([rev, fx(500, 500)]);
check("void nets to nothing", [r.otherIncome.length, r.otherExpenses.length, r.profitBeforeTax], [0, 0, 10000]);
r = buildProfitAndLoss([rev, fx(300, 500)]);
check("profitBeforeTax equals raw net of every account (Balance Sheet invariant)", r.profitBeforeTax, 10000 + (500 - 300));

// 5. Permissions
check("permissions defined", ["forex.manage", "forex.view"].every((k) => k in PERMISSIONS), true);
check("owner has both", ["forex.manage", "forex.view"].every((k) => (DEFAULT_ROLE_PERMISSIONS.OWNER as string[]).includes(k)), true);
check("accountant has both", ["forex.manage", "forex.view"].every((k) => (DEFAULT_ROLE_PERMISSIONS.ACCOUNTANT as string[]).includes(k)), true);
check("manager/cashier have neither", ["MANAGER", "CASHIER"].some((role) => (DEFAULT_ROLE_PERMISSIONS as any)[role].some((k: string) => k.startsWith("forex."))), false);

// 6. Request schema
const base = { cashAccountId: "acc1", kind: "UNREALISED", currencyCode: " usd " };
const okRates = fxAdjustmentSchema.safeParse({ ...base, method: "RATES", foreignAmount: 1000, bookRate: 1700, newRate: 1750 });
check("rates request valid, code normalised", okRates.success && okRates.data.currencyCode, "USD");
check("rates request missing a rate rejected", fxAdjustmentSchema.safeParse({ ...base, method: "RATES", foreignAmount: 1000, bookRate: 1700 }).success, false);
check("amount request valid", fxAdjustmentSchema.safeParse({ ...base, method: "AMOUNT", direction: "LOSS", amount: 100 }).success, true);
check("amount request missing direction rejected", fxAdjustmentSchema.safeParse({ ...base, method: "AMOUNT", amount: 100 }).success, false);
check("bad currency code rejected", fxAdjustmentSchema.safeParse({ ...base, currencyCode: "US", method: "AMOUNT", direction: "GAIN", amount: 1 }).success, false);
check("bad kind rejected", fxAdjustmentSchema.safeParse({ ...base, kind: "SOMETIMES", method: "AMOUNT", direction: "GAIN", amount: 1 }).success, false);
check("negative amount rejected", fxAdjustmentSchema.safeParse({ ...base, method: "AMOUNT", direction: "GAIN", amount: -1 }).success, false);
check("void needs a reason", [voidFxAdjustmentSchema.safeParse({ reason: "  " }).success, voidFxAdjustmentSchema.safeParse({ reason: "wrong rate" }).success], [false, true]);

// 7. Summary counts recorded rows only
check("summary ignores voided, splits kinds", summariseAdjustments([
  { kind: "REALISED", status: "RECORDED", gainLossAmount: 100 },
  { kind: "UNREALISED", status: "RECORDED", gainLossAmount: -40 },
  { kind: "REALISED", status: "VOIDED", gainLossAmount: 9999 },
]), { realisedNet: 100, unrealisedNet: -40, net: 60 });

// 8. Module 40 – settling a foreign-currency Sale / Purchase
const sumSide = (ls: { debit?: number; credit?: number }[], k: "debit" | "credit") => round2(ls.reduce((a, x) => a + (x[k] ?? 0), 0));
// USD 1,000 sale booked at 1,700 (MWK 1,700,000) is paid when the rate is 1,750
let st = computeSettlement({ side: "RECEIVE", foreignAmount: 1000, bookRate: 1700, settlementRate: 1750, balance: 1700000 });
check("receive at a stronger rate = gain", st, { bookAmount: 1700000, cashAmount: 1750000, gainLoss: 50000 });
st = computeSettlement({ side: "RECEIVE", foreignAmount: 1000, bookRate: 1700, settlementRate: 1650, balance: 1700000 });
check("receive at a weaker rate = loss", st, { bookAmount: 1700000, cashAmount: 1650000, gainLoss: -50000 });
st = computeSettlement({ side: "PAY", foreignAmount: 1000, bookRate: 1700, settlementRate: 1750, balance: 1700000 });
check("pay at a stronger rate = loss", st, { bookAmount: 1700000, cashAmount: 1750000, gainLoss: -50000 });
st = computeSettlement({ side: "PAY", foreignAmount: 1000, bookRate: 1700, settlementRate: 1650, balance: 1700000 });
check("pay at a weaker rate = gain", st, { bookAmount: 1700000, cashAmount: 1650000, gainLoss: 50000 });
check("same rate = no difference", computeSettlement({ side: "RECEIVE", foreignAmount: 10, bookRate: 1700, settlementRate: 1700, balance: 17000 }).gainLoss, 0);
st = computeSettlement({ side: "RECEIVE", foreignAmount: 400, bookRate: 1700, settlementRate: 1720, balance: 1700000 });
check("partial settlement clears foreign x book rate", [st.bookAmount, st.cashAmount, st.gainLoss], [680000, 688000, 8000]);
check("foreign balance after a partial", foreignBalance(1700000 - 680000, 1700), 600);
check("last few tambala snap to close the balance", computeSettlement({ side: "RECEIVE", foreignAmount: 333.33, bookRate: 1700.5, settlementRate: 1700.5, balance: 566827.70 }).bookAmount, 566827.7);
throws("more than owing rejected", () => computeSettlement({ side: "RECEIVE", foreignAmount: 1001, bookRate: 1700, settlementRate: 1700, balance: 1700000 }));
throws("zero foreign amount rejected (settlement)", () => computeSettlement({ side: "PAY", foreignAmount: 0, bookRate: 1700, settlementRate: 1700, balance: 100 }));
throws("zero settlement rate rejected", () => computeSettlement({ side: "PAY", foreignAmount: 1, bookRate: 1700, settlementRate: 0, balance: 100 }));
for (const side of ["RECEIVE", "PAY"] as const) {
  for (const settlementRate of [1650, 1700, 1750]) {
    const r = computeSettlement({ side, foreignAmount: 1234.56, bookRate: 1700.25, settlementRate, balance: 5_000_000 });
    const lines = buildSettlementJournalLines({ side, cashGlAccountId: "CASH", controlAccountId: "CTL", fxAccountId: "FX", ...r, });
    check(`${side} @${settlementRate}: entry balances`, sumSide(lines, "debit"), sumSide(lines, "credit"));
    check(`${side} @${settlementRate}: control account moves by the booked amount`, lines.find((x) => x.accountId === "CTL")?.[side === "RECEIVE" ? "credit" : "debit"], r.bookAmount);
    check(`${side} @${settlementRate}: cash leg is what actually moved`, lines.find((x) => x.accountId === "CASH")?.[side === "RECEIVE" ? "debit" : "credit"], r.cashAmount);
    check(`${side} @${settlementRate}: stored payment reproduces cash`, cashAmountForPayment(r.bookAmount, r.gainLoss, side), r.cashAmount);
    check(`${side} @${settlementRate}: FX line only when there is a difference`, lines.some((x) => x.accountId === "FX"), r.gainLoss !== 0);
  }
}
const gainEntry = buildSettlementJournalLines({ side: "RECEIVE", cashGlAccountId: "CASH", controlAccountId: "AR", fxAccountId: "FX", bookAmount: 1700000, cashAmount: 1750000, gainLoss: 50000 });
check("receive gain: Dr cash / Cr AR / Cr FX", gainEntry, [{ accountId: "CASH", debit: 1750000 }, { accountId: "AR", credit: 1700000 }, { accountId: "FX", credit: 50000 }]);
const lossEntry = buildSettlementJournalLines({ side: "PAY", cashGlAccountId: "CASH", controlAccountId: "AP", fxAccountId: "FX", bookAmount: 1700000, cashAmount: 1750000, gainLoss: -50000 });
check("pay loss: Dr AP / Cr cash / Dr FX", lossEntry, [{ accountId: "AP", debit: 1700000 }, { accountId: "CASH", credit: 1750000 }, { accountId: "FX", debit: 50000 }]);
// A settlement gain reads as Other Income on the P&L, exactly like a Module 39 adjustment
r = buildProfitAndLoss([rev, fx(0, 50000)]);
check("settlement gain is non-operating income", [r.operatingProfit, r.profitBeforeTax], [10000, 60000]);

// Request schemas
const saleBase = { items: [{ productId: "p", quantity: 1, unitPrice: 100 }], paymentMethod: "CASH", amountPaid: 100 };
check("sale with currency + rate valid, code normalised", (() => { const x = saleSchema.safeParse({ ...saleBase, currency: "usd", exchangeRate: 1750 }); return x.success && x.data.currency; })(), "USD");
check("sale with currency but no rate rejected", saleSchema.safeParse({ ...saleBase, currency: "USD" }).success, false);
check("sale with rate but no currency rejected", saleSchema.safeParse({ ...saleBase, exchangeRate: 1750 }).success, false);
check("sale with neither still valid (kwacha document)", saleSchema.safeParse(saleBase).success, true);
check("sale with bad currency code rejected", saleSchema.safeParse({ ...saleBase, currency: "DOLLAR", exchangeRate: 1 }).success, false);
const purBase = { supplierId: "s", items: [{ productId: "p", quantity: 1, unitCost: 10 }], paymentMethod: "CREDIT", amountPaid: 0 };
check("purchase currency pair rules", [purchaseSchema.safeParse({ ...purBase, currency: "ZAR", exchangeRate: 95 }).success, purchaseSchema.safeParse({ ...purBase, currency: "ZAR" }).success, purchaseSchema.safeParse(purBase).success], [true, false, true]);
const setBase = { saleId: "s1", foreignAmount: 100, settlementRate: 1750, method: "BANK" };
check("settlement request valid", foreignSettlementSchema.safeParse(setBase).success, true);
check("settlement needs exactly one document", [foreignSettlementSchema.safeParse({ ...setBase, purchaseId: "p1" }).success, foreignSettlementSchema.safeParse({ foreignAmount: 1, settlementRate: 1, method: "BANK" }).success], [false, false]);
check("settlement can't use CREDIT", foreignSettlementSchema.safeParse({ ...setBase, method: "CREDIT" }).success, false);
check("settlement needs positive amount and rate", [foreignSettlementSchema.safeParse({ ...setBase, foreignAmount: 0 }).success, foreignSettlementSchema.safeParse({ ...setBase, settlementRate: -1 }).success], [false, false]);

console.log(`${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
