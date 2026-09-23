# supabase/migrations — the v2 database, as a forward-only chain

This folder is the history of the v2 DAM database (Supabase project `ivpqwbrpvpmxngkbbsak`, "DAM",
Postgres 17.6). The Supabase CLI applies the files in version order with `supabase db push`, each
file in one transaction, and records each in `supabase_migrations.schema_migrations`.

**Every migration is applied by the repo owner, by hand.** No script, CI job or assistant runs
`supabase link`, `migration repair`, `db push` or anything else that writes to the project.

`supabase/schema.sql` (one level up) is the **v1** schema of the current library, which lives in a
different project. It is unrelated to this chain, the CLI never reads it, and it must never be run
against v2. It stays where it is because `scripts/import-stage3.mjs` parses it.

## The chain

| Version | File | What it does |
|---|---|---|
| 20260915000000 | `20260915000000_baseline.sql` | A byte copy of `/SCHEMA.sql`: 97 tables, 48 enums, 29 functions, 164 policies, the reference seeds. **Already applied** on 2026-09-15 through the SQL editor, before any history table existed; it is adopted with `migration repair`, never pushed. |
| 20260923120000 | `20260923120000_p1_grants_settings_principals.sql` | Explicit table grants on every `dam_` table (`authenticated`: select/insert/update/delete, row-level security still gates every row; `service_role`: all; nothing for `anon`), the system principals, the `dam_setting*` accessors, the settings seed and its guards. |
| 20260923120100 | `20260923120100_p1_identity_helpers.sql` | The missing RLS helpers (`dam_is_system`, `dam_has_grant`, `dam_asset_studio_ids`, `dam_asset_effective_level`, ...), `dam_provision_user`, and the inactive-user fix to `dam_access_level_allows`. |
| 20260923120200 | `20260923120200_p1_search_row.sql` | The search-row writer (`dam_rebuild_asset_search_batch`, `dam_rebuild_asset_search`), staleness (`dam_mark_search_stale`, `dam_reindex_stale`), the reindex triggers, `dam_asset_search.ingest_relative_path` and two indexes, and the per-minute pg_cron job `dam-reindex-stale`. |
| 20260923120300 | `20260923120300_p1_taxonomy_integrity.sql` | Keyword, link and external-id integrity triggers, keyword path maintenance, the `descendant_ids` backfill. |
| 20260923120400 | `20260923120400_p1_search_rpcs.sql` | `dam_search_assets`, `dam_search_assets_count`, `dam_search_facets`: the only read path the app uses. |

### The baseline file

- It is exactly `SCHEMA.sql`, including that file's stale header ("Status: PROPOSAL. This file has NOT
  been applied to any database"). The header is wrong, and deliberately left wrong: editing either
  copy would make the file claim something other than what ran. This README is the correction.
- Never edit it, and never edit `SCHEMA.sql`. `node tools/sqlcheck/run-all.mjs --baseline SCHEMA.sql`
  (and CI) fail if the two differ by a single byte (CRLF aside).
- Once forward migrations exist, the database is baseline + migrations, not `SCHEMA.sql`. A drift
  check against the live project is `supabase db diff --linked`, which needs Docker and the database
  password: a user-run check, not CI.

### Naming

