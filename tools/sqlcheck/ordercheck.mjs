// Execution-order check for the assembled SCHEMA.sql.
//
// The parser accepts a forward reference happily — `alter table a add foreign
// key references b` is valid syntax whether or not b exists yet — so a file can
// parse perfectly and still fail on the third statement when it is actually
// run. This walks the statements in order and asserts that every object a
// statement depends on was created by an earlier statement.
//
// Covers: ALTER TABLE (the table and its FK target), CREATE INDEX, CREATE
// POLICY, CREATE TRIGGER, INSERT/UPDATE targets, and the table names named
// inside DO blocks (which run dynamic SQL the parser cannot see into).
//
// Usage: node ordercheck.mjs <schema.sql>
import { readFileSync } from "node:fs";
import { parse } from "libpg-query";

const file = process.argv[2];
if (!file) {
  console.error("usage: node ordercheck.mjs <schema.sql>");
  process.exitCode = 2;
} else {
  const sql = readFileSync(file, "utf8");
  const tree = await parse(sql);
  const lineOf = (loc) => (typeof loc === "number" ? sql.slice(0, loc).split("\n").length : 0);

  const created = new Map();   // table -> line
  const functions = new Set(); // function name
  const types = new Set();     // enum/type name
  const problems = [];
  let order = 0;

  const need = (table, atLine, what) => {
    if (!table) return;
    if (!created.has(table)) problems.push(`line ${atLine}: ${what} needs ${table}, which is not created anywhere earlier`);
  };

  for (const { stmt, stmt_location } of tree.stmts ?? []) {
    order++;
    const kind = Object.keys(stmt ?? {})[0];
    const n = stmt?.[kind];
    const line = lineOf(stmt_location ?? n?.relation?.location);

    if (kind === "CreateStmt") {
      created.set(n.relation?.relname, line);
      // A partition child needs its parent first.
      const parent = n.inhRelations?.[0]?.RangeVar?.relname;
      if (parent) need(parent, line, `partition ${n.relation?.relname}`);
      // Inline FK targets must already exist.
      for (const el of n.tableElts ?? []) {
        const cons = el.ColumnDef ? (el.ColumnDef.constraints ?? []) : [el];
        for (const c of cons) {
          const t = c.Constraint?.contype === "CONSTR_FOREIGN" ? c.Constraint.pktable?.relname : null;
          if (t && t !== n.relation?.relname) need(t, line, `${n.relation?.relname} inline FK`);
        }
      }
      continue;
    }

    if (kind === "CreateFunctionStmt") { functions.add((n.funcname ?? []).map((x) => x.String?.sval).filter(Boolean).at(-1)); continue; }
    if (kind === "CreateEnumStmt") { types.add((n.typeName ?? []).map((x) => x.String?.sval).filter(Boolean).at(-1)); continue; }

    if (kind === "AlterTableStmt") {
      need(n.relation?.relname, line, "alter table");
      for (const c of n.cmds ?? []) {
        const con = c.AlterTableCmd?.def?.Constraint;
        if (con?.contype === "CONSTR_FOREIGN") need(con.pktable?.relname, line, `${n.relation?.relname} FK`);
      }
      continue;
    }

    if (kind === "IndexStmt") { need(n.relation?.relname, line, `index ${n.idxname ?? ""}`); continue; }
    if (kind === "CreatePolicyStmt") { need(n.table?.relname, line, `policy ${n.policy_name}`); continue; }
    if (kind === "CreateTrigStmt") { need(n.relation?.relname, line, `trigger ${n.trigname}`); continue; }
    if (kind === "InsertStmt") { need(n.relation?.relname, line, "insert"); continue; }
    if (kind === "UpdateStmt") { need(n.relation?.relname, line, "update"); continue; }

    if (kind === "DoStmt") {
      // A DO block runs dynamic SQL. Take every dam_ identifier that appears
      // as a quoted string or bare word inside it and require it to exist,
      // skipping anything that is a function or a type rather than a table.
      const body = (n.args ?? []).map((a) => a.DefElem?.arg?.String?.sval ?? "").join("\n");
      const names = new Set([...body.matchAll(/\b(dam_[a-z0-9_]+)\b/g)].map((m) => m[1]));
      for (const name of names) {
        if (functions.has(name) || types.has(name)) continue;
        if (!created.has(name)) problems.push(`line ${line}: DO block names ${name}, which is not created anywhere earlier`);
      }
      continue;
    }
  }

  console.log(`statements ${order}; tables created ${created.size}`);
  if (problems.length) {
    console.log(`\nWOULD FAIL AT RUNTIME (${problems.length}):`);
    for (const p of problems.slice(0, 25)) console.log("  " + p);
    if (problems.length > 25) console.log(`  … and ${problems.length - 25} more`);
  } else {
    console.log("Every statement's dependencies exist by the time it runs.");
  }
  process.exitCode = problems.length ? 1 : 0;
}
