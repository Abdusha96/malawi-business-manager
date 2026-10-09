import { Prisma } from "@prisma/client";
import ExcelJS from "exceljs";
import { prisma } from "./prisma";
import { recordInventoryMovement } from "./inventory";
import { resolveBranchScope, TenantAccessError, ResolvedMembership } from "./tenant";
import { assertRecordDateOpen } from "./period-close";
import { getOrCreateSystemAccountId, postJournalEntry } from "./accounting";
import { logAudit } from "./audit";

type RowError = { rowNumber: number; code: string; field: string; value: string; error: string };
type ImportRow = Record<string, unknown>;
type ImportKind = "PRODUCTS" | "FIXED_ASSETS";

const PRODUCT_FIELDS = ["sku", "name", "description", "category", "unit", "openingQuantity", "unitCost", "sellingPrice", "branch", "vatCategory", "barcode"] as const;
const ASSET_FIELDS = ["name", "category", "acquisitionDate", "cost", "accumulatedDepreciation", "netBookValue", "usefulLifeYears", "residualValue", "branch", "notes"] as const;
const normalize = (v: unknown) => String(v ?? "").trim();
const headerKey = (v: unknown) => normalize(v).toLowerCase().replace(/[^a-z0-9]/g, "");
const toNum = (v: unknown) => typeof v === "number" ? v : Number(normalize(v).replace(/[, ]/g, ""));
const categoryMap: Record<string, string> = { land: "LAND", buildings: "BUILDINGS", "motor vehicles": "MOTOR_VEHICLES", "furniture fittings": "FURNITURE_FITTINGS", "furniture and fittings": "FURNITURE_FITTINGS", "furniture & fittings": "FURNITURE_FITTINGS", "computer equipment": "COMPUTER_EQUIPMENT", "machinery equipment": "MACHINERY_EQUIPMENT", "machinery and equipment": "MACHINERY_EQUIPMENT", "machinery & equipment": "MACHINERY_EQUIPMENT", other: "OTHER" };
const vatMap: Record<string, string> = { standard: "STANDARD", zero_rated: "ZERO_RATED", "zero rated": "ZERO_RATED", exempt: "EXEMPT" };

function readCsvMigrationFile(buffer: Buffer, filename: string) {
  if (buffer.byteLength > 10 * 1024 * 1024) throw new Error("File exceeds the 10 MB import limit.");
  const ext = filename.toLowerCase().split(".").pop();
  if (ext !== "csv") throw new Error("Upload a .xlsx or .csv file.");
  if (ext === "csv") {
    const records: string[][] = [];
    let row: string[] = []; let field = ""; let quoted = false;
    const input = buffer.toString("utf8").replace(/^\uFEFF/, "");
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (ch === '"' && quoted && input[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) { row.push(field); field = ""; }
      else if ((ch === "\n" || ch === "\r") && !quoted) { if (ch === "\r" && input[i + 1] === "\n") i++; row.push(field); records.push(row); row = []; field = ""; }
      else field += ch;
    }
    if (field || row.length) { row.push(field); records.push(row); }
    if (quoted) throw new Error("This CSV has an opening quote that is not closed.");
    return tableToRows(records);
  }
  return { headers: [] as string[], rows: [] as ImportRow[] };
}

export async function readXlsxMigrationFile(buffer: Buffer, filename: string) {
  if (buffer.byteLength > 10 * 1024 * 1024) throw new Error("File exceeds the 10 MB import limit.");
  const ext = filename.toLowerCase().split(".").pop();
  if (ext !== "csv" && ext !== "xlsx") throw new Error("Upload a .xlsx or .csv file.");
  if (ext === "csv") return readCsvMigrationFile(buffer, filename);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("The workbook has no worksheet.");
  if (sheet.rowCount > 5001 || sheet.columnCount > 100) throw new Error("Imports are limited to 5,000 data rows and 100 columns.");
  const records: unknown[][] = [];
  const sourceNumbers: number[] = [];
  sheet.eachRow({ includeEmpty: false }, (r) => {
    const vals: unknown[] = [];
    r.eachCell({ includeEmpty: true }, (cell, col) => { vals[col - 1] = cell.value instanceof Date ? cell.value.toISOString().slice(0, 10) : cell.text ?? ""; });
    records.push(vals);
    sourceNumbers.push(r.number);
  });
  return tableToRows(records, sourceNumbers);
}

