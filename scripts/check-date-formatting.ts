/**
 * Module 36 – static guard for the rule Module 35 wrote down: never compute or
 * display a calendar day, month or time with the runtime's own time zone.
 *
 * Module 35 moved every date COMPUTATION onto the business zone; Module 36
 * moved the last ~35 date DISPLAYS. This script keeps both true. It scans
 * every .ts/.tsx file under src/ and fails on:
 *
 *   - toLocaleDateString / toLocaleTimeString / toDateString / toTimeString
 *   - toLocaleString on something that is a date (`...Date`, `...At`, `date`)
 *   - runtime-local getters/setters: getFullYear, getMonth, getDate, getDay,
 *     getHours, getMinutes, setHours, setMinutes, setDate, setMonth,
 *     setFullYear
 *
 * Use `formatDateIn` / `formatDateTimeIn` and the helpers in
 * src/lib/timezone.ts instead. src/lib/timezone.ts itself is exempt (it is
 * the one place allowed to call the Intl/locale methods, always with an
 * explicit `timeZone`). A line that is genuinely correct as written (for
 * example a duration, not a calendar day) can carry a `// tz-ok: reason`
 * comment to opt out.
 *
 *   npx tsx scripts/check-date-formatting.ts
 *
 * No framework, no database. Exits non-zero on any violation. It reads text,
 * so a comment or string that merely mentions a banned call is ignored only
 * if the line is a comment line; put the reason in a `// tz-ok:` marker
 * otherwise.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");
const EXEMPT = new Set([join("src", "lib", "timezone.ts")]);

interface Rule {
  name: string;
  re: RegExp;
}

const RULES: Rule[] = [
  { name: "bare locale date/time formatter (use formatDateIn / formatDateTimeIn)", re: /\.(toLocaleDateString|toLocaleTimeString|toDateString|toTimeString)\s*\(/ },
  {
    name: "toLocaleString on a date (use formatDateTimeIn)",
    re: /(?:\b[A-Za-z_]*(?:Date|At|date)\)?|new Date\([^()]*(?:\([^()]*\))?[^()]*\))\s*\.toLocaleString\s*\(/,
  },
  { name: "runtime-local date getter/setter (use zonedParts / zonedDate)", re: /\.(getFullYear|getMonth|getDate|getDay|getHours|getMinutes|setFullYear|setMonth|setDate|setHours|setMinutes)\s*\(/ },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** The code part of a line: drops a leading comment line and a trailing `// …` comment. */
function codeOf(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
  const idx = line.indexOf(" //");
  return idx >= 0 ? line.slice(0, idx) : line;
}

let violations = 0;
let filesScanned = 0;
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  if (EXEMPT.has(rel.split(sep).join(sep))) continue;
  filesScanned++;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (line.includes("tz-ok")) return;
    const code = codeOf(line);
    if (!code) return;
    for (const rule of RULES) {
      if (rule.re.test(code)) {
        violations++;
        console.error(`  FAIL  ${rel}:${i + 1}  ${rule.name}\n        ${line.trim()}`);
      }
    }
  });
}

console.log(`${filesScanned} files scanned, ${violations} violation${violations === 1 ? "" : "s"}.`);
if (violations > 0) process.exit(1);
