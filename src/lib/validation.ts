import { z } from "zod";
import { MAX_CSV_CHARS } from "./bank-statement-csv";
import { TAX_PAYMENT_TYPES } from "./tax-period";
import { isSupportedTimeZone } from "./timezone";
import { MIN_MAX_REOPENS, MAX_MAX_REOPENS } from "./reopen-constants";
import { MIN_STALE_TRANSFER_ALERT_DAYS, MAX_STALE_TRANSFER_ALERT_DAYS } from "./stale-transfer";
import {
  MIN_SERVICE_COST_ALERT_DAYS,
  MAX_SERVICE_COST_ALERT_DAYS,
  MAX_BULK_SETTLEMENT_SERVICES,
} from "./service-cost-clearing";

// Validated on both client and server per the "validate forms on both
// client and server" development rule – this file is imported by both.

export const registerSchema = z.object({
  // Owner / user account
  ownerName: z.string().min(2, "Owner name is required"),
  email: z.string().email("Enter a valid email address"),
  phone: z
    .string()
    .regex(/^(\+265|0)[0-9]{9}$/, "Enter a valid Malawian phone number, e.g. 0991234567"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Password must contain an uppercase letter")
    .regex(/[a-z]/, "Password must contain a lowercase letter")
    .regex(/[0-9]/, "Password must contain a number"),

  // Business
  businessName: z.string().min(2, "Business name is required"),
  businessType: z.string().min(2, "Select a business type"),
  district: z.string().min(2, "District is required"),
  city: z.string().min(1, "City/Town is required"),
  physicalAddress: z.string().optional(),
  taxpayerId: z.string().optional(),
  currency: z.string().default("MWK"),
  financialYearStartMonth: z.number().int().min(1).max(12).default(1),
  numberOfEmployees: z.number().int().min(0).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  identifier: z.string().min(3, "Enter your email or phone number"),
  password: z.string().min(1, "Password is required"),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email("Enter a valid email address"),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(10),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Password must contain an uppercase letter")
    .regex(/[a-z]/, "Password must contain a lowercase letter")
    .regex(/[0-9]/, "Password must contain a number"),
});

export const BUSINESS_TYPES = [
  "Grocery Shop",
  "Boutique",
  "Salon / Barbershop",
  "Restaurant",
  "Hardware Shop",
  "Pharmacy",
  "Phone Accessories",
  "Wholesaler",
  "Freelancer",
  "Farming / Agribusiness",
  "Service Business",
  "Accounting Firm",
  "Other",
] as const;

export const MALAWI_DISTRICTS = [
  "Balaka", "Blantyre", "Chikwawa", "Chiradzulu", "Chitipa", "Dedza", "Dowa",
  "Karonga", "Kasungu", "Likoma", "Lilongwe", "Machinga", "Mangochi",
  "Mchinji", "Mulanje", "Mwanza", "Mzimba", "Neno", "Nkhata Bay", "Nkhotakota",
  "Nsanje", "Ntcheu", "Ntchisi", "Phalombe", "Rumphi", "Salima", "Thyolo",
  "Zomba",
] as const;

// ----------------------------------------------------------------------------
// PRODUCTS & INVENTORY (Module 2)
// ----------------------------------------------------------------------------

export const PRODUCT_UNITS = ["each", "kg", "g", "litre", "ml", "box", "pack", "dozen"] as const;

// Module 18 (VAT) – see src/lib/vat.ts for what each category means.
export const VAT_CATEGORIES = ["STANDARD", "ZERO_RATED", "EXEMPT"] as const;

export const productSchema = z.object({
  name: z.string().min(1, "Product name is required"),
  categoryId: z.string().optional().nullable(),
  sku: z.string().optional().nullable(),
  barcode: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  purchasePrice: z.number().nonnegative("Purchase price cannot be negative"),
  sellingPrice: z.number().nonnegative("Selling price cannot be negative"),
  openingQuantity: z.number().nonnegative().default(0),
  // Module 28: which branch the opening quantity should be attributed to
  // (creates that branch's first StockLevel row). Optional – a product
  // created with no branch chosen behaves exactly as it did before this
  // module: Product.quantity is set, no StockLevel row is created.
  branchId: z.string().optional().nullable(),
  unit: z.enum(PRODUCT_UNITS).default("each"),
  reorderLevel: z.number().nonnegative().default(0),
  expiryDate: z.string().datetime().optional().nullable(),
  imageUrl: z.string().url().optional().nullable(),
  vatCategory: z.enum(VAT_CATEGORIES).default("STANDARD"),
  // Module 77: false = a service with no stock. The stock-only fields (opening quantity, reorder level, expiry
  // date) are checked against it by validateProductKind() in src/lib/product-kind.ts, not here, so
  // productUpdateSchema below can still derive from this object with .omit()/.partial().
  isStocked: z.boolean().default(true),
});

export type ProductInput = z.infer<typeof productSchema>;

// Partial version for edits – opening quantity isn't editable directly here;
// stock changes go through the adjustment endpoint so they're always logged.
// branchId is also dropped – it only ever meant "where opening stock landed"
// at creation time, and editing a product shouldn't re-trigger that.
export const productUpdateSchema = productSchema
  .omit({ openingQuantity: true, branchId: true })
  .partial();

export const categorySchema = z.object({
  name: z.string().min(1, "Category name is required"),
});

// Module 53: a branch's own reorder-level override for one product. null
// clears the override (falls back to the product's business-wide
// reorderLevel); a number (0 included – "don't track this branch") sets
// one. z.number() alone would reject null, so the override is spelled out
// explicitly rather than reusing productSchema's plain reorderLevel field.
export const branchReorderLevelSchema = z.object({
  branchId: z.string().min(1, "branchId is required"),
  reorderLevel: z.number().nonnegative().nullable(),
});

export type BranchReorderLevelInput = z.infer<typeof branchReorderLevelSchema>;

// Module 60: bulk counterpart – no branchId, applies (or clears) the same
// level across every branch the business has.
export const bulkBranchReorderLevelSchema = z.object({
  reorderLevel: z.number().nonnegative().nullable(),
});

export type BulkBranchReorderLevelInput = z.infer<typeof bulkBranchReorderLevelSchema>;

export const stockAdjustmentSchema = z.object({
  delta: z.number().refine((n) => n !== 0, "Adjustment cannot be zero"),
  reason: z.string().min(1, "A reason is required for stock adjustments"),
  // Module 28: optional – an adjustment attributed to a branch also
  // updates that branch's StockLevel, not just the business-wide total.
  branchId: z.string().optional().nullable(),
});

// ----------------------------------------------------------------------------
// CUSTOMERS (minimal – Module 3; expanded in the Customers module)
// ----------------------------------------------------------------------------

export const CUSTOMER_TYPES = ["INDIVIDUAL", "BUSINESS"] as const;

export const customerSchema = z.object({
  name: z.string().min(1, "Customer name is required"),
  customerType: z.enum(CUSTOMER_TYPES).default("INDIVIDUAL"),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal("")),
  address: z.string().optional().nullable(),
  creditLimit: z.number().nonnegative().default(0),
});

