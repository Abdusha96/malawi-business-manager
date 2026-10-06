import { prisma } from "./prisma";
import { postCashTransactionForPayroll } from "./cashbook";
import { postJournalEntryForPayroll } from "./accounting-integrations";
import { PaymentMethod } from "@prisma/client";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface TaxBand {
  min: number;
  max: number | null; // null = no upper bound (top band)
  rate: number; // percent, e.g. 30 for 30%
}

/**
 * EXAMPLE bands only – seeded at business registration, NOT real current
 * Malawi Revenue Authority figures. This app is not the source of truth
 * for tax law; every screen that shows these carries a disclaimer, and
 * TaxConfiguration.isExample stays true until an Owner/Accountant
 * consciously reviews and re-saves the configuration (see the tax settings
 * route). The shape (progressive bands) is what matters here, not the
 * specific numbers – an admin must verify and set real rates before
 * running real payroll.
 */
export const EXAMPLE_PAYE_BANDS: TaxBand[] = [
  { min: 0, max: 100000, rate: 0 },
  { min: 100000, max: 300000, rate: 25 },
  { min: 300000, max: 3000000, rate: 30 },
  { min: 3000000, max: null, rate: 35 },
];

export const EXAMPLE_PENSION_EMPLOYEE_RATE = 5;
export const EXAMPLE_PENSION_EMPLOYER_RATE = 10;

// Module 18 (VAT) – Malawi's standard VAT rate at time of writing, seeded
// as an EXAMPLE like everything else in this file (see the disclaimer
// above). Lives here rather than in src/lib/vat.ts to avoid that file
// needing to import from here just for a constant used only at seed time –
// vat.ts imports getOrCreateTaxConfiguration from this file already, so
// keeping the constant here too avoids a second import for one number.
export const EXAMPLE_VAT_STANDARD_RATE = 16.5;

// Module 19 (Withholding Tax) – same EXAMPLE disclaimer as everything else
// in this file: a flat percent per payment type, not verified current MRA
// figures. Lives here for the same reason EXAMPLE_VAT_STANDARD_RATE does –
// src/lib/withholding-tax.ts already imports getOrCreateTaxConfiguration
// from this file, so seed-time constants stay co-located with the function
// that uses them rather than creating a second cross-import just for data.
export interface WithholdingTaxRate {
  category: "RENT" | "COMMISSION" | "PROFESSIONAL_FEES" | "CONTRACTOR_FEES" | "CASUAL_LABOUR" | "PUBLIC_ENTERTAINMENT_FEE";
  rate: number; // percent
}

export const EXAMPLE_WITHHOLDING_TAX_RATES: WithholdingTaxRate[] = [
  { category: "RENT", rate: 15 },
  { category: "COMMISSION", rate: 20 },
  { category: "PROFESSIONAL_FEES", rate: 10 },
  { category: "CONTRACTOR_FEES", rate: 4 },
  { category: "CASUAL_LABOUR", rate: 20 },
  { category: "PUBLIC_ENTERTAINMENT_FEE", rate: 5 },
];

// Module 20 (Corporate Tax) – Malawi's standard resident company income
// tax rate at time of writing, same EXAMPLE disclaimer as everything else
// in this file. Lives here for the same co-location reason
// EXAMPLE_VAT_STANDARD_RATE does: src/lib/corporate-tax.ts imports
// getOrCreateTaxConfiguration from this file already.
export const EXAMPLE_CORPORATE_TAX_RATE = 30;

/**
 * Progressive tax calculation: each band only taxes the portion of income
 * that falls within it, not the whole amount at that band's rate. Reads
 * bands as plain data – nothing here is a hard-coded percentage, fulfilling
 * spec section 18's explicit requirement.
 */
export function computePAYE(taxableIncome: number, bands: TaxBand[]): number {
  let tax = 0;
  const sorted = [...bands].sort((a, b) => a.min - b.min);

  for (const band of sorted) {
    if (taxableIncome <= band.min) break;
    const upper = band.max === null ? taxableIncome : Math.min(taxableIncome, band.max);
    const taxableInBand = Math.max(0, upper - band.min);
    tax += taxableInBand * (band.rate / 100);
  }

  return round2(tax);
}

