# tools/pgtest — the migration chain in an in-process Postgres

`SCHEMA.sql` plus every file in `supabase/migrations/`, applied to [PGlite](https://pglite.dev)
(Postgres compiled to WASM, running inside Node). It proves that the chain applies, and lets tests
call the real functions, triggers and policies as a PostgREST principal would. Nothing here can
reach a real database: there is no connection string anywhere in this folder, and no network.

It is the dynamic half of the SQL checks. `tools/sqlcheck` parses and inspects statically; this
executes. Run both before handing a migration to `supabase db push`.

## Run it

```bash
cd tools/pgtest && npm ci                                # once; PGlite is a dependency of this folder only

node apply.mjs                                           # SCHEMA.sql + every migration
node apply.mjs --fixtures fixtures.sql                   # ... then the fixture library
node apply.mjs --files --fixtures fixtures.sql           # SCHEMA.sql alone + fixtures (no migrations)
node apply.mjs --files ../../supabase/migrations/20260923120000_p1_grants_settings_principals.sql
                                                         # SCHEMA.sql + just the files named, in order
node test.mjs                                            # the behaviour suite: 363 checks, run under both privilege regimes
```

From the repo root, `npm run db:test` runs the chain with the fixtures and then `test.mjs`.

`apply.mjs` prints one line per file applied and a summary of what exists (`dam_` tables, policies,
functions, triggers), or the failing file and line. A full apply takes a few seconds.

In Git Bash on Windows, give node a timeout and an empty stdin, or a crashed WASM worker can hang
the shell: `timeout 300 node apply.mjs < /dev/null`.

## Writing a test

`harness.mjs` exports:

| Export | What it does |
|---|---|
| `createDb({ migrations, fixtures, defaults, log })` | A fresh database: the Supabase stand-in, then `SCHEMA.sql`, then `migrations` (`"all"`, the default, or a list of paths), then `fixtures` (paths). `defaults` is `"legacy"` (default) or `"revoked"`, see below. |
| `applyFile(db, path, sql, log)` | Applies one file as one transaction, the way `supabase db push` does. Errors name the file and line. |
| `asPrincipal(db, claims, fn, { commit })` | Runs `fn(tx)` as PostgREST would for a token with these claims: `set local role` (authenticated, anon or service_role, from `claims.role`) and `request.jwt.claims`. Rolls back afterwards unless `commit: true`. |
| `userClaims(userId, email)` | The claims the web tier mints for a signed-in user (`principal` and `principal_type` both `user`). |
| `systemClaims(userId)` / `WEB_SYSTEM_USER_ID` | The web tier's system principal, `00000000-0000-0000-0000-000000000005`. |
| `migrationFiles()` | The migration paths in version order, without the `*_baseline.sql` copy (the harness applies `SCHEMA.sql` itself). |

A throwaway test imports the harness by URL and runs with `tools/pgtest` as the working directory,
so PGlite resolves:

```js
import { createDb, asPrincipal, userClaims } from "file:///C:/Users/DWP2/Desktop/dwp-dam/tools/pgtest/harness.mjs";

const db = await createDb({ fixtures: ["fixtures.sql"] });
const rows = await asPrincipal(db, userClaims("f9000000-0000-4000-8000-000000000001", "fixture.bangkok.viewer@dwp.com"),
  (tx) => tx.query(`select count(*)::int as n from dam_assets`));
```

Test both privilege regimes when a change touches grants: `createDb({ defaults: "revoked" })`.

## How this differs from the Supabase project

| Here | On v2 (`ivpqwbrpvpmxngkbbsak`) | Why it is safe to ignore, or what to watch |
|---|---|---|
| Postgres 18 (PGlite) | Postgres 17.6 | Nothing the schema uses changed between them. |
| `anon`, `authenticated`, `service_role` created by the harness; `service_role` has BYPASSRLS | Supabase's roles | The attributes that matter for RLS are the same. |
| `pgcrypto`, `pg_trgm`, `unaccent`, `vector` created in schema `extensions` | Supabase places extensions in `extensions` | Where they really landed on v2 is unverified (see the read-only query in `supabase/migrations/README.md`); pin `public, extensions, pg_temp` on functions that use their operators. |
| `pg_cron` is a stub: schema `cron` with a `cron.job` table and `cron.schedule` / `cron.unschedule` that only record calls. The baseline's `create extension pg_cron` line is replaced before it runs. | Real pg_cron | Tests can assert what a migration scheduled; nothing ever runs on a timer here. |
| PostgREST is emulated by `asPrincipal()`: role switch plus `request.jwt.claims`, nothing else | PostgREST also verifies the JWT signature, applies `max_rows`, and exposes only granted objects | Signature checks and HTTP behaviour are the web tier's tests, not these. |
| `defaults: "legacy"` grants everything `postgres` creates in `public` to all three API roles, like the project v2 was created under. `defaults: "revoked"` grants nothing, like a new Supabase project and plain Postgres. | Legacy defaults, as far as can be told (unverified) | A migration must be correct under both, so it may never rely on a default grant. |
| No `auth` schema, no Supabase Auth, no Storage, no Realtime | Present, unused by the DAM | The schema reads identity from `request.jwt.claims`, never `auth.uid()`. |
| No `supabase_migrations.schema_migrations` history table | Created by the CLI at the first `migration repair` / `db push` | Ordering here comes from the file names, the same rule the CLI uses. |
| An EMPTY database plus the fixtures | 34,949 imported assets and their links | Passing here does not prove a new constraint holds for the imported data. That needs an assertion inside the migration, which then fails the push cleanly. |

## The fixtures (`fixtures.sql`)

A mini-library shaped exactly like the imported v2 data: one Drive storage location like the real
one, six projects (home studios Bangkok, Singapore and the Australia region group; one with no
code; one with no studio; one filed under two studios), 26 assets (25 approved, one pending; four
without a project, one of them with a studio; one with an explicit access level), one version each,
`dwp_dam_v1` and `google_drive` external ids, OpenAsset ids on the OpenAsset projects, the
three-level Sector tree with fractional project weights, flat asset keywords in nine categories
including the exclusive ones, and the `legacy` blob and `ingest_relative_path` exactly as Stage 1
wrote them. Every row was produced by replaying `scripts/import-stage1..4.mjs` and
`scripts/lib/derive.mjs` over a designed corpus; the header of the file lists the fixed ids and the
edge cases each row exists for.

The last section adds seven test principals (`f9000000-...`) with studio memberships: v2 has no
users yet, and visibility cannot be tested without them. They use `fixture.*@dwp.com` addresses so
they never collide with a test that provisions its own user.

The file loads into a FRESH database only (it has no `on conflict` clauses), after `SCHEMA.sql`
alone or after the whole chain, and must stay independent of every migration: when migrations are
applied, their triggers fire on these inserts, which is part of the point.
