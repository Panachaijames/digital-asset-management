// Offline Postgres syntax check using libpg-query (WASM, PG17 grammar).
// Usage: node check.mjs <file.sql>
// Exit 0 = every statement parsed. Exit 1 = parse error (line/col reported).
// NOTE: uses process.exitCode (not process.exit) — process.exit() trips a libuv
// assertion on Windows while the WASM worker is still closing.
import { readFileSync } from "node:fs";
import { parse } from "libpg-query";

const file = process.argv[2];
if (!file) { console.error("usage: node check.mjs <file.sql>"); process.exitCode = 2; }
else {
  const sql = readFileSync(file, "utf8");
  try {
    const tree = await parse(sql);
    const stmts = tree.stmts ?? [];
    const kinds = {};
    for (const s of stmts) { const k = Object.keys(s.stmt ?? {})[0] ?? "?"; kinds[k] = (kinds[k] ?? 0) + 1; }
    console.log(`OK: ${stmts.length} statements parsed`);
    console.log(JSON.stringify(kinds));
    process.exitCode = 0;
  } catch (e) {
    const msg = e?.message ?? String(e);
    let pos = null;
    for (const k of ["cursorPosition", "cursorpos", "position"]) if (typeof e?.[k] === "number") { pos = e[k]; break; }
    let where = "";
    if (typeof pos === "number" && pos > 0) {
      const before = sql.slice(0, pos);
      const line = before.split("\n").length;
      const col = pos - before.lastIndexOf("\n");
      const lines = sql.split("\n");
      where = `\n  at line ${line}, col ${col}:\n  ${lines[line - 1]}`;
    } else {
      // Fallback: locate the offending token text from the message, if any.
      const m = /at or near "([^"]+)"/.exec(msg);
      if (m) {
        const lines = sql.split("\n");
        const hits = lines.map((l, i) => (l.includes(m[1]) ? i + 1 : 0)).filter(Boolean);
        if (hits.length) where = `\n  candidate lines containing "${m[1]}": ${hits.slice(0, 15).join(", ")}${hits.length > 15 ? " …" : ""}`;
      }
      where += `\n  (error keys: ${Object.keys(e ?? {}).join(",") || "none"})`;
    }
    console.error(`PARSE ERROR: ${msg}${where}`);
    process.exitCode = 1;
  }
}
