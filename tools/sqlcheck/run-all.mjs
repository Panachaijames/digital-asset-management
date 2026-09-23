// Validate the baseline plus every migration, in apply order, with every
// offline validator in this folder. Nothing here connects to a database.
//
// Usage (from tools/sqlcheck, or anywhere: it resolves its sibling tools from its own folder):
//   node run-all.mjs --migrations ../../supabase/migrations --baseline ../../SCHEMA.sql [--out <concat.sql>]
//
// 1. Lists <dir>/<digits>_<name>.sql, sorted by numeric version; refuses duplicate versions.
//    A file named *_baseline.sql is THE baseline: at most one, and it must sort first.
// 2. With --baseline <SCHEMA.sql>: the baseline file must exist and equal that file byte for byte
//    after CRLF normalisation (drift guard: the baseline migration is a frozen copy of what was applied).
// 3. Per file: check.mjs (syntax, real PG17 grammar) and plpgsql.mjs (block balance), so line numbers
//    are the file's own.
// 4. Per non-baseline file, rules no other validator enforces: no BEGIN/COMMIT, no CONCURRENTLY, no
//    VACUUM, ALTER TYPE ... ADD VALUE alone in its file, the search_path preamble (warn), identifiers
//    <= 63 bytes, no control characters, every CREATE FUNCTION body in the `as $$ ... \n$$;` shape the
//    body validators can see, and every plpgsql function pinning search_path.
// 5. Concatenates everything (LF) and runs the whole-schema validators on it, remapping "line N" in
//    their output to file:line: ordercheck, fninsert, fninsertselect, seedcheck, checkeval,
//    seedintegrity, enumcast, lint, and polcheck (all -- all).
//
// Exit 0 = every check passed (warnings allowed). Exit 1 = at least one failure. Exit 2 = usage.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname, basename, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "libpg-query";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const lf = (s) => s.replace(/\r\n/g, "\n");
const isBaseline = (f) => /_baseline\.sql$/.test(f);

let failed = 0;
const fail = (m) => { failed++; console.log("FAIL  " + m); };
const warn = (m) => console.log("WARN  " + m);
const indent = (t) => t.trim().split("\n").map((l) => "      " + l).join("\n");

const run = (script, args) => {
  const r = spawnSync(process.execPath, [join(HERE, script), ...args], { cwd: HERE, encoding: "utf8" });
  return { code: r.status, text: (r.stdout ?? "") + (r.stderr ?? "") };
};

