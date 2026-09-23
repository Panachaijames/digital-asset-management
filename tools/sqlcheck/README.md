# tools/sqlcheck — offline validators for the v2 schema and its migrations

Static checks for `SCHEMA.sql` (the applied v2 baseline) and every file in `supabase/migrations/`.
They parse SQL with the real PostgreSQL 17 grammar (`libpg-query`, compiled to WASM) and never
connect to a database. What only a running Postgres can catch is covered by `tools/pgtest`, which
applies the same chain to an in-process Postgres; run both.

## Setup

The dependency lives here, not in the root `package.json`:

```bash
cd tools/sqlcheck && npm ci
```

Every tool sets `process.exitCode` rather than calling `process.exit()`, because `process.exit()`
trips a libuv assertion on Windows while the WASM worker is still closing. Exit 0 means clean,
1 means a real finding, 2 means a usage error.

## Runbook

One command validates the whole chain, in apply order. From the repo root:

```bash
npm run db:check
# which is
node tools/sqlcheck/run-all.mjs --migrations supabase/migrations --baseline SCHEMA.sql
```

Add `--out <file>` to choose where the concatenation is written (default: the OS temp folder).
It refuses an `--out` that is one of its inputs or lies inside the migrations folder: redirecting
output into an input once destroyed a source file.

`run-all.mjs` does five things:

1. Lists `<digits>_<name>.sql` in numeric version order (the Supabase CLI's own rule) and fails on
   a duplicate version. A `.sql` file that does not match the pattern is reported, because the CLI
   silently ignores it.
2. Treats the one file named `*_baseline.sql` as the baseline: it must have the lowest version and,
   with `--baseline SCHEMA.sql`, must equal `SCHEMA.sql` byte for byte after CRLF normalisation.
   The baseline was applied on 2026-09-15 through the SQL editor; its copy is frozen.
3. Runs `check.mjs` and `plpgsql.mjs` on each file on its own, so line numbers are the file's own.
4. On every non-baseline file, enforces the migration rules no other validator knows:
   - no `begin`/`commit`/`rollback` (the CLI already runs each file as one transaction);
   - no `create index concurrently` and no `vacuum` (both are illegal inside a transaction);
   - `alter type ... add value` alone in its file (the new value is unusable until commit);
   - the `set search_path = public, extensions, pg_catalog;` preamble (warning only);
   - no identifier of 64 bytes or more (Postgres silently truncates at 63);
   - no control characters (a `\b` or `\m` written through a shell heredoc becomes one);
   - every `create function` body in the shape the body validators can see (below);
   - every `language plpgsql` function pins `search_path`.
5. Concatenates baseline plus migrations and runs the whole-schema validators on the result,
   rewriting each `line N` in their output as `<file>:<line>`: `ordercheck`, `fninsert`,
   `fninsertselect`, `seedcheck`, `checkeval`, `seedintegrity`, `enumcast`, `lint`, and
   `polcheck all -- all`. Warnings from passing tools are echoed.

Expected result on the baseline alone: `RUN-ALL OK`, with lint's two documented warnings
(`dam_asset_search` omits `id`/`updated_by`/`deleted_by`, D-242; tables use ENABLE rather than FORCE
row-level security, SPEC 3.7.4). It takes about 5 seconds.

### The function-body shape

`plpgsql.mjs`, `fninsert.mjs` and `fninsertselect.mjs` find bodies with one regular expression, so a
body is only checked when it is written like this:

```sql
create or replace function dam_example(p_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return 1;
end;
$$;
```

- the name unqualified (`dam_example`, not `public.dam_example`; the ACL statements may qualify);
- `$$` quoting, never a `$fn$` tag (a tagged body also makes the lazy match swallow the next one);
- `as $$` at the start of a line, and `$$;` alone on the closing line (no `$$ language plpgsql;`).

`run-all.mjs` counts `CreateFunctionStmt` nodes against shaped bodies and names every function it
could not see, so a stray shape fails loudly instead of skipping the checks.

## The validators

| Tool | Checks | Run on | Blind spots |
|---|---|---|---|
| `check.mjs` | The file parses with the PG17 grammar; prints the statement count and kind histogram; a parse error reports line and column. | each file | Function bodies are opaque strings to the grammar. |
| `plpgsql.mjs` | `if`/`loop`/`case`/`begin` balance inside `language plpgsql` bodies. | each file | Not a plpgsql parser: a bad expression in a balanced body passes. Only shaped bodies (above). |
| `ordercheck.mjs` | Every object a statement needs (ALTER TABLE target and FK target, index, policy and trigger tables, INSERT/UPDATE targets, partition parents, `dam_*` names inside DO bodies) was created earlier. | concatenation | On a migration alone every baseline table looks missing. |
| `fninsert.mjs` | INSERT ... VALUES inside plpgsql bodies: an uninitialised DECLARE variable passed to a NOT NULL column (naming a column overrides its DEFAULT), arity, unknown and GENERATED columns, NOT NULL-without-default columns omitted. Honours `-- fninsert:ok <var> - <reason>`. | concatenation | VALUES form only. Columns added by `alter table ... add column` are unknown to it. "near line N" is approximate. |
| `fninsertselect.mjs` | INSERT ... SELECT and UPDATE ... SET inside plpgsql bodies (the shape a search-row writer takes): named columns exist and are not GENERATED, the SELECT list matches the column list, every NOT NULL-without-default column is named, and every `on conflict ... do update set` column exists and is not GENERATED. Models `add column`. Handles an INSERT inside a CTE and plpgsql's `returning ... into`. | concatenation | Dynamic SQL (`execute format(...)`), statements inside string literals, tables outside `public` or not named `dam_*`, and unshaped bodies. A statement that will not parse once cut out is printed as SKIPPED (check it by hand), never passed silently. |
| `seedcheck.mjs` | Top-level INSERT/UPDATE against the table: arity per tuple, unknown or GENERATED columns, NULL into NOT NULL, NOT NULL-without-default omitted. | concatenation | Columns added by `add column` are unknown to it. |
| `checkeval.mjs` | Evaluates every CREATE TABLE CHECK against every seeded `insert ... values` row (supplied values plus literal defaults) in three-valued logic. | concatenation | CHECKs added by `alter table ... add constraint` are not modelled. What it cannot evaluate is counted as not evaluable, never passed. Regexes using `\m \M \y` are not evaluable. |
| `seedintegrity.mjs` | Unique-index collisions among seeded rows (partial predicates and `lower()` keys) and seeded FK values that point at rows not seeded earlier in the file. | concatenation | Assumes an EMPTY database: a seed that references imported v2 data is a false dangling FK, and a collision with imported data is invisible. Primary keys and inline UNIQUE constraints are not modelled; 7 expression indexes are listed as not modelled. |
| `enumcast.mjs` | Every `'literal'::dam_enum` against the type's member list. | concatenation | On a migration alone it finds no types and passes vacuously. Does not know members added by `add value`. Cannot see an uncast literal compared with an enum column. |
| `lint.mjs` | House conventions: `dam_` prefix, snake_case, the six standard columns, `id uuid`, RLS enabled and at least one policy per table, duplicate table/enum/policy/index names (a `drop policy`/`drop index` before re-creating is understood), SECURITY DEFINER without `set search_path`, references to undefined tables, unused enums. `--json`, `--inventory <DECISIONS.md>`. | concatenation | No index, policy or trigger naming patterns. An unpinned SECURITY INVOKER function is not reported. Functions not prefixed `dam_` (such as `trg_*` trigger functions) are warnings. |
| `polcheck.mjs` | Every column a policy (USING / WITH CHECK) or an index (keys and WHERE) references exists on its table, or on some table for names inside a sub-select. Models `add column`. | `all.sql -- all.sql` | Given one argument it checks nothing and exits 0: always pass the file on both sides of `--`. |
| `refcheck.mjs` | `dam_table.column` mentions in SPEC prose against SPEC's column grids. | SPEC.md | A SPEC-consistency tool, not a SQL validator. Exits 1 on five known prose-versus-grid artefacts; not part of `run-all`. |
| `run-all.mjs` | The runner above. | a migrations folder | Everything the tools above miss. |

## What none of this catches

Review these by eye, or rely on `tools/pgtest` (and, finally, the transaction the CLI wraps each
push in):

- an expression or type error inside a structurally valid plpgsql body (plpgsql bodies are resolved
  at first execution, not at CREATE);
- `ON CONFLICT` against a partial unique index without a predicate that implies the index predicate
  (raises 42P10 at run time, never at CREATE);
- `\b` in a Postgres regex (it is backspace; use `\m`, `\M`, `\y`);
- a column type that cannot hold every value its CHECKs admit;
- data-dependent failures on the populated v2 database: a new constraint or trigger assertion that
  the 34,949 imported assets do not satisfy. PGlite applies the chain to an empty database plus the
  fixtures; only the real push meets the real data, and it rolls back cleanly if it fails.

The optional `sql-apply` job in `.github/workflows/ci.yml` (a local Supabase Postgres plus
`supabase db lint`, which runs plpgsql_check) would close the first gap. It has never been run and
is marked `continue-on-error`.
