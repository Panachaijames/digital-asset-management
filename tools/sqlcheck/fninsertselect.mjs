// INSERT ... SELECT and UPDATE ... SET written INSIDE plpgsql function bodies,
// checked against the real tables: the blind spot fninsert.mjs leaves (it only
// sees `insert into t (cols) values (...)`). A search-row writer is naturally
// an INSERT ... SELECT ... ON CONFLICT DO UPDATE, so this is the shape that
// matters most for the v2 migrations.
//
// Each such statement is cut out of its body (up to the next top-level ';')
// and parsed with the real PG17 grammar. plpgsql variables simply parse as
// column references, which is harmless for these checks:
//   * INSERT: every named column exists and is not GENERATED; the SELECT's
//     target list has as many entries as the column list (a `select *` or a
//     missing column list is reported, because neither can be verified);
//     every NOT NULL column without a DEFAULT is named; every column in an
//     `on conflict ... do update set` list exists and is not GENERATED.
//   * UPDATE: every SET column exists on the table and is not GENERATED.
// The VALUES form is left to fninsert.mjs.
//
// Table model: CREATE TABLE plus ALTER TABLE ... ADD COLUMN; partition
// children inherit the parent's columns. Run it on the concatenation of the
// baseline and every migration (run-all.mjs does this).
//
// Blind spots: dynamic SQL (`execute format(...)`), statements inside string
// literals, schema-qualified tables outside `public`, tables that are not
// `dam_*` (temp tables), and function bodies that are not in the
// `create [or replace] function <name>(...) ... \nas $$ ... \n$$;` shape.
// A statement that does not parse once cut out is reported as SKIPPED, not
// passed silently.
//
// Usage: node fninsertselect.mjs <schema-plus-migrations.sql>
import { readFileSync } from "node:fs";
import { parse } from "libpg-query";