export const customerUpdateSchema = customerSchema.partial().extend({ isActive: z.boolean().optional() });

export type CustomerInput = z.infer<typeof customerSchema>;

// ----------------------------------------------------------------------------
// SALES (Module 3)
// ----------------------------------------------------------------------------

export const PAYMENT_METHODS = ["CASH", "AIRTEL_MONEY", "TNM_MPAMBA", "BANK", "CARD", "CREDIT"] as const;

export const saleItemSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().positive("Quantity must be greater than zero"),
  unitPrice: z.number().nonnegative(),
  discount: z.number().nonnegative().default(0),
});

// Module 40: currency and exchangeRate travel together on a Sale/Purchase.
function currencyPairCheck(v: { currency?: string | null; exchangeRate?: number | null }, ctx: z.RefinementCtx) {
  const hasC = !!v.currency;
  const hasR = v.exchangeRate != null;
  if (hasC !== hasR) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasC ? "exchangeRate" : "currency"],
      message: "Give both the currency and its exchange rate, or neither",
    });
  }
}

export const saleSchema = z
  .object({
    customerId: z.string().optional().nullable(),
    branchId: z.string().optional().nullable(),
    cashAccountId: z.string().optional().nullable(),
    items: z.array(saleItemSchema).min(1, "A sale needs at least one item"),
    discount: z.number().nonnegative().default(0),
    paymentMethod: z.enum(PAYMENT_METHODS),
    amountPaid: z.number().nonnegative().default(0),
    // Module 40: optional foreign-currency memo – both or neither. Prices stay in
    // kwacha; the rate is the BOOK rate later settlements are measured against.
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Use a 3-letter currency code, e.g. USD").optional().nullable(),
    exchangeRate: z.number().positive("The exchange rate must be greater than zero").optional().nullable(),
  })
  .superRefine(currencyPairCheck)
  .refine(
    (data) => {
      // Module 18: VAT (if any) is computed server-side in src/lib/sales.ts
      // and can only ever ADD to the total, never reduce it – so checking
      // against the pre-VAT subtotal here is a safe conservative lower
      // bound for "does this sale need a customer", without the client
      // needing to know the business's VAT rate just to pass validation.
      const subtotal = data.items.reduce(
        (sum, item) => sum + (item.quantity * item.unitPrice - item.discount),
        0
      );
      const total = subtotal - data.discount;
      const balance = total - data.amountPaid;
      // A sale left with an outstanding balance must be attributable to a
      // customer, or there's no one to collect the debt from later.
      return balance <= 0.01 || !!data.customerId;
    },
    { message: "A customer is required for partial or credit sales", path: ["customerId"] }
  );

export type SaleInput = z.infer<typeof saleSchema>;

// ----------------------------------------------------------------------------
// BUSINESS DOCUMENTS – QUOTATIONS (Module 15)
// ----------------------------------------------------------------------------

// A quotation line can reference a real Product (auto-fills description from
// it) or be free-text (a product not yet in inventory, or a service line) –
// unlike a Sale line, which always requires a real productId since it must
// decrement real stock.
export const quotationItemSchema = z.object({
  productId: z.string().optional().nullable(),
  description: z.string().min(1, "Each line needs a description"),
  quantity: z.number().positive("Quantity must be greater than zero"),
  unitPrice: z.number().nonnegative(),
  discount: z.number().nonnegative().default(0),
});

export const quotationSchema = z.object({
  customerId: z.string().optional().nullable(),
  customerName: z.string().optional().nullable(),
  branchId: z.string().optional().nullable(),
  items: z.array(quotationItemSchema).min(1, "A quotation needs at least one item"),
  discount: z.number().nonnegative().default(0),
  expiryDate: z.string().datetime().optional().nullable(),
  notes: z.string().optional().nullable(),
  terms: z.string().optional().nullable(),
});

export type QuotationInput = z.infer<typeof quotationSchema>;

export const quotationStatusSchema = z.object({
  status: z.enum(["DRAFT", "SENT", "ACCEPTED", "DECLINED", "EXPIRED"]),
});

// Converting a quotation into a real sale needs the same information a
// manually-entered sale does (payment method, amount actually collected) –
// the quotation only fixed the items and prices, not how it gets paid for.
export const convertQuotationSchema = z.object({
  paymentMethod: z.enum(PAYMENT_METHODS),
  amountPaid: z.number().nonnegative().default(0),
  // Module 68: the product each free-text quotation line should be sold as.
  // Only lines with no product may appear here; the rules live in
  // src/lib/quotation-line-mapping.ts. Omitted = every line must already be
  // linked (the pre-Module-68 behaviour).
  lineProducts: z
    .array(z.object({ itemId: z.string().min(1), productId: z.string().min(1) }))
    .max(200)
    .optional(),
});

export type ConvertQuotationInput = z.infer<typeof convertQuotationSchema>;

export const generateInvoiceSchema = z.object({
  dueDate: z.string().datetime().optional().nullable(),
  terms: z.string().optional().nullable(),
});