export function computePension(grossSalary: number, employeeRate: number, employerRate: number) {
  return {
    employeeContribution: round2(grossSalary * (employeeRate / 100)),
    employerContribution: round2(grossSalary * (employerRate / 100)),
  };
}

export interface PayrollCalculationInput {
  grossSalary: number;
  allowances: number;
  otherDeductions: number;
  bands: TaxBand[];
  pensionEmployeeRate: number;
  pensionEmployerRate: number;
}

/**
 * Full payroll calculation for one employee, one period. Taxable income is
 * gross salary + allowances, before pension deduction – this is a common
 * convention, but whether pension is deductible from taxable income before
 * PAYE is a real jurisdiction-specific policy detail an Owner/Accountant
 * must configure correctly, not something to assume silently. Kept as a
 * pure function (no DB access) so it's directly unit-testable.
 */
export function calculatePayroll(input: PayrollCalculationInput) {
  const taxableIncome = input.grossSalary + input.allowances;
  const paye = computePAYE(taxableIncome, input.bands);
  const pension = computePension(input.grossSalary, input.pensionEmployeeRate, input.pensionEmployerRate);

  const netSalary = round2(
    input.grossSalary + input.allowances - paye - pension.employeeContribution - input.otherDeductions
  );

  return {
    grossSalary: round2(input.grossSalary),
    allowances: round2(input.allowances),
    taxableIncome: round2(taxableIncome),
    paye,
    pensionEmployee: pension.employeeContribution,
    pensionEmployer: pension.employerContribution,
    otherDeductions: round2(input.otherDeductions),
    netSalary,
  };
}

/**
 * Loads a business's TaxConfiguration, creating an example one if it
 * somehow doesn't exist (defensive – registration seeds this, but this
 * keeps payroll from hard-failing for a business created before this
 * module existed).
 */
export async function getOrCreateTaxConfiguration(businessId: string) {
  const existing = await prisma.taxConfiguration.findUnique({ where: { businessId } });
  if (existing) {
    // Module 19 backfill: a business that registered before withholding tax
    // existed has a TaxConfiguration row with withholdingTaxRates still
    // null – fill it in with the same EXAMPLE rates a fresh registration
    // gets, rather than making every caller handle null. Doesn't touch
    // isExample: if this business already reviewed and saved real PAYE/VAT
    // rates, it shouldn't be silently flipped back to "unreviewed" just
    // because withholding tax rates are still placeholders.
    if (existing.withholdingTaxRates == null) {
      return prisma.taxConfiguration.update({
        where: { businessId },
        data: { withholdingTaxRates: EXAMPLE_WITHHOLDING_TAX_RATES as any },
      });
    }
    return existing;
  }

  return prisma.taxConfiguration.create({
    data: {
      businessId,
      payeBands: EXAMPLE_PAYE_BANDS as any,
      pensionEmployeeRate: EXAMPLE_PENSION_EMPLOYEE_RATE,
      pensionEmployerRate: EXAMPLE_PENSION_EMPLOYER_RATE,
      vatStandardRate: EXAMPLE_VAT_STANDARD_RATE,
      withholdingTaxRates: EXAMPLE_WITHHOLDING_TAX_RATES as any,
      corporateTaxRate: EXAMPLE_CORPORATE_TAX_RATE,
      isExample: true,
    },
  });
}

export class PayrollError extends Error {}

/**
 * Creates or updates a DRAFT payroll row for one employee/period. Always
 * recalculates from the employee's current monthlySalary and the business's
 * current TaxConfiguration – so if either changes before this run is paid,
 * re-saving picks up the correction rather than a run silently drifting
 * from what the employee record now says.
 */