const file = process.argv[2];
if (!file) {
  console.error("usage: node fninsertselect.mjs <schema-plus-migrations.sql>");
  process.exitCode = 2;
} else {
  const sql = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const tree = await parse(sql);

  // ---- table model
  const tables = new Map();
  const colOf = (cd) => {
    let notNull = false, hasDefault = false, generated = false, identity = false;
    for (const con of cd.constraints ?? []) {
      const t = con.Constraint?.contype;
      if (t === "CONSTR_NOTNULL" || t === "CONSTR_PRIMARY") notNull = true;
      if (t === "CONSTR_DEFAULT") hasDefault = true;
      if (t === "CONSTR_GENERATED") generated = true;
      if (t === "CONSTR_IDENTITY") identity = true;
    }
    return { notNull, hasDefault, generated, identity };
  };
  for (const { stmt } of tree.stmts ?? []) {
    const c = stmt?.CreateStmt;
    if (c?.relation?.relname) {
      const cols = new Map();
      for (const el of c.tableElts ?? []) if (el.ColumnDef?.colname) cols.set(el.ColumnDef.colname, colOf(el.ColumnDef));
      const parent = c.inhRelations?.[0]?.RangeVar?.relname;
      if (c.partbound && parent && tables.has(parent)) for (const [k, v] of tables.get(parent)) if (!cols.has(k)) cols.set(k, v);
      tables.set(c.relation.relname, cols);
      continue;
    }
    const a = stmt?.AlterTableStmt;
    if (a?.relation?.relname && tables.has(a.relation.relname)) {
      for (const cmd of a.cmds ?? []) {
        const cd = cmd.AlterTableCmd?.def?.ColumnDef;
        if (cmd.AlterTableCmd?.subtype === "AT_AddColumn" && cd?.colname) {
          const cols = tables.get(a.relation.relname);
          // `add column if not exists` of a column the table already has changes nothing
          if (!cols.has(cd.colname)) cols.set(cd.colname, colOf(cd));
        }
      }
    }
  }

  // Cut a statement out of a body: from `start` to the first ';' outside
  // quotes and parentheses, or to the ')' that closes an enclosing
  // parenthesis (an INSERT written inside a CTE: `with w as (insert ...)`).
  const cut = (body, start) => {
    let depth = 0, q = false;
    for (let i = start; i < body.length; i++) {
      const ch = body[i];
      if (q) { if (ch === "'") { if (body[i + 1] === "'") i++; else q = false; } continue; }
      if (ch === "'") q = true;
      else if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth < 0) return body.slice(start, i); }
      else if (ch === ";" && depth === 0) return body.slice(start, i);
    }
    return body.slice(start);
  };
  // plpgsql's `returning ... into v_x` is not SQL grammar; drop the INTO so the statement parses.
  const parseStmt = async (text) => {
    try { return (await parse(text)).stmts?.[0]?.stmt; } catch (e) {
      const bare = text.replace(/(\breturning\b[\s\S]*?)\binto\s+(?:strict\s+)?[a-z0-9_.,\s]+$/i, "$1");
      if (bare === text) throw e;
      return (await parse(bare)).stmts?.[0]?.stmt;
    }
  };

  const fnRe = /create (?:or replace )?function\s+([a-z0-9_]+)\s*\(([\s\S]*?)\)([\s\S]*?)\nas \$\$([\s\S]*?)\n\$\$;/gi;
  const hitRe = /\b(insert\s+into|update)\s+(?:only\s+)?(?:([a-z0-9_]+)\.)?([a-z0-9_]+)\b/gi;
  const problems = [];
  const skipped = [];
  let checked = 0;

  const checkSet = (at, verb, t, cols, targets) => {
    for (const r of targets ?? []) {
      const n = r.ResTarget?.name;
      if (!n) continue;
      if (!cols.has(n)) problems.push(`${at}: ${verb} ${t} sets unknown column "${n}"`);
      else if (cols.get(n).generated) problems.push(`${at}: ${verb} ${t} sets GENERATED column ${n}`);
    }
  };

  for (const m of sql.matchAll(fnRe)) {
    const [, fname, , head, body] = m;
    if (!/language\s+plpgsql/i.test(head)) continue;
    const at = `${fname}()`;
    const clean = body.replace(/--[^\n]*/g, (s) => " ".repeat(s.length));
    for (const hit of clean.matchAll(hitRe)) {
      const isInsert = /^insert/i.test(hit[1]);
      // `on conflict ... do update set` and `select ... for update` are clauses, not UPDATE statements
      if (!isInsert && /\b(do|for|no\s+key)\s*$/i.test(clean.slice(Math.max(0, hit.index - 16), hit.index))) continue;
      const schema = hit[2]?.toLowerCase();
      const t = hit[3].toLowerCase();
      if (schema && schema !== "public") continue; // not one of ours
      const cols = tables.get(t);
      if (!cols) {
        if (t.startsWith("dam_")) problems.push(`${at}: ${isInsert ? "insert into" : "update"} ${t}, which has no CREATE TABLE`);
        continue;
      }
      const text = cut(clean, hit.index);
      let st;
      try { st = await parseStmt(text); } catch { skipped.push(`${at}: ${text.replace(/\s+/g, " ").slice(0, 80)}`); continue; }

      if (isInsert && st?.InsertStmt) {
        const ins = st.InsertStmt;
        const sel = ins.selectStmt?.SelectStmt;
        if (sel?.valuesLists?.length) continue; // VALUES form: fninsert.mjs covers it
        checked++;
        const named = (ins.cols ?? []).map((c) => c.ResTarget?.name).filter(Boolean);
        if (!named.length) { problems.push(`${at}: insert into ${t} names no columns - name them so the shape can be verified`); continue; }
        for (const n of named) {
          if (!cols.has(n)) problems.push(`${at}: insert into ${t} names unknown column "${n}"`);
          else if (cols.get(n).generated) problems.push(`${at}: insert into ${t} names GENERATED column ${n}`);
        }
        for (const [n, d] of cols) {
          if (d.notNull && !d.hasDefault && !d.generated && !d.identity && !named.includes(n)) {
            problems.push(`${at}: insert into ${t} omits ${n}, which is NOT NULL with no default`);
          }
        }
        const tl = sel?.targetList ?? [];
        const star = tl.some((r) => r.ResTarget?.val?.ColumnRef?.fields?.some((f) => f.A_Star));
        if (star) problems.push(`${at}: insert into ${t} ... select * - arity cannot be verified`);
        else if (sel && (!sel.op || sel.op === "SETOP_NONE") && tl.length !== named.length) {
          problems.push(`${at}: insert into ${t} names ${named.length} columns but selects ${tl.length}`);
        }
        checkSet(at, "insert into", t, cols, ins.onConflictClause?.targetList);
      } else if (!isInsert && st?.UpdateStmt) {
        checked++;
        checkSet(at, "update", t, cols, st.UpdateStmt.targetList);
      }
    }
  }

  console.log(`INSERT ... SELECT / UPDATE statements inside plpgsql bodies checked ${checked}; skipped ${skipped.length}`);
  for (const s of skipped) console.log(`  SKIPPED (did not parse once cut out, check by hand): ${s}`);
  if (problems.length) {
    console.log(`\nWOULD FAIL AT RUN TIME (${problems.length}):`);
    for (const p of problems) console.log("  " + p);
  } else {
    console.log("Every in-function INSERT ... SELECT and UPDATE matches its target table.");
  }
  process.exitCode = problems.length ? 1 : 0;
}
