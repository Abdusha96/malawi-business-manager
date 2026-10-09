CREATE TABLE "ImportBatch" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "importType" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "migrationDate" TIMESTAMP(3) NOT NULL,
  "totalRows" INTEGER NOT NULL,
  "importedRows" INTEGER NOT NULL,
  "rejectedRows" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "errorSummary" TEXT,
  "errors" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ImportBatch_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ImportBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ImportBatch_businessId_createdAt_idx" ON "ImportBatch"("businessId", "createdAt");
CREATE INDEX "ImportBatch_userId_idx" ON "ImportBatch"("userId");
ALTER TABLE "FixedAsset" ADD COLUMN "isOpeningBalanceImported" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "FixedAsset" ADD COLUMN "openingBalanceDate" TIMESTAMP(3);