`<14-digit UTC timestamp>_<name>.sql`, as `supabase migration new <name>` writes it. The CLI takes
the leading digits as the version, so SPEC D-108's `<phase>_<n>_<name>.sql` would make every file of
a phase share one version. The phase goes in the name (`_p1_`). Files that do not match
`<digits>_<name>.sql`, such as this README, are ignored by the CLI (it may print a "Skipping
migration" notice for them, which is expected).

## Writing a migration

Each file starts with a header comment (purpose, what it depends on, forward-only and applied with
`supabase db push`), then `set search_path = public, extensions, pg_catalog;`. It has no
`begin`/`commit` (the CLI already wraps it), no `concurrently`, no `vacuum`, and never
`alter type ... add value` together with anything that uses the new value. It is idempotent where
that is cheap (`create or replace function`, `drop trigger if exists` before `create trigger`,
`create index if not exists`, `on conflict do nothing` seeds, `add column if not exists`).

It ends with explicit per-function ACLs for everything it creates, with the exact identity argument
types: `revoke all on function public.<name>(<args>) from public, anon;` and then the grant the
function needs. Never re-run the baseline's all-functions grant loop: it would hand `authenticated`
the service-role-only writers. Never rely on default privileges either: Supabase is switching new
projects to revoked defaults, and `tools/pgtest` tests both regimes.

Check it before handing it over:

```bash
npm run db:check    # tools/sqlcheck/run-all.mjs: the static validators, the migration rules, the baseline guard
npm run db:test     # tools/pgtest: applies the chain to an in-process Postgres, loads the fixtures, runs the tests
```

`tools/sqlcheck/README.md` lists what each validator catches and what it cannot.

## Applying the chain (the owner's runbook)

### 1. Read-only checks first (SQL editor of `ivpqwbrpvpmxngkbbsak`)

Each is a pure catalogue read. Run them before linking, and keep the output.

```sql
-- (a) default ACLs that new objects will receive
select pg_get_userbyid(d.defaclrole) as creator, coalesce(n.nspname, '(all)') as schema,
       d.defaclobjtype as kind, d.defaclacl
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
 order by 1, 2, 3;
-- (b) does authenticated really hold table privileges on the baseline tables?
select grantee, string_agg(privilege_type, ', ' order by privilege_type) as privs
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name in ('dam_assets', 'dam_asset_search', 'dam_projects')
 group by grantee order by 1;
-- (c) function ACLs (expect {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}, no anon, no "=X")
select p.proname, p.proacl from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'dam\_%' order by 1;
-- (d) where the extensions actually live
select extname, extnamespace::regnamespace as schema, extversion from pg_extension order by 1;
-- (e) has any migration history been recorded? (expect NULL: the baseline went through the SQL editor)
select to_regclass('supabase_migrations.schema_migrations');
```

What to look for: (b) with no row for `authenticated` means the read path cannot work until the
first migration's grants land, which is what that migration is for. (d) should show `pg_trgm`,
`unaccent` and `vector` in `extensions` (the migrations resolve either placement, but it is worth
knowing). (e) must be NULL; if it is not, run `supabase migration list --linked` after linking and
read it before repairing anything. (c) may show `dam_users_guard_privileged_columns` with a PUBLIC
grant (`=X/postgres`): known, harmless (a trigger function), and closed by the first migration.

### 2. Local checks

`npm run db:check` and `npm run db:test` both green (above).

### 3. Link, adopt the baseline, dry run, push

```bash
supabase link --project-ref ivpqwbrpvpmxngkbbsak                      # asks for the database password; writes supabase/.temp/ (git-ignored)
supabase migration repair --status applied 20260915000000 --linked     # records the baseline as applied; runs none of it
supabase migration list --linked                                       # 20260915000000 in both columns, the p1 files local only
supabase db push --dry-run                                             # must list exactly the five 20260923... files
supabase db push
```

`--db-url <percent-encoded postgres URL>` works in place of `--linked`; `-p` or
`SUPABASE_DB_PASSWORD` supplies the password. If the repair step is skipped, the push tries to run
the baseline again and stops at its first `create type` ("already exists"); nothing changes, but
nothing is applied either.

Each file is its own transaction. If one fails, it rolls back completely, the files before it stay
applied and recorded, and a second `supabase db push` after the fix resumes from the failed file.

### 4. Backfill the search rows

`dam_asset_search` is empty until something builds it. Either:

```bash
node scripts/v2-backfill-search.mjs            # dry run: counts assets, search rows and stale rows
node scripts/v2-backfill-search.mjs --write    # calls dam_reindex_stale(1000) until it returns 0
```

or leave it to the `dam-reindex-stale` pg_cron job, which rebuilds up to 2,000 missing or stale rows
a minute (the whole 34,949-asset library in about 18 minutes). Both use the same function, so they
can overlap safely.

### 5. Verify

`node scripts/v2-verify.mjs` is read-only: settings rows, system users, search rows against assets,
and (with `DAM_V2_SUPABASE_JWT_SECRET` set and `--email <addr>`) a search as that user. The web
tier's switch (`DAM_V2_BROWSE`) and its environment variables are documented in `DEPLOY.md`; the
deploy that ships them is also the owner's to run.

### Never

- **`supabase db reset --linked`** (or `--db-url` pointing at v2): it drops the imported library and
  replays the chain onto an empty database. `db reset` is only ever `--local`.
- **`supabase migration down --linked`**: the same class of damage.
- **`supabase config push`**: it would copy the local-stack defaults in `supabase/config.toml`
  (auth, storage, API settings) onto the cloud project.
- Running `supabase/schema.sql` (v1) against v2, or editing an applied migration. A change to
  something already applied is a new file with a later version.

## Deliberate deviations from SPEC.md

Recorded so a reader of SPEC does not "fix" them back:

1. `dam_setting_int` returns `bigint`, not `int`: the seeded `uploads.max_file_bytes` overflows
   `int4`.
2. `ai.autoaccept_confidence` is not seeded: as SPEC seeds it, it could never be set. The AI phase
   adds it.
3. A fifth system principal, `00000000-0000-0000-0000-000000000005` "Web service", is the web tier's
   principal (D-375), alongside migration, worker, directory sync and AI.
4. The identity helpers read role and studios from the tables (`dam_users`, `dam_user_studios`), the
   convention the applied baseline already follows; JWT claims beyond `sub` and `principal` are
   informational.
5. The web tier's minted JWT carries both `principal` (read by the baseline) and `principal_type`
   (SPEC's name), always equal.
6. `dam_asset_search.project_keyword_ids` ignores the D-483 override (an asset's own Space Type
   suppressing the inherited project Sector): the column is additive for now.
7. Reindexing is synchronous for asset- and project-scoped changes, and mark-stale plus the per-minute
   cron for category and keyword changes. pg_cron runs `dam_reindex_stale`, not `dam_enqueue_job`
   (SPEC 3.7.5), because no job worker exists yet.
8. `dam_asset_search.ingest_relative_path` is added (a copy of `dam_assets.ingest_relative_path`),
   because the v1 folder navigation filters on it.
9. `dam_can_read_asset` and the base-table policies are unchanged. The search RPC implements SPEC
   3.5.5 and is the only read path the app uses; the D-377 property test (policy and RPC agree) is
   future work.
10. New users take `cross_studio_visibility` from the setting `users.default_cross_studio_visibility`,
    seeded `true` so the preview matches today's library, where everyone sees everything.

### Implementation choices the builders made inside that contract

Not deviations from SPEC's intent, but choices a reader might otherwise "correct".

**20260923120000 (grants, settings, principals)**
- Settings seed rows carry fixed ids `5e000000-0000-4000-8000-0000000000NN` (01..22); the conflict
  target is still `key`. A DO block after the seed aborts the file if any key or system principal did
  not take.
- Seeded keys carry real `validation` bounds (SPEC leaves them `{}`). `trg_dam_settings_validate`
  also fires on `value_type` and requires integer settings to hold whole bigints;
  `trg_dam_settings_no_secrets` also checks `default_value`. `protect_system` compares old and new
  values, so an upsert naming an unchanged key is allowed; restoring a trashed system key is allowed.
- `dam_setting_text/_int/_bool` are invoker functions over the SECURITY DEFINER `dam_setting`;
  `_int` and `_bool` raise 22023 on the wrong JSON type.
- `authenticated` keeps TRUNCATE, REFERENCES and TRIGGER on the baseline tables it received under the
  project's legacy default privileges; this chain grants only the four DML privileges and does not
  narrow the rest (optional hardening later).

**20260923120100 (identity helpers)**
- `dam_level_satisfied` lets global admin and owner pass first (SPEC 3.5.5 step 2).
- `dam_is_at_least_in_studios` returns false, never null, for a caller with no role.
- `dam_has_scope` is false with no `sub`, true for any non-API-key principal with one; for API keys
  only the five stored scopes (read, write, admin, share, upload) exist, `admin` implying all.
- `dam_asset_effective_level` breaks ties on the level id so the result is deterministic.
- `dam_asset_studio_ids` falls back to `dam_assets.studio_id` whenever the linked projects name no
  studio (not only when there are no links); the search row uses the same reading.
- `dam_provision_user` uses `on conflict on constraint dam_users_email_key`; it reads
  `users.default_cross_studio_visibility` only for a new ACTIVE user, and writes sign-in bookkeeping
  at most once per 15 minutes (one audit row per user per window).
- Only the null-role hole in `dam_access_level_allows` is closed; its other baseline behaviours
  (inactive groups, grant below a `grant_only` floor) remain, as do the base-table policies.

**20260923120200 (search row)**
- `dam_mark_search_stale` stamps `clock_timestamp()`, not `now()`: with `now()` a mark made later in
  the same transaction as a rebuild is silently lost.
- The search row's `updated_at` is `least(dam_assets.updated_at, now())`, so a rebuild always leaves
  its row fresh and `dam_reindex_stale` always converges.
- `dam_reindex_stale` takes an advisory lock so the cron job and the backfill script queue behind
  each other; it builds missing rows first, then stale ones.
- Project and category UPDATE triggers act only when a searchable column changed. The keyword trigger
  is row-level with a WHEN clause and never fires on `descendant_ids` alone.
- Not yet wired (all empty today): clients, photographers, employees, text blocks, OCR, embeddings and
  access-level changes do not reindex. Their future writers must call
  `dam_rebuild_asset_search_batch`, or a later migration adds triggers. `rights_status` also changes
  with time alone and is refreshed only on the next rebuild.
- Bulk DML on the reindexed tables rebuilds rows inside that transaction (about 6 s per 10,000 rows in
  PGlite). Bulk scripts should `set local dam.skip_search_row = 'on'` and rebuild afterwards.

**20260923120300 (taxonomy integrity)**
- The baseline `dam_assert_keyword_namespace()` and `dam_assert_target_exists()` are attached
  unchanged, with column lists that leave out `deleted_at`, so a soft-delete cascade never trips
  them. A new link or external id pointing at an already-trashed target is refused (23503).
- `trg_dam_keyword_links_exclusive` raises 23505; `trg_dam_external_ids_immutable` raises 23514.
- SPEC's "AFTER UPDATE OF path" cannot fire (path is only ever changed by a BEFORE trigger), so
  `trg_dam_keywords_propagate` watches the columns callers actually set and compares old and new
  itself. Subtrees are found by walking `parent_id`, not `path LIKE`.
- A rename that leaves `slug` unchanged re-derives the slug; to keep a custom slug, send a different
  one. A category change is refused for a node with children. Multi-row keyword inserts must list
  parents before children.
- The file ends with assertions that abort it if the imported data breaks any rule it attaches.

**20260923120400 (search RPCs)**
- An `offset` outside 0..10,000, or fractional, raises 22023 rather than being clamped (a clamped
  offset would silently repeat a page).
- `studio_ids` expands region groups to their children, like `studio_codes`; an unknown studio code
  adds nothing to an any-of list.
- The embargo test is written null-safe (SPEC 3.5.5 step 5); `min_role` is compared with the global
  role (SPEC 3.7.6), not the per-studio effective role.
- `keyword_names` / `project_keyword_names` compare `lower(btrim(name))` on both sides; hydrated
  `keyword_names` holds each distinct name once, at its highest link weight; `project_codes` lines up
  with `project_names` and holds null for a project with no code.
- Facets over the whole library took about 240 ms for six groups in PGlite, above SPEC's 120-150 ms
  budget; measure on the real database after the backfill (the app does not call facets yet).