export const recordPaymentSchema = z.object({
  saleId: z.string().optional().nullable(),
  customerId: z.string().optional().nullable(),
  purchaseId: z.string().optional().nullable(),
  supplierId: z.string().optional().nullable(),
  amount: z.number().positive("Payment amount must be greater than zero"),
  method: z.enum(PAYMENT_METHODS),
  cashAccountId: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

// Module 40: settling a foreign-currency Sale/Purchase. The amount is stated in
// the document's own currency; the server derives the kwacha figures.
export const foreignSettlementSchema = z
  .object({
    saleId: z.string().optional().nullable(),
    purchaseId: z.string().optional().nullable(),
    foreignAmount: z.number().positive("The amount must be greater than zero"),
    settlementRate: z.number().positive("The exchange rate must be greater than zero"),
    method: z.enum(PAYMENT_METHODS).refine((m) => m !== "CREDIT", "Choose how the money moved"),
    cashAccountId: z.string().optional().nullable(),
    reference: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
  })
  .refine((v) => !!v.saleId !== !!v.purchaseId, { message: "Give exactly one of saleId or purchaseId", path: ["saleId"] });
export type ForeignSettlementInput = z.infer<typeof foreignSettlementSchema>;

// ----------------------------------------------------------------------------
// EXPENSES (Module 4)
// ----------------------------------------------------------------------------

export const EXPENSE_CATEGORIES = [
  "RENT", "ELECTRICITY", "WATER", "INTERNET", "AIRTIME", "TRANSPORT",
  "SALARIES", "WAGES", "FUEL", "REPAIRS", "ADVERTISING", "BANK_CHARGES",
  "MOBILE_MONEY_CHARGES", "PURCHASES", "OTHER",
] as const;

export const EXPENSE_CATEGORY_LABELS: Record<(typeof EXPENSE_CATEGORIES)[number], string> = {
  RENT: "Rent",
  ELECTRICITY: "Electricity",
  WATER: "Water",
  INTERNET: "Internet",
  AIRTIME: "Airtime",
  TRANSPORT: "Transport",
  SALARIES: "Salaries",
  WAGES: "Wages",
  FUEL: "Fuel",
  REPAIRS: "Repairs",
  ADVERTISING: "Advertising",
  BANK_CHARGES: "Bank charges",
  MOBILE_MONEY_CHARGES: "Mobile-money charges",
  PURCHASES: "Purchases",
  OTHER: "Other",
};

// Module 19 (Withholding Tax) – the payment types Malawi's withholding tax
// regime singles out. Distinct from EXPENSE_CATEGORIES above: RENT exists in
// both lists (an expense category AND a withholding category can share a
// name), but most ExpenseCategory values (ELECTRICITY, FUEL, AIRTIME, ...)
// simply aren't withholding-tax-eligible payment types, so this is a
// deliberately smaller, separate list rather than reusing EXPENSE_CATEGORIES
// with a "not applicable" option sprinkled in.
export const WITHHOLDING_TAX_CATEGORIES = [
  "RENT", "COMMISSION", "PROFESSIONAL_FEES", "CONTRACTOR_FEES", "CASUAL_LABOUR", "PUBLIC_ENTERTAINMENT_FEE",
] as const;

export const WITHHOLDING_TAX_CATEGORY_LABELS: Record<(typeof WITHHOLDING_TAX_CATEGORIES)[number], string> = {
  RENT: "Rent",
  COMMISSION: "Commission",
  PROFESSIONAL_FEES: "Professional/consultancy fees",
  CONTRACTOR_FEES: "Contractor/subcontractor fees",
  CASUAL_LABOUR: "Casual labour",
  PUBLIC_ENTERTAINMENT_FEE: "Public entertainment fee",
};

export const expenseSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  description: z.string().min(1, "Description is required"),
  amount: z.number().positive("Amount must be greater than zero"),
  expenseDate: z.string().datetime().optional(), // defaults to now server-side if omitted
  paymentMethod: z.enum(PAYMENT_METHODS),
  payee: z.string().optional().nullable(),
  receiptUrl: z.string().url().optional().nullable(),
  notes: z.string().optional().nullable(),
  branchId: z.string().optional().nullable(),
  // Module 19 (Withholding Tax) – optional: most Expenses aren't a
  // withholding-tax-eligible payment at all. withholdingTaxAmount is NOT
  // accepted from the client – like VAT, it's always computed server-side
  // from the business's configured rate (see the expenses API route) so a
  // cashier can't type an arbitrary tax figure.
  withholdingTaxCategory: z.enum(WITHHOLDING_TAX_CATEGORIES).optional().nullable(),
  payeeTpin: z.string().optional().nullable(),
});

export type ExpenseInput = z.infer<typeof expenseSchema>;

export const expenseUpdateSchema = expenseSchema.partial();

// ----------------------------------------------------------------------------
// SUPPLIERS & PURCHASES (Module 8)
// ----------------------------------------------------------------------------

export const inviteMemberSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  role: z.enum(["MANAGER", "CASHIER", "ACCOUNTANT"]), // inviting another OWNER isn't supported
  branchId: z.string().optional().nullable(),
});

export const updateMemberSchema = z.object({
  role: z.enum(["MANAGER", "CASHIER", "ACCOUNTANT"]).optional(),
  branchId: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});

export const acceptInvitationSchema = z.object({
  token: z.string().min(1),
  // Only required when the invited email has no existing account yet.
  name: z.string().min(2).optional(),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Password must contain an uppercase letter")
    .regex(/[a-z]/, "Password must contain a lowercase letter")
    .regex(/[0-9]/, "Password must contain a number")
    .optional(),
});

export const branchSchema = z.object({
  name: z.string().min(1, "Branch name is required"),
  district: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
});

export const branchUpdateSchema = branchSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const supplierSchema = z.object({
  name: z.string().min(1, "Supplier name is required"),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal("")),
  address: z.string().optional().nullable(),
});

export const supplierUpdateSchema = supplierSchema.partial().extend({ isActive: z.boolean().optional() });

export const purchaseItemSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().positive("Quantity must be greater than zero"),
  unitCost: z.number().nonnegative(),
});

export const purchaseSchema = z
  .object({
  supplierId: z.string().min(1, "A supplier is required"),
  // Module 27: mirrors saleSchema/expenseSchema's branchId exactly – which
  // branch received this stock. Optional; resolveBranchScope() fills it in
  // for a branch-restricted member regardless of what's submitted.
  branchId: z.string().optional().nullable(),
  items: z.array(purchaseItemSchema).min(1, "A purchase needs at least one item"),
  paymentMethod: z.enum(PAYMENT_METHODS),
  amountPaid: z.number().nonnegative().default(0),
  // Module 40: optional foreign-currency memo – both or neither. Prices stay in
  // kwacha; the rate is the BOOK rate later settlements are measured against.
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Use a 3-letter currency code, e.g. USD").optional().nullable(),
  exchangeRate: z.number().positive("The exchange rate must be greater than zero").optional().nullable(),
})
  .superRefine(currencyPairCheck);

export type PurchaseInput = z.infer<typeof purchaseSchema>;

// ----------------------------------------------------------------------------
// STOCK TRANSFERS (Module 28)
// ----------------------------------------------------------------------------

export const stockTransferItemSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().positive("Quantity must be greater than zero"),
});

