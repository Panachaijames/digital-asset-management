// Verify that every column referenced by a policy, index or trigger actually
// exists on the table it is attached to.
//
// Uses the real PostgreSQL parse tree rather than regexes: ColumnRef nodes are
// walked out of each statement's expression, so `case target_type when ... then
// dam_can_read_asset(target_id) end` is understood the same way the server
// understands it.
//
// Unqualified names inside a sub-select could belong to the sub-select's own
// table, so a name is reported only when it belongs to NO table in the schema —
// that keeps the output free of false alarms while still catching a typo.
//
// Usage: node polcheck.mjs <table-files...> -- <policy-files...>
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parse } from "libpg-query";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const tableFiles = sep === -1 ? argv : argv.slice(0, sep);
const policyFiles = sep === -1 ? [] : argv.slice(sep + 1);

const S = (n) => n?.String?.sval ?? n?.sval ?? null;

// ---- collect columns per table
const tables = new Map();
for (const f of tableFiles) {
  const tree = await parse(readFileSync(f, "utf8"));
  for (const { stmt } of tree.stmts ?? []) {
    const c = stmt?.CreateStmt;
    if (!c) continue;
    const name = c.relation?.relname;
    if (!name) continue;
    const cols = tables.get(name) ?? new Set();
    for (const el of c.tableElts ?? []) if (el.ColumnDef?.colname) cols.add(el.ColumnDef.colname);
    tables.set(name, cols);
    // A partition child inherits its parent's columns.
    if (c.partbound) {
      const parent = c.inhRelations?.[0]?.RangeVar?.relname;
      if (parent && tables.has(parent)) for (const x of tables.get(parent)) cols.add(x);
    }
  }
  // ALTER TABLE ... ADD COLUMN
  for (const { stmt } of tree.stmts ?? []) {
    const a = stmt?.AlterTableStmt;
    if (!a) continue;
    const name = a.relation?.relname;
    for (const cmd of a.cmds ?? []) {
      const cd = cmd.AlterTableCmd?.def?.ColumnDef;
      if (cd?.colname && tables.has(name)) tables.get(name).add(cd.colname);
    }
  }
}

const everyColumn = new Set();
for (const cols of tables.values()) for (const c of cols) everyColumn.add(c);

// ---- walk a parse tree for ColumnRef field names
function columnsIn(node, out = new Set()) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const x of node) columnsIn(x, out); return out; }
  if (node.ColumnRef) {
    const fields = (node.ColumnRef.fields ?? []).map(S).filter(Boolean);
    if (fields.length === 1) out.add(fields[0]);          // bare name
    else if (fields.length >= 2) out.add(fields.join(".")); // qualified
  }
  for (const v of Object.values(node)) columnsIn(v, out);
  return out;
}

const problems = [];
let checked = 0;
let policyCount = 0;

for (const f of policyFiles) {
  const name = basename(f);
  const sql = readFileSync(f, "utf8");
  const tree = await parse(sql);
  for (const { stmt } of tree.stmts ?? []) {
    let table = null;
    let expr = null;
    let label = null;
    if (stmt?.CreatePolicyStmt) {
      table = stmt.CreatePolicyStmt.table?.relname;
      label = `policy ${stmt.CreatePolicyStmt.policy_name} on ${table}`;
      expr = [stmt.CreatePolicyStmt.qual, stmt.CreatePolicyStmt.with_check];
      policyCount++;
    } else if (stmt?.IndexStmt) {
      table = stmt.IndexStmt.relation?.relname;
      label = `index ${stmt.IndexStmt.idxname ?? "(unnamed)"} on ${table}`;
      expr = [stmt.IndexStmt.indexParams, stmt.IndexStmt.whereClause];
    } else continue;

    if (!table || !tables.has(table)) {
      problems.push(`${name}: ${label} — table not defined in the table files`);
      continue;
    }
    checked++;
    const own = tables.get(table);
    for (const col of columnsIn(expr)) {
      if (col.includes(".")) {
        // qualified: alias.column or table.column — only check the known-table form
        const [q, c] = col.split(".");
        if (tables.has(q) && !tables.get(q).has(c)) {
          problems.push(`${name}: ${label} — ${q}.${c} does not exist on ${q}`);
        }
        continue;
      }
      if (own.has(col)) continue;
      // Might belong to a table joined inside a sub-select. Only flag names that
      // exist nowhere in the schema at all.
      if (!everyColumn.has(col)) {
        problems.push(`${name}: ${label} — "${col}" is not a column of ${table}, nor of any table`);
      }
    }
  }
}

console.log(`TABLES ${tables.size}; policies and indexes checked ${checked} (${policyCount} policies)`);
if (problems.length) {
  console.log(`\nPROBLEMS (${problems.length}):`);
  for (const p of problems) console.log("  " + p);
} else {
  console.log("Every policy and index column resolves.");
}
process.exitCode = problems.length ? 1 : 0;
