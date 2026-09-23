// Cross-part reference checker for the SPEC parts.
//
// Builds the table -> column map from the domain parts (02a, 02b), then checks
// every `dam_table.column` reference anywhere in the specification against it.
// This is the defect class a syntax parser cannot see: one part referring to a
// column another part never defined, or spelling it differently.
//
// Usage: node refcheck.mjs --domain spec/02a-domain-core.md spec/02b-domain-supporting.md -- spec/*.md
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const domainFiles = argv.slice(argv.indexOf("--domain") + 1, sep === -1 ? undefined : sep);
const allFiles = sep === -1 ? domainFiles : argv.slice(sep + 1);

const tables = new Map();   // table -> Set(columns)
const definedIn = new Map(); // table -> file

for (const f of domainFiles) {
  const name = basename(f);
  const lines = readFileSync(f, "utf8").replace(/\r\n/g, "\n").split("\n");
  let cur = null;
  for (const line of lines) {
    // "### 2.7 `dam_categories`" or "#### 2B.45a `dam_sync_field_state`"
    const h = /^#{3,4}\s+\d+[AB]?\.\d+[a-z]?\s+`?(dam_[a-z0-9_]+)`?/.exec(line);
    if (h) { cur = h[1]; if (!tables.has(cur)) { tables.set(cur, new Set()); definedIn.set(cur, name); } continue; }
    if (!cur) continue;
    // A field-table row: | `column` | type | ...
    // Part 02a backticks its column names, part 02b does not. Accept both.
    const c = /^\|\s*`?([a-z][a-z0-9_]*)`?\s*\|/.exec(line);
    if (c) tables.get(cur).add(c[1]);
    // Inline child-table definitions: `dam_x {a, b, c}` or "one row per ..." lists
    const inline = /`(dam_[a-z0-9_]+)\s*\{([^}]+)\}`/.exec(line);
    if (inline) {
      const t = inline[1];
      if (!tables.has(t)) { tables.set(t, new Set()); definedIn.set(t, name + " (inline)"); }
      for (const tok of inline[2].split(/[,\s]+/)) {
        const m = /^([a-z][a-z0-9_]*)$/.exec(tok.trim());
        if (m) tables.get(t).add(m[1]);
      }
    }
  }
}

// Standard columns every table carries, whether or not the field table repeats them.
const STANDARD = ["id", "created_at", "updated_at", "created_by", "updated_by", "deleted_at", "deleted_by"];
for (const cols of tables.values()) for (const c of STANDARD) cols.add(c);

// Pseudo-columns and qualified names that are not column references.
const NOT_A_COLUMN = new Set(["id", "count", "length", "sql", "md", "ts", "json", "jsonb", "uuid", "text", "then", "com"]);

const problems = new Map(); // "table.column" -> [file:line]
const unknownTables = new Map();
let refs = 0;

for (const f of allFiles) {
  const name = basename(f);
  const lines = readFileSync(f, "utf8").replace(/\r\n/g, "\n").split("\n");
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { fence = !fence; return; }
    if (fence) return;
    for (const m of line.matchAll(/\b(dam_[a-z0-9_]+)\.([a-z][a-z0-9_]*)\b/g)) {
      const [, t, c] = m;
      if (NOT_A_COLUMN.has(c)) continue;
      refs++;
      if (!tables.has(t)) {
        // A function or a file name, not a table.
        if (/\(\)|\.md|\.sql|\.ts/.test(line.slice(m.index, m.index + 40))) continue;
        const at = unknownTables.get(t) ?? [];
        if (at.length < 4) at.push(`${name}:${i + 1}`);
        unknownTables.set(t, at);
        continue;
      }
      if (!tables.get(t).has(c)) {
        const key = `${t}.${c}`;
        const at = problems.get(key) ?? [];
        if (at.length < 5) at.push(`${name}:${i + 1}`);
        problems.set(key, at);
      }
    }
  });
}

console.log(`TABLES ${tables.size} defined; ${refs} qualified column references checked`);
if (unknownTables.size) {
  console.log(`\nREFERENCES TO UNDEFINED TABLES (${unknownTables.size}):`);
  for (const [t, at] of [...unknownTables.entries()].sort()) console.log(`  ${t}  (${at.join(", ")})`);
}
if (problems.size) {
  console.log(`\nREFERENCES TO UNDEFINED COLUMNS (${problems.size}):`);
  for (const [k, at] of [...problems.entries()].sort()) {
    const t = k.split(".")[0];
    console.log(`  ${k}  (${at.join(", ")})  [table defined in ${definedIn.get(t)}]`);
  }
} else {
  console.log("\nNo undefined column references.");
}
process.exitCode = problems.size || unknownTables.size ? 1 : 0;
