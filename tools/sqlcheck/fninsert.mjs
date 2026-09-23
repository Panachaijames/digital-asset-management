// INSERTs written INSIDE plpgsql function bodies, checked against the real
// tables — the blind spot that produced the changed_keys failure.
//
// The SQL grammar treats a function body as an opaque string, so an INSERT in
// there is never checked against anything until it runs. This pulls each body
// apart and applies three checks to every INSERT it contains:
//
//   1. A DECLARE variable with NO initialiser (`v_changed text[];`) passed into
//      a NOT NULL column. plpgsql initialises such a variable to NULL, and
//      naming a column in an INSERT overrides its DEFAULT — so the default can
//      never rescue it. This is exactly the defect that aborted the first run.
//   2. Column-list arity against the VALUES list, paren- and quote-aware so
//      that function calls and casts inside the values do not miscount.
//   3. A NOT NULL column with no DEFAULT that the INSERT never supplies.
//
// Check 1 is a heuristic: a variable assigned on every path before the INSERT
// is a false positive. It is tuned to complain, because the cost of a false
// positive is one reading and the cost of a miss is a failed migration.
//
// Usage: node fninsert.mjs <schema.sql>
import { readFileSync } from "node:fs";
import { parse } from "libpg-query";

const file = process.argv[2];
if (!file) {
  console.error("usage: node fninsert.mjs <schema.sql>");
  process.exitCode = 2;
} else {
  const sql = readFileSync(file, "utf8");
  const tree = await parse(sql);

  // ---- real table shapes, from the parse tree
  const tables = new Map();
  for (const { stmt } of tree.stmts ?? []) {
    const c = stmt?.CreateStmt;
    if (!c?.relation?.relname) continue;
    const cols = new Map();
    for (const el of c.tableElts ?? []) {
      const cd = el.ColumnDef;
      if (!cd?.colname) continue;
      let notNull = false, hasDefault = false, generated = false;
      for (const con of cd.constraints ?? []) {
        const t = con.Constraint?.contype;
        if (t === "CONSTR_NOTNULL" || t === "CONSTR_PRIMARY") notNull = true;
        if (t === "CONSTR_DEFAULT") hasDefault = true;
        if (t === "CONSTR_GENERATED") generated = true;
      }
      cols.set(cd.colname, { notNull, hasDefault, generated });
    }
    const parent = c.inhRelations?.[0]?.RangeVar?.relname;
    if (c.partbound && parent && tables.has(parent)) {
      for (const [k, v] of tables.get(parent)) if (!cols.has(k)) cols.set(k, v);
    }
    tables.set(c.relation.relname, cols);
  }

  // Split on top-level commas only: depth-aware over () and '...'.
  const splitTop = (s) => {
    const out = [];
    let depth = 0, quoted = false, cur = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quoted) {
        cur += ch;
        if (ch === "'") quoted = s[i + 1] === "'" ? (cur += s[++i], true) : false;
        continue;
      }
      if (ch === "'") { quoted = true; cur += ch; continue; }
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };

  const problems = [];
  let bodies = 0, stmts = 0;

  const fnRe = /create (?:or replace )?function\s+([a-z0-9_]+)\s*\(([\s\S]*?)\)([\s\S]*?)\nas \$\$([\s\S]*?)\n\$\$;/gi;
  let m;
  while ((m = fnRe.exec(sql))) {
    const [, fname, , head, body] = m;
    if (!/language\s+plpgsql/i.test(head)) continue;
    bodies++;
    const fnLine = sql.slice(0, m.index).split("\n").length;

    // Uninitialised DECLARE variables: `name type;` with no `:=` before the ;
    const declEnd = body.search(/\bbegin\b/i);
    const decl = declEnd > 0 ? body.slice(0, declEnd) : "";
    const uninit = new Set();
    // A body may justify a variable the heuristic would otherwise flag, with
    // `-- fninsert:ok <var> — <reason>`. The reason then lives next to the code
    // a reviewer reads, instead of in a list nobody opens.
    const excused = new Set(
      [...body.matchAll(/--\s*fninsert:ok\s+([a-z_][a-z0-9_]*)/gi)].map((x) => x[1])
    );
    for (const line of decl.split("\n")) {
      const t = line.replace(/--.*$/, "").trim();
      if (!t || /:=/.test(t) || /\bconstant\b/i.test(t)) continue;
      const d = t.match(/^([a-z_][a-z0-9_]*)\s+[a-z].*;$/i);
      if (d) uninit.add(d[1]);
    }

    // Every `insert into <t> (cols) values (vals)` in the body.
    const insRe = /insert\s+into\s+([a-z0-9_]+)\s*\(([^;]*?)\)\s*values\s*\(([\s\S]*?)\)\s*(?:returning|on\s+conflict|;)/gi;
    let ins;
    while ((ins = insRe.exec(body))) {
      stmts++;
      const [, t, colsRaw, valsRaw] = ins;
      const cols = tables.get(t);
      const at = `${fname}() near line ${fnLine + body.slice(0, ins.index).split("\n").length - 1}`;
      if (!cols) { problems.push(`${at}: inserts into ${t}, which has no CREATE TABLE`); continue; }

      const named = splitTop(colsRaw.replace(/\s+/g, " ")).map((c) => c.trim());
      const vals = splitTop(valsRaw.replace(/\s+/g, " "));

      if (named.length !== vals.length) {
        problems.push(`${at}: ${t} — ${named.length} columns but ${vals.length} values`);
        continue;
      }

      for (const name of named) {
        if (!cols.has(name)) problems.push(`${at}: ${t} has no column "${name}"`);
        else if (cols.get(name).generated) problems.push(`${at}: ${t}.${name} is GENERATED ALWAYS and cannot be named`);
      }

      for (const [name, def] of cols) {
        if (def.notNull && !def.hasDefault && !def.generated && !named.includes(name)) {
          problems.push(`${at}: ${t}.${name} is NOT NULL with no default and is not supplied`);
        }
      }

      named.forEach((name, i) => {
        const def = cols.get(name);
        if (!def?.notNull) return;
        const v = vals[i];
        if (uninit.has(v) && !excused.has(v)) {
          problems.push(
            `${at}: ${t}.${name} is NOT NULL but receives "${v}", declared without an initialiser ` +
            `(plpgsql sets it to NULL, and naming the column overrides its DEFAULT)`
          );
        }
        if (/^null$/i.test(v)) problems.push(`${at}: ${t}.${name} is NOT NULL but receives a literal NULL`);
      });
    }
  }

  console.log(`plpgsql bodies ${bodies}; INSERT statements inside them ${stmts}`);
  if (problems.length) {
    console.log(`\nWOULD FAIL AT RUN TIME (${problems.length}):`);
    for (const p of problems) console.log("  " + p);
  } else {
    console.log("Every in-function INSERT matches its target table, and none passes an uninitialised variable to a NOT NULL column.");
  }
  process.exitCode = problems.length ? 1 : 0;
}
