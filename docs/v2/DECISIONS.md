# DECISIONS.md — binding architecture digest for SPEC.md / SCHEMA.sql / ROADMAP.md

Status: binding for every writer. Written 2026-09-09 from the brief (`BRIEF.md`) and the six fact sheets in this folder (`existing-schema-and-types.md`, `existing-auth-and-api.md`, `existing-drive-and-ops.md`, `existing-ai.md`, `existing-ui-standard.md`, `aec-integrations-research.md`). The web research on OpenAsset's API did not complete; §9 carries what is known from memory, marked as such.

Rules for writers:
- Use the table names, enum names and column conventions here verbatim. If you need a table that is not in §2, follow the conventions and list it under `additionalTables` in your return.
- Items in §7 are OPEN. Never write them as decided. Present options, recommendation, consequences.
- Everything else here is a sensible default. Tag defaults inline in the SPEC as **[D-nnn]** with a one-line rationale; ids D-001…D-099 are reserved for this file, each part has its own range.
- British spelling. Region id is `asia-southeast3`.

---

## 1. Design decisions DQ1–DQ18

### DQ1 Custom fields — hybrid: typed EAV with per-category schema
Do: `dam_fields` defines a field (type, scope, options, validation, `is_facet`, `is_inheritable`); `dam_field_values` stores one row per (field, target) with typed value columns (`value_text`, `value_long_text`, `value_number numeric`, `value_date date`, `value_bool`, `value_json jsonb`, `value_currency_code`) and a CHECK that exactly the column matching the field type is populated (enforced by trigger, because the type lives on the parent row). Single-select stores `value_text` = option key; multi-select stores `value_json` (array of option keys). `dam_category_fields` says which fields apply to which asset category and whether they are required; `dam_fields.scope` says project / asset / employee. Options for selects live in `dam_field_options`.
Do not: put custom fields in a JSONB blob on the entity (no per-field indexes, no required-per-category enforcement, no type safety at 500k rows).
Consequences: indexes on `(field_id, value_text)`, `(field_id, value_number)`, `(field_id, value_date)` for facets; a `dam_validate_field_value()` trigger; facet-flagged fields are also copied into `dam_asset_search.facet_fields jsonb` (GIN) so search never joins EAV.

