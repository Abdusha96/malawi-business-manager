import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiContext } from "@/lib/api-context";
import { taxConfigurationSchema, WITHHOLDING_TAX_CATEGORIES } from "@/lib/validation";
import { getOrCreateTaxConfiguration } from "@/lib/payroll";
import { logAudit } from "@/lib/audit";

export async function GET(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "tax.manage");
  if (ctx instanceof NextResponse) return ctx;

  const [config, business] = await Promise.all([
    getOrCreateTaxConfiguration(params.businessId),
    prisma.business.findUniqueOrThrow({
      where: { id: params.businessId },
      // Module 20: financialYearStartMonth now rides along with
      // vatRegistered/vatNumber – same "load everything this one settings
      // page needs" reasoning Module 18 used.
      select: { vatRegistered: true, vatNumber: true, financialYearStartMonth: true },
    }),
  ]);
  return NextResponse.json({ config, business });
}

export async function PUT(req: NextRequest, props: { params: Promise<{ businessId: string }> }) {
  const params = await props.params;
  const ctx = await requireApiContext(params.businessId, "tax.manage");
  if (ctx instanceof NextResponse) return ctx;
  const { userId } = ctx;

  const parsed = taxConfigurationSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error", details: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  // Basic sanity check: bands shouldn't overlap or leave gaps in a way that
  // would silently under/over-tax. A full validator (contiguous, ascending,
  // no gaps) is worth building if this becomes a support burden – for now,
  // catch the most obvious mistake: unsorted or overlapping ranges.
  const sorted = [...data.payeBands].sort((a, b) => a.min - b.min);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].min < (sorted[i - 1].max ?? Infinity)) {
      return NextResponse.json(
        {
          error: "validation_error",
          message: `Tax bands overlap: band starting at ${sorted[i].min} begins before the previous band ends.`,
        },
        { status: 400 }
      );
    }
  }

  // Module 19 (Withholding Tax): fill in 0 for any WITHHOLDING_TAX_CATEGORIES
  // value the client didn't submit, rather than rejecting an incomplete
  // payload – mirrors how a freshly-registered business's rates start at
  // whatever EXAMPLE_WITHHOLDING_TAX_RATES seeds, not a hard requirement
  // that every category be explicitly reviewed before saving any of them.
  const withholdingTaxRates = WITHHOLDING_TAX_CATEGORIES.map((category) => ({
    category,
    rate: data.withholdingTaxRates.find((r) => r.category === category)?.rate ?? 0,
  }));

  const existing = await getOrCreateTaxConfiguration(params.businessId);

  // Module 18 (VAT): Business.vatRegistered/vatNumber and
  // TaxConfiguration.vatStandardRate save together with PAYE/pension in
  // this one PUT – see the comment on taxConfigurationSchema in
  // validation.ts for why this is one review action, not two.
  const [business, config] = await prisma.$transaction([
    prisma.business.update({
      where: { id: params.businessId },
      // Module 20: financialYearStartMonth bundled in alongside
      // vatRegistered/vatNumber – see the schema comment on
      // Business.financialYearStartMonth for why it lives here rather than
      // a separate general-settings page (which this app doesn't have yet).
      data: {
        vatRegistered: data.vatRegistered,
        vatNumber: data.vatNumber || null,
        financialYearStartMonth: data.financialYearStartMonth,
      },
    }),
    prisma.taxConfiguration.update({
      where: { businessId: params.businessId },
      data: {
        payeBands: data.payeBands as any,
        pensionEmployeeRate: data.pensionEmployeeRate,
        pensionEmployerRate: data.pensionEmployerRate,
        vatStandardRate: data.vatStandardRate,
        withholdingTaxRates: withholdingTaxRates as any,
        corporateTaxRate: data.corporateTaxRate,
        vatPartialExemptionEnabled: data.vatPartialExemptionEnabled,
        vatDeMinimisPercent: data.vatDeMinimisPercent,
        isExample: false, // an Owner/Accountant has now explicitly reviewed and saved real rates
        updatedById: userId,
      },
    }),
  ]);

  await logAudit({
    businessId: params.businessId,
    userId,
    action: "tax_configuration.update",
    entityType: "TaxConfiguration",
    entityId: existing.id,
    metadata: {
      pensionEmployeeRate: data.pensionEmployeeRate,
      pensionEmployerRate: data.pensionEmployerRate,
      vatRegistered: data.vatRegistered,
      vatStandardRate: data.vatStandardRate,
      withholdingTaxRates,
      corporateTaxRate: data.corporateTaxRate,
      financialYearStartMonth: data.financialYearStartMonth,
      vatPartialExemptionEnabled: data.vatPartialExemptionEnabled,
      vatDeMinimisPercent: data.vatDeMinimisPercent,
    },
  });

  return NextResponse.json({ config, business });
}