async function main() {
  const migArg = arg("--migrations");
  const baseArg = arg("--baseline");
  if (!migArg) {
    console.error("usage: node run-all.mjs --migrations <dir> [--baseline <SCHEMA.sql>] [--out <concat.sql>]");
    return 2;
  }
  const migDir = resolve(migArg);
  const baseline = baseArg ? resolve(baseArg) : null;
  const out = resolve(arg("--out") ?? join(tmpdir(), "dam-migrations-concat.sql"));

  // ---- 1. files in apply order
  let files;
  try { files = readdirSync(migDir).filter((f) => /^\d+_.+\.sql$/.test(f)); } catch (e) {
    fail(`cannot read ${migDir}: ${e.message}`); return 1;
  }
  files.sort((a, b) => { const va = BigInt(a.split("_")[0]), vb = BigInt(b.split("_")[0]); return va < vb ? -1 : va > vb ? 1 : a < b ? -1 : 1; });
  if (!files.length) { fail(`no <digits>_<name>.sql files in ${migDir}`); return 1; }
  console.log(`migrations (${files.length}): ${files.join(", ")}`);
  const seen = new Map();
  for (const f of files) { const v = f.split("_")[0]; if (seen.has(v)) fail(`duplicate version ${v}: ${seen.get(v)} and ${f}`); seen.set(v, f); }
  const stray = readdirSync(migDir).filter((f) => /\.sql$/i.test(f) && !/^\d+_.+\.sql$/.test(f));
  for (const f of stray) warn(`${f} does not match <digits>_<name>.sql; the Supabase CLI ignores it`);

  // never write the concatenation over an input (a redirect once destroyed a source file)
  const inputs = files.map((f) => join(migDir, f));
  if (baseline) inputs.push(baseline);
  const rel = relative(migDir, out);
  const outInside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  if (inputs.some((p) => p.toLowerCase() === out.toLowerCase()) || outInside) {
    fail(`--out ${out} is an input or lies inside the migrations folder`); return 1;
  }

  // ---- 2. the baseline and its drift guard
  const baseFiles = files.filter(isBaseline);
  if (baseFiles.length > 1) fail(`more than one baseline: ${baseFiles.join(", ")}`);
  if (baseFiles.length && files[0] !== baseFiles[0]) fail(`${baseFiles[0]} must have the lowest version; ${files[0]} sorts before it`);
  const texts = files.map((f) => lf(readFileSync(join(migDir, f), "utf8")));
  if (baseline) {
    if (!baseFiles.length) fail(`--baseline given but ${migDir} has no *_baseline.sql`);
    else {
      const i = files.indexOf(baseFiles[0]);
      if (lf(readFileSync(baseline, "utf8")) !== texts[i]) fail(`${baseFiles[0]} differs from ${basename(baseline)}: the baseline migration must be a byte copy (CRLF aside)`);
      else console.log(`OK    ${baseFiles[0]} is a byte copy of ${basename(baseline)}`);
    }
  } else if (baseFiles.length) {
    warn(`no --baseline given: ${baseFiles[0]} is not compared with SCHEMA.sql`);
  }

  // ---- 3 + 4. per file
  const fnRe = /create (?:or replace )?function\s+([a-z0-9_]+)\s*\(([\s\S]*?)\)([\s\S]*?)\nas \$\$([\s\S]*?)\n\$\$;/gi;
  for (const [i, f] of files.entries()) {
    const p = join(migDir, f);
    for (const tool of ["check.mjs", "plpgsql.mjs"]) {
      const r = run(tool, [p]);
      if (r.code !== 0) { fail(`${tool} ${f}`); console.log(indent(r.text)); }
    }
    if (isBaseline(f)) continue; // applied 2026-09-15 and validated then; its bytes are frozen
    const sql = texts[i];
    let tree;
    try { tree = await parse(sql); } catch { continue; } // check.mjs has already reported it
    const kinds = tree.stmts.map((s) => Object.keys(s.stmt ?? {})[0]);
    // stmt_location points just past the previous ';', so skip leading whitespace and comments first
    const lineOf = (loc) => {
      let at = loc ?? 0;
      for (;;) {
        const ws = /^\s+/.exec(sql.slice(at)); if (ws) { at += ws[0].length; continue; }
        const cm = /^--[^\n]*/.exec(sql.slice(at)); if (cm) { at += cm[0].length; continue; }
        break;
      }
      return sql.slice(0, at).split("\n").length;
    };
    const fnNames = [];
    tree.stmts.forEach(({ stmt, stmt_location }, j) => {
      const k = kinds[j], n = stmt[k];
      if (k === "TransactionStmt") fail(`${f}:${lineOf(stmt_location)} explicit transaction statement; the CLI already runs the file as one transaction`);
      if (k === "IndexStmt" && n.concurrent) fail(`${f}:${lineOf(stmt_location)} CREATE INDEX CONCURRENTLY cannot run inside the migration transaction`);
      if (k === "VacuumStmt") fail(`${f}:${lineOf(stmt_location)} VACUUM/ANALYZE cannot run inside the migration transaction`);
      if (k === "CreateFunctionStmt") fnNames.push({ name: (n.funcname ?? []).map((x) => x.String?.sval).filter(Boolean).join("."), line: lineOf(stmt_location) });
    });
    if (kinds.includes("AlterEnumStmt") && kinds.some((k) => !["AlterEnumStmt", "VariableSetStmt", "CommentStmt"].includes(k))) {
      fail(`${f}: ALTER TYPE ... ADD VALUE shares a file with other statements; the new value is unusable until commit`);
    }
    if (!/^\s*set search_path = public, extensions, pg_catalog;/m.test(sql)) warn(`${f}: no 'set search_path = public, extensions, pg_catalog;' preamble`);
    const noComments = sql.replace(/--[^\n]*/g, "");
    for (const m of noComments.matchAll(/[A-Za-z_][A-Za-z0-9_$]{63,}/g)) fail(`${f}: identifier of ${m[0].length} bytes will be truncated to 63: ${m[0]}`);
    const ctl = sql.match(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g);
    if (ctl) fail(`${f}: ${ctl.length} control character(s) (a \\b or \\m written through a shell?)`);
    const bodies = [...sql.matchAll(fnRe)];
    if (bodies.length !== fnNames.length) {
      const shaped = new Set(bodies.map((b) => b[1].toLowerCase()));
      const unseen = fnNames.filter((x) => !shaped.has(x.name.toLowerCase())).map((x) => `${x.name} (line ${x.line})`);
      fail(`${f}: ${fnNames.length} CREATE FUNCTION but ${bodies.length} bodies in the 'as $$ ... \\n$$;' shape; plpgsql.mjs, fninsert.mjs and fninsertselect.mjs cannot see the rest` +
        (unseen.length ? `: ${unseen.join(", ")}` : "") +
        ". Write `create or replace function dam_x(` (name unqualified), quote with $$ (no $fn$ tag), put `as $$` at the start of a line and `$$;` alone on the closing line");
    }
    for (const b of bodies) {
      if (!/language\s+plpgsql/i.test(b[3])) continue;
      if (!/set\s+search_path/i.test(b[3])) fail(`${f}: ${b[1]}() does not pin search_path`);
    }
  }

  // ---- 5. whole-schema validators on the concatenation
  const starts = [];
  let acc = "", line = 1;
  for (const [i, t] of texts.entries()) {
    const sep = i ? "\n\n" : "";
    starts.push({ file: files[i], line: line + (i ? 2 : 0) }); // the separator pushes each later file down 2 lines
    acc += sep + t;
    line += (sep + t).split("\n").length - 1;
  }
  writeFileSync(out, acc);
  const where = (n) => { let s = starts[0]; for (const x of starts) if (x.line <= n) s = x; return `${s.file}:${n - s.line + 1}`; };
  const remap = (text) => text.replace(/\bline (\d+)/g, (_, n) => where(Number(n)));
  console.log(`concatenated ${acc.split("\n").length} lines -> ${out}`);
  for (const [tool, args] of [
    ["ordercheck.mjs", [out]], ["fninsert.mjs", [out]], ["fninsertselect.mjs", [out]], ["seedcheck.mjs", [out]],
    ["checkeval.mjs", [out]], ["seedintegrity.mjs", [out]], ["enumcast.mjs", [out]], ["lint.mjs", [out]],
    ["polcheck.mjs", [out, "--", out]],
  ]) {
    const r = run(tool, args);
    const lines = remap(r.text).trim().split("\n");
    if (r.code === 0) {
      console.log(`OK    ${tool}: ${lines.at(-1)}`);
      for (const l of lines) if (/^\s*WARN\b/.test(l)) console.log("      " + l.trim());
    } else {
      fail(tool);
      console.log(indent(lines.join("\n")));
    }
  }
  return failed ? 1 : 0;
}

const code = await main();
if (code !== 2) console.log(failed ? `\nRUN-ALL FAILED: ${failed} problem(s)` : "\nRUN-ALL OK");
process.exitCode = code;
