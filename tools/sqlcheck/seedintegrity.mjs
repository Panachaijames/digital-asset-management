// The last two ways a seed row can fail: a unique-index collision and a
// foreign key pointing at a row nobody seeds.
//
// The database this file is applied to is EMPTY, so every foreign-key value in
// a seed must be satisfied by another seed in the same file, and earlier in it.
// That makes both checks decidable offline:
//
//   * UNIQUE. Every unique index, including the partial ones that carry the
//     real rules — one live default access level, one pass-through size, one
//     row per aspect ratio — evaluated over the seeded rows, with the index
//     predicate applied first and `lower(col)` key expressions honoured.
//   * FOREIGN KEY. Every FK column with a seeded value, resolved against the
//     ids seeded into the target table, and against the STATEMENT ORDER: a
//     parent seeded after its child is as fatal as one never seeded at all.
//
// Usage: node seedintegrity.mjs <schema.sql>
import { readFileSync } from "node:fs";
import { parse } from "libpg-query";

const file = process.argv[2];
if (!file) {
  console.error("usage: node seedintegrity.mjs <schema.sql>");
  process.exitCode = 2;
} else {
  const sql = readFileSync(file, "utf8");
  const tree = await parse(sql);
  const stmts = tree.stmts ?? [];
  const lineOf = (loc) => (typeof loc === "number" ? sql.slice(0, loc).split("\n").length : 0);

  const lit = (n) => {
    if (!n) return undefined;
    if (n.A_Const) {
      const c = n.A_Const;
      if (c.isnull) return null;
      if ("ival" in c) return c.ival.ival ?? 0;
      if ("fval" in c) return Number(c.fval.fval);
      if ("sval" in c) return c.sval.sval;
      if ("boolval" in c) return c.boolval.boolval ?? false;
    }
    if (n.TypeCast) return lit(n.TypeCast.arg);
    return undefined;
  };

  // ---- FK edges and column defaults, from CREATE TABLE and ALTER TABLE ------
  const fks = [];          // {table, col, target}
  const defaults = new Map(); // table -> Map(col -> literal|undefined)
  for (const { stmt } of stmts) {
    const c = stmt?.CreateStmt;
    if (c?.relation?.relname) {
      const t = c.relation.relname;
      const d = new Map();
      for (const el of c.tableElts ?? []) {
        const cd = el.ColumnDef;
        if (cd?.colname) {
          for (const con of cd.constraints ?? []) {
            const k = con.Constraint;
            if (k?.contype === "CONSTR_DEFAULT") d.set(cd.colname, lit(k.raw_expr));
            if (k?.contype === "CONSTR_FOREIGN" && k.pktable?.relname) {
              fks.push({ table: t, col: cd.colname, target: k.pktable.relname });
            }
          }
        } else if (el.Constraint?.contype === "CONSTR_FOREIGN") {
          const k = el.Constraint;
          for (const a of k.fk_attrs ?? []) {
            const col = a.String?.sval;
            if (col && k.pktable?.relname) fks.push({ table: t, col, target: k.pktable.relname });
          }
        }
      }
      defaults.set(t, d);
      continue;
    }
    const a = stmt?.AlterTableStmt;
    if (a?.relation?.relname) {
      for (const cmd of a.cmds ?? []) {
        const k = cmd.AlterTableCmd?.def?.Constraint;
        if (k?.contype !== "CONSTR_FOREIGN" || !k.pktable?.relname) continue;
        for (const at of k.fk_attrs ?? []) {
          const col = at.String?.sval;
          if (col) fks.push({ table: a.relation.relname, col, target: k.pktable.relname });
        }
      }
    }
  }
  const fkByTable = new Map();
  for (const f of fks) {
    if (!fkByTable.has(f.table)) fkByTable.set(f.table, []);
    fkByTable.get(f.table).push(f);
  }

  // ---- unique indexes -------------------------------------------------------
  // Keys: plain columns and lower(col). Predicates: the small grammar the
  // schema actually uses. Anything else is reported as unmodelled, not passed.
  const uniques = [], unmodelled = [];
  for (const { stmt } of stmts) {
    const ix = stmt?.IndexStmt;
    if (!ix?.unique || !ix.relation?.relname) continue;
    let ok = true;
    const keys = (ix.indexParams ?? []).map((p) => {
      const e = p.IndexElem;
      if (e?.name) return { col: e.name, fn: null };
      const fc = e?.expr?.FuncCall;
      const fn = (fc?.funcname ?? []).map((x) => x.String?.sval).filter(Boolean).pop();
      const arg = fc?.args?.[0]?.ColumnRef?.fields?.map((x) => x.String?.sval).filter(Boolean).pop();
      if (fn === "lower" && arg) return { col: arg, fn: "lower" };
      if (e?.expr?.A_Const) return { col: null, fn: "const", constVal: lit(e.expr) };
      ok = false;
      return null;
    });
    if (!ok) { unmodelled.push(`${ix.idxname} on ${ix.relation.relname} (key expression)`); continue; }

    // Predicate: AND of `col is null` / `col is not null` / `col` / `not col`
    // / `col = literal` / `col <> literal` / `col in (...)`.
    const preds = [];
    const walk = (n) => {
      if (!n) return true;
      if (n.BoolExpr?.boolop === "AND_EXPR") return (n.BoolExpr.args ?? []).every(walk);
      if (n.NullTest) {
        const col = n.NullTest.arg?.ColumnRef?.fields?.map((x) => x.String?.sval).filter(Boolean).pop();
        if (!col) return false;
        preds.push({ col, kind: n.NullTest.nulltesttype === "IS_NULL" ? "null" : "notnull" });
        return true;
      }
      if (n.ColumnRef) {
        preds.push({ col: n.ColumnRef.fields.map((x) => x.String?.sval).filter(Boolean).pop(), kind: "true" });
        return true;
      }
      if (n.BoolExpr?.boolop === "NOT_EXPR") {
        const col = n.BoolExpr.args?.[0]?.ColumnRef?.fields?.map((x) => x.String?.sval).filter(Boolean).pop();
        if (!col) return false;
        preds.push({ col, kind: "false" });
        return true;
      }
      if (n.A_Expr) {
        const op = (n.A_Expr.name ?? []).map((x) => x.String?.sval).filter(Boolean).pop();
        const col = n.A_Expr.lexpr?.ColumnRef?.fields?.map((x) => x.String?.sval).filter(Boolean).pop();
        if (!col) return false;
        if (n.A_Expr.kind === "AEXPR_IN") {
          const vals = (n.A_Expr.rexpr?.List?.items ?? []).map(lit);
          if (vals.some((v) => v === undefined)) return false;
          preds.push({ col, kind: op === "<>" ? "notin" : "in", vals });
          return true;
        }
        const v = lit(n.A_Expr.rexpr);
        if (v === undefined) return false;
        if (op === "=") { preds.push({ col, kind: "eq", val: v }); return true; }
        if (op === "<>") { preds.push({ col, kind: "ne", val: v }); return true; }
        return false;
      }
      return false;
    };
    if (ix.whereClause && !walk(ix.whereClause)) {
      unmodelled.push(`${ix.idxname} on ${ix.relation.relname} (predicate)`);
      continue;
    }
    uniques.push({ name: ix.idxname, table: ix.relation.relname, keys, preds });
  }

  // ---- walk the seeds in statement order ------------------------------------
  const seededIds = new Map();      // table -> Set(id)
  const seen = new Map();           // index name -> Map(key -> label)
  const problems = [];
  let rows = 0;

  for (const { stmt, stmt_location } of stmts) {
    const ins = stmt?.InsertStmt;
    if (!ins?.relation?.relname) continue;
    const t = ins.relation.relname;
    const line = lineOf(stmt_location);
    const named = (ins.cols ?? []).map((c) => c.ResTarget?.name).filter(Boolean);
    const defs = defaults.get(t) ?? new Map();

    for (const [i, row] of (ins.selectStmt?.SelectStmt?.valuesLists ?? []).entries()) {
      rows++;
      const env = new Map(defs);
      (row.List?.items ?? []).forEach((v, j) => { if (named[j]) env.set(named[j], lit(v)); });
      const label = `${t} row ${i + 1} (${env.get("name") ?? env.get("slug") ?? env.get("code") ?? env.get("id")})`;

      // --- foreign keys, against what has been seeded SO FAR
      for (const f of fkByTable.get(t) ?? []) {
        const v = env.get(f.col);
        if (v === null || v === undefined) continue;
        const pool = seededIds.get(f.target);
        if (f.target === t && env.get("id") === v) continue; // self-reference in-row
        if (!pool || !pool.has(v)) {
          problems.push(`line ${line}: ${label} — ${f.col} = ${v} references ${f.target}, which has no such row seeded before this statement`);
        }
      }

      // --- unique indexes
      for (const u of uniques) {
        if (u.table !== t) continue;
        const applies = u.preds.every((p) => {
          const v = env.get(p.col);
          switch (p.kind) {
            case "null":    return v === null || v === undefined;
            case "notnull": return v !== null && v !== undefined;
            case "true":    return v === true;
            case "false":   return v === false;
            case "eq":      return v === p.val;
            case "ne":      return v !== p.val;
            case "in":      return p.vals.includes(v);
            case "notin":   return !p.vals.includes(v);
            default:        return false;
          }
        });
        if (!applies) continue;
        const parts = u.keys.map((k) => {
          if (k.fn === "const") return String(k.constVal);
          const v = env.get(k.col);
          if (v === null || v === undefined) return " NULL";
          return k.fn === "lower" ? String(v).toLowerCase() : String(v);
        });
        // A NULL key column makes the row distinct under a plain unique index.
        if (parts.some((p) => p === " NULL")) continue;
        const key = parts.join("");
        if (!seen.has(u.name)) seen.set(u.name, new Map());
        const m = seen.get(u.name);
        if (m.has(key)) {
          problems.push(`line ${line}: ${label} collides with ${m.get(key)} on unique index ${u.name} [${parts.join(", ")}]`);
        } else {
          m.set(key, label);
        }
      }

      if (env.get("id") !== undefined && env.get("id") !== null) {
        if (!seededIds.has(t)) seededIds.set(t, new Set());
        seededIds.get(t).add(env.get("id"));
      }
    }
  }

  const seededTables = new Set([...seededIds.keys()]);
  console.log(`seeded rows ${rows}; unique indexes modelled ${uniques.length}; FK columns tracked ${fks.length}`);
  if (unmodelled.length) {
    console.log(`unique indexes NOT modelled (reported, never assumed safe): ${unmodelled.length}`);
    for (const u of unmodelled) console.log("    " + u + (seededTables.has(u.split(" on ")[1].split(" ")[0]) ? "   <-- ON A SEEDED TABLE" : ""));
  }
  if (problems.length) {
    console.log(`\nWOULD FAIL AT RUN TIME (${problems.length}):`);
    for (const p of problems) console.log("  " + p);
  } else {
    console.log("No unique collision and no dangling foreign key among the seeded rows.");
  }
  process.exitCode = problems.length ? 1 : 0;
}
