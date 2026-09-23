// Every 'literal'::enum_type cast in the file, checked against that enum's real
// CREATE TYPE list. A wrong member parses fine and raises 22P02 when the
// statement runs — in a policy, a CHECK, a seed row or a function body.
import { readFileSync } from "node:fs";
const sql = readFileSync(process.argv[2], "utf8");
const enums = new Map();
for (const m of sql.matchAll(/create type (\w+) as enum \(([^)]*)\)/gi)) {
  enums.set(m[1], new Set([...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1])));
}
const bad = [];
const seen = new Set();
for (const m of sql.matchAll(/'([^']*)'\s*::\s*(dam_\w+)/g)) {
  const [, val, type] = m;
  if (!enums.has(type)) continue;
  if (enums.get(type).has(val)) continue;
  const line = sql.slice(0, m.index).split("\n").length;
  const key = `${type}:${val}`;
  if (seen.has(key)) continue;
  seen.add(key);
  bad.push(`line ${line}: '${val}'::${type} — not a member. Valid: ${[...enums.get(type)].join(", ")}`);
}
const casts = [...sql.matchAll(/'([^']*)'\s*::\s*(dam_\w+)/g)].filter((m) => enums.has(m[2])).length;
console.log(`enum types ${enums.size}; enum casts checked ${casts}`);
if (bad.length) { console.log(`\nINVALID (${bad.length}):`); bad.forEach((b) => console.log("  " + b)); }
else console.log("Every enum cast names a real member of its type.");
process.exitCode = bad.length ? 1 : 0;
