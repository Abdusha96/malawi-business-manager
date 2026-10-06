import { PrismaClient } from "@prisma/client";
import { PLAN_DEFINITIONS } from "../src/lib/plans";
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, PermissionKey } from "../src/lib/permissions";

const prisma = new PrismaClient();

async function seedSubscriptionPlans() {
  for (const plan of PLAN_DEFINITIONS) {
    await prisma.subscriptionPlan.upsert({
      where: { key: plan.key },
      update: {
        name: plan.name,
        monthlyPriceMWK: Math.round(plan.monthlyPriceMWK),
        annualPriceMWK: Math.round(plan.annualPriceMWK),
        isCustomPricing: plan.isCustomPricing,
        maxUsers: plan.maxUsers,
        maxBranches: plan.maxBranches,
        maxSalesPerMonth: plan.maxSalesPerMonth,
        features: plan.features,
      },
      create: {
        key: plan.key,
        name: plan.name,
        monthlyPriceMWK: Math.round(plan.monthlyPriceMWK),
        annualPriceMWK: Math.round(plan.annualPriceMWK),
        isCustomPricing: plan.isCustomPricing,
        maxUsers: plan.maxUsers,
        maxBranches: plan.maxBranches,
        maxSalesPerMonth: plan.maxSalesPerMonth,
        features: plan.features,
      },
    });
  }
  console.log(`Seeded ${PLAN_DEFINITIONS.length} subscription plans.`);
}

async function seedPermissions() {
  const keys = Object.keys(PERMISSIONS) as PermissionKey[];

  const permissionRecords = await Promise.all(
    keys.map((key) =>
      prisma.permission.upsert({
        where: { key },
        update: { description: PERMISSIONS[key] },
        create: { key, description: PERMISSIONS[key] },
      })
    )
  );

  const permissionIdByKey = new Map(permissionRecords.map((p) => [p.key, p.id]));

  for (const [role, permissionKeys] of Object.entries(DEFAULT_ROLE_PERMISSIONS) as [
    keyof typeof DEFAULT_ROLE_PERMISSIONS,
    PermissionKey[]
  ][]) {
    for (const key of permissionKeys) {
      const permissionId = permissionIdByKey.get(key)!;
      await prisma.rolePermission.upsert({
        where: { role_permissionId: { role: role as any, permissionId } },
        update: {},
        create: { role: role as any, permissionId },
      });
    }
  }

  console.log(`Seeded ${permissionRecords.length} permissions and role grants.`);
}

async function main() {
  await seedSubscriptionPlans();
  await seedPermissions();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
