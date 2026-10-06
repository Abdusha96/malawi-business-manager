import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { registerSchema } from "@/lib/validation";
import { normalizePhone } from "@/lib/auth";
import { createEmailVerificationToken } from "@/lib/tokens";
import { TRIAL_LENGTH_DAYS, TRIAL_PLAN_KEY } from "@/lib/plans";
import { EXAMPLE_PAYE_BANDS, EXAMPLE_PENSION_EMPLOYEE_RATE, EXAMPLE_PENSION_EMPLOYER_RATE } from "@/lib/payroll";
import { seedChartOfAccounts } from "@/lib/accounting";
import { sendEmail, TEMPLATE_KEYS } from "@/lib/notifications";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = registerSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const data = parsed.data;
  const normalizedEmail = data.email.toLowerCase();
  const normalizedPhone = normalizePhone(data.phone);

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email: normalizedEmail }, { phone: normalizedPhone }] },
  });

  if (existing) {
    return NextResponse.json(
      { error: "account_exists", message: "An account with this email or phone already exists." },
      { status: 409 }
    );
  }

  const trialPlan = await prisma.subscriptionPlan.findUnique({ where: { key: TRIAL_PLAN_KEY } });
  if (!trialPlan) {
    // Indicates the plans haven't been seeded – fail loudly rather than
    // silently registering a business with no subscription record.
    return NextResponse.json(
      { error: "server_not_ready", message: "Subscription plans are not configured." },
      { status: 500 }
    );
  }

  const passwordHash = await hashPassword(data.password);
  const trialEndsAt = new Date(Date.now() + TRIAL_LENGTH_DAYS * 24 * 60 * 60 * 1000);

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name: data.ownerName,
        email: normalizedEmail,
        phone: normalizedPhone,
        passwordHash,
      },
    });

    const business = await tx.business.create({
      data: {
        name: data.businessName,
        ownerName: data.ownerName,
        phone: normalizedPhone,
        email: normalizedEmail,
        businessType: data.businessType,
        district: data.district,
        city: data.city,
        physicalAddress: data.physicalAddress,
        taxpayerId: data.taxpayerId,
        currency: data.currency,
        financialYearStartMonth: data.financialYearStartMonth,
        numberOfEmployees: data.numberOfEmployees ?? 0,
      },
    });

    const headOffice = await tx.branch.create({
      data: {
        businessId: business.id,
        name: "Head Office",
        isHeadOffice: true,
        district: data.district,
        city: data.city,
        address: data.physicalAddress,
      },
    });

    await tx.businessMember.create({
      data: {
        businessId: business.id,
        userId: user.id,
        role: "OWNER",
        branchId: headOffice.id,
        acceptedAt: new Date(),
      },
    });

    await tx.subscription.create({
      data: {
        businessId: business.id,
        planId: trialPlan.id,
        status: "TRIAL",
        billingCycle: "MONTHLY",
        trialEndsAt,
        currentPeriodStart: new Date(),
        currentPeriodEnd: trialEndsAt,
      },
    });

    // Seed the four default cash accounts from spec section 13 so the
    // Cashbook has somewhere to post to from day one, rather than relying
    // solely on getOrCreateDefaultAccount's lazy fallback.
    await tx.cashAccount.createMany({
      data: [
        { businessId: business.id, type: "CASH", name: "Cash", isDefault: true },
        { businessId: business.id, type: "BANK", name: "Bank", isDefault: false },
        { businessId: business.id, type: "AIRTEL_MONEY", name: "Airtel Money", isDefault: true },
        { businessId: business.id, type: "TNM_MPAMBA", name: "TNM Mpamba", isDefault: true },
      ],
    });

    // Seed an EXAMPLE tax configuration (spec section 18/19) – isExample
    // stays true until an Owner/Accountant reviews and re-saves it, which
    // drives the disclaimer banner on every payroll/tax screen.
    await tx.taxConfiguration.create({
      data: {
        businessId: business.id,
        payeBands: EXAMPLE_PAYE_BANDS as any,
        pensionEmployeeRate: EXAMPLE_PENSION_EMPLOYEE_RATE,
        pensionEmployerRate: EXAMPLE_PENSION_EMPLOYER_RATE,
        isExample: true,
      },
    });

    // Seed the standard chart of accounts (spec section 20) so every
    // transaction from day one has somewhere to post a journal entry.
    await seedChartOfAccounts(tx, business.id);

    await tx.auditLog.create({
      data: {
        businessId: business.id,
        userId: user.id,
        action: "business.register",
        entityType: "Business",
        entityId: business.id,
        ipAddress: req.headers.get("x-forwarded-for") ?? undefined,
      },
    });

    return { user, business };
  });

  const { token } = await createEmailVerificationToken(result.user.id);

  await sendEmail({
    businessId: result.business.id,
    userId: result.user.id,
    to: normalizedEmail,
    subject: "Verify your email – Malawi Business Manager",
    body: `Hi ${data.ownerName},\n\nWelcome to Malawi Business Manager. Verify your email address to finish setting up your business:\n\n${process.env.NEXTAUTH_URL ?? ""}/verify-email?token=${token}\n\nIf you didn't create this account, you can ignore this email.`,
    templateKey: TEMPLATE_KEYS.EMAIL_VERIFICATION,
    relatedEntityType: "User",
    relatedEntityId: result.user.id,
  });

  return NextResponse.json(
    {
      message: "Business registered successfully. A 14-day Professional trial has started.",
      businessId: result.business.id,
      userId: result.user.id,
      trialEndsAt,
    },
    { status: 201 }
  );
}
