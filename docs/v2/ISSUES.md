# Defect log — project-based DAM planning pack

Every defect found by the validators, with what was done about it. Updated 2026-09-15.

## Fixed

| # | Class | Defect | Where found | Fix |
|---|---|---|---|---|
| 1 | Contradiction between parts | Part 3's audit policy filters `dam_audit_log.studio_id`, but part 2b's audit log had no such column. Studio admins could not read their own studio's audit trail without a polymorphic lookup per row across 36 partitions. | reference checker | Added `project_id` and `studio_id` to `dam_audit_log`, matching the treatment the other two log tables already had; the audit trigger now populates both. |
| 2 | Missing column | Retention (part 2b) skips assets on legal hold, but `dam_assets.legal_hold` did not exist, so the rule could never fire. | reference checker | Added `legal_hold boolean not null default false` to `dam_assets`. |
| 3 | Missing column | The Projectworks mapping writes a project manager, but `dam_projects` had nowhere to put it. | reference checker | Added `project_manager_employee_id` with a deferred foreign key to `dam_employees`. |
| 4 | Missing column | Part 5 requires an employee to be able to withdraw consent for automated headshot matching; no column carried it, so the pipeline could not honour it. | reference checker | Added `dam_employees.headshot_matching_opt_out`. |
| 5 | Missing column | Part 4 scopes webhook subscriptions by studio; `dam_webhooks` had no studio column. | column audit | Added `dam_webhooks.studio_ids uuid[]`. |
| 6 | Race condition | Part 2b says a running job is "marked" for cancellation, but no column existed; writing `status = 'cancelled'` directly would race the worker's own terminal write. | column audit | Added `dam_jobs.cancel_requested_at`; the worker performs the status change at its next heartbeat. |
| 7 | Wrong column names (7) | Part 4 referenced `dam_api_keys.prefix`, `.rate_limit_per_min`, `.studio_ids`, `dam_sizes.key`, `dam_external_ids.extra`; part 5 referenced `dam_integrations.schedule`, `.watermarks`, `dam_template_versions.object_key`. None existed under those names. | reference checker | Repointed each to the real column (`key_prefix`, `rate_limit_per_minute`, `studio_id`, `slug`, `payload`, `schedule_cron`, `cursor`, `source_asset_id`). |
| 8 | Wrong column names (2) | Part 2b referenced `dam_projects.name_internal` and `.name_marketing`; the real columns are `internal_name` and `name`. | reference checker | Renamed both references. |
| 9 | Dangling reference | Part 2b referenced `dam_asset_text`, a table that does not exist (the real one is `dam_asset_ocr_text`), and referenced `dam_sync_field_state` in three places without ever defining it. | assembler entity index | Part 2b now defines `dam_sync_field_state` as §2B.45a; the OCR reference is corrected. |
| 10 | Missing enum values (4) | Parts used notification kinds `hero_cleared` and `api_key_expiring`, and job kinds `ingest_walk` and `bulk_edit`, that the schema never defined. | enum checker | Added all four. |
| 11 | Retention gaps | `dam_webhook_deliveries` and `dam_ai_runs` grow without bound and were being pruned by ad-hoc settings rather than retention policy rows. | agent reports, cross-checked | Added `webhook_deliveries`, `ai_runs` and `jobs` to `dam_retention_target`. |
| 12 | Permission hole | `dam_can_read_album` resolved only individual collaborators; `dam_album_collaborators` also grants by group, so group members were denied access they had been given. | manual review of the helper against the table | Helper now resolves group membership. |
| 13 | Tables missing from the inventory (3) | `dam_ingest_batch_files`, `dam_asset_crops` and `dam_sync_field_state` were introduced by the parts but were not in the canonical inventory, so nothing guaranteed they reached the schema. | assembler entity index | All three added to the inventory; `dam_asset_crops` given a full definition (§2.22a), `dam_ingest_batch_files` promoted to §2.28a. |
| 14 | Id collisions | Three default ids (`D-701`–`D-703`) and two (`D-STOR-01/02`) were fact-sheet citations written in the same form as the specification's own defaults, so they read as duplicate definitions. | SPEC linter | Rewritten as explicit citations (`[integrations sheet D-701]`, `[storage sheet D-STOR-01]`). |
| 15 | My own errors | Part 6's migration appendix referenced `dam_asset_versions.provider_parent` and `dam_assets.legacy_path`; neither exists. Part 6 also wrote a settings key as if it were a column. | reference checker | Corrected to `object_parent_key`, the `legacy` JSON key, and `dam_setting('read_only')`. |
| 16 | Ambiguous citations | Seven section references pointed into research fact sheets without naming them, so they read as broken internal cross-references. | assembler | Each now names its source file. |

