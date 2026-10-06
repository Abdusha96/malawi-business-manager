/**
 * CSV covers spec section 21's "CSV export" directly, and opens fine in
 * Excel for the "Excel export" requirement too – genuine .xlsx generation
 * (with formatting, multiple sheets, etc.) is deferred to a dedicated pass
 * once there's a second real consumer of it (Payroll payslips, tax reports)
 * to justify pulling in a spreadsheet-writing library for more than one
 * feature. PDF export follows the same reasoning as receipts (Module 3) –
 * deferred to the Business Documents module's shared layout engine.
 */
export function toCsv(rows: Record<string, string | number>[]): string {
  if (rows.length === 0) return "";

  const headers = Object.keys(rows[0]);
  const escape = (value: string | number) => {
    const str = String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((h) => escape(row[h] ?? "")).join(",")),
  ];

  return lines.join("\n");
}

export function csvResponse(filename: string, rows: Record<string, string | number>[]): Response {
  return new Response(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