function tableToRows(table: unknown[][], sourceNumbers = table.map((_, i) => i + 1)) {
  const headers = (table[0] ?? []).map((x) => normalize(x));
  const nonEmptyHeaders = headers.filter(Boolean).map((h) => h.toLowerCase());
  if (new Set(nonEmptyHeaders).size !== nonEmptyHeaders.length) throw new Error("Column names must be unique.");
  const rows = table.slice(1)
    .map((r, i) => ({ row: r, number: sourceNumbers[i + 1] ?? i + 2 }))
    .filter(({ row }) => row.some((x) => normalize(x) !== ""))
    .map(({ row, number }) => ({ ...Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""])), __rowNumber: number }));
  if (!headers.length || !rows.length) throw new Error("The first worksheet must contain column headers and at least one data row.");
  if (rows.length > 5000 || headers.length > 100) throw new Error("Imports are limited to 5,000 data rows and 100 columns.");
  return { headers, rows };
}

export function suggestMappings(headers: string[], kind: ImportKind) {
  const fields = kind === "PRODUCTS" ? PRODUCT_FIELDS : ASSET_FIELDS;
  const aliases: Record<string, string[]> = {
    sku: ["sku", "productcode", "productid", "code", "assetcode"], name: ["name", "productname", "assetname"], description: ["description", "details"], category: ["category", "assetcategory"], unit: ["unit", "unitofmeasure"], openingQuantity: ["openingquantity", "openingqty", "quantity", "qty", "openingstock"], unitCost: ["unitcost", "cost", "purchaseprice", "originalcost"], sellingPrice: ["sellingprice", "salesprice", "price"], branch: ["branch", "location"], vatCategory: ["vatcategory", "vatcode", "taxcode", "vat"], barcode: ["barcode"], acquisitionDate: ["acquisitiondate", "purchasedate"], cost: ["originalcost", "cost", "acquisitioncost"], accumulatedDepreciation: ["accumulateddepreciation", "depreciationto date"], netBookValue: ["netbookvalue", "nbv"], usefulLifeYears: ["usefullifeyears", "usefullife", "life"], residualValue: ["residualvalue", "salvagevalue"], notes: ["notes", "description"]
  };
  return Object.fromEntries(fields.map((f) => [f, headers.find((h) => aliases[f].includes(headerKey(h))) ?? ""]));
}