| 17 | Execution failure | The generated search and OCR columns call an accent-folding function that was never defined. The schema parses and then fails on execution — a parser cannot catch a name that does not resolve. | SQL transcription | Added `dam_unaccent`, pinning the dictionary so it is genuinely immutable and therefore legal in a generated column. |
| 18 | Execution failure | Two rights CHECK constraints call a territory validator that was never defined, so both table creations would fail. | SQL transcription | Added `dam_valid_territories`: either the worldwide sentinel alone, or ISO 3166-1 alpha-2 codes. |
| 19 | Missing default | An upload file's `state` had no default and no `not null`, so a row could sit outside its own permitted vocabulary without violating the constraint. | SQL transcription | `not null default 'pending'` in both the specification and the schema. |
| 20 | Self-contradiction | A watched-folder `schedule` column said "no default" in the grid and "default `0 1 * * *`" in its note. | SQL transcription | Resolved as an interface default, not a data one, and the reason recorded. |
| 21 | Convention slip | One table was described as carrying six standard columns; the convention is seven. | SQL transcription | Corrected to seven. |
| 22 | Unusable index | `dam_jobs.asset_id` cascades on delete, but the only index on it is partial on status, so a cascade cannot use it and purging an asset would scan the whole queue. | index transcription | A second index partial on `asset_id is not null`, and the reason recorded in the specification. |
| 23 | Rule in two places | AI run retention was half a policy row and half a setting, because the retention enum lacked a member. | supporting-table transcription | The enum gained `ai_runs`, `webhook_deliveries` and `jobs`; the specification now states retention in one place. |

## Accepted, not defects

- `dam_sizes.params_version` is declared in a prose note under its table rather than in the column grid. The checker cannot see it. It must still reach the schema.
- One `§9.3` citation still trips the assembler's heuristic because the line contains an earlier section symbol. The document text is correct.

## Validators built for this work

| Tool | Catches |
|---|---|
| `check.mjs` | PostgreSQL syntax, offline, via the real parser grammar |
| `lint.mjs` | Schema conventions: `dam_` prefix, the six standard columns, row-level security enabled, a policy on every table, index and policy naming, security-definer search paths |
| `speclint.mjs` | Table coverage against the inventory, default-id ranges and collisions, open-decision labels, malformed tables, house style, secret patterns |
| `refcheck.mjs` | Every `table.column` reference in the specification against the tables as actually defined — the checker that found most of the defects above |
| `enumcheck.mjs` | Enum values used in prose that the schema does not define |
| `stitch.mjs` | Assembly, contents, defaults register, entity index, endpoint index, unresolved cross-references |

## Round 2 — the Supabase-compatibility preflight (2026-09-15)

A 45-agent adversarial preflight (6 compatibility lenses x 3 refutation votes)
run against the assembled file, plus the follow-up hunt it prompted. 13
candidates raised, 9 confirmed, 2 of them fatal. Four further defects were
found while fixing those.