export const stockTransferSchema = z.object({
  fromBranchId: z.string().min(1, "Source branch is required"),
  toBranchId: z.string().min(1, "Destination branch is required"),
  items: z.array(stockTransferItemSchema).min(1, "A transfer needs at least one item"),
  notes: z.string().optional().nullable(),
});

export type StockTransferInput = z.infer<typeof stockTransferSchema>;

// Module 55: cancelling an in-transit transfer requires a reason (same
// treatment as void/refund reasons elsewhere).
export const cancelStockTransferSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required").max(500),
});
export type CancelStockTransferInput = z.infer<typeof cancelStockTransferSchema>;

// Module 65: receiving used to take no body at all (all-or-nothing). It now
// takes an OPTIONAL list of per-line quantities actually received. No body,
// an empty body or an empty `lines` array still means "everything arrived in
// full", so a Module 55 client keeps working. The real rules (0 <= received
// <= dispatched, reason required when short, 3 decimals) live in the pure
// src/lib/stock-transfer-receipt.ts, where they can be unit-tested; this
// schema only checks the shape, so the two can't drift into double-reporting.
export const receiveStockTransferSchema = z.object({
  lines: z
    .array(
      z.object({
        lineId: z.string().min(1),
        quantityReceived: z.number(),
        shortfallReason: z.string().optional().nullable(),
      })
    )
    .max(200)
    .optional(),
});
export type ReceiveStockTransferInput = z.infer<typeof receiveStockTransferSchema>;

// Module 66: recovering stock that was written off as short at receipt. Shape
// only – the real rules (> 0, <= what is still outstanding, 3 decimals) live in
// the pure src/lib/stock-transfer-recovery.ts. Unlike a receipt there is no
// "omitted means full" default, so `lines` is required and non-empty.
export const recoverStockTransferSchema = z.object({
  lines: z
    .array(
      z.object({
        lineId: z.string().min(1),
        quantityRecovered: z.number(),
      })
    )
    .min(1, "Enter the quantity recovered on at least one line")
    .max(200),
  note: z.string().trim().min(1, "A note is required").max(200),
});
export type RecoverStockTransferInput = z.infer<typeof recoverStockTransferSchema>;

// ----------------------------------------------------------------------------
// CASHBOOK (Module 9)
// ----------------------------------------------------------------------------

export const CASH_ACCOUNT_TYPES = ["CASH", "BANK", "AIRTEL_MONEY", "TNM_MPAMBA"] as const;

export const cashAccountSchema = z.object({
  type: z.enum(CASH_ACCOUNT_TYPES),
  name: z.string().min(1, "Account name is required"),
  openingBalance: z.number().default(0),
});

export const cashAccountUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  openingBalance: z.number().optional(),
});

export const cashTransferSchema = z.object({
  fromAccountId: z.string().min(1, "Source account is required"),
  toAccountId: z.string().min(1, "Destination account is required"),
  amount: z.number().positive("Transfer amount must be greater than zero"),
  description: z.string().optional().nullable(),
});

// ----------------------------------------------------------------------------
// AI ASSISTANT (Module 12)
// ----------------------------------------------------------------------------

export const askAssistantSchema = z.object({
  question: z.string().min(3, "Please enter a question").max(500, "Question is too long"),
});

// ----------------------------------------------------------------------------
// EMPLOYEES & PAYROLL (Module 10)
// ----------------------------------------------------------------------------

export const employeeSchema = z.object({
  name: z.string().min(1, "Employee name is required"),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal("")),
  position: z.string().min(1, "Position is required"),
  department: z.string().optional().nullable(),
  monthlySalary: z.number().nonnegative("Salary cannot be negative"),
  startDate: z.string().datetime(),
  bankName: z.string().optional().nullable(),
  bankAccountNumber: z.string().optional().nullable(),
  taxpayerId: z.string().optional().nullable(),
  // Module 29: the employee's home branch – optional/nullable, and (unlike
  // Product's opening-stock branchId) kept in employeeUpdateSchema too,
  // since an employee's branch is an ongoing fact that can genuinely
  // change (a transfer), not a one-time fact about where something arrived.
  branchId: z.string().optional().nullable(),
});

export const employeeUpdateSchema = employeeSchema.partial();

const taxBandSchema = z.object({
  min: z.number().nonnegative(),
  max: z.number().positive().nullable(),
  rate: z.number().min(0).max(100),
});

export const taxConfigurationSchema = z.object({
  payeBands: z.array(taxBandSchema).min(1, "At least one tax band is required"),
  pensionEmployeeRate: z.number().min(0).max(100),
  pensionEmployerRate: z.number().min(0).max(100),
  // Module 18 (VAT) – bundled into the same Tax Settings save as PAYE/
  // pension so there's one "I reviewed my tax settings" action, not two.
  vatRegistered: z.boolean().default(false),
  vatNumber: z.string().optional().nullable(),
  vatStandardRate: z.number().min(0).max(100).default(16.5),
  // Module 19 (Withholding Tax) – bundled into the same Tax Settings save
  // as PAYE/pension/VAT, for the same "one review action" reason given on
  // vatStandardRate above. One entry per WITHHOLDING_TAX_CATEGORIES value;
  // the API route fills in 0 for any category the client omits, rather
  // than rejecting an incomplete submission outright.
  withholdingTaxRates: z
    .array(
      z.object({
        category: z.enum(WITHHOLDING_TAX_CATEGORIES),
        rate: z.number().min(0).max(100),
      })
    )
    .default([]),
  // Module 20 (Corporate Tax & Tax Calendar) – bundled into the same Tax
  // Settings save as PAYE/pension/VAT/withholding tax, for the same "one
  // review action" reason given on vatStandardRate above.
  // financialYearStartMonth lives on Business (like vatRegistered/
  // vatNumber), not TaxConfiguration, but rides along in this one schema
  // since the tax-configuration route already saves both models together.
  corporateTaxRate: z.number().min(0).max(100).default(30),
  financialYearStartMonth: z.number().int().min(1).max(12).default(1),
  // Module 45 (VAT Partial Exemption) – bundled into the same Tax Settings save
  // as everything above, for the same "one review action" reason.
  vatPartialExemptionEnabled: z.boolean().default(true),
  vatDeMinimisPercent: z.number().min(0).max(100).default(0),
});

