// Evaluate every CHECK constraint against every seeded row, offline.
//
// seedcheck.mjs proves a seed row has the right SHAPE — the right columns, the
// right arity, no NULL in a NOT NULL column. It says nothing about whether the
// VALUES satisfy the table's own CHECK constraints, and that is the gap that
// let `('Original', ..., format 'jpeg', ..., is_original true)` through a green
// validation run and into a failed migration: dam_sizes asserts
// `is_original = (format = 'original')`, and the seed said otherwise.
//
// This builds an environment per seeded row — the supplied values plus the
// column DEFAULTs for everything unsupplied — and evaluates each CHECK against
// it with PostgreSQL's three-valued logic, in which a CHECK fails only when it
// evaluates to FALSE. NULL passes. That distinction is the whole reason a
// hand-check of these constraints is unreliable.
//
// Anything it cannot evaluate faithfully (a function it does not model, a
// regex construct outside the subset it translates) is reported as SKIPPED and
// counted, never silently treated as a pass.
//
// Usage: node checkeval.mjs <schema.sql> [--verbose]
import { readFileSync } from "node:fs";
import { parse } from "libpg-query";

const file = process.argv[2];
const verbose = process.argv.includes("--verbose");
if (!file) {
  console.error("usage: node checkeval.mjs <schema.sql> [--verbose]");
  process.exitCode = 2;
} else {
  const sql = readFileSync(file, "utf8");
  const tree = await parse(sql);

  const UNKNOWN = Symbol("unevaluable");
  const isU = (v) => v === UNKNOWN;

  // ---- literal extraction ---------------------------------------------------
  const constOf = (c) => {
    if (c.isnull) return null;
    if ("ival" in c) return c.ival.ival ?? 0;
    if ("fval" in c) return Number(c.fval.fval);
    if ("sval" in c) return c.sval.sval;
    if ("boolval" in c) return c.boolval.boolval ?? false;
    return UNKNOWN;
  };

  // POSIX ERE -> JS RegExp for the subset the schema actually uses. Anything
  // outside it returns null so the caller reports SKIPPED rather than guessing.
  const toJsRegex = (pat, flags) => {
    if (/\\[mMyYAZ]|\(\?|\[\[\.|\[\[=/.test(pat)) return null;
    const translated = pat
      .replace(/\[:alpha:\]/g, "a-zA-Z")
      .replace(/\[:digit:\]/g, "0-9")
      .replace(/\[:alnum:\]/g, "a-zA-Z0-9")
      .replace(/\[:space:\]/g, " \\t\\n\\r\\f\\v")
      .replace(/\[:upper:\]/g, "A-Z")
      .replace(/\[:lower:\]/g, "a-z");
    if (/\[:[a-z]+:\]/.test(translated)) return null;
    try { return new RegExp(translated, flags); } catch { return null; }
  };

  const likeToRegex = (pat) => {
    let out = "^";
    for (let i = 0; i < pat.length; i++) {
      const ch = pat[i];
      if (ch === "%") out += "[\\s\\S]*";
      else if (ch === "_") out += "[\\s\\S]";
      else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(out + "$");
  };

  // ---- expression evaluator -------------------------------------------------
  function ev(node, env) {
    if (node == null) return UNKNOWN;

    if (node.A_Const) return constOf(node.A_Const);
    if (node.ColumnRef) {
      const f = (node.ColumnRef.fields ?? []).map((x) => x.String?.sval).filter(Boolean);
      const name = f[f.length - 1];
      return name in env ? env[name] : UNKNOWN;
    }
    if (node.TypeCast) {
      const v = ev(node.TypeCast.arg, env);
      if (isU(v) || v === null) return v;
      const t = (node.TypeCast.typeName?.names ?? []).map((x) => x.String?.sval).filter(Boolean).pop();
      if (/^(int|int2|int4|int8|smallint|integer|bigint)$/i.test(t ?? "")) return Number(v);
      if (/^(numeric|decimal|float4|float8|real|double)$/i.test(t ?? "")) return Number(v);
      if (/^bool/i.test(t ?? "")) return v === true || v === "t" || v === "true";
      return v; // text, char, enums, jsonb: the literal stands
    }
    if (node.A_ArrayExpr) {
      const els = (node.A_ArrayExpr.elements ?? []).map((e) => ev(e, env));
      return els.some(isU) ? UNKNOWN : els;
    }

    if (node.NullTest) {
      const v = ev(node.NullTest.arg, env);
      if (isU(v)) return UNKNOWN;
      return node.NullTest.nulltesttype === "IS_NULL" ? v === null : v !== null;
    }

    if (node.BooleanTest) {
      const v = ev(node.BooleanTest.arg, env);
      if (isU(v)) return UNKNOWN;
      switch (node.BooleanTest.booltesttype) {
        case "IS_TRUE": return v === true;
        case "IS_NOT_TRUE": return v !== true;
        case "IS_FALSE": return v === false;
        case "IS_NOT_FALSE": return v !== false;
        default: return UNKNOWN;
      }
    }

    if (node.BoolExpr) {
      const kind = node.BoolExpr.boolop;
      const vals = (node.BoolExpr.args ?? []).map((a) => ev(a, env));
      if (kind === "NOT_EXPR") {
        const v = vals[0];
        if (isU(v)) return UNKNOWN;
        return v === null ? null : !v;
      }
      if (kind === "AND_EXPR") {
        if (vals.some((v) => v === false)) return false;
        if (vals.some(isU)) return UNKNOWN;
        return vals.some((v) => v === null) ? null : true;
      }
      if (kind === "OR_EXPR") {
        if (vals.some((v) => v === true)) return true;
        if (vals.some(isU)) return UNKNOWN;
        return vals.some((v) => v === null) ? null : false;
      }
      return UNKNOWN;
    }

    if (node.CaseExpr) {
      const test = node.CaseExpr.arg ? ev(node.CaseExpr.arg, env) : undefined;
      for (const w of node.CaseExpr.args ?? []) {
        const when = w.CaseWhen;
        let hit;
        if (test === undefined) hit = ev(when.expr, env);
        else {
          const c = ev(when.expr, env);
          hit = isU(c) || isU(test) ? UNKNOWN : c === test;
        }
        if (isU(hit)) return UNKNOWN;
        if (hit === true) return ev(when.result, env);
      }
      return node.CaseExpr.defresult ? ev(node.CaseExpr.defresult, env) : null;
    }

    if (node.FuncCall) {
      const name = (node.FuncCall.funcname ?? []).map((x) => x.String?.sval).filter(Boolean).pop();
      const args = (node.FuncCall.args ?? []).map((a) => ev(a, env));
      switch (name) {
        case "length":       return args[0] === null ? null : isU(args[0]) ? UNKNOWN : String(args[0]).length;
        case "btrim": case "trim": return args[0] === null ? null : isU(args[0]) ? UNKNOWN : String(args[0]).trim();
        case "lower":        return args[0] === null ? null : isU(args[0]) ? UNKNOWN : String(args[0]).toLowerCase();
        case "upper":        return args[0] === null ? null : isU(args[0]) ? UNKNOWN : String(args[0]).toUpperCase();
        case "cardinality": case "array_length":
          return args[0] === null ? null : Array.isArray(args[0]) ? args[0].length : UNKNOWN;
        case "num_nonnulls": return args.some(isU) ? UNKNOWN : args.filter((a) => a !== null).length;
        case "coalesce":     { for (const a of args) { if (isU(a)) return UNKNOWN; if (a !== null) return a; } return null; }
        case "ceil": case "ceiling": return typeof args[0] === "number" ? Math.ceil(args[0]) : args[0] === null ? null : UNKNOWN;
        case "floor":        return typeof args[0] === "number" ? Math.floor(args[0]) : args[0] === null ? null : UNKNOWN;
        case "greatest":     return args.some(isU) ? UNKNOWN : Math.max(...args.filter((a) => a !== null).map(Number));
        case "least":        return args.some(isU) ? UNKNOWN : Math.min(...args.filter((a) => a !== null).map(Number));
        default:             return UNKNOWN;
      }
    }

    if (node.A_Expr) {
      const e = node.A_Expr;
      const op = (e.name ?? []).map((x) => x.String?.sval).filter(Boolean).pop();

      if (e.kind === "AEXPR_BETWEEN" || e.kind === "AEXPR_NOT_BETWEEN") {
        const v = ev(e.lexpr, env);
        const bounds = (e.rexpr?.List?.items ?? []).map((x) => ev(x, env));
        if (isU(v) || bounds.some(isU)) return UNKNOWN;
        if (v === null || bounds.some((b) => b === null)) return null;
        const inRange = v >= bounds[0] && v <= bounds[1];
        return e.kind === "AEXPR_BETWEEN" ? inRange : !inRange;
      }

      if (e.kind === "AEXPR_IN") {
        const v = ev(e.lexpr, env);
        const items = (e.rexpr?.List?.items ?? []).map((x) => ev(x, env));
        if (isU(v) || items.some(isU)) return UNKNOWN;
        if (v === null) return null;
        const hit = items.some((i) => i === v);
        return op === "<>" ? !hit : hit;
      }

      if (e.kind === "AEXPR_LIKE" || e.kind === "AEXPR_ILIKE") {
        const v = ev(e.lexpr, env), p = ev(e.rexpr, env);
        if (isU(v) || isU(p)) return UNKNOWN;
        if (v === null || p === null) return null;
        const re = likeToRegex(String(p));
        const hit = re.test(String(v));
        return op === "!~~" || op === "!~~*" ? !hit : hit;
      }

      const l = ev(e.lexpr, env), r = ev(e.rexpr, env);
      if (isU(l) || isU(r)) return UNKNOWN;

      if (op === "~" || op === "!~" || op === "~*" || op === "!~*") {
        if (l === null || r === null) return null;
        const re = toJsRegex(String(r), op.endsWith("*") ? "i" : "");
        if (!re) return UNKNOWN;
        const hit = re.test(String(l));
        return op.startsWith("!") ? !hit : hit;
      }

      if (l === null || r === null) return null;
      switch (op) {
        case "=":  return Array.isArray(l) && Array.isArray(r) ? JSON.stringify(l) === JSON.stringify(r) : l === r;
        case "<>": return Array.isArray(l) && Array.isArray(r) ? JSON.stringify(l) !== JSON.stringify(r) : l !== r;
        case ">":  return l > r;
        case "<":  return l < r;
        case ">=": return l >= r;
        case "<=": return l <= r;
        case "+":  return Number(l) + Number(r);
        case "-":  return Number(l) - Number(r);
        case "*":  return Number(l) * Number(r);
        case "/":  return Number(r) === 0 ? UNKNOWN : Number(l) / Number(r);
        default:   return UNKNOWN;
      }
    }

    return UNKNOWN;
  }

  // ---- table model ----------------------------------------------------------
  const tables = new Map();
  for (const { stmt } of tree.stmts ?? []) {
    const c = stmt?.CreateStmt;
    if (!c?.relation?.relname) continue;
    const cols = new Map();
    const checks = [];
    for (const el of c.tableElts ?? []) {
      if (el.ColumnDef) {
        const cd = el.ColumnDef;
        let def = undefined, generated = false;
        for (const con of cd.constraints ?? []) {
          const t = con.Constraint?.contype;
          if (t === "CONSTR_DEFAULT") def = con.Constraint.raw_expr;
          if (t === "CONSTR_GENERATED") generated = true;
          if (t === "CONSTR_CHECK") {
            checks.push({ name: con.Constraint.conname ?? `${cd.colname}_check`, expr: con.Constraint.raw_expr });
          }
        }
        cols.set(cd.colname, { def, generated });
      } else if (el.Constraint?.contype === "CONSTR_CHECK") {
        checks.push({ name: el.Constraint.conname ?? "(unnamed)", expr: el.Constraint.raw_expr });
      }
    }
    tables.set(c.relation.relname, { cols, checks });
  }

  // ---- evaluate every seeded row -------------------------------------------
  const violations = [], skipped = [];
  let rows = 0, evaluated = 0;

  for (const { stmt, stmt_location } of tree.stmts ?? []) {
    const ins = stmt?.InsertStmt;
    if (!ins) continue;
    const t = ins.relation?.relname;
    const model = tables.get(t);
    if (!model) continue;
    const line = sql.slice(0, stmt_location ?? 0).split("\n").length;
    const named = (ins.cols ?? []).map((c) => c.ResTarget?.name).filter(Boolean);

    for (const [i, row] of (ins.selectStmt?.SelectStmt?.valuesLists ?? []).entries()) {
      rows++;
      const env = {};
      // Unsupplied columns take their DEFAULT; a generated or non-literal
      // default stays UNKNOWN so nothing is asserted about it.
      for (const [name, def] of model.cols) {
        if (def.generated) { env[name] = UNKNOWN; continue; }
        env[name] = def.def ? ev(def.def, {}) : null;
      }
      (row.List?.items ?? []).forEach((v, j) => { if (named[j]) env[named[j]] = ev(v, {}); });

      const label = `${t} row ${i + 1} (${env.name ?? env.slug ?? env.code ?? env.id ?? "?"})`;
      for (const chk of model.checks) {
        const r = ev(chk.expr, env);
        if (isU(r)) { skipped.push(`${label}: ${chk.name}`); continue; }
        evaluated++;
        // PostgreSQL: a CHECK fails only when it evaluates to FALSE.
        if (r === false) {
          violations.push(`line ${line}: ${label} VIOLATES ${chk.name}`);
        }
      }
    }
  }

  console.log(`seeded rows ${rows}; CHECK constraints evaluated ${evaluated}; not evaluable ${skipped.length}`);
  if (violations.length) {
    console.log(`\nCONSTRAINT VIOLATIONS (${violations.length}):`);
    for (const v of violations) console.log("  " + v);
  } else {
    console.log("Every seeded row satisfies every CHECK this tool can evaluate.");
  }
  if (verbose && skipped.length) {
    console.log(`\nNot evaluable (reported, never assumed to pass):`);
    for (const s of [...new Set(skipped)]) console.log("  " + s);
  }
  process.exitCode = violations.length ? 1 : 0;
}
