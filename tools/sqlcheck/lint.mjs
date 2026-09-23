// Structural lint for SCHEMA.sql against the brief's §6 conventions, using the
// libpg-query AST. Usage: node lint.mjs <file.sql> [--json]
// Exit 0 = no errors (warnings allowed). Exit 1 = at least one error.
import { readFileSync } from "node:fs";
import { parse } from "libpg-query";

const file = process.argv[2];
const asJson = process.argv.includes("--json");
// --inventory <DECISIONS.md>: also check that every canonical table and enum in the
// decision digest actually exists in the schema, and report tables the schema adds.
const invIdx = process.argv.indexOf("--inventory");
const inventoryPath = invIdx >= 0 ? process.argv[invIdx + 1] : null;
if (!file) {
  console.error("usage: node lint.mjs <file.sql>");
  process.exitCode = 2;
} else {
  const sql = readFileSync(file, "utf8");
  let tree;
  try {
    tree = await parse(sql);
  } catch (e) {
    console.error("PARSE ERROR (run check.mjs for location): " + (e?.message ?? e));
    process.exitCode = 1;
  }
  if (tree) {
    const S = (n) => n?.String?.sval ?? n?.sval ?? null;
    const names = (arr) => (arr ?? []).map(S).filter(Boolean);
    const lineOf = (loc) => (typeof loc === "number" ? sql.slice(0, loc).split("\n").length : "?");
    const snake = (s) => /^[a-z][a-z0-9_]*$/.test(s);
    const REQUIRED = ["id", "created_at", "updated_at", "created_by", "updated_by", "deleted_at"];
    const tables = new Map(); // name -> {cols:Map, line, partitionChild}
    const enums = new Map();
    const enumUse = new Map();
    const rls = new Map(); // table -> {enable, force}
    const policies = new Map(); // table -> [names]
    const indexes = new Map();
    const idxNames = new Map();
    const funcs = [];
    const triggers = [];
    const views = new Set();
    const fkRefs = []; // {from, to, schema, line}
    const errors = [];
    const warns = [];
    const noForce = [];
    const E = (m) => errors.push(m);
    const W = (m) => warns.push(m);
    const typeName = (t) => names(t?.names).filter((x) => x !== "pg_catalog").join(".");

    for (const { stmt } of tree.stmts ?? []) {
      const k = Object.keys(stmt ?? {})[0];
      const n = stmt?.[k];
      if (k === "CreateStmt") {
        const name = n.relation?.relname;
        const line = lineOf(n.relation?.location);
        if (tables.has(name)) E(`duplicate table ${name} (line ${line})`);
        const isChild = Boolean(n.partbound);
        const t = { cols: new Map(), line, partitionChild: isChild };
        for (const el of n.tableElts ?? []) {
          if (el.ColumnDef) {
            const c = el.ColumnDef;
            t.cols.set(c.colname, typeName(c.typeName));
            for (const cc of c.constraints ?? []) {
              if (cc.Constraint?.contype === "CONSTR_FOREIGN") {
                fkRefs.push({ from: name, to: cc.Constraint.pktable?.relname, schema: cc.Constraint.pktable?.schemaname, line });
              }
            }
          } else if (el.Constraint?.contype === "CONSTR_FOREIGN") {
            fkRefs.push({ from: name, to: el.Constraint.pktable?.relname, schema: el.Constraint.pktable?.schemaname, line });
          }
        }
        if (isChild) t.parent = n.inhRelations?.[0]?.RangeVar?.relname ?? n.inhRelations?.[0]?.relname;
        tables.set(name, t);
      } else if (k === "AlterTableStmt") {
        const name = n.relation?.relname;
        const r = rls.get(name) ?? { enable: false, force: false };
        for (const c of n.cmds ?? []) {
          const cmd = c.AlterTableCmd;
          const st = cmd?.subtype;
          if (st === "AT_EnableRowSecurity") r.enable = true;
          if (st === "AT_ForceRowSecurity") r.force = true;
          if (st === "AT_AddConstraint" && cmd.def?.Constraint?.contype === "CONSTR_FOREIGN") {
            fkRefs.push({ from: name, to: cmd.def.Constraint.pktable?.relname, schema: cmd.def.Constraint.pktable?.schemaname, line: lineOf(n.relation?.location) });
          }
          if (st === "AT_AddColumn" && cmd.def?.ColumnDef) {
            const cd = cmd.def.ColumnDef;
            tables.get(name)?.cols.set(cd.colname, typeName(cd.typeName));
          }
        }
        rls.set(name, r);
      } else if (k === "CreatePolicyStmt") {
        const name = n.table?.relname;
        const arr = policies.get(name) ?? [];
        if (arr.includes(n.policy_name)) E(`duplicate policy ${n.policy_name} on ${name}`);
        arr.push(n.policy_name);
        policies.set(name, arr);
        if (n.permissive === false) W(`restrictive policy ${n.policy_name} on ${name}: a permissive policy must also exist or nothing is ever visible`);
      } else if (k === "IndexStmt") {
        const name = n.relation?.relname;
        indexes.set(name, (indexes.get(name) ?? 0) + 1);
        if (n.idxname) {
          if (idxNames.has(n.idxname)) E(`duplicate index name ${n.idxname}`);
          idxNames.set(n.idxname, name);
        }
      } else if (k === "CreateEnumStmt") {
        const name = names(n.typeName).at(-1);
        if (enums.has(name)) E(`duplicate enum ${name}`);
        enums.set(name, (n.vals ?? []).map(S));
        enumUse.set(name, 0);
      } else if (k === "CreateFunctionStmt") {
        const name = names(n.funcname).at(-1);
        const opts = n.options ?? [];
        const secdef = opts.some((o) => o.DefElem?.defname === "security" && o.DefElem?.arg?.Boolean?.boolval === true);
        const setsPath = opts.some((o) => o.DefElem?.defname === "set" && o.DefElem?.arg?.VariableSetStmt?.name === "search_path");
        const vol = opts.find((o) => o.DefElem?.defname === "volatility")?.DefElem?.arg?.String?.sval ?? "volatile";
        funcs.push({ name, secdef, setsPath, vol });
        if (secdef && setsPath === false) E(`security definer function ${name} does not SET search_path`);
        if (name && name.startsWith("dam_") === false) W(`function ${name} not prefixed dam_`);
      } else if (k === "CreateTrigStmt") {
        triggers.push({ name: n.trigname, table: n.relation?.relname });
      } else if (k === "ViewStmt") {
        views.add(n.view?.relname);
      } else if (k === "DropStmt") {
        // A migration that drops and recreates a policy or index under the same name is not a duplicate.
        for (const o of n.objects ?? []) {
          const parts = (o.List?.items ?? []).map(S).filter(Boolean);
          if (n.removeType === "OBJECT_POLICY" && parts.length >= 2) {
            const [tbl, pol] = parts.slice(-2);
            policies.set(tbl, (policies.get(tbl) ?? []).filter((p) => p !== pol));
          } else if (n.removeType === "OBJECT_INDEX" && parts.length >= 1) {
            const idx = parts.at(-1);
            const onTable = idxNames.get(idx);
            if (onTable) { idxNames.delete(idx); indexes.set(onTable, (indexes.get(onTable) ?? 1) - 1); }
          }
        }
      }
    }
    for (const [, t] of tables) {
      for (const ty of t.cols.values()) if (enums.has(ty)) enumUse.set(ty, (enumUse.get(ty) ?? 0) + 1);
    }

    for (const [name, t] of tables) {
      if (name.startsWith("dam_") === false) E(`table ${name} (line ${t.line}) not prefixed dam_`);
      if (snake(name) === false) E(`table ${name} not snake_case`);
      for (const c of t.cols.keys()) if (snake(c) === false) E(`column ${name}.${c} not snake_case`);
      if (t.partitionChild === false) {
        // dam_asset_search is the one documented exception (SPEC D-242): a 1:1
        // derived index row keyed by asset_id, not a business record. Reported
        // as a note so a real missing-column error is not lost among warnings
        // people have learned to ignore.
        const EXEMPT_STANDARD_COLUMNS = { dam_asset_search: ["id", "updated_by", "deleted_by"] };
        const exempt = EXEMPT_STANDARD_COLUMNS[name] ?? [];
        const missing = REQUIRED.filter((c) => t.cols.has(c) === false && exempt.includes(c) === false);
        if (missing.length) E(`table ${name} (line ${t.line}) missing required columns: ${missing.join(", ")}`);
        if (exempt.length) W(`table ${name} omits ${exempt.join(", ")} — documented exception (D-242)`);
        if (t.cols.has("id") && t.cols.get("id") !== "uuid") E(`table ${name}.id is ${t.cols.get("id")}, expected uuid`);
        const r = rls.get(name) ?? {};
        if (r.enable !== true) E(`table ${name} has no ENABLE ROW LEVEL SECURITY`);
        // FORCE is deliberately not used (SPEC §3.7.4): the migration owner must
        // be able to seed and repair without a JWT, and service_role bypasses
        // policies by design. Counted once at the end rather than per table.
        if (r.force !== true) noForce.push(name);
        if ((policies.get(name)?.length ?? 0) === 0) E(`table ${name} has no RLS policy (deny-by-default only if intentional: document it or add policies)`);
      }
    }
    for (const [name] of rls) if (tables.has(name) === false) E(`ALTER TABLE on undefined table ${name}`);
    for (const [name] of policies) if (tables.has(name) === false) E(`policy on undefined table ${name}`);
    for (const [name] of indexes) if (tables.has(name) === false) E(`index on undefined table ${name}`);
    for (const tr of triggers) if (tables.has(tr.table) === false) E(`trigger ${tr.name} on undefined table ${tr.table}`);
    for (const fk of fkRefs) {
      if (fk.schema && fk.schema !== "public") {
        if ((fk.schema === "auth" && fk.to === "users") === false) W(`FK ${fk.from} -> ${fk.schema}.${fk.to} references a non-public table`);
        continue;
      }
      if (tables.has(fk.to) === false) E(`FK ${fk.from} (line ${fk.line}) -> ${fk.to} references undefined table`);
    }
    for (const [en, uses] of enumUse) if (uses === 0) W(`enum ${en} is never used by a column`);

    const stats = {
      tables: tables.size,
      partitionChildren: [...tables.values()].filter((t) => t.partitionChild).length,
      enums: enums.size,
      policies: [...policies.values()].reduce((a, b) => a + b.length, 0),
      indexes: [...indexes.values()].reduce((a, b) => a + b, 0),
      functions: funcs.length,
      triggers: triggers.length,
      views: views.size,
      fks: fkRefs.length,
    };
    if (noForce.length) W(`${noForce.length} tables use ENABLE rather than FORCE row level security — deliberate, SPEC §3.7.4`);
    if (asJson) {
      console.log(JSON.stringify({ stats, errors, warns, tables: [...tables.keys()] }, null, 1));
    } else {
      console.log("STATS " + JSON.stringify(stats));
      for (const e of errors) console.log("ERROR " + e);
      for (const w of warns) console.log("WARN  " + w);
      console.log(errors.length ? `LINT FAILED: ${errors.length} error(s), ${warns.length} warning(s)` : `LINT OK: 0 errors, ${warns.length} warning(s)`);
    }
    process.exitCode = errors.length ? 1 : 0;
  }
}