export const payrollRunSchema = z.object({
  employeeId: z.string().min(1),
  payPeriod: z.string().regex(/^\d{4}-\d{2}$/, "Pay period must be in YYYY-MM format"),
  allowances: z.number().nonnegative().default(0),
  allowanceNotes: z.string().optional().nullable(),
  otherDeductions: z.number().nonnegative().default(0),
  otherDeductionNotes: z.string().optional().nullable(),
});

export const payPayrollSchema = z.object({
  paymentMethod: z.enum(PAYMENT_METHODS),
});

// ----------------------------------------------------------------------------
// REFUNDS (Module 16)
// ----------------------------------------------------------------------------

export const REFUND_METHODS = ["CASH", "CREDIT_NOTE", "WRITE_OFF"] as const;

export const refundSchema = z
  .object({
    saleId: z.string().optional().nullable(),
    purchaseId: z.string().optional().nullable(),
    amount: z.number().positive("Refund amount must be greater than zero"),
    method: z.enum(REFUND_METHODS),
    reason: z.string().min(1, "A reason is required to process a refund"),
    cashAccountId: z.string().optional().nullable(),
  })
  .refine((data) => !!data.saleId !== !!data.purchaseId, {
    message: "A refund must be linked to exactly one sale or purchase, not both",
    path: ["saleId"],
  })
  .refine((data) => data.method !== "CASH" || !!data.cashAccountId, {
    message: "A cash account is required for a cash refund",
    path: ["cashAccountId"],
  });

export type RefundInput = z.infer<typeof refundSchema>;

// ----------------------------------------------------------------------------
// CREDIT NOTES (Module 43)
// ----------------------------------------------------------------------------

export const CREDIT_NOTE_SETTLEMENT_METHODS = ["CASH", "CUSTOMER_CREDIT"] as const;

// Amounts are never trusted from the client: the server recomputes every figure from the sale's own lines
// (src/lib/credit-note-calc.ts). What arrives here is only WHAT the operator wants credited: quantity and/or
// a net amount per sale item, whether returned units go back on the shelf, and, only when part of the credit
// is money the customer already paid, how to settle that part.
export const creditNoteSchema = z.object({
  saleId: z.string().min(1, "Choose the sale to credit"),
  reason: z.string().trim().min(1, "A reason is required to issue a credit note"),
  lines: z
    .array(
      z.object({
        saleItemId: z.string().min(1),
        quantity: z.number().min(0, "Quantity cannot be negative").default(0),
        netAmount: z.number().positive("The credit amount must be greater than zero").optional().nullable(),
        restock: z.boolean().default(false),
      })
    )
    .min(1, "Add at least one line to credit")
    .max(200),
  settlementMethod: z.enum(CREDIT_NOTE_SETTLEMENT_METHODS).optional().nullable(),
  cashAccountId: z.string().optional().nullable(),
});

export type CreditNoteInput = z.infer<typeof creditNoteSchema>;

// ----------------------------------------------------------------------------
// SUPPLIER DEBIT NOTES (Module 44)
// ----------------------------------------------------------------------------

export const DEBIT_NOTE_SETTLEMENT_METHODS = ["CASH", "SUPPLIER_CREDIT"] as const;

// Mirrors creditNoteSchema exactly – amounts are never trusted from the client, only WHAT the
// operator wants debited: quantity and/or a net amount per purchase item, whether the units
// actually left stock back to the supplier, and, only when part of the debit is money we already
// paid, how to settle that part.
export const debitNoteSchema = z.object({
  purchaseId: z.string().min(1, "Choose the purchase to debit"),
  reason: z.string().trim().min(1, "A reason is required to issue a debit note"),
  lines: z
    .array(
      z.object({
        purchaseItemId: z.string().min(1),
        quantity: z.number().min(0, "Quantity cannot be negative").default(0),
        netAmount: z.number().positive("The debit amount must be greater than zero").optional().nullable(),
        stockOut: z.boolean().default(false),
      })
    )
    .min(1, "Add at least one line to debit")
    .max(200),
  settlementMethod: z.enum(DEBIT_NOTE_SETTLEMENT_METHODS).optional().nullable(),
  cashAccountId: z.string().optional().nullable(),
});

export type DebitNoteInput = z.infer<typeof debitNoteSchema>;

// ----------------------------------------------------------------------------
// CREDIT REDEMPTION (Module 17)
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// FIXED ASSETS & DEPRECIATION (Module 21)
// ----------------------------------------------------------------------------

export const FIXED_ASSET_CATEGORIES = [
  "LAND",
  "BUILDINGS",
  "MOTOR_VEHICLES",
  "FURNITURE_FITTINGS",
  "COMPUTER_EQUIPMENT",
  "MACHINERY_EQUIPMENT",
  "OTHER",
] as const;

export const FIXED_ASSET_CATEGORY_LABELS: Record<(typeof FIXED_ASSET_CATEGORIES)[number], string> = {
  LAND: "Land",
  BUILDINGS: "Buildings",
  MOTOR_VEHICLES: "Motor Vehicles",
  FURNITURE_FITTINGS: "Furniture & Fittings",
  COMPUTER_EQUIPMENT: "Computer & IT Equipment",
  MACHINERY_EQUIPMENT: "Machinery & Equipment",
  OTHER: "Other",
};

// CREDIT is deliberately excluded – see the KNOWN LIMITATION on
// FixedAsset.paymentMethod in the schema and
// postJournalEntryForFixedAssetAcquisition in accounting-integrations.ts.
export const FIXED_ASSET_PAYMENT_METHODS = ["CASH", "AIRTEL_MONEY", "TNM_MPAMBA", "BANK", "CARD"] as const;

export const fixedAssetSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    category: z.enum(FIXED_ASSET_CATEGORIES),
    description: z.string().optional().nullable(),
    acquisitionDate: z.string().datetime().optional(), // defaults to now server-side if omitted
    cost: z.number().positive("Cost must be greater than zero"),
    residualValue: z.number().min(0).default(0),
    // Required for every category except LAND, which is never depreciated.
    usefulLifeYears: z.number().int().positive().optional().nullable(),
    paymentMethod: z.enum(FIXED_ASSET_PAYMENT_METHODS),
    supplierId: z.string().optional().nullable(),
    branchId: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
  })
  .refine((data) => data.category === "LAND" || !!data.usefulLifeYears, {
    message: "Useful life (years) is required for a depreciable asset",
    path: ["usefulLifeYears"],
  })
  .refine((data) => data.residualValue < data.cost, {
    message: "Residual value must be less than cost",
    path: ["residualValue"],
  });