| # | Class | Defect | Fix |
|---|---|---|---|
| 24 | **Fatal — aborts CREATE TABLE** | `dam_aspect_ratios.orientation` wrapped a CASE over bare literals in an outer `::dam_orientation`. That cast is a `CoerceViaIO` call of `enum_in()`, which is STABLE, and a generated column requires an IMMUTABLE expression — Postgres rejects the table outright. | Each CASE arm cast individually to `dam_orientation`, removing the coercion node. |
| 25 | **Fatal — aborts the run at the last statement** | The `dam_aspect_ratios` seed INSERT named `orientation` in its column list. A `GENERATED ALWAYS` column cannot appear in an INSERT target list. It sits at the very end of the file, so the whole schema would have rolled back after everything else succeeded. | Column and its six supplied values removed; the generated expression reproduces all six exactly. |
| 26 | Silent wrong result | The same orientation expression used a 2.2 panorama cut and an exact `ratio_w = ratio_h` square test, while `dam_assets.orientation` uses 2.4 and a 0.95–1.05 band. The same shape would file under different orientations depending on which table answered, and the SPEC line claimed the thresholds were identical. | Both aligned on greatest/least, 2.4 and 0.95–1.05. SPEC corrected. |
| 27 | **Silent hole — RLS bypass** | Row-level security is not inherited by partition children. All twelve children of the three log tables were directly readable: `select * from dam_audit_log_y2026m09` returned every row to any authenticated user while the parent was correctly filtered. | `enable row level security` on all twelve, with no policies (the parent's govern reads through the parent). The partition job is now told to do the same and assert it. |
| 28 | **Silent hole — privilege escalation** | `dam_users_update_self` grants a row-level update of one's own row; RLS cannot restrict columns; `authenticated` holds Supabase's default GRANT ALL. So `update dam_users set role = 'owner' where id = <self>` satisfied every policy on the table. SPEC §3.7.2 already required a trigger here; it had never been written. | `trg_users_guard_privileged_columns`, a BEFORE UPDATE guard holding a **whitelist** of self-service columns, plus the full D-358 rule set: only an owner grants or modifies owner/global_admin, nobody changes their own role or deactivates themselves, the last active owner cannot be removed, `is_system` never changes. |
| 29 | Silent hole — ineffective revoke | `revoke all on function … from anon` removes a grant `anon` never held: Postgres grants EXECUTE on every function to PUBLIC, and `anon` inherits through it. The anonymous role could still call `dam_is_global_admin()` and every other helper. | `revoke all … from public, anon` then `grant execute … to authenticated, service_role`. |
| 30 | Silent wrong result | `dam_config_has_no_secrets` used `\b` for a word boundary. In Postgres's ARE dialect `\b` is the BACKSPACE character, so the `AIza` and `sk-` branches were dead code. | `\m` (beginning of word), consistent with the `eyJ` branch beside them. |
| 31 | Spec/schema divergence — weakened control | The implemented secrets CHECK tested value shapes only, so `{"api_key": "hunter2"}` passed. D-338 specifies a key-name rule as well, and every seeded connector config is written around it (`token_secret_name`, `api_key_secret_name`). | Reimplemented to D-338: key-name rule (exempting `_name`/`_ref` suffixes) plus value shapes, recursing through nested objects and arrays. |
| 32 | Identifier truncation | `dam_integration_field_mappings_transform_config_no_secrets_check` is 64 bytes; NAMEDATALEN-1 is 63, so Postgres would silently truncate it and a later `alter table … drop constraint` by the written name would fail. | Renamed to 56 bytes. |
| 33 | Latent fatal on data | `dam_aspect_ratios.ratio numeric(8,5)` holds at most 999.99999, but the `ratio_w`/`ratio_h` CHECKs admit `10000:1`, which computes 10000.00000 and raises `numeric field overflow` on insert. A column's domain must cover everything its table's constraints allow. | `numeric(10,5)`. SPEC corrected. |
| 34 | Non-reproducible DDL | Partition bounds were bare date literals, cast using the *session's* TimeZone (UTC on Supabase) while the comment above them claimed firm-timezone boundaries. A later partition created under a different session timezone would not meet the previous one's upper bound: Postgres refuses the overlap, or accepts a gap that routes rows to the default partition, which retention never drops. | All nine bounds written `timestamptz '…+07'`. SPEC and the partition-job contract corrected. |
| 35 | Hardening — search_path shadowing | Seven of 28 functions had no pinned `search_path`, against a house convention the other 21 followed. Two of them are trigger validators: `pg_temp` is searched first when not named explicitly, so a caller could shadow a table or function the validator resolves and defeat the check. | `set search_path = public, pg_temp` on all seven. All 29 functions are now pinned. |

Refuted, or accepted as already correct: 4 of the 13 candidates. The file is one
transaction (no `CONCURRENTLY`, no `VACUUM`, no `ALTER TYPE … ADD VALUE`), so any
failure rolls the whole thing back rather than half-applying.

### Validator added this round

| Tool | Catches |
|---|---|
| `plpgsql.mjs` | Unbalanced `if`/`loop`/`case`/`begin` inside plpgsql function bodies — the one class every other tool here is blind to, because the SQL grammar treats a body as an opaque string and Postgres only parses it at CREATE time. Mutation-tested: two planted breaks, both located. |

### Known blind spot

Nothing offline can fully validate a plpgsql body: `plpgsql.mjs` checks block
structure, but an expression error inside a balanced statement would only
surface at CREATE time. The mitigation is structural — the file is one
transaction, so such an error aborts and rolls back with nothing applied.

## Round 3 - the first real execution (2026-09-15)

The schema was run against the new Supabase project and failed on the FIRST seeded
row. Everything in this round is a defect that no parser and none of the six existing
validators could see, because they all stop at the edge of a plpgsql function body.

| # | Class | Defect | Fix |
|---|---|---|---|
| 36 | **Fatal - aborted the run** | `dam_audit_row()` declared `v_changed text[];` with no initialiser. The INSERT and DELETE branches never assign it, so it was NULL, and because the function's INSERT NAMES `changed_keys` the column's `NOT NULL DEFAULT '{{}}'` never applied. Every audited insert died with 23502, which meant the first seeded access level. | Declared `:= array[]::text[]`. The empty-set test beside it changed from `= array[]::text[]` to `cardinality(...) = 0`, which is null-safe. |
| 37 | **Fatal on first call** | `dam_enqueue_job()` wrote `on conflict (idempotency_key) where idempotency_key is not null`, but `dam_jobs_idempotency_key_active_key` is partial on that AND `status in ('queued','running')`. Postgres infers a partial unique index only when the predicate given implies the index's own, so inference fails and the call raises 42P10. Not at CREATE FUNCTION - at the first enqueue, which is the first ingest. | The ON CONFLICT predicate now states both conditions. |
| 38 | Silent wrong result | The fallback in the same function, `select id ... where idempotency_key = p_idempotency_key`, was unbounded by status. Because the unique index is partial, finished jobs keep their keys, so this could return a long-completed job id for the caller to poll forever. | Narrowed to the same non-terminal window, newest first. |

Accepted, not a defect: `dam_audit_row()`'s `v_action` is also declared without an
initialiser, and the new checker flags it. It is assigned on every reachable path - the
branch is exhaustive over `tg_op`, which for a FOR EACH ROW trigger can only be INSERT,
UPDATE or DELETE. Justified in place with a `-- fninsert:ok` comment so the reasoning
sits next to the code and a genuinely new finding still stands out.

### Validators added this round

Each was mutation-tested: a defect was planted, the tool located it, the file restored.

| Tool | Catches |
|---|---|
| `fninsert.mjs` | INSERTs inside plpgsql bodies, checked against the real tables: an uninitialised DECLARE variable flowing into a NOT NULL column (defect 36 exactly - reverting the fix makes it reappear), column/value arity, unknown or GENERATED columns, and a NOT NULL column with no default that is never supplied. Honours an inline `-- fninsert:ok <var> - <reason>` justification. |
| `seedcheck.mjs` | Every seeded INSERT and UPDATE against its table's real shape: arity per tuple, unknown columns, GENERATED columns named in a column list, literal NULL into NOT NULL, and any NOT NULL column with no default left unsupplied. |
| `enumcast.mjs` | Every `'literal'::dam_enum` cast in the file against that type's real CREATE TYPE list. A wrong member parses and raises 22P02 when the statement runs. 156 casts checked. |

### What this round changed about the method

The previous report named "no offline tool can fully validate a plpgsql body" as the one
known blind spot and offered the single-transaction rollback as the mitigation. That was
accurate but too comfortable: the mitigation limits the DAMAGE of such a defect, it does
nothing to find one. Two of the three defects above were reachable by static analysis of
the body text against the catalogue, and are now covered. What genuinely remains
unreachable is narrower than before: an expression error inside a structurally valid
statement whose operands are all legal - for example a division whose divisor is only
zero for certain data.

### Round 3, second failure — the seed data itself

| # | Class | Defect | Fix |
|---|---|---|---|
| 39 | **Fatal - aborted the run** | The seeded `Original` output preset declared `format = 'jpeg'` while `is_original = true`. dam_sizes asserts `check (is_original = (format = 'original'))` — the two are the same fact stated twice, and the constraint exists precisely so they cannot disagree. The seed made them disagree. | `format 'original'`, as D-306 states. |

The pattern across all four defects of this round is one thing: every validator
built before it checked the schema's STRUCTURE and none of them evaluated its
RULES against the DATA the same file inserts. Three more tools close that.

| Tool | Catches |
|---|---|
| `checkeval.mjs` | Evaluates every CHECK constraint against every seeded row — the supplied values plus the column DEFAULTs for everything unsupplied — in PostgreSQL's three-valued logic, where a CHECK fails only on FALSE and passes on NULL. 351 constraints over 57 rows, none un-evaluable. Anything it cannot model faithfully is reported as SKIPPED, never counted as a pass. Regression-tested: reverting defect 39 makes it reappear. |
| `seedintegrity.mjs` | The other two ways a seed row dies: a unique-index collision (90 of the 97 unique indexes modelled, partial predicates and `lower()` keys included — the seven it cannot model are all on tables the seed never touches, and it says so) and a foreign key pointing at a row that is never seeded, or seeded LATER in the file. Mutation-tested with three planted defects; all three located. |
| `enumcast.mjs` | Every `'literal'::dam_enum` cast against its type's real member list. 156 checked. |

### Residual risk, stated precisely

What can still fail, after eleven validators:

1. **A plpgsql body syntax error outside block structure.** Postgres parses every
   body at CREATE FUNCTION (`check_function_bodies`), so such an error aborts the
   run rather than lying dormant. `plpgsql.mjs` covers block balance, which is the
   common case; a malformed DECLARE would not be caught here.
2. **A data-dependent runtime error** — a division whose divisor is only zero for
   certain rows, a numeric overflow only some values reach. Nothing offline can
   decide these without the data.

Both abort and roll back rather than half-applying, because the file is one
transaction. The generated columns were re-audited by hand this round for the
immutability trap that produced defect 24: `to_tsvector('simple', …)` and
`unaccent('unaccent'::regdictionary, …)` are safe, because an UNKNOWN literal
coerced to a type becomes a parse-time constant, not the run-time `CoerceViaIO`
call that a cast over a TEXT-typed expression produces. That distinction is the
whole of defect 24, and it is why the CASE arms are cast individually.
