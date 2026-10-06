/**
 * Plan definitions matching spec section 4. Prices and limits live in the
 * SubscriptionPlan DB table (seeded from this file) rather than being
 * hard-coded at check-sites, so an admin can adjust pricing/limits from the
 * admin dashboard (Module: Admin) without a deploy.
 *
 * `features` is a flat boolean/limit map. Feature-gating a UI element or API
 * route should call `planHasFeature(plan, "payroll")`, never check the plan
 * key string directly – that way ENTERPRISE (or a future custom plan)
 * automatically inherits everything without listing it explicitly.
 */

export type FeatureKey =
  | "unlimitedSales"
  | "suppliers"
  | "multiUser"
  | "payroll"
  | "taxCalculations"
  | "advancedReports"
  | "aiAssistant"
  | "multiBranch"
  | "accountantAccess"
  | "automatedBackups"
  | "advancedAnalytics"
  | "apiAccess"
  | "advancedPermissions"
  | "customReports"
  | "advancedIntegrations";

export interface PlanDefinition {
  key: "FREE" | "BUSINESS" | "PROFESSIONAL" | "ENTERPRISE";
  name: string;
  monthlyPriceMWK: number;
  annualPriceMWK: number;
  isCustomPricing: boolean;
  maxUsers: number | null; // null = unlimited
  maxBranches: number | null;
  maxSalesPerMonth: number | null;
  features: Record<FeatureKey, boolean>;
}

const noFeatures: Record<FeatureKey, boolean> = {
  unlimitedSales: false,
  suppliers: false,
  multiUser: false,
  payroll: false,
  taxCalculations: false,
  advancedReports: false,
  aiAssistant: false,
  multiBranch: false,
  accountantAccess: false,
  automatedBackups: false,
  advancedAnalytics: false,
  apiAccess: false,
  advancedPermissions: false,
  customReports: false,
  advancedIntegrations: false,
};

export const PLAN_DEFINITIONS: PlanDefinition[] = [
  {
    key: "FREE",
    name: "Free",
    monthlyPriceMWK: 0,
    annualPriceMWK: 0,
    isCustomPricing: false,
    maxUsers: 1,
    maxBranches: 1,
    maxSalesPerMonth: 50,
    features: { ...noFeatures },
  },
  {
    key: "BUSINESS",
    name: "Business",
    monthlyPriceMWK: 5000,
    annualPriceMWK: 5000 * 12 * 0.85, // 15% annual discount, see billing.ts
    isCustomPricing: false,
    maxUsers: null,
    maxBranches: 1,
    maxSalesPerMonth: null,
    features: { ...noFeatures, unlimitedSales: true, suppliers: true, multiUser: true },
  },
  {
    key: "PROFESSIONAL",
    name: "Professional",
    monthlyPriceMWK: 15000,
    annualPriceMWK: 15000 * 12 * 0.85,
    isCustomPricing: false,
    maxUsers: null,
    maxBranches: null,
    maxSalesPerMonth: null,
    features: {
      ...noFeatures,
      unlimitedSales: true,
      suppliers: true,
      multiUser: true,
      payroll: true,
      taxCalculations: true,
      advancedReports: true,
      aiAssistant: true,
      multiBranch: true,
      accountantAccess: true,
      automatedBackups: true,
      advancedAnalytics: true,
    },
  },
  {
    key: "ENTERPRISE",
    name: "Enterprise",
    monthlyPriceMWK: 0,
    annualPriceMWK: 0,
    isCustomPricing: true,
    maxUsers: null,
    maxBranches: null,
    maxSalesPerMonth: null,
    features: {
      unlimitedSales: true,
      suppliers: true,
      multiUser: true,
      payroll: true,
      taxCalculations: true,
      advancedReports: true,
      aiAssistant: true,
      multiBranch: true,
      accountantAccess: true,
      automatedBackups: true,
      advancedAnalytics: true,
      apiAccess: true,
      advancedPermissions: true,
      customReports: true,
      advancedIntegrations: true,
    },
  },
];

export const TRIAL_LENGTH_DAYS = 14;
export const TRIAL_PLAN_KEY = "PROFESSIONAL"; // new businesses trial the Professional tier

export function getPlanDefinition(key: string): PlanDefinition {
  const plan = PLAN_DEFINITIONS.find((p) => p.key === key);
  if (!plan) throw new Error(`Unknown plan key: ${key}`);
  return plan;
}

export function planHasFeature(plan: PlanDefinition, feature: FeatureKey): boolean {
  return plan.features[feature] === true;
}