export type FixedAssetInput = z.infer<typeof fixedAssetSchema>;

// Editing an existing asset never touches cost/paymentMethod/acquisitionDate
// (that would silently invalidate every depreciation entry already posted
// against the original cost) – only the descriptive/estimate fields a
// register entry might legitimately need correcting.
export const fixedAssetUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  category: z.enum(FIXED_ASSET_CATEGORIES).optional(),
  description: z.string().optional().nullable(),
  residualValue: z.number().min(0).optional(),
  usefulLifeYears: z.number().int().positive().optional().nullable(),
  supplierId: z.string().optional().nullable(),
  branchId: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export const disposeFixedAssetSchema = z
  .object({
    disposalDate: z.string().datetime().optional(), // defaults to now server-side if omitted
    disposalProceeds: z.number().min(0).default(0),
    cashAccountId: z.string().optional().nullable(),
    disposalNotes: z.string().optional().nullable(),
  })
  .refine((data) => data.disposalProceeds === 0 || !!data.cashAccountId, {
    message: "A cash account is required when disposal proceeds are greater than zero",
    path: ["cashAccountId"],
  });

export type DisposeFixedAssetInput = z.infer<typeof disposeFixedAssetSchema>;

// "YYYY-MM" – one depreciation run per period, same shape as Payroll.payPeriod.
export const depreciationRunSchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Period must be in YYYY-MM format"),
});

export const redeemCreditSchema = z
  .object({
    customerId: z.string().optional().nullable(),
    supplierId: z.string().optional().nullable(),
    // Omit to spend as much standing credit as fits against open balances –
    // see src/lib/credits.ts::redeemCustomerCredit. Provide it for a manual,
    // operator-chosen partial amount.
    amount: z.number().positive("Amount must be greater than zero").optional(),
  })
  .refine((data) => !!data.customerId !== !!data.supplierId, {
    message: "Specify exactly one of customerId or supplierId",
    path: ["customerId"],
  });

export type RedeemCreditInput = z.infer<typeof redeemCreditSchema>;

// ----------------------------------------------------------------------------
// Bank Reconciliation (Module 22)
// ----------------------------------------------------------------------------

export const openBankReconciliationSchema = z.object({
  accountId: z.string().min(1, "Account is required"),
  statementDate: z.string().datetime(),
  // Module 69 – first day the statement covers, optional (null/absent = unknown,
  // Module 64's heuristic applies). start <= statementDate is checked in
  // openBankReconciliation() with the pure validatePeriodStart(), not here – the
  // schema can't name the offending pair as clearly.
  periodStart: z.string().datetime().optional().nullable(),
  statementEndingBalance: z.number(),
});
export type OpenBankReconciliationInput = z.infer<typeof openBankReconciliationSchema>;

// Module 69 – set, change or clear (null) the start date of an IN_PROGRESS reconciliation.
export const setPeriodStartSchema = z.object({
  periodStart: z.string().datetime().nullable(),
});
export type SetPeriodStartInput = z.infer<typeof setPeriodStartSchema>;

export const bankStatementLineSchema = z.object({
  lineDate: z.string().datetime(),
  description: z.string().min(1, "Description is required"),
  // Signed the same way CashTransaction.amount is: positive = money in,
  // negative = money out. Zero is rejected – a real statement line always
  // moved money one way or the other.
  amount: z.number().refine((n) => n !== 0, "Amount can't be zero"),
});
export type BankStatementLineInput = z.infer<typeof bankStatementLineSchema>;

// Module 62 – CSV import of statement lines. The CSV travels as text in the
// JSON body (read in the browser with File.text()), so there's no multipart
// handling. The parsing itself lives in the import-free bank-statement-csv.ts
// (its MAX_CSV_CHARS is the single source for the size cap).
export const importBankStatementSchema = z.object({
  csv: z.string().min(1, "The file is empty").max(MAX_CSV_CHARS, "The file is too large – split the statement into smaller files"),
  format: z.enum(["CSV", "OFX"]).default("CSV"),
  // Numeric dates like 01/09/2026 are read day-first unless told otherwise.
  dateOrder: z.enum(["DMY", "MDY"]).default("DMY"),
  // true = parse and report only, write nothing (the "Preview" step).
  dryRun: z.boolean().default(false),
  // Rows already present in this reconciliation (same date, description and
  // amount) are skipped unless the person consciously turns this off.
  skipDuplicates: z.boolean().default(true),
  // Rows that couldn't be read block a real import unless the person
  // consciously chooses to import the rest.
  skipInvalid: z.boolean().default(false),
  // Module 64. Rows dated after the reconciliation's statement date (or far
  // before it) only WARN by default; ticking this leaves them out.
  skipOutOfPeriod: z.boolean().default(false),
  // Module 70. Rows whose date + description + amount already sit on another
  // statement of the same account only WARN by default; ticking this leaves them out.
  skipOtherStatementRepeats: z.boolean().default(false),
});
export type ImportBankStatementInput = z.infer<typeof importBankStatementSchema>;

export const matchBankStatementLineSchema = z.object({
  transactionId: z.string().min(1, "A book transaction is required"),
});
export type MatchBankStatementLineInput = z.infer<typeof matchBankStatementLineSchema>;

export const ignoreBankStatementLineSchema = z.object({
  reason: z.string().optional().nullable(),
});
export type IgnoreBankStatementLineInput = z.infer<typeof ignoreBankStatementLineSchema>;

// Module 48 – reopening a COMPLETED reconciliation. Reason is required (unlike
// ignoreBankStatementLineSchema's optional one above) – a reopen undoes a
// signed-off statement match, same "reason required" bar periodCloseSchema
// sets for a period reopen.
// Module 54 – `lineId`, optional: which statement line (if any) this reopen
// is actually about. Existence/ownership is checked in reopenBankReconciliation
// itself, not here – a Zod schema can't see the database.
export const reopenBankReconciliationSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required").max(500),
  lineId: z.string().optional().nullable(),
});
export type ReopenBankReconciliationInput = z.infer<typeof reopenBankReconciliationSchema>;

// ----------------------------------------------------------------------------
// Stock Take (Module 23)
// ----------------------------------------------------------------------------

export const openStockTakeSchema = z.object({
  categoryId: z.string().optional().nullable(),
  // Module 31: which branch to count – resolved/enforced server-side via
  // resolveBranchScope() (see the /stock-take POST route), same shape as
  // purchaseSchema.branchId. Fixed for the life of the stock take.
  branchId: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
});
export type OpenStockTakeInput = z.infer<typeof openStockTakeSchema>;