export async function upsertPayrollRun(params: {
  businessId: string;
  employeeId: string;
  payPeriod: string; // "YYYY-MM"
  allowances: number;
  allowanceNotes?: string;
  otherDeductions: number;
  otherDeductionNotes?: string;
  createdById: string;
}) {
  const { businessId, employeeId, payPeriod } = params;

  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee || employee.businessId !== businessId) {
    throw new PayrollError("Employee not found in this business.");
  }

  const existing = await prisma.payroll.findUnique({
    where: { businessId_employeeId_payPeriod: { businessId, employeeId, payPeriod } },
  });
  if (existing?.status === "PAID") {
    throw new PayrollError("This payroll run has already been paid and cannot be changed.");
  }

  const taxConfig = await getOrCreateTaxConfiguration(businessId);
  const calculation = calculatePayroll({
    grossSalary: Number(employee.monthlySalary),
    allowances: params.allowances,
    otherDeductions: params.otherDeductions,
    bands: taxConfig.payeBands as unknown as TaxBand[],
    pensionEmployeeRate: Number(taxConfig.pensionEmployeeRate),
    pensionEmployerRate: Number(taxConfig.pensionEmployerRate),
  });

  const data = {
    businessId,
    employeeId,
    // Module 29: re-derived from the employee's CURRENT branch on every
    // (re)calculation, same "always recalculates, never drifts" philosophy
    // as grossSalary/taxConfig above – if the employee is reassigned to a
    // different branch before this run is paid, re-saving picks up the
    // correction. Once PAID, the row above already blocks further saves,
    // so this becomes a permanent snapshot at that point.
    branchId: employee.branchId,
    payPeriod,
    grossSalary: calculation.grossSalary,
    allowances: calculation.allowances,
    allowanceNotes: params.allowanceNotes,
    paye: calculation.paye,
    pensionEmployee: calculation.pensionEmployee,
    pensionEmployer: calculation.pensionEmployer,
    otherDeductions: calculation.otherDeductions,
    otherDeductionNotes: params.otherDeductionNotes,
    netSalary: calculation.netSalary,
    createdById: params.createdById,
  };

  if (existing) {
    return prisma.payroll.update({ where: { id: existing.id }, data });
  }
  return prisma.payroll.create({ data: { ...data, status: "DRAFT" } });
}

/**
 * Marks a payroll run PAID and posts the net salary as a Cashbook outflow
 * (Module 9) – the same integration pattern as Expenses. Once paid, a
 * payroll run is immutable (upsertPayrollRun refuses to touch it) –
 * correcting a paid run means a new adjustment entry, not silently editing
 * history, the same principle applied to voided sales/purchases.
 */
export async function payPayrollRun(params: {
  businessId: string;
  payrollId: string;
  paymentMethod: PaymentMethod;
  userId: string;
}) {
  const { businessId, payrollId, paymentMethod, userId } = params;

  return prisma.$transaction(async (tx) => {
    const payroll = await tx.payroll.findUnique({ where: { id: payrollId }, include: { employee: true } });
    if (!payroll || payroll.businessId !== businessId) {
      throw new PayrollError("Payroll run not found in this business.");
    }
    if (payroll.status === "PAID") {
      throw new PayrollError("This payroll run has already been paid.");
    }

    const updated = await tx.payroll.update({
      where: { id: payrollId },
      data: { status: "PAID", paymentMethod, paidAt: new Date() },
    });

    await postCashTransactionForPayroll({
      tx,
      businessId,
      payrollId: updated.id,
      netSalary: Number(updated.netSalary),
      paymentMethod,
      createdById: userId,
      branchId: updated.branchId,
    });

    await postJournalEntryForPayroll({
      tx,
      businessId,
      payrollId: updated.id,
      payPeriod: updated.payPeriod,
      employeeName: payroll.employee.name,
      grossSalary: Number(updated.grossSalary),
      allowances: Number(updated.allowances),
      paye: Number(updated.paye),
      pensionEmployee: Number(updated.pensionEmployee),
      pensionEmployer: Number(updated.pensionEmployer),
      otherDeductions: Number(updated.otherDeductions),
      netSalary: Number(updated.netSalary),
      paymentMethod,
      createdById: userId,
    });

    return updated;
  });
}