function val(row: ImportRow, map: Record<string, string>, field: string) { return normalize(row[map[field]]); }
function parseDate(v: unknown): Date | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  const s = normalize(v);
  if (!s) return null;
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (dmy) {
    const [, day, month, year] = dmy;
    const parsed = new Date(Number(year), Number(month) - 1, Number(day), 12);
    if (parsed.getFullYear() !== Number(year) || parsed.getMonth() !== Number(month) - 1 || parsed.getDate() !== Number(day)) return null;
    return parsed;
  }
  if (/^\d{5}(?:\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial < 1 || serial > 2958465) return null;
    return new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function validateMigration(params: { businessId: string; kind: ImportKind; rows: ImportRow[]; mapping: Record<string, string>; membership: ResolvedMembership }) {
  const { businessId, kind, rows, mapping, membership } = params;
  const branches = await prisma.branch.findMany({ where: { businessId, isActive: true } });
  const categories = kind === "PRODUCTS" ? await prisma.category.findMany({ where: { businessId } }) : [];
  const knownProducts = kind === "PRODUCTS" ? await prisma.product.findMany({ where: { businessId }, select: { sku: true, barcode: true, name: true } }) : [];
  const seenSku = new Set<string>(); const seenBarcode = new Set<string>();
  const seenUncodedNames = new Set<string>();
  const errors: RowError[] = [];
  const valid: Record<string, unknown>[] = [];
  const validRowNumbers: number[] = [];
  const seenAssetNames = new Set<string>();
  const knownAssetNames = kind === "FIXED_ASSETS" ? await prisma.fixedAsset.findMany({ where: { businessId }, select: { name: true } }) : [];
  const dateNow = new Date();
  rows.forEach((row, index) => {
    const rowNumber = Number(row.__rowNumber ?? index + 2);
    const add = (field: string, value: unknown, error: string, code = "") => errors.push({ rowNumber, code, field, value: normalize(value), error });
    if (kind === "PRODUCTS") {
      const name = val(row, mapping, "name"); const sku = val(row, mapping, "sku"); const barcode = val(row, mapping, "barcode");
      const qty = val(row, mapping, "openingQuantity") ? toNum(row[mapping.openingQuantity]) : 0;
      const unitCost = toNum(row[mapping.unitCost]); const sellingPrice = toNum(row[mapping.sellingPrice]);
      const catName = val(row, mapping, "category"); const category = categories.find((c) => c.name.toLowerCase() === catName.toLowerCase());
      const branchName = val(row, mapping, "branch"); const branch = branchName ? branches.find((b) => b.name.toLowerCase() === branchName.toLowerCase()) : null;
      const vatText = val(row, mapping, "vatCategory"); const vat = vatText ? vatMap[vatText.toLowerCase()] : "STANDARD";
      if (!name) add("name", "", "Product name is required.");
      if (!Number.isFinite(unitCost) || unitCost < 0) add("unitCost", row[mapping.unitCost], "Unit cost must be zero or greater.");
      if (!Number.isFinite(sellingPrice) || sellingPrice < 0) add("sellingPrice", row[mapping.sellingPrice], "Selling price must be zero or greater.");
      if (!Number.isFinite(qty) || qty < 0) add("openingQuantity", row[mapping.openingQuantity], "Opening quantity must be zero or greater.");
      if (catName && !category) add("category", catName, "Category does not exist in this business.");
      if (branchName && !branch) add("branch", branchName, "Branch does not exist in this business.");
      if (branch && membership.branchId && membership.branchId !== branch.id) add("branch", branchName, "You do not have access to this branch.");
      if (vatText && !vat) add("vatCategory", vatText, "VAT code must be Standard, Zero Rated, or Exempt.");
      if (sku && (seenSku.has(sku.toLowerCase()) || knownProducts.some((p) => p.sku?.toLowerCase() === sku.toLowerCase()))) add("sku", sku, "Product code already exists in this file or business.");
      if (barcode && (seenBarcode.has(barcode.toLowerCase()) || knownProducts.some((p) => p.barcode?.toLowerCase() === barcode.toLowerCase()))) add("barcode", barcode, "Barcode already exists in this file or business.");
      if (!sku && !barcode && name && (seenUncodedNames.has(name.toLowerCase()) || knownProducts.some((p) => p.name.toLowerCase() === name.toLowerCase()))) add("name", name, "This uncoded product name already exists in this file or business; add a unique product code or barcode to import it safely.");
      if (sku) seenSku.add(sku.toLowerCase()); if (barcode) seenBarcode.add(barcode.toLowerCase());
      if (!sku && !barcode && name) seenUncodedNames.add(name.toLowerCase());
      valid.push({ name, sku: sku || null, barcode: barcode || null, description: val(row, mapping, "description") || null, categoryId: category?.id ?? null, unit: val(row, mapping, "unit") || "each", qty, unitCost, sellingPrice, branchId: branch?.id ?? null, vatCategory: vat ?? "STANDARD" });
      validRowNumbers.push(rowNumber);
    } else {
      const name = val(row, mapping, "name"); const catName = val(row, mapping, "category"); const categoryKey = catName.toLowerCase().replaceAll("_", " ").replaceAll("-", " ").replace(/\s+/g, " ").trim(); const category = categoryMap[catName.toLowerCase()] ?? categoryMap[categoryKey];
      const cost = toNum(row[mapping.cost]); const acc = toNum(row[mapping.accumulatedDepreciation]); const nbv = toNum(row[mapping.netBookValue]);
      const lifeText = val(row, mapping, "usefulLifeYears"); const life = lifeText ? Number(lifeText) : null; const residual = val(row, mapping, "residualValue") ? toNum(row[mapping.residualValue]) : 0;
      const branchName = val(row, mapping, "branch"); const branch = branchName ? branches.find((b) => b.name.toLowerCase() === branchName.toLowerCase()) : null;
      const acquisitionRaw = val(row, mapping, "acquisitionDate");
      const acquisitionDate = acquisitionRaw ? parseDate(row[mapping.acquisitionDate]) : dateNow;
      if (!name) add("name", "", "Asset name is required.");
      if (name && (seenAssetNames.has(name.toLowerCase()) || knownAssetNames.some((a) => a.name.toLowerCase() === name.toLowerCase()))) add("name", name, "An asset with this name already exists in this file or business.");
      if (name) seenAssetNames.add(name.toLowerCase());
      if (acquisitionRaw && !acquisitionDate) add("acquisitionDate", acquisitionRaw, "Acquisition date is invalid.");
      if (!category) add("category", catName, "Choose Land, Buildings, Motor Vehicles, Furniture & Fittings, Computer Equipment, Machinery & Equipment, or Other.");
      if (!Number.isFinite(cost) || cost <= 0) add("cost", row[mapping.cost], "Original cost must be greater than zero.");
      if (!Number.isFinite(acc) || acc < 0 || acc > cost) add("accumulatedDepreciation", row[mapping.accumulatedDepreciation], "Accumulated depreciation must be between zero and original cost.");
      if (Number.isFinite(acc) && Number.isFinite(cost) && Number.isFinite(residual) && acc > cost - residual) add("accumulatedDepreciation", row[mapping.accumulatedDepreciation], "Accumulated depreciation cannot exceed the depreciable amount after residual value.");
      if (!Number.isFinite(nbv) || Math.abs(cost - acc - nbv) > 0.01) add("netBookValue", row[mapping.netBookValue], `Net Book Value does not reconcile. Expected ${(cost - acc).toFixed(2)}.`);
      if (category === "LAND" && acc > 0) add("accumulatedDepreciation", row[mapping.accumulatedDepreciation], "Land cannot have accumulated depreciation.");
      if (Number.isFinite(nbv) && nbv < residual) add("netBookValue", row[mapping.netBookValue], "Net Book Value cannot be below residual value.");
      if (lifeText && (!Number.isInteger(life) || (life ?? 0) <= 0)) add("usefulLifeYears", lifeText, "Useful life must be a positive whole number of years.");
      if (!Number.isFinite(residual) || residual < 0 || residual > cost) add("residualValue", row[mapping.residualValue], "Residual value must be between zero and original cost.");
      if (branchName && !branch) add("branch", branchName, "Branch does not exist in this business.");
      if (branch && membership.branchId && membership.branchId !== branch.id) add("branch", branchName, "You do not have access to this branch.");
      valid.push({ name, category, cost, acc, nbv, life: category === "LAND" ? null : life, residual, branchId: branch?.id ?? null, acquisitionDate, notes: val(row, mapping, "notes") || null });
      validRowNumbers.push(rowNumber);
    }
  });
  const errorRows = new Set(errors.map((e) => e.rowNumber));
  return { validRows: valid.filter((_, i) => !errorRows.has(validRowNumbers[i])), errors, totalRows: rows.length };
}

export async function commitMigration(params: { businessId: string; userId: string; membership: ResolvedMembership; kind: ImportKind; filename: string; migrationDate: Date; rows: Record<string, any>[]; errors: RowError[] }) {
  const { businessId, userId, membership, kind, filename, migrationDate, rows, errors } = params;
  const errorRows = new Set(errors.map((e) => e.rowNumber));
  const rejectedRows = errorRows.size;
  return prisma.$transaction(async (tx) => {
    await assertRecordDateOpen({ tx, businessId, instant: migrationDate, what: "this opening balance date", mode: "date" });
    const batch = await tx.importBatch.create({ data: { businessId, userId, importType: kind, filename: filename.slice(0, 255), migrationDate, totalRows: rows.length + rejectedRows, importedRows: 0, rejectedRows, status: "PROCESSING", errorSummary: rejectedRows ? `${rejectedRows} row${rejectedRows === 1 ? "" : "s"} rejected during validation.` : null, errors: errors as unknown as Prisma.InputJsonValue } });
    if (!rows.length) {
      await tx.importBatch.update({ where: { id: batch.id }, data: { status: "COMPLETED_WITH_ERRORS" } });
      await logAudit({ tx, businessId, userId, action: `data_migration.${kind.toLowerCase()}`, entityType: "ImportBatch", entityId: batch.id, metadata: { imported: 0, rejected: rejectedRows, migrationDate: migrationDate.toISOString() } });
      return { batchId: batch.id, imported: 0, rejected: rejectedRows, openingValue: 0 };
    }
    if (kind === "PRODUCTS") {
      const inventoryId = await getOrCreateSystemAccountId(tx, businessId, "INVENTORY");
      const equityId = await getOrCreateSystemAccountId(tx, businessId, "OPENING_BALANCE_EQUITY");
      let openingValue = 0;
      for (const item of rows) {
        const branchId = resolveBranchScope(membership, item.branchId ?? null);
        const product = await tx.product.create({ data: { businessId, categoryId: item.categoryId, name: item.name, sku: item.sku, barcode: item.barcode, description: item.description, purchasePrice: item.unitCost, sellingPrice: item.sellingPrice, unit: item.unit, vatCategory: item.vatCategory, quantity: 0 } });
        if (item.qty > 0) {
          await recordInventoryMovement({ tx, businessId, productId: product.id, type: "OPENING_STOCK", delta: item.qty, branchId, reason: `Opening stock import ${batch.id}`, referenceType: "ImportBatch", referenceId: batch.id, occurredAt: migrationDate, createdById: userId });
          openingValue += Number(item.qty) * Number(item.unitCost);
        }
      }
      if (openingValue > 0) await postJournalEntry({ tx, businessId, description: `Opening inventory import ${batch.id}`, lines: [{ accountId: inventoryId, debit: openingValue }, { accountId: equityId, credit: openingValue }], referenceType: "DataMigration", referenceId: batch.id, createdById: userId, entryDate: migrationDate });
      await tx.importBatch.update({ where: { id: batch.id }, data: { importedRows: rows.length, status: rejectedRows ? "COMPLETED_WITH_ERRORS" : "COMPLETED" } });
      await logAudit({ tx, businessId, userId, action: "data_migration.products", entityType: "ImportBatch", entityId: batch.id, metadata: { imported: rows.length, rejected: rejectedRows, openingValue, migrationDate: migrationDate.toISOString() } });
      return { batchId: batch.id, imported: rows.length, rejected: rejectedRows, openingValue };
    }
    const costId = await getOrCreateSystemAccountId(tx, businessId, "FIXED_ASSETS");
    const depreciationId = await getOrCreateSystemAccountId(tx, businessId, "ACCUMULATED_DEPRECIATION");
    const equityId = await getOrCreateSystemAccountId(tx, businessId, "OPENING_BALANCE_EQUITY");
    let totalCost = 0; let totalAccumulated = 0;
    for (const item of rows) {
      const branchId = resolveBranchScope(membership, item.branchId ?? null);
      const asset = await tx.fixedAsset.create({ data: { businessId, branchId, name: item.name, category: item.category, acquisitionDate: item.acquisitionDate, openingBalanceDate: migrationDate, cost: item.cost, residualValue: item.residual, usefulLifeYears: item.life, paymentMethod: "CASH", isOpeningBalanceImported: true, notes: item.notes, recordedById: userId } });
      totalCost += Number(item.cost); totalAccumulated += Number(item.acc);
      if (Number(item.acc) > 0) await postJournalEntry({ tx, businessId, description: `Opening depreciation – ${asset.name} (${batch.id})`, lines: [{ accountId: equityId, debit: item.acc }, { accountId: depreciationId, credit: item.acc }], referenceType: "Depreciation", referenceId: `${asset.id}:opening:${batch.id}`, createdById: userId, entryDate: migrationDate });
    }
    if (totalCost > 0) await postJournalEntry({ tx, businessId, description: `Fixed asset opening balances (${batch.id})`, lines: [{ accountId: costId, debit: totalCost }, { accountId: equityId, credit: totalCost }], referenceType: "DataMigration", referenceId: batch.id, createdById: userId, entryDate: migrationDate });
    await tx.importBatch.update({ where: { id: batch.id }, data: { importedRows: rows.length, status: rejectedRows ? "COMPLETED_WITH_ERRORS" : "COMPLETED" } });
    await logAudit({ tx, businessId, userId, action: "data_migration.fixed_assets", entityType: "ImportBatch", entityId: batch.id, metadata: { imported: rows.length, rejected: rejectedRows, totalCost, totalAccumulated, migrationDate: migrationDate.toISOString() } });
    return { batchId: batch.id, imported: rows.length, rejected: rejectedRows, openingValue: totalCost - totalAccumulated };
  }, { timeout: 120000, maxWait: 10000 });
}

export async function makeTemplate(kind: ImportKind) {
  const wb = new ExcelJS.Workbook();
  const headers = kind === "PRODUCTS" ? ["Product Code", "Product Name*", "Description", "Category", "Unit", "Opening Quantity", "Unit Cost*", "Selling Price*", "Branch", "VAT Code", "Barcode"] : ["Asset Name*", "Asset Category*", "Acquisition Date", "Original Cost*", "Accumulated Depreciation*", "Net Book Value*", "Useful Life Years", "Residual Value", "Branch", "Notes"];
  const examples = kind === "PRODUCTS" ? [["PRD-001", "Example stock item", "Optional description", "", "each", 10, 1000, 1500, "", "STANDARD", ""]] : [["Example vehicle", "Motor Vehicles", "2024-01-01", 45000000, 18000000, 27000000, 8, 0, "", "Imported opening balance"]];
  const dataSheet = wb.addWorksheet("Import Data");
  dataSheet.addRow(headers); dataSheet.addRows(examples);
  const instructionSheet = wb.addWorksheet("Instructions");
  [["Instructions"], ["Required columns are marked with *. Delete the example row before importing."], ["Branches must match an active branch name in this business. No Warehouse field exists in this application."], ["For assets, Original Cost less Accumulated Depreciation must equal Net Book Value."], ["The opening balance date is selected in the import screen."]].forEach((r) => instructionSheet.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export { Prisma };