export const recordStockCountSchema = z.object({
  countedQuantity: z.number().min(0, "Counted quantity can't be negative"),
});
export type RecordStockCountInput = z.infer<typeof recordStockCountSchema>;

export const ignoreStockTakeLineSchema = z.object({
  reason: z.string().optional().nullable(),
});
export type IgnoreStockTakeLineInput = z.infer<typeof ignoreStockTakeLineSchema>;

// Module 49 – reopening a COMPLETED stock take. Reason is required (unlike
// ignoreStockTakeLineSchema's optional one above) – a reopen undoes a
// signed-off physical count, same "reason required" bar
// reopenBankReconciliationSchema (Module 48) sets.
// Module 54 – `lineId`, optional: which stock take line (if any) this reopen
// is actually about, same treatment as reopenBankReconciliationSchema.
export const reopenStockTakeSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required").max(500),
  lineId: z.string().optional().nullable(),
});
export type ReopenStockTakeInput = z.infer<typeof reopenStockTakeSchema>;

// ----------------------------------------------------------------------------
// Billing & Subscription (Module 26)
// ----------------------------------------------------------------------------

export const changeSubscriptionPlanSchema = z.object({
  planKey: z.enum(["FREE", "BUSINESS", "PROFESSIONAL"], {
    errorMap: () => ({ message: "planKey must be one of FREE, BUSINESS, PROFESSIONAL (Enterprise is contact-only)" }),
  }),
  billingCycle: z.enum(["MONTHLY", "ANNUAL"]),
});
export type ChangeSubscriptionPlanInput = z.infer<typeof changeSubscriptionPlanSchema>;

export const cancelSubscriptionSchema = z.object({
  reason: z.string().max(500).optional().nullable(),
});
export type CancelSubscriptionInput = z.infer<typeof cancelSubscriptionSchema>;

// ----------------------------------------------------------------------------
// Tax Payments (Module 33)
// ----------------------------------------------------------------------------

export const taxPaymentSchema = z.object({
  taxType: z.enum(TAX_PAYMENT_TYPES),
  // "YYYY-MM" for VAT/PAYE/withholding tax, "YYYY-MM-DD" (period's first
  // day) for provisional/annual – validated properly against the
  // business's own fiscal calendar in src/lib/tax-payments.ts.
  periodKey: z.string().min(1, "Choose the period this payment is for"),
  paymentDate: z.string().datetime().optional().nullable(), // defaults to now server-side
  cashAccountId: z.string().min(1, "Choose the account the payment was made from"),
  // Ignored-if-absent for VAT (the server computes it and rejects a
  // mismatched value); required and positive for every other type.
  principalAmount: z.number().positive("The tax amount must be greater than zero").optional().nullable(),
  penaltyAmount: z.number().min(0, "Penalty can't be negative").default(0),
  // Module 67: true = a part-payment, more to follow for this period. Absent
  // or false = the payment closes the period, exactly as before. Refused for
  // VAT server-side.
  partial: z.boolean().optional().default(false),
  reference: z.string().max(100).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});
export type TaxPaymentInput = z.infer<typeof taxPaymentSchema>;

export const voidTaxPaymentSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required to void a tax payment").max(500),
});
export type VoidTaxPaymentInput = z.infer<typeof voidTaxPaymentSchema>;

// ----------------------------------------------------------------------------
// Foreign Exchange Gains & Losses (Module 39)
// ----------------------------------------------------------------------------

export const FX_KINDS = ["REALISED", "UNREALISED"] as const;

const fxAdjustmentBaseSchema = z.object({
  cashAccountId: z.string().min(1, "Choose the account that holds the foreign currency"),
  adjustmentDate: z.string().datetime().optional().nullable(), // defaults to now server-side
  kind: z.enum(FX_KINDS),
  currencyCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Use a 3-letter currency code such as USD, ZAR or GBP"),
  // RATES: the server works the gain/loss out from foreignAmount and the two
  // rates. AMOUNT: the operator types the difference (e.g. straight off a bank
  // advice) and a direction. Exactly the fields of the chosen method are used.
  method: z.enum(["RATES", "AMOUNT"]),
  foreignAmount: z.number().positive("The foreign amount must be greater than zero").optional().nullable(),
  bookRate: z.number().positive("The carried rate must be greater than zero").optional().nullable(),
  newRate: z.number().positive("The new rate must be greater than zero").optional().nullable(),
  direction: z.enum(["GAIN", "LOSS"]).optional().nullable(),
  amount: z.number().positive("The amount must be greater than zero").optional().nullable(),
  reference: z.string().max(100).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});

export const fxAdjustmentSchema = fxAdjustmentBaseSchema.superRefine((v, ctx) => {
  if (v.method === "RATES") {
    for (const field of ["foreignAmount", "bookRate", "newRate"] as const) {
      if (v[field] == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "Required when working the difference out from rates" });
    }
  } else {
    if (v.direction == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["direction"], message: "Choose gain or loss" });
    if (v.amount == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amount"], message: "Enter the amount of the gain or loss" });
  }
});
export type FxAdjustmentInput = z.infer<typeof fxAdjustmentSchema>;

export const voidFxAdjustmentSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required to void an exchange adjustment").max(500),
});
export type VoidFxAdjustmentInput = z.infer<typeof voidFxAdjustmentSchema>;

// Module 35: the business's calendar time zone. Only zones in SUPPORTED_TIME_ZONES
// (src/lib/timezone.ts – UTC+0 or east, no daylight saving; see that file for why).
export const businessTimeZoneSchema = z.object({
  timezone: z.string().refine(isSupportedTimeZone, "Choose one of the listed time zones."),
});
export type BusinessTimeZoneInput = z.infer<typeof businessTimeZoneSchema>;

// Module 51: how many times a completed Bank Reconciliation/Stock Take may be
// reopened (see src/lib/reopen-audit.ts and the schema comment on
// Business.maxReopens). Bounds match MIN_MAX_REOPENS/MAX_MAX_REOPENS in
// reopen-constants.ts – a whole number so "reopened 2.5 times" can't happen.
export const businessMaxReopensSchema = z.object({
  maxReopens: z
    .number()
    .int("Must be a whole number.")
    .min(MIN_MAX_REOPENS, `Must be at least ${MIN_MAX_REOPENS}.`)
    .max(MAX_MAX_REOPENS, `Must be ${MAX_MAX_REOPENS} or less.`),
});
export type BusinessMaxReopensInput = z.infer<typeof businessMaxReopensSchema>;

