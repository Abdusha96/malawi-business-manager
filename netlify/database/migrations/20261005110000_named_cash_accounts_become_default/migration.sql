-- Generic registration accounts should remain fallbacks. Promote the newest
-- explicitly named bank account for each business when one already exists.
WITH ranked_defaults AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "businessId", "type"
    ORDER BY "createdAt" ASC, "id" ASC
  ) AS row_number
  FROM "CashAccount"
  WHERE "isDefault" = true
)
UPDATE "CashAccount" AS account
SET "isDefault" = false
FROM ranked_defaults
WHERE account."id" = ranked_defaults."id"
  AND ranked_defaults.row_number > 1;

UPDATE "CashAccount"
SET "isDefault" = false
WHERE "type" = 'BANK';

WITH named_banks AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "businessId"
    ORDER BY "createdAt" DESC, "id" DESC
  ) AS row_number
  FROM "CashAccount"
  WHERE "type" = 'BANK'
    AND "isActive" = true
    AND "name" <> 'Bank'
)
UPDATE "CashAccount" AS account
SET "isDefault" = true
FROM named_banks
WHERE account."id" = named_banks."id"
  AND named_banks.row_number = 1;

CREATE UNIQUE INDEX "CashAccount_one_default_per_type"
ON "CashAccount" ("businessId", "type")
WHERE "isDefault" = true;