### DQ2 Keywords — one namespaced tree table, aliases, and one polymorphic link table
Do: `dam_keyword_categories(namespace, name, …)` and `dam_keywords(namespace, category_id, parent_id, name, slug, path text, depth int, …)`; `namespace` is `dam_keyword_namespace` = `asset | project | employee`. `path` is a materialised `/`-joined chain of slugs maintained by trigger (rename propagates by rewriting descendants' paths; no ltree dependency). `dam_keyword_aliases(keyword_id, alias)` for synonyms; unique on `(namespace, lower(alias))`. Links: `dam_keyword_links(keyword_id, target_type dam_target_type, target_id uuid, source dam_link_source, weight, …)`, unique `(keyword_id, target_type, target_id)`. Links are always **confirmed**; AI proposals live in `dam_ai_suggestions` (DQ10-AI) until accepted, at which point a link row is created with `source = 'ai'`.
Integrity: no FK on `target_id` (polymorphic). A trigger `dam_assert_keyword_target()` checks the target row exists and that `namespace` matches `target_type` (asset↔asset, project↔project, employee↔employee). Deleting a target soft-deletes its links via trigger.
Merge: `dam_merge_keywords(src, dst)` re-points links (skipping duplicates), moves aliases, adds `src.name` as an alias of `dst`, soft-deletes `src`. Rename-with-propagation is free (links are by id).
Per-category keyword schema: `dam_category_keyword_categories(category_id, keyword_category_id, is_required)`.

### DQ3 Access control — role on the user, studio membership, named access levels, RLS through helper predicates
Model: `dam_users.role dam_role` (global role; the six tiers `viewer < contributor < editor < studio_admin < global_admin < owner`), `dam_user_studios(user_id, studio_id, role_override dam_role null)` (membership; `studio_admin` is normally granted here per studio), `dam_users.cross_studio_visibility bool` (the "see other studios' work" permission of §4.8). Access levels are named rows in `dam_access_levels(name, min_role dam_role, scope dam_access_scope = firm | studio | grant_only, is_default)`; `dam_access_grants(access_level_id, group_id | user_id)` extends a level to named people/groups. `dam_categories.access_level_id` (not null), `dam_projects.access_level_id` (not null), `dam_assets.access_level_id` (nullable = inherit the project's level, else the category's).
Effective read on an asset = not deleted AND (caller is `global_admin`+ OR (studio scope satisfied OR `cross_studio_visibility`) AND access level satisfied (role ≥ `min_role`, or a grant, or the caller created it) AND (status is `published`/`approved`, or role ≥ `editor`, or caller created it)). Write rules follow the permission matrix in SPEC part 3 (proposed, OPEN §10.3).
RLS mechanics: every table `ENABLE ROW LEVEL SECURITY` (NOT `FORCE` — the migration owner must be able to seed, and Supabase's `service_role` bypasses RLS anyway; document this). Policies call STABLE SECURITY DEFINER helper functions with `SET search_path = public, pg_temp`: `dam_current_user_id()`, `dam_current_role()`, `dam_current_studio_ids()`, `dam_is_at_least(dam_role)`, `dam_can_read_project(uuid)`, `dam_can_write_project(uuid)`, `dam_can_read_asset(uuid)`, `dam_can_write_asset(uuid)`, `dam_can_read_category(uuid)`, `dam_can_manage_studio(uuid)`, `dam_can_read_album(uuid)`, `dam_can_read_employee(uuid)`. Helpers read only indexed columns. The hot search path does NOT rely on per-row policy evaluation: `dam_search_assets(...)` is a SECURITY DEFINER RPC that applies the same predicate set-wise against `dam_asset_search` (which carries `access_level_id`, `studio_ids`, `status`, `deleted_at`, `created_by`). Policies remain on the base tables as defence in depth.
Anonymous access (share links, upload requests) is only ever through SECURITY DEFINER RPCs that validate the token; there are no `anon` policies on core tables.
Workers use `service_role`; the API layer never uses `service_role` for user-initiated reads or writes.

### DQ4 Identity — dwp auth broker in front, server-minted Supabase-compatible JWT behind (OPEN Q6 records the alternative)
Default: keep the fleet's SSO (Google GSI → server-side exchange at the dwp auth broker → HS256 `dwp_session` cookie, claims `email/role/name/picture/exp/app_id`; the broker role is always `viewer` and is ignored). On each request the app resolves `email → dam_users` (auto-provision on first sign-in as `viewer`, `is_active` gated by an admin), then mints a short-lived Supabase JWT (signed with the Supabase JWT secret) with `role = 'authenticated'`, `sub = dam_users.id`, and app claims `dam_role`, `studio_ids`, `cross_studio`. `dam_current_user_id()` reads `sub` from `request.jwt.claims`. This makes RLS work without Supabase Auth user records and keeps the schema identical if Supabase Auth is adopted later (`dam_users.auth_uid uuid null` reserved; when Supabase Auth is used, `dam_users.id` is set equal to `auth.users.id` at provisioning).
API keys (`dam_api_keys`: `key_hash`, prefix, `owner_user_id` or `service_name`, `scopes text[]`, studio scope, rate limit, `expires_at`, `revoked_at`) resolve to a principal the same way and mint the same claims (`principal_type = 'api_key'`, acting role capped by scopes). SAML/OIDC fallback is a broker concern; SCIM is out of scope for v1 (users are provisioned from BambooHR sync or on first login).

### DQ5 Search — denormalised search row, arrays + GIN, tsvector, trigram, pgvector; keyset pagination; RPC-driven
Do: `dam_asset_search` 1:1 with `dam_assets` (PK = `asset_id`), maintained by row triggers for the asset's own columns and by queued reindex jobs for cascaded/aggregate changes (project rename, keyword merge, rights expiry). Columns: `search_tsv tsvector` (weights: A filename/title/project code, B caption + keyword names + project name + client, C text blocks + employee names on the project, D OCR text), `trigram_text text` (filename + title + project code + project name), `asset_keyword_ids uuid[]`, `project_ids uuid[]`, `project_keyword_ids uuid[]`, `studio_ids uuid[]`, `client_ids uuid[]`, `category_id`, `photographer_id`, `country_code`, `captured_on date`, `orientation`, `long_edge_px int`, `megapixels numeric`, `file_kind`, `mime_type`, `rights_status`, `colour_buckets smallint[]` (12 hue buckets + 3 neutrals), `facet_fields jsonb`, `access_level_id`, `status`, `is_hero_anywhere bool`, `rating_avg`, `created_by`, `deleted_at`, `updated_at`. Embeddings live apart in `dam_asset_embeddings` (`image_embedding vector(1408)`, `text_embedding vector(768)`, `image_model`, `text_model`) so the search row stays narrow.
Indexes: GIN on `search_tsv`; GIN `gin_trgm_ops` on `trigram_text`; GIN on each uuid[] (keyword AND = `@>`, OR = `&&`); btree on `(category_id)`, `(rights_status)`, `(captured_on)`, `(created_at desc, asset_id)`; partial indexes `where deleted_at is null and status = 'published'` on the hottest facets; HNSW `vector_cosine_ops` on both embedding columns. Keyset pagination is the default (cursor = base64 of `(sort_value, asset_id)`); `offset` accepted up to 10,000 for compatibility. Counts: exact for filtered sets ≤ 50,000 rows, else `count_estimate` from `EXPLAIN` with `is_estimate = true`. Facet counts come from a second RPC over the same predicate, capped to top 50 values per facet. Hybrid ranking: reciprocal rank fusion of `ts_rank_cd` and vector cosine distance; the §1 example query is: project keywords (Hospitality) ∧ project country = VN ∧ project status = completed ∧ project size ≥ 4000 ∧ project has employee role "Project Architect" for the named person ∧ `is_hero_anywhere` — all resolvable inside `dam_asset_search` plus one join to `dam_project_employees`.

### DQ6 Inheritance — materialised effective values, recomputed by triggers and reindex jobs
What cascades from project to asset: home + contributing studios, client, country/city, project status, project keywords, project custom fields with `is_inheritable = true`. What overrides: an asset-level keyword or field value with the same category/field wins; `dam_effective_field_values(asset_id)` returns the merged set (asset row, else inheritable project row). Effective values are written into `dam_asset_search` (DQ5); the raw tables never copy values. A project change enqueues one `reindex_project` job that rewrites its assets' search rows in batches of 1,000.

### DQ7 Storage — StorageProvider interface, versions as immutable objects, derivatives in Supabase Storage behind a CDN
Do: `dam_storage_locations(name, provider dam_storage_provider, tier dam_storage_tier, container text, config jsonb, is_default_originals, is_default_derivatives, is_active)`; `config` never holds secrets (secret names only). Originals are immutable objects: `dam_asset_versions(asset_id, version_no, storage_location_id, object_key, size_bytes, sha256, md5, phash, mime_type, width, height, duration_ms, page_count, exif jsonb, iptc jsonb, xmp jsonb, uploaded_by, replaced_reason)`, `dam_assets.current_version_id`. Replacing an asset inserts a new version and moves the pointer; keywords, fields, album membership, rights and links stay on the asset. `dam_derivatives(version_id, kind dam_derivative_kind, storage_location_id, object_key, width, height, format, size_bytes, status)`; derivatives always live in the Supabase Storage location per [D-STOR-02], are served through the CDN with signed URLs (TTL 1 h, path-bound HMAC as today's `/api/slides/image` pattern for the Drive provider). On-the-fly renders are cached in `dam_render_cache(version_id, params_hash, object_key, …)`. Drive-specific: never trust `thumbnailLink`; always generate own derivatives; never use whole-drive `q` listings (Changes API or parent-scoped only). The `StorageProvider` TypeScript interface is the one in `existing-drive-and-ops.md` §9 (ObjectRef/ObjectMeta/UploadSession/SignedUrlOptions/QuotaInfo; put, createUploadSession, finalizeUpload, replace, rename, move, delete, restore, head, exists, get, stream, signedUrl, nativePreview, list, ensureFolder, changes, quota, capabilities). Where originals live is OPEN §10.1; the schema is neutral (`storage_location_id` per version).

### DQ8 Jobs — Postgres queue table, one worker service, pg_cron for schedules
Do: `dam_jobs(kind dam_job_kind, payload jsonb, status dam_job_status, priority smallint, run_after, attempts, max_attempts, locked_by, locked_at, lock_expires_at, idempotency_key text unique, parent_job_id, asset_id null, project_id null, last_error, result jsonb, started_at, finished_at)`; workers claim with `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`; visibility timeout via `lock_expires_at`; exponential backoff on retry; `dead` after `max_attempts` raises a notification. Ingest chain per version: `hash → extract_metadata → derivatives → dedupe → embed → ocr → index` as separate jobs linked by `parent_job_id`. Schedules (rights expiry sweep, tiering, purge, sync runs, digest emails) via `pg_cron` calling `dam_enqueue_job(...)`; Cloud Scheduler is the fallback if pg_cron is unavailable. The worker is a second Cloud Run service (`dwp-dam-worker`, min instances 1, 2 vCPU / 4 GiB for TIFF decoding). No long work in request handlers: uploads finalise by enqueueing.

### DQ9 Audit and usage — trigger-based audit with monthly partitions; separate usage and search logs
Do: `dam_audit_log` (partitioned by range on `occurred_at`, monthly; parent + a default partition + the first three months in SCHEMA.sql; a `create_next_partitions` job): `table_name, row_id, action dam_audit_action, actor_id, actor_type, request_id, old_row jsonb, new_row jsonb, changed_keys text[], occurred_at`. Trigger `dam_audit_row()` on every business table (not on logs, search, cache, jobs). `dam_usage_events` (partitioned monthly): `asset_id, version_id, event dam_usage_event, principal (user_id | api_key_id | share_link_id), size_id, format, purpose text, bytes, ip_hash, user_agent, occurred_at`. `dam_search_log`: `query_text, filters jsonb, result_count, is_zero_result, took_ms, user_id, occurred_at`. Retention defaults: audit 36 months, usage 36 months, search 12 months (`dam_retention_policies`). Partition children are exempt from the six standard columns (they inherit).

### DQ10 API — `/api/v2` resource API with OpenAsset-shaped ergonomics; `/api/v1` kept as a compatibility shim
Base `/api/v2/…` on the same origin. Auth: `Authorization: Bearer dam_live_<…>` (API key) or the session cookie; `?key=` accepted only on derivative URLs. Verbs GET/POST/PATCH/DELETE (v1 stays GET/POST-only). Pagination: `limit` default 50 max 200, `cursor` (opaque keyset) preferred, `offset` accepted ≤ 10,000; response `{ data, meta: { limit, next_cursor, count, total, total_is_estimate } }`. Sparse fieldsets: `fields=id,name,project.code` (OpenAsset `displayFields`). Expansion: `include=project,rights,derivatives,keywords` (depth 1; OpenAsset nested resources are also mirrored: `/projects/{id}/assets`, `/assets?project_id=`). Filters: `filter[field]=v`, `filter[field][op]=v` with ops `eq ne in nin gt gte lt lte like ilike any all null`; `q=` free text; `sort=-created_at,name`. Errors `{ error: { code, message, details?, request_id } }`; codes `bad_request validation_failed unauthorized forbidden not_found conflict rate_limited payload_too_large server_error`. Rate limits per key (token bucket; `X-RateLimit-Limit/Remaining/Reset`, 429 with `Retry-After`). `Idempotency-Key` on POST create/upload; ETag + `If-Match` on PATCH. Bulk: `POST /api/v2/assets/bulk` (up to 500 ids). Webhooks: `dam_webhooks(url, secret_hash, events dam_webhook_event[], is_active)`, `dam_webhook_deliveries(webhook_id, event, payload, attempt, status, response_code, next_attempt_at)`, signature `X-DAM-Signature: t=<ts>,v1=<hmac-sha256>`, 5 attempts over ~1 h, dead after that. OpenAPI 3.1 generated from Zod. Keep `/api/v1/*` exactly as documented in `existing-auth-and-api.md` §3.1 (paths, key transport, envelope, 12-field asset shape, ids, params, studio ids, POST writes, CORS `*`) as a shim over the new model, with a sunset date to be agreed (OPEN Q8).

### DQ11 Studios — first-class table, home studio + contributing studios, membership drives default visibility
Do: `dam_studios(code, name, city, country_code char(2), region, timezone, parent_studio_id, is_region_group, legacy_folder_names text[], sort_order, is_active)` seeded with the 15 entries of the existing vocabulary (ids kept as `code`: `australia`, `bahrain`, `bangkok`, `china`, `dubai`, `ho-chi-minh-city`, `hong-kong`, `london`, `malaysia`, `myanmar`, `new-zealand`, `philippines`, `riyadh`, `singapore`, `united-states`), Australia as `is_region_group = true` with child studios Sydney, Melbourne, Brisbane, Adelaide, Newcastle (no assets until master data assigns them). `dam_projects.studio_id` = home studio; `dam_project_studios(project_id, studio_id, role)` for contributing studios. `dam_user_studios` = membership. Default visibility (DQ3) is "projects whose home or contributing studio is one of mine"; `cross_studio_visibility` or role ≥ `editor` lifts it. Firm-wide assets (brand, marketing collateral) get an access level with `scope = firm`.

### DQ12 Soft delete, trash, retention
Do: `deleted_at`/`deleted_by` on every table (the brief's `deleted_at` plus `deleted_by` for the trash UI). All select policies filter `deleted_at is null`; a separate `…_select_trash` policy lets `studio_admin`+ see deleted rows in their scope. Restore = null the columns (children restored by the same call). `dam_retention_policies(target dam_retention_target, category_id null, days, action dam_retention_action = purge | archive)`; default trash purge after 30 days, done by the `purge_trash` job which also deletes the storage objects. `dam_tiering_rules(storage_location_from, storage_location_to, condition jsonb, is_active)` move cold versions (no usage in N days) to the archive tier; restore-on-demand enqueues a `restore_from_archive` job.

### DQ13 Employees — normalised sub-tables; expertise via the `employee` keyword namespace
Do: `dam_employees(user_id null, employee_no, first_name, last_name, preferred_name, title, studio_id, manager_id, email, phone, joined_on, left_on, years_experience_start date, is_visible_in_directory, sort_name, …)`; `dam_employee_bios(employee_id, length dam_bio_length = w25 | w50 | w150 | custom, locale, body, state dam_text_state, approved_by, approved_at)`; `dam_employee_headshots(employee_id, asset_id, kind dam_headshot_kind, is_primary, crop jsonb)`; `dam_employee_education(institution, qualification, field, country_code, completed_on)`; `dam_employee_registrations(body, registration_no, jurisdiction, issued_on, expires_on, status, evidence_asset_id)`; `dam_employee_languages(language_code, proficiency)`; sector/typology expertise = keyword links in the `employee` namespace. `dam_project_employees(project_id, employee_id, role_keyword_id null, role_title, started_on, ended_on, is_featured, sort_order)`; roles are a controlled vocabulary (keyword category "Project Role", namespace employee) with free text fallback. Org chart = `manager_id`.

### DQ14 Text blocks — versioned, approval state, scoped
Do: `dam_text_blocks(kind dam_text_block_kind, target_type null, target_id null, title, length_words int null, locale, current_version_id, tags)`; `dam_text_block_versions(text_block_id, version_no, body, state dam_text_state, submitted_by, approved_by, approved_at, change_note)`. Documents and CVs reference `text_block_version_id`, never the live body. Project descriptions at 25/50/100/150/300 words are separate `dam_text_blocks` rows with `length_words` set.

### DQ15 Share links and upload requests — hashed tokens, RPC-only anonymous access
Do: `dam_share_links(token_hash, token_prefix, scope dam_share_scope = album | selection | asset | search, album_id, saved_search_id, password_hash, expires_at, allow_download, max_size_id, watermark, require_email, view_count, last_viewed_at, revoked_at, created_by)`, `dam_share_link_items(share_link_id, asset_id, sort_order)`; `dam_upload_requests(token_hash, token_prefix, project_id, category_id, default_keyword_ids uuid[], default_rights jsonb, instructions, uploader_name, uploader_email, max_files, max_bytes, expires_at, status dam_upload_request_status)`, `dam_upload_request_files(upload_request_id, asset_id, original_filename, status)`. Tokens are 32 random bytes, stored as SHA-256; passwords as argon2id. Views are `dam_usage_events` with `share_link_id`. Anonymous readers and uploaders reach data only through SECURITY DEFINER RPCs (`dam_share_open(token, password)`, `dam_share_list_items(token)`, `dam_upload_request_open(token)`, `dam_upload_request_finalise(token, …)`) that validate token, expiry, password and revocation.

### DQ16 Rights — reusable policy + per-asset override + computed status
Do: `dam_photographers(name, company, email, website, default_copyright_holder_id, notes)`, `dam_copyright_holders(name, type, contact, notes)`, `dam_copyright_policies(name, summary, terms, permitted_uses dam_permitted_use[], territories text[] (ISO 3166 or 'WW'), duration_months, credit_required, credit_template, watermark_required, allow_external_share, allow_download_original, is_default)`, `dam_asset_rights(asset_id unique, photographer_id, copyright_holder_id, policy_id, permitted_uses override, territories override, embargo_until, expires_on, model_release dam_release_status, property_release dam_release_status, credit_line, restriction dam_rights_restriction = cleared | internal_only | restricted | do_not_use, notes)`. Status = `dam_rights_status(asset_id)` → `cleared | restricted | expiring | expired | unknown` (`expiring` = expires within 30 days [D-020]; `unknown` = no rights row or `restriction` null); materialised into `dam_asset_search.rights_status` by trigger and a nightly `rights_sweep` job (time moves status). Download rules by role are part of the permission matrix (viewer/contributor blocked on `restricted`/`expired`; editor+ warn-and-log; `global_admin`+ may override with a logged reason). Expiry alerts at 90/30/7 days to the asset's creator, the project's studio admins and global admins.

### DQ17 Ids and migration keys
uuid PKs everywhere (`gen_random_uuid()`). `dam_external_ids(target_type, target_id, system dam_external_system = openasset | dwp_dam_v1 | hubspot | bamboohr | projectworks | marq | google_drive, external_id, external_url, synced_at)`, unique `(system, external_id)` and unique `(target_type, target_id, system)`. Project code unique case-insensitively (`unique (lower(code))` via expression index); `dam_project_aliases(project_id, alias, source)` for folder-name variants and legacy codes. Importers are idempotent on `(system, external_id)`. If §10.4 = migrate, `common_dam_assets.id` is stored as `dwp_dam_v1` external id and the v1 shim resolves it; new assets get new ids.

### DQ18 Contracts, generated types, repo layout, migrations
Monorepo: `apps/web` (Next.js 15), `apps/worker` (Node worker), `packages/contracts` (Zod schemas = single source of truth for API bodies, query params and entity shapes; OpenAPI generated from them), `packages/db` (`supabase gen types typescript` output + snake↔camel mappers; hand-written types are forbidden for DB rows), `packages/storage` (StorageProvider + Drive/GCS/Supabase implementations), `packages/ai` (provider adapter). `SCHEMA.sql` is the reviewed target; it is cut into `supabase/migrations/<phase>_<n>_<name>.sql` per roadmap phase, and CI runs the offline parser/lint (`check.mjs`, `lint.mjs`) plus `supabase db reset` against a local database. Tables never use `NEXT_PUBLIC_*` config; all config is runtime, server-side.

---

## 2. Canonical table inventory (name · purpose · owning SPEC part)

### 2a — core (SPEC part 02a): projects, assets, taxonomy, fields, storage
| Table | Purpose |
|---|---|
| `dam_studios` | Studios and region groups; seeded with the 15 codes + 5 Australian children |
| `dam_clients` | Client organisations (HubSpot company link via external ids) |
| `dam_projects` | The spine: code, name, client, home studio, location (country/city/lat/lng), status, dates, size (sqm), value + currency, hero asset, description pointers, access level |
| `dam_project_aliases` | Alternate codes/names (folder-name variants, legacy codes) |
| `dam_project_studios` | Contributing studios per project |
| `dam_project_assets` | Project ↔ asset link with `rank` and `is_hero` (exactly one hero per project) |
| `dam_categories` | Asset categories (Project Photography, Renderings, Drawings, Staff, Logos & Brand, Marketing Collateral, Awards, Site Photos) with default access level and review requirement |
| `dam_keyword_categories` | Keyword trees' roots, per namespace (Space Type, Material, Time of Day, Photography Style, Sector, Project Role …) |
| `dam_keywords` | Hierarchical keywords, namespaced, materialised path |
| `dam_keyword_aliases` | Synonyms / aliases |
| `dam_keyword_links` | Polymorphic confirmed keyword ↔ target links |
| `dam_category_keyword_categories` | Which keyword categories apply (and are required) per asset category |
| `dam_field_categories` | Groups of custom fields |
| `dam_fields` | Custom field definitions (type, scope, facet, inheritable, validation) |
| `dam_field_options` | Options for single/multi-select fields |
| `dam_category_fields` | Which fields apply (and are required) per asset category |
| `dam_field_values` | Typed EAV values per (field, target) |
| `dam_storage_locations` | Configured stores and tiers (StorageProvider instances) |
| `dam_assets` | The asset record: filename, title, caption, alt text, category, current version pointer, status, access level, rating aggregates, completeness score, capture data |
| `dam_asset_versions` | Immutable file versions: object ref, hashes, dimensions, EXIF/IPTC/XMP |
| `dam_derivatives` | Generated renditions per version |
| `dam_render_cache` | Cached on-the-fly renders keyed by params hash |
| `dam_asset_search` | Denormalised search/facet row per asset |
| `dam_asset_embeddings` | pgvector columns per asset (image 1408, text 768) |
| `dam_asset_ocr_text` | OCR text per version (pages) |
| `dam_asset_duplicates` | Candidate duplicate pairs (hash/pHash) and their resolution |
| `dam_asset_crops` | Saved manual crop box per asset and aspect ratio, reused by renders and document placement |
| `dam_ingest_sources` | Watched folders / scheduled ingest configurations |
| `dam_ingest_batches` | Upload batches with the metadata applied at point of upload |
| `dam_ingest_batch_files` | One row per file in a batch: claimed object key, per-file metadata overrides, resumable session state, outcome |
| `dam_external_ids` | External / legacy identifiers per record |

### 2b — supporting (SPEC part 02b): people, collections, rights, output, governance, integration
| Table | Purpose |
|---|---|
| `dam_users` | Platform users (email from SSO, role, studios, flags, settings) |
| `dam_groups` | Named groups |
| `dam_group_members` | Group membership |
| `dam_user_studios` | User ↔ studio membership (+ optional role override) |
| `dam_access_levels` | Named access levels (min role, scope) |
| `dam_access_grants` | Access level grants to users/groups |
| `dam_api_keys` | Hashed API keys, scopes, limits |
| `dam_employees` | Staff records |
| `dam_employee_bios` | Bios at fixed lengths with approval |
| `dam_employee_headshots` | Headshot crops (asset links by kind) |
| `dam_employee_education` | Education history |
| `dam_employee_registrations` | Professional registrations/licences with expiry |
| `dam_employee_languages` | Languages |
| `dam_project_employees` | Employee ↔ project with role and date range |
| `dam_albums` | Curated collections (nested, ordered, visibility) |
| `dam_album_items` | Album membership with order and caption |
| `dam_album_collaborators` | Collaborators and their permission on an album |
| `dam_text_blocks` | Reusable copy (project descriptions, boilerplate, awards, sustainability) |
| `dam_text_block_versions` | Versions with approval state |
| `dam_photographers` | Credit records |
| `dam_copyright_holders` | Rights holders |
| `dam_copyright_policies` | Reusable licence terms |
| `dam_asset_rights` | Per-asset rights (1:1) |
| `dam_sizes` | Named output presets |
| `dam_aspect_ratios` | Named crop ratios |
| `dam_saved_searches` | Persisted queries (personal/shared) |
| `dam_share_links` | External share links |
| `dam_share_link_items` | Assets in a selection share |
| `dam_upload_requests` | External upload request links |
| `dam_upload_request_files` | Files deposited via a request |
| `dam_comments` | Comments on assets/albums/projects (threaded) |
| `dam_review_decisions` | Approval/rejection decisions on assets and albums |
| `dam_notifications` | In-app notifications (+ digest state) |
| `dam_ratings` | Star ratings per user per asset |
| `dam_favourites` | Personal favourites |
| `dam_audit_log` | Row-level audit (partitioned monthly) |
| `dam_usage_events` | Views, downloads, shares, placements (partitioned monthly) |
| `dam_search_log` | Query log incl. zero-result searches (partitioned monthly) |
| `dam_jobs` | Background job queue |
| `dam_webhooks` | Webhook subscriptions |
| `dam_webhook_deliveries` | Delivery attempts |
| `dam_integrations` | Connector configurations (HubSpot, BambooHR, ProjectWorks, Drive/Sheets, Marq, CSV) |
| `dam_integration_field_mappings` | Field mapping, direction, source of truth per field |
| `dam_sync_runs` | Sync executions with status and error log |
| `dam_sync_conflicts` | Conflicts awaiting manual resolution |
| `dam_sync_field_state` | Per-mapping, per-row sync state: last synced value, detach records that make a source-of-truth field locally editable |
| `dam_templates` | Document templates (project sheet, CV, qualification pack, deck, contact sheet) |
| `dam_template_versions` | Template versions with brand lock |
| `dam_generated_documents` | Generated outputs and their inputs |
| `dam_ai_suggestions` | AI proposals (keywords, captions, alt text, descriptions, headshot matches, crops) with confidence, model, state |
| `dam_ai_runs` | Provider calls (model, tokens, cost, latency) for analytics |
| `dam_retention_policies` | Retention/purge rules |
| `dam_tiering_rules` | Storage tiering rules |
| `dam_settings` | Firm-wide settings (key/value jsonb) |

---

## 3. Canonical enums
- `dam_role`: viewer, contributor, editor, studio_admin, global_admin, owner
- `dam_principal_type`: user, api_key, share_link, upload_request, system
- `dam_access_scope`: firm, studio, grant_only
- `dam_keyword_namespace`: asset, project, employee
- `dam_target_type`: asset, project, employee, album, text_block, client, studio
- `dam_link_source`: manual, import, ai, rule, migration
- `dam_field_type`: text, long_text, number, date, single_select, multi_select, boolean, url, currency
- `dam_field_scope`: project, asset, employee
- `dam_project_status`: prospect, active, on_hold, completed, cancelled, unverified
- `dam_asset_status`: pending, approved, published, rejected, superseded, archived
- `dam_file_kind`: image, raw_image, vector, design, video, audio, pdf, document, spreadsheet, presentation, cad, bim, model_3d, archive, other
- `dam_orientation`: landscape, portrait, square, panorama
- `dam_derivative_kind`: thumbnail, preview, proxy, poster, pdf_page, contact_sheet, placeholder
- `dam_derivative_status`: queued, ready, failed, unsupported
- `dam_storage_provider`: google_drive, gcs, s3, supabase_storage
- `dam_storage_tier`: hot, cold, archive
- `dam_rights_status`: cleared, restricted, expiring, expired, unknown
- `dam_rights_restriction`: cleared, internal_only, restricted, do_not_use
- `dam_release_status`: none, partial, full, not_applicable
- `dam_permitted_use`: web, social, print, editorial, advertising, awards, proposals, internal
- `dam_album_visibility`: personal, shared, company
- `dam_album_permission`: view, contribute, manage
- `dam_text_block_kind`: project_description, boilerplate, award, sustainability, service, sector, custom
- `dam_text_state`: draft, in_review, approved, superseded
- `dam_bio_length`: w25, w50, w150, custom
- `dam_headshot_kind`: formal, casual, black_white, other
- `dam_registration_status`: active, expired, lapsed, pending
- `dam_share_scope`: album, selection, asset, search
- `dam_upload_request_status`: open, closed, expired, revoked
- `dam_review_decision`: approved, rejected, changes_requested
- `dam_job_kind`: ingest_finalise, hash, extract_metadata, generate_derivatives, dedupe, embed, ocr, reindex_asset, reindex_project, transcode_video, render_pdf, generate_document, zip_export, send_notification, digest_email, rights_sweep, tiering_sweep, purge_trash, restore_from_archive, sync_run, webhook_deliver, ai_autotag, ai_caption, ai_describe, drive_changes_poll, create_partitions, seed_perf_data
- `dam_job_status`: queued, running, succeeded, failed, dead, cancelled
- `dam_audit_action`: insert, update, delete, restore, purge, login, download, share, permission_change
- `dam_usage_event`: view, preview, download_original, download_derivative, zip_export, share_view, share_download, placement, document_generate
- `dam_webhook_event`: asset.created, asset.updated, asset.deleted, project.created, project.updated, share.viewed, rights.expiring, rights.expired, employee.updated, album.updated
- `dam_external_system`: openasset, dwp_dam_v1, hubspot, bamboohr, projectworks, marq, google_drive
- `dam_sync_direction`: inbound, outbound, bidirectional
- `dam_conflict_policy`: source_wins, dam_wins, newest_wins, manual
- `dam_sync_run_status`: running, succeeded, partial, failed
- `dam_ai_suggestion_kind`: keyword, caption, alt_text, description, headshot_match, crop, project_match, employee_match
- `dam_suggestion_state`: suggested, accepted, rejected, expired
- `dam_ai_provider`: gemini, anthropic, vertex, voyage
- `dam_notification_kind`: share_viewed, approval_requested, approval_decided, rights_expiring, ingest_completed, comment_mention, sync_failed, job_dead
- `dam_template_kind`: project_sheet, cv, qualification_pack, credentials_deck, award_submission, contact_sheet, custom
- `dam_document_format`: pdf, docx, pptx, indd
- `dam_retention_target`: trash, audit_log, usage_events, search_log, generated_documents, render_cache
- `dam_retention_action`: purge, archive
- `dam_ingest_source_kind`: watched_folder, scheduled_walk, manual_walk

---

## 4. Cross-cutting conventions
- Every table (including join tables and append-only logs; partition children excepted) has: `id uuid primary key default gen_random_uuid()`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`, `created_by uuid references dam_users(id)`, `updated_by uuid references dam_users(id)`, `deleted_at timestamptz`, plus `deleted_by uuid` where trash UI needs it. `dam_users` self-references for created_by/updated_by (nullable).
- `updated_at` maintained by trigger `dam_set_updated_at()` on every table.
- snake_case everywhere in SQL; `dam_` prefix on tables, enums, functions, views, triggers; indexes named `<table>_<cols>_idx` (unique: `_key`); policies named `dam_<table>_<cmd>_<who>`; triggers `trg_<table>_<purpose>`.
- Timestamps `timestamptz`; dates that are calendar dates (`expires_on`, `completed_on`) are `date`. Money: `numeric(14,2)` + `currency_code char(3)`. Geo: `latitude double precision`, `longitude double precision` (PostGIS optional, commented). Country `char(2)` ISO 3166-1. Locale `text` BCP-47.
- Soft delete: select policies filter `deleted_at is null`; trash policies for `studio_admin`+.
- RLS: `ENABLE ROW LEVEL SECURITY` on every table (no FORCE, documented); deny-by-default (no policy = no access); explicit policies per command; `service_role` bypasses by design and is used only by workers and migrations.
- Search row and caches are maintained by triggers + jobs; never edited by the app.
- No secrets in any table; `config jsonb` columns hold names of secrets in Secret Manager.
- Zod schemas are the single source of truth for validation; DB types are generated.

## 5. API conventions (summary — full detail in SPEC part 4)
Base `/api/v2`; Bearer API key or session; GET/POST/PATCH/DELETE; `limit`/`cursor` (+ `offset` ≤ 10,000); `fields=`; `include=`; `filter[...]`; `q=`; `sort=`; error envelope with `request_id`; per-key rate limits with headers; `Idempotency-Key`; ETag/`If-Match`; bulk endpoints; HMAC-signed webhooks; OpenAPI 3.1 from Zod. `/api/v1` frozen as a shim (see `existing-auth-and-api.md` §3.1).

## 6. Sensible defaults seeded here (D-001…)
- **[D-001]** Page size default 50, max 200 (v2); v1 keeps 60/100.
- **[D-002]** Trash retention 30 days before purge.
- **[D-003]** Rights `expiring` window 30 days; alerts at 90/30/7 days.
- **[D-004]** Exactly one hero per project, enforced by a partial unique index on `dam_project_assets (project_id) where is_hero`.
- **[D-005]** Review queue: uploads by `contributor` land `pending`; uploads by `editor`+ land `approved`; publishing is explicit; categories can force review.
- **[D-006]** Embeddings: image 1408-d (Vertex multimodalembedding@001 or equivalent joint image-text model) and text 768-d (gemini-embedding-001 MRL) — provider is OPEN Q9; dimensions fixed here so the schema is stable.
- **[D-007]** Content hash SHA-256 (plus Drive-supplied MD5 when available); perceptual hash 64-bit dHash; near-duplicate threshold Hamming ≤ 6.
- **[D-008]** Derivatives: thumbnail 320 px, preview 1200 px, proxy 2560 px (longest edge), WebP + JPEG fallback; video poster + 1080p H.264 MP4 proxy; PDF first-page preview at 1200 px; CAD/BIM/3D/design files get a typed placeholder unless a converter is configured.
- **[D-009]** Signed derivative URLs TTL 1 hour; originals via signed URL TTL 15 minutes; both bound to path + principal type.
- **[D-010]** Keyset pagination default; total counts exact ≤ 50,000 else estimated.
- **[D-011]** Search weights A/B/C/D as DQ5; `simple` dictionary + `unaccent`; language-specific stemming deferred.
- **[D-012]** Completeness score = weighted checklist (project link 25, category 10, ≥3 keywords 20, caption 15, rights row 20, photographer 10) for assets; projects similarly (code, client, studio, location, sector, status, dates, hero, description).
- **[D-013]** Default access levels seeded: `Firm-wide` (viewer, firm), `Studio` (viewer, studio — the default for projects), `Restricted` (editor, grant_only), `Confidential` (studio_admin, grant_only).
- **[D-014]** Default categories seeded per brief §3 with `requires_review` true only for Project Photography and Staff.
- **[D-015]** Default keyword categories: asset namespace — Space Type, Material, Time of Day, Photography Style, View, Colour Mood; project namespace — Sector (3-level tree seeded from the existing 3/9/42 taxonomy), Services, Certifications, Awards; employee namespace — Sector Expertise, Typology Expertise, Project Role.
- **[D-016]** Default sizes: Web 1200, Social Square 1080, Print A4 300 dpi, Print A3 300 dpi, Presentation 1920, Original; default aspect ratios: 1:1, 4:3, 3:2, 16:9, 2:3, A-series.
- **[D-017]** Watermark default text "dwp — for review", applied for `viewer` external shares unless the share disables it and the role allows.
- **[D-018]** Job retries: 5 attempts, backoff 30 s × 2^n, visibility timeout 15 min; worker concurrency 4 per instance.
- **[D-019]** Audit on all business tables; not on `dam_asset_search`, `dam_render_cache`, `dam_jobs`, logs.
- **[D-020]** Rights status `unknown` when no rights row exists; every migrated legacy asset starts `unknown` (all legacy rows are `pending`).
- **[D-021]** Project code format is free text but unique case-insensitively; the legacy pattern `^\d{2}-\d{4,5}$` is recognised by filename/folder intelligence.
- **[D-022]** Upload chunk size 8 MiB, resumable via provider protocol (Drive 308 / GCS resumable); sessions persist in `dam_ingest_batches` so a reload resumes.
- **[D-023]** ZIP exports capped at 2 GiB or 500 files per request; larger runs are jobs with a signed download link.
- **[D-024]** Analytics dashboards read from `dam_usage_events`, `dam_search_log`, `dam_audit_log` via nightly materialised views (`dam_mv_*`, refreshed by job).
- **[D-025]** Map view uses project `latitude/longitude`; geocoding of city/country is a job through a pluggable geocoder (Google Geocoding by default).

## 7. OPEN decisions (never write as decided)
- **§10.1 Storage of originals**: (a) Google Drive originals + Supabase Storage derivatives (Phase 1 default because the 34k-asset corpus is already there; inherits the 400k-items-per-Shared-Drive ceiling, the 750 GB/day per-account upload cap, hours-scale listing lag, proxy-everything egress); (b) GCS in `asia-southeast3` + Cloud CDN signed URLs, Drive kept as an ingest source; (c) Supabase Storage for everything. Recommendation: (b) as the target, (a) as the Phase 1 default behind `StorageProvider`. Schema is neutral (`storage_location_id` per version).
- **§10.2 RFP / proposal AI module**: build inside the DAM (Phase 11) vs separate application consuming the API. Recommendation: separate application on the v2 API; the DAM ships text blocks, approved imagery, employee data and the conversational query it would need. Schema impact if built in: `dam_rfp_documents`, `dam_rfp_requirements`, `dam_rfp_responses` (not in this inventory).
- **§10.3 Permission matrix**: SPEC part 3 proposes the full matrix; the user confirms or edits. Schema impact: none (roles are an enum; capabilities are code + policies).
- **§10.4 Migrate the existing dwp-dam or clean rebuild**: (a) migrate — run the mapping in `existing-schema-and-types.md` §9 (34,437 rows, Drive files stay put, v1 ids preserved as external ids, v1 shim on the same origin); (b) clean rebuild — new library, old app retired after consumers move. Recommendation: (a) with a reconciling Drive walk, because four consumer sites depend on ids and URLs. Roadmap gates Phase 1 storage adapter and Phase 9 importer on it.
- **§10.5 Target scale**: assumptions used until answered — 500,000 assets and 5,000 projects in three years (brief §4.11), 35,000 assets / ~2,000 projects / ~600 employees at go-live, 150 concurrent users peak. Index and partition design assumes these.
- **Q6 Design system**: brief §2 (paper/ink/blueprint blue; Fraunces + Montserrat + JetBrains Mono) vs the fleet dwp.intelligence UI Standard v1.3 (eight warm tokens, one sans face, 6 px radius, no shadows) that dwp-dam was migrated to on 2026-09-07 — brief §2 is literally dwp-dam's original palette that was replaced twice by user decision. Recommendation: fleet standard, with "dense, information-first" as a layout rule; record a monospace exception for codes/EXIF if wanted.
- **Q7 Identity plumbing**: broker SSO + server-minted Supabase JWT (default, DQ4) vs Supabase Auth Google provider. Recommendation: default; revisit if the broker gains role claims or SCIM.
- **Q8 `/api/v1` compatibility**: keep the shim indefinitely vs announce a sunset (recommend 12 months after v2 GA) and migrate the four consumer sites.
- **Q9 Embedding provider**: Vertex AI multimodal embeddings (GCP ADC, joint image-text 1408-d) vs Voyage multimodal (1024-d, third vendor); Gemini's API-key endpoint offers text-only embeddings and Anthropic offers none. Recommendation: Vertex (same GCP project). Dimension change = full re-embed.
- **Q10 App name and its relation to "Digital Assets"**: if §10.4 = clean rebuild coexisting with dwp-dam, the new app needs a distinct two-word Title Case fleet name.

## 8. Facts writers must not get wrong
- Existing table is `common_dam_assets` (not `dam_assets`): 16 columns, RLS off, anon key writes; 34,437 rows / 1,707 folder paths (2026-09-07); `publish_permission` is 100% `pending`; tags are a flat lower-cased `text[]`; taxonomy 3/9/42; 15 studio codes with per-studio counts in `existing-schema-and-types.md` §5; folder convention `dwp_Digital_Asset/<collection>/<LOCATION>/<project>/…`.
- Broker SSO: HS256 `dwp_session`, claims `email/role/name/picture/exp/app_id`, `role` always `viewer`, server-side id_token exchange, 401 JSON (never 307) for internal APIs, matcher exclusions listed in `existing-auth-and-api.md` §1.6; `x-dwp-*` headers spoofable on excluded paths.
- v1 contract: 16 endpoints, `x-api-key`/`?key=`, `DAM_API_KEYS name:key:scopes`, envelope `{data, meta}` / `{error:{code,message}}`, 12-field asset shape, `limit` 60/100, four consumers (dwp_website2026, proposal-maker, dwp-marketing-hub, studioai).
- Drive: whole-drive `files.list` with `q` lags by hours (measured 2026-09-04); Changes API and parent-scoped listings are consistent; `thumbnailLink` expires within hours and is forbidden to Slides; resumable sessions exist but the browser PUTs in one request today; Cloud Run body cap 32 MiB; SA must be Content Manager on each Shared Drive; no move primitive today.
- Deployment: project `dwp2026`, region `asia-southeast3`, env delivered by `--env-vars-file` from two hand-maintained lists (deploy.ps1 and set-env.ps1); the Docker builder gets no build args so `NEXT_PUBLIC_*` is unusable; the user runs every deploy.
- AI today: Gemini only (`gemini-3.7-flash` default), thinking-config dialect ladder, sharp re-encode to ≤1568 px JPEG, small-enum rule (≤60 enum values in response schemas), auto-tag writes directly (the brief forbids this going forward), no embeddings/OCR/captions.
- UI: fleet standard tokens bg #F7F7F5, surface #FFFFFF, text #2C2C2A, muted #5F5E5A, accent #A5680F, border #D9D7CE, on-accent #FFFFFF, danger #7E2B25; type 12/14/16/20/24; weights 400/500; radius 6 px; no shadows except menus.

## 9. OpenAsset reference (from memory — verify before relying on any single detail; mark [memory] in the SPEC)
- REST base `https://<tenant>.openasset.com/REST/1/`; JSON; integer ids; auth via `Authorization: OATU <username>:<token>` header (API tokens per user) or a session cookie.
- Resources: `Files`, `Projects`, `Employees`, `Albums`, `Categories`, `Keywords`, `KeywordCategories`, `ProjectKeywords`, `ProjectKeywordCategories`, `EmployeeKeywords`, `EmployeeKeywordCategories`, `Fields`, `Sizes`, `AspectRatios`, `Photographers`, `CopyrightHolders`, `CopyrightPolicies`, `Searches`, `Users`, `Groups`, `AccessLevels`, `TextRewrites`, `AlternateStores`, `DataIntegrations`, `Ranks`/`ProjectFiles` (hero and rank per project-file link).
- Query idioms: `limit` and `offset` (default 10, max ~ 1000 varies); `displayFields=id,filename,…` (sparse fieldsets); `orderBy=created,uploaded`; `textMatching=exact|contains|startsWith` combined with a field filter such as `?filename=lobby`; filter by relation `?projects=18` or nested `/Projects/18/Files`; `?sizes=all` or `/Files/{id}/Sizes` returns rendition URLs (`http_root` + `http_relative_path`) per Size; `?keywords=all`, `?fields=all` embed related data.
- `Files` fields: `id, filename, original_filename, category_id, project_id, uploaded, created, updated, rank, description, caption, alternative_text, md5_at_upload, photographer_id, copyright_holder_id, access_level, rotation_since_upload, user_id, contains_video, duration, download_count, sizes[], keywords[], fields[], albums[]`.
- `Projects` fields: `id, code, name, alive, created, updated, hero_image_id, keywords[], fields[]` with firm-defined Fields for client, location, size, value, status, dates (fields are dynamic, addressed by `field_id` and `rest_code`).
- `Employees`: `id, first_name, last_name, employee_number, hero_image_id, alive, projects[] (with roles and dates via ProjectEmployees), keywords[], fields[]`; `TextRewrites` hold rewritten text per length; `Sizes` have `width, height, dpi, file_format, colourspace, watermarked, crop_aspect_ratio_id`.
- No bulk export endpoint: the importer pages every resource through the API and downloads originals from the `original` Size URL; rate limits are per tenant and undocumented — importer must be resumable and throttled.
- Shred (OpenAsset's proposal AI) parses RFP documents, extracts requirements and drafts responses from DAM content — the scope the brief's §4.10 stretch item mirrors.