// Module 58: how many days an IN_TRANSIT Stock Transfer can sit unconfirmed
// before it's flagged stale (see src/lib/stale-transfer.ts and the schema
// comment on Business.staleTransferAlertDays). Bounds match
// MIN_STALE_TRANSFER_ALERT_DAYS/MAX_STALE_TRANSFER_ALERT_DAYS.
export const businessStaleTransferAlertDaysSchema = z.object({
  staleTransferAlertDays: z
    .number()
    .int("Must be a whole number.")
    .min(MIN_STALE_TRANSFER_ALERT_DAYS, `Must be at least ${MIN_STALE_TRANSFER_ALERT_DAYS}.`)
    .max(MAX_STALE_TRANSFER_ALERT_DAYS, `Must be ${MAX_STALE_TRANSFER_ALERT_DAYS} or less.`),
});
export type BusinessStaleTransferAlertDaysInput = z.infer<typeof businessStaleTransferAlertDaysSchema>;

// ----------------------------------------------------------------------------
// Manual Journal Entries & custom accounts (Module 41)
//
// Shape checks only. The rules that need the business's accounts (controlled
// accounts, inactive accounts, balance) live in src/lib/manual-journal-rules.ts
// and are enforced server-side in src/lib/manual-journal.ts.
// ----------------------------------------------------------------------------

const manualJournalLineSchema = z.object({
  accountId: z.string().min(1, "Choose an account"),
  debit: z.number().min(0, "Amounts can't be negative").max(99_999_999_999.99).optional().nullable(),
  credit: z.number().min(0, "Amounts can't be negative").max(99_999_999_999.99).optional().nullable(),
  memo: z.string().trim().max(200).optional().nullable(),
});

export const manualJournalSchema = z.object({
  // A bare calendar date in the business's time zone ("2026-03-31"), never an instant:
  // the entry is posted AS OF that day. Absent = today in the business zone.
  entryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date such as 2026-03-31")
    .optional()
    .nullable(),
  description: z.string().trim().min(3, "Say what this entry is and why").max(300),
  documentRef: z.string().trim().max(100).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
  lines: z.array(manualJournalLineSchema).min(2, "A journal entry needs at least two lines").max(40),
});
export type ManualJournalInput = z.infer<typeof manualJournalSchema>;

export const voidManualJournalSchema = z.object({
  reason: z.string().trim().min(3, "A reason is required to void a journal entry").max(500),
});
export type VoidManualJournalInput = z.infer<typeof voidManualJournalSchema>;

// Module 79 (Service Cost Clearing). `amount` omitted = settle the whole remaining balance; the direction is never
// sent, it is derived from the balance on the server (see planSettlement in service-cost-clearing.ts).
export const settleServiceCostSchema = z.object({
  productId: z.string().min(1),
  amount: z.number().positive("The amount must be more than zero").optional().nullable(),
  // Module 80: the leftover the person saw. When given, the server refuses if it has moved. Omitted = old behaviour.
  expectedBalance: z.number().finite().optional().nullable(),
  reason: z.string().trim().min(1, "A reason is required").max(200, "The reason is too long (200 characters at most)"),
});
export type SettleServiceCostInput = z.infer<typeof settleServiceCostSchema>;

// Module 80. `expectedBalance` is the leftover the person saw (kwacha, debit positive). It is optional on a single
// settle (omitted = Module 79 behaviour) and REQUIRED per service on a bulk settle.
export const bulkSettleServiceCostSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        expectedBalance: z.number().finite("Enter the leftover as a number"),
      })
    )
    .min(1, "Choose at least one service")
    .max(MAX_BULK_SETTLEMENT_SERVICES, `Choose at most ${MAX_BULK_SETTLEMENT_SERVICES} services at a time`),
  reason: z.string().trim().min(1, "A reason is required").max(200, "The reason is too long (200 characters at most)"),
});
export type BulkSettleServiceCostInput = z.infer<typeof bulkSettleServiceCostSchema>;

// Module 80: days a leftover can sit before the bell calls it aged (Business.serviceCostAlertDays).
export const businessServiceCostAlertDaysSchema = z.object({
  serviceCostAlertDays: z
    .number()
    .int("Must be a whole number.")
    .min(MIN_SERVICE_COST_ALERT_DAYS, `Must be at least ${MIN_SERVICE_COST_ALERT_DAYS}.`)
    .max(MAX_SERVICE_COST_ALERT_DAYS, `Must be ${MAX_SERVICE_COST_ALERT_DAYS} or less.`),
});
export type BusinessServiceCostAlertDaysInput = z.infer<typeof businessServiceCostAlertDaysSchema>;

export const voidServiceCostSettlementSchema = z.object({
  reason: z.string().trim().min(3, "A reason is required to void a settlement").max(500),
});
export type VoidServiceCostSettlementInput = z.infer<typeof voidServiceCostSettlementSchema>;

export const ACCOUNT_TYPES = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const;

export const accountCreateSchema = z.object({
  // Numeric like every seeded code (1000s assets ... 5000s+ expenses). The code carries no
  // logic – postings look accounts up by systemKey – it only sorts the chart.
  code: z.string().trim().regex(/^\d{4,8}$/, "Use 4 to 8 digits, for example 1450"),
  name: z.string().trim().min(2, "Give the account a name").max(80),
  type: z.enum(ACCOUNT_TYPES),
});
export type AccountCreateInput = z.infer<typeof accountCreateSchema>;

export const accountUpdateSchema = z
  .object({
    code: z.string().trim().regex(/^\d{4,8}$/, "Use 4 to 8 digits, for example 1450").optional(),
    name: z.string().trim().min(2, "Give the account a name").max(80).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => v.code !== undefined || v.name !== undefined || v.isActive !== undefined, "Nothing to change");
export type AccountUpdateInput = z.infer<typeof accountUpdateSchema>;

// Module 42 (Period Close). `closedThrough` is the last calendar day to close, a bare
// "YYYY-MM-DD" in the business time zone, or null to reopen everything. Whether it is a real
// date, a finished day, and a close or a reopen is decided by planClosedThroughChange() on the
// server; this only rejects the wrong shape.
export const periodCloseSchema = z.object({
  closedThrough: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date such as 2026-03-31")
    .nullable(),
  reason: z.string().trim().max(500).optional().nullable(),
});
export type PeriodCloseInput = z.infer<typeof periodCloseSchema>;
