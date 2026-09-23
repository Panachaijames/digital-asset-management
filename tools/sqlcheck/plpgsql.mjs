// Block-balance check for plpgsql function bodies.
//
// check.mjs parses the SQL grammar, but a function body is just a string
// literal to that grammar — it is never looked inside. Postgres itself only
// parses the body at CREATE time (check_function_bodies), so an unbalanced
// IF/LOOP/CASE is a run-aborting error that every other tool here is blind to.
// This closes that gap: tokenise each body and walk the block openers and
// closers on a stack.
//
// It is NOT a plpgsql parser. It catches the overwhelmingly common fatal — a
// missing or surplus `end if` / `end loop` / `end case` / `end` — and names the
// function; it cannot catch a bad expression inside an otherwise balanced
// statement.
//
// Usage: node plpgsql.mjs <file.sql...>
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node plpgsql.mjs <file.sql...>");
  process.exitCode = 2;
}

let problems = 0;
let bodies = 0;

for (const file of files) {
  const sql = readFileSync(file, "utf8");
  const re = /create (?:or replace )?function\s+([a-z0-9_]+)\s*\(([\s\S]*?)\)([\s\S]*?)\nas \$\$([\s\S]*?)\n\$\$;/gi;
  let m;

  while ((m = re.exec(sql))) {
    const [, name, , head, body] = m;
    if (!/language\s+plpgsql/i.test(head)) continue;
    bodies++;
    const line = sql.slice(0, m.index).split("\n").length;

    // Remove line comments and string literals so keywords inside them do not
    // count. '' inside a literal is consumed by the alternation.
    const clean = body
      .replace(/--[^\n]*/g, " ")
      .replace(/'(?:[^']|'')*'/g, " ' ' ");

    // Longest-match first: `end if` must tokenise as one closer, not as `end`
    // followed by `if`.
    const tok = /\bend\s+(if|loop|case)\b|\bend\b|\bbegin\b|\bcase\b|\bloop\b|\bif\b|\belsif\b|\bexception\b/gi;
    const stack = [];
    const errs = [];
    let t;

    while ((t = tok.exec(clean))) {
      const raw = t[0].toLowerCase().replace(/\s+/g, " ");
      const at = body.slice(0, t.index).split("\n").length;

      if (t[1]) {
        const want = t[1].toLowerCase();
        const top = stack.pop();
        if (top !== want) errs.push(`line ${at}: "end ${want}" closes ${top ?? "nothing"}`);
      } else if (raw === "end") {
        // Closes a begin block or an expression CASE.
        const top = stack.pop();
        if (top !== "begin" && top !== "case") {
          errs.push(`line ${at}: bare "end" closes ${top ?? "nothing"}`);
        }
      } else if (raw === "begin" || raw === "case" || raw === "loop" || raw === "if") {
        stack.push(raw);
      }
      // elsif and exception belong to a block already open; they neither open
      // nor close one.
    }

    if (stack.length) errs.push(`unclosed at end of body: ${stack.join(", ")}`);

    if (errs.length) {
      problems++;
      console.log(`  ${file}:${line}  ${name}()`);
      for (const e of errs.slice(0, 4)) console.log(`      ${e}`);
    }
  }
}

console.log(`plpgsql bodies checked ${bodies}`);
if (problems) console.log(`UNBALANCED (${problems})`);
else console.log("Every body's if/loop/case/begin blocks are closed.");
process.exitCode = problems ? 1 : 0;
