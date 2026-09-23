// Seed-statement check: every INSERT and UPDATE against the real table shape.
//
// The grammar accepts `insert into t (a, b) values (1, 2, 3)` as far as parsing
// goes and only complains at execution, and it has no idea whether a column is
// GENERATED ALWAYS, NOT NULL, or even exists. This walks the real parse tree and
// checks each write statement against the CREATE TABLE it targets:
//
//   * column-list arity vs every VALUES tuple;
//   * every named column exists on that table;
//   * no named column is GENERATED ALWAYS (naming one is an error);
//   * every NOT NULL column with no DEFAULT and no GENERATED clause is supplied
//     — the class that produced the changed_keys failure, one level up;
//   * a NULL literal supplied for a NOT NULL column.
//
// Usage: node seedcheck.mjs <schema.sql>
import { readFileSync } from "node:fs";
import { parse } from "libpg-query";

const file = process.argv[2];
if (!file) {
  console.error("usage: node seedcheck.mjs <schema.sql>");
  process.exitCode = 2;
} else {
  const sql = readFileSync(file, "utf8");
  const tree = await parse(sql);
  const lineOf = (loc) => (typeof loc === "number" ? sql.slice(0, loc).split("\n").length : 0);

  // ---- model every table from its CREATE TABLE
  const tables = new Map();
  for (const { stmt } of tree.stmts ?? []) {
    const c = stmt?.CreateStmt;
    if (!c?.relation?.relname) continue;
    const cols = new Map();
    for (const el of c.tableElts ?? []) {
      const cd = el.ColumnDef;
      if (!cd?.colname) continue;
      let notNull = false, hasDefault = false, generated = false, identity = false;
      for (const con of cd.constraints ?? []) {
        const t = con.Constraint?.contype;
        if (t === "CONSTR_NOTNULL") notNull = true;
        if (t === "CONSTR_DEFAULT") hasDefault = true;
        if (t === "CONSTR_GENERATED") generated = true;
        if (t === "CONSTR_IDENTITY") identity = true;
        if (t === "CONSTR_PRIMARY") notNull = true;
      }
      cols.set(cd.colname, { notNull, hasDefault, generated, identity });
    }
    // A partition child inherits every column of its parent.
    const parent = c.inhRelations?.[0]?.RangeVar?.relname;
    if (c.partbound && parent && tables.has(parent)) {
      for (const [k, v] of tables.get(parent)) if (!cols.has(k)) cols.set(k, v);
    }
    tables.set(c.relation.relname, cols);
  }

  const problems = [];
  let inserts = 0, updates = 0, tuples = 0;

  for (const { stmt, stmt_location } of tree.stmts ?? []) {
    const line = lineOf(stmt_location);

    // ---------------------------------------------------------------- INSERT
    const ins = stmt?.InsertStmt;
    if (ins) {
      inserts++;
      const t = ins.relation?.relname;
      const cols = tables.get(t);
      if (!cols) { problems.push(`line ${line}: insert into ${t} — no CREATE TABLE for it`); continue; }

      const named = (ins.cols ?? []).map((c) => c.ResTarget?.name).filter(Boolean);
      const rows = ins.selectStmt?.SelectStmt?.valuesLists ?? [];

      for (const name of named) {
        const def = cols.get(name);
        if (!def) problems.push(`line ${line}: ${t} has no column "${name}"`);
        else if (def.generated) problems.push(`line ${line}: ${t}.${name} is GENERATED ALWAYS and cannot be named in an INSERT`);
      }

      // Required = NOT NULL, no default, not generated, not identity.
      for (const [name, def] of cols) {
        if (def.notNull && !def.hasDefault && !def.generated && !def.identity && !named.includes(name)) {
          problems.push(`line ${line}: ${t}.${name} is NOT NULL with no default and is not supplied`);
        }
      }

      rows.forEach((row, i) => {
        tuples++;
        const vals = row.List?.items ?? [];
        if (named.length && vals.length !== named.length) {
          problems.push(`line ${line}: ${t} tuple ${i + 1} has ${vals.length} values for ${named.length} columns`);
          return;
        }
        vals.forEach((v, j) => {
          const isNull = v?.A_Const?.isnull === true;
          if (!isNull) return;
          const def = cols.get(named[j]);
          if (def?.notNull) problems.push(`line ${line}: ${t} tuple ${i + 1} passes NULL to NOT NULL column ${named[j]}`);
        });
      });
      continue;
    }

    // ---------------------------------------------------------------- UPDATE
    const upd = stmt?.UpdateStmt;
    if (upd) {
      updates++;
      const t = upd.relation?.relname;
      const cols = tables.get(t);
      if (!cols) { problems.push(`line ${line}: update ${t} — no CREATE TABLE for it`); continue; }
      for (const tgt of upd.targetList ?? []) {
        const name = tgt.ResTarget?.name;
        if (!name) continue;
        const def = cols.get(name);
        if (!def) problems.push(`line ${line}: update ${t} sets unknown column "${name}"`);
        else if (def.generated) problems.push(`line ${line}: update ${t} sets GENERATED ALWAYS column ${name}`);
        else if (def.notNull && tgt.ResTarget?.val?.A_Const?.isnull === true) {
          problems.push(`line ${line}: update ${t} sets NOT NULL column ${name} to NULL`);
        }
      }
    }
  }

  console.log(`tables ${tables.size}; insert statements ${inserts} (${tuples} tuples); update statements ${updates}`);
  if (problems.length) {
    console.log(`\nWOULD FAIL OR MISBEHAVE (${problems.length}):`);
    for (const p of problems) console.log("  " + p);
  } else {
    console.log("Every seeded write matches its table's real shape.");
  }
  process.exitCode = problems.length ? 1 : 0;
}
