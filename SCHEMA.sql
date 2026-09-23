-- ===========================================================================
-- SCHEMA.sql — Project-Based DAM (OpenAsset-equivalent)
-- ===========================================================================
-- Status: PROPOSAL. This file has NOT been applied to any database, and it is
-- not a migration. It is the reviewed target schema that accompanies SPEC.md;
-- once reviewed it is cut into forward-only numbered migrations, one set per
-- roadmap phase (SPEC §6.14).
--
-- Target:      PostgreSQL 15+ on Supabase.
-- Companions:  SPEC.md (the specification this transcribes), ROADMAP.md.
--
-- Contents, in the order they must be applied:
--   0. Extensions, enum types, helper and trigger functions
--   1. Core tables       — projects, assets, taxonomy, fields, storage
--   2. Supporting tables — people, collections, rights, output, governance,
--                          integration, and the partitioned log tables
--   3. Indexes           — including the search-row plan and the vector indexes
--   4. Row-level security, triggers and reference data
--
-- Conventions (brief §6), enforced by the checks below:
--   * every table is prefixed `dam_` and named in snake_case;
--   * every table carries id, created_at, updated_at, created_by, updated_by
--     and deleted_at, plus deleted_by where a trash screen needs it;
--   * row-level security is enabled on every table and access is denied by
--     default — a command with no policy cannot be performed;
--   * no secret value appears anywhere in this file; configuration columns hold
--     the NAMES of secrets held in Secret Manager.
--
-- The one documented exception to the standard columns is `dam_asset_search`,
-- whose primary key is `asset_id` and which omits `id`, `updated_by` and
-- `deleted_by`: it is a 1:1 derived index row, not a business record, and the
-- permission helpers address it by the asset it describes.
--
-- Validation performed on this file before it was handed over:
--   * parsed in full with the PostgreSQL grammar (libpg-query, PG17), offline;
--   * structural lint for the conventions above;
--   * every policy and index column resolved against the real parse tree;
--   * every table, column and enum value cross-checked against SPEC.md.
-- No database was contacted at any point.
-- ===========================================================================


-- ===========================================================================
-- SECTION 0 — Extensions, enum types and shared functions
-- ===========================================================================
-- Target: PostgreSQL 15+ on Supabase.
--
-- Helper functions here are declared BEFORE the tables they read. That is
-- legal because every one of them is `language plpgsql`: a plpgsql body is
-- parsed at definition time but its table references are resolved on first
-- execution. A `language sql` body would be validated immediately and would
-- fail. Do not "simplify" these to SQL functions.
--
-- Every function that a policy calls is STABLE (so the planner may cache it
-- within a statement) and SECURITY DEFINER with an explicit search_path (so a
-- caller cannot shadow a table name and so the function can read rows the
-- caller itself cannot). SECURITY DEFINER without `SET search_path` is a
-- privilege-escalation bug, not a style choice.
-- ===========================================================================

-- --- extensions ------------------------------------------------------------

-- gen_random_uuid() for every primary key.
create extension if not exists pgcrypto;
-- Trigram GIN indexes for filename, title and project-code fragment search.
create extension if not exists pg_trgm;
-- Accent-insensitive matching for names entered with and without diacritics.
create extension if not exists unaccent;
-- pgvector: image and text embeddings, HNSW cosine indexes (SPEC part 2, 2.24).
create extension if not exists vector;
-- Scheduling for the sweeps in SPEC 6.5.2. Where the Supabase plan does not
-- offer pg_cron, Cloud Scheduler calls the worker instead and this is omitted.
create extension if not exists pg_cron;
-- PostGIS is deliberately NOT enabled. Project geography is a latitude and a
-- longitude used for a map view and a radius filter; that does not justify the
-- extension. Enable it only if geospatial queries become a real requirement:
-- create extension if not exists postgis;

-- --- schema resolution ------------------------------------------------------
-- Supabase installs extensions into the `extensions` schema, not `public`.
-- Three things in this file are resolved when the statement is CREATED, against
-- the session search path, not when it is later executed:
--
--   * the `vector(1408)` / `vector(768)` column types (2.24);
--   * the `gin_trgm_ops`, `jsonb_path_ops` and `vector_cosine_ops` operator
--     classes used by the GIN and HNSW indexes;
--   * the `'unaccent'::regdictionary` cast inside dam_unaccent().
--
-- If the session path is only `public`, each of those fails with "type does not
-- exist" or "operator class does not exist" even though the extension is
-- installed. Setting the path explicitly costs nothing and removes the whole
-- class of failure. `public` stays first, so every table below is still created
-- in `public`.
set search_path = public, extensions, pg_catalog;

-- --- enum types ------------------------------------------------------------
-- These are the canonical vocabularies. A closed vocabulary that exists on
-- exactly one table is a text column with a CHECK constraint instead, so this
-- list stays the single place where a shared vocabulary is defined.

-- Identity and access
create type dam_role as enum ('viewer', 'contributor', 'editor', 'studio_admin', 'global_admin', 'owner');
create type dam_principal_type as enum ('user', 'api_key', 'share_link', 'upload_request', 'system');
create type dam_access_scope as enum ('firm', 'studio', 'grant_only');

-- Taxonomy and metadata
create type dam_keyword_namespace as enum ('asset', 'project', 'employee');
create type dam_target_type as enum ('asset', 'project', 'employee', 'album', 'text_block', 'client', 'studio');
create type dam_link_source as enum ('manual', 'import', 'ai', 'rule', 'migration');
create type dam_field_type as enum ('text', 'long_text', 'number', 'date', 'single_select', 'multi_select', 'boolean', 'url', 'currency');
create type dam_field_scope as enum ('project', 'asset', 'employee');

-- Projects and assets
create type dam_project_status as enum ('prospect', 'active', 'on_hold', 'completed', 'cancelled', 'unverified');
create type dam_asset_status as enum ('pending', 'approved', 'published', 'rejected', 'superseded', 'archived');
create type dam_file_kind as enum ('image', 'raw_image', 'vector', 'design', 'video', 'audio', 'pdf', 'document', 'spreadsheet', 'presentation', 'cad', 'bim', 'model_3d', 'archive', 'other');
create type dam_orientation as enum ('landscape', 'portrait', 'square', 'panorama');

-- Storage and derivatives
create type dam_derivative_kind as enum ('thumbnail', 'preview', 'proxy', 'poster', 'pdf_page', 'contact_sheet', 'placeholder');
create type dam_derivative_status as enum ('queued', 'ready', 'failed', 'unsupported');
create type dam_storage_provider as enum ('google_drive', 'gcs', 's3', 'supabase_storage');
create type dam_storage_tier as enum ('hot', 'cold', 'archive');

-- Rights
create type dam_rights_status as enum ('cleared', 'restricted', 'expiring', 'expired', 'unknown');
create type dam_rights_restriction as enum ('cleared', 'internal_only', 'restricted', 'do_not_use');
create type dam_release_status as enum ('none', 'partial', 'full', 'not_applicable');
create type dam_permitted_use as enum ('web', 'social', 'print', 'editorial', 'advertising', 'awards', 'proposals', 'internal');

-- Collections and copy
create type dam_album_visibility as enum ('personal', 'shared', 'company');
create type dam_album_permission as enum ('view', 'contribute', 'manage');
create type dam_text_block_kind as enum ('project_description', 'boilerplate', 'award', 'sustainability', 'service', 'sector', 'custom');
create type dam_text_state as enum ('draft', 'in_review', 'approved', 'superseded');

-- People
create type dam_bio_length as enum ('w25', 'w50', 'w150', 'custom');
create type dam_headshot_kind as enum ('formal', 'casual', 'black_white', 'other');
create type dam_registration_status as enum ('active', 'expired', 'lapsed', 'pending');

-- Sharing and collaboration
create type dam_share_scope as enum ('album', 'selection', 'asset', 'search');
create type dam_upload_request_status as enum ('open', 'closed', 'expired', 'revoked');
create type dam_review_decision as enum ('approved', 'rejected', 'changes_requested');
-- 'hero_cleared' exists because losing a project's hero (the asset was deleted,
-- unlinked or superseded) tells somebody rather than blocking the operation.
create type dam_notification_kind as enum ('share_viewed', 'approval_requested', 'approval_decided', 'rights_expiring', 'ingest_completed', 'comment_mention', 'sync_failed', 'job_dead', 'hero_cleared', 'api_key_expiring');

-- Jobs
create type dam_job_kind as enum (
  'ingest_finalise', 'hash', 'extract_metadata', 'generate_derivatives', 'dedupe', 'embed', 'ocr',
  'reindex_asset', 'reindex_project', 'transcode_video', 'render_pdf', 'render_on_demand',
  'generate_document', 'zip_export', 'send_notification', 'digest_email', 'rights_sweep',
  'tiering_sweep', 'purge_trash', 'purge_render_cache', 'restore_from_archive', 'sync_run',
  'webhook_deliver', 'ai_autotag', 'ai_caption', 'ai_describe', 'drive_changes_poll',
  'create_partitions', 'seed_perf_data', 'reconcile_storage',
  -- A folder-tree ingest walk and a large bulk edit are both long enough to be
  -- jobs with progress rather than requests (SPEC parts 2a and 5).
  'ingest_walk', 'bulk_edit');
create type dam_job_status as enum ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled');

-- Governance
create type dam_audit_action as enum ('insert', 'update', 'delete', 'restore', 'purge', 'login', 'download', 'share', 'permission_change');
create type dam_usage_event as enum ('view', 'preview', 'download_original', 'download_derivative', 'zip_export', 'share_view', 'share_download', 'placement', 'document_generate');
-- 'webhook_deliveries' and 'ai_runs' are retention targets like the rest: both
-- grow without bound and both were being pruned by ad-hoc settings instead of
-- by a policy row, which put two retention rules in two different places.
create type dam_retention_target as enum ('trash', 'audit_log', 'usage_events', 'search_log', 'generated_documents', 'render_cache', 'webhook_deliveries', 'ai_runs', 'jobs');
create type dam_retention_action as enum ('purge', 'archive');

-- Integration
create type dam_webhook_event as enum ('asset.created', 'asset.updated', 'asset.deleted', 'project.created', 'project.updated', 'share.viewed', 'rights.expiring', 'rights.expired', 'employee.updated', 'album.updated');
create type dam_external_system as enum ('openasset', 'dwp_dam_v1', 'hubspot', 'bamboohr', 'projectworks', 'marq', 'google_drive');
create type dam_sync_direction as enum ('inbound', 'outbound', 'bidirectional');
create type dam_conflict_policy as enum ('source_wins', 'dam_wins', 'newest_wins', 'manual');
create type dam_sync_run_status as enum ('running', 'succeeded', 'partial', 'failed');
create type dam_ingest_source_kind as enum ('watched_folder', 'scheduled_walk', 'manual_walk');

-- Output
create type dam_template_kind as enum ('project_sheet', 'cv', 'qualification_pack', 'credentials_deck', 'award_submission', 'contact_sheet', 'custom');
create type dam_document_format as enum ('pdf', 'docx', 'pptx', 'indd');

-- AI
create type dam_ai_suggestion_kind as enum ('keyword', 'caption', 'alt_text', 'description', 'headshot_match', 'crop', 'project_match', 'employee_match');
create type dam_suggestion_state as enum ('suggested', 'accepted', 'rejected', 'expired');
create type dam_ai_provider as enum ('gemini', 'anthropic', 'vertex', 'voyage');

-- ===========================================================================
-- Text normalisation
-- ===========================================================================

-- Accent-folding wrapper used by the generated tsvector columns
-- (dam_asset_ocr_text.ocr_tsv, dam_asset_search.search_tsv) and by the
-- sort-name triggers.
--
-- Why a wrapper rather than calling unaccent() directly: the ONE-argument
-- unaccent(text) is STABLE, because it resolves the dictionary through the
-- search path at call time, and PostgreSQL refuses a STABLE function inside a
-- generated column. The TWO-argument unaccent(regdictionary, text) is
-- IMMUTABLE, because the dictionary is pinned by the argument. So this wrapper
-- pins the dictionary and is honestly immutable.
--
-- The cast 'unaccent'::regdictionary resolves at definition time against the
-- search path set below. On Supabase the extension installs into `extensions`,
-- which is why that schema is named explicitly — without it the cast fails at
-- creation with "text search dictionary \"unaccent\" does not exist".
create or replace function dam_unaccent(p_text text)
returns text
language sql
immutable
parallel safe
strict
set search_path = public, extensions, pg_catalog
as $$
  select unaccent('unaccent'::regdictionary, p_text)
$$;

comment on function dam_unaccent(text) is
  'Immutable accent folding. Pins the unaccent dictionary so the result may be used in generated columns and expression indexes.';

-- ===========================================================================
-- Shared trigger functions
-- ===========================================================================

-- Keeps updated_at honest and makes the creation columns immutable. Applied to
-- every table as trg_<table>_updated_at.
create or replace function dam_set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  -- A client that sends created_at/created_by on an update is either confused
  -- or malicious; either way the original values win.
  new.created_at := old.created_at;
  new.created_by := old.created_by;
  return new;
end;
$$;

comment on function dam_set_updated_at() is
  'BEFORE UPDATE trigger: stamps updated_at and preserves created_at/created_by.';

-- ===========================================================================
-- Identity helpers
-- ===========================================================================
-- The request's principal arrives in the JWT the web service mints after it has
-- authenticated the caller (SPEC part 3). Claims used here:
--   sub          dam_users.id
--   dam_role     the caller's role, already resolved (never the broker's claim)
--   studio_ids   array of studio uuids the caller belongs to
--   cross_studio boolean
--   principal    dam_principal_type
-- A worker connecting with the service role has no claims and bypasses RLS.

create or replace function dam_jwt_claims()
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  -- current_setting(..., true) returns null rather than raising when unset,
  -- which is the case for a service-role connection and for migrations.
  return coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
exception
  when others then
    -- A malformed claims string must not take down every policy on the server.
    return '{}'::jsonb;
end;
$$;

create or replace function dam_current_user_id()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub text;
begin
  v_sub := dam_jwt_claims() ->> 'sub';
  if v_sub is null or v_sub = '' then
    return null;
  end if;
  return v_sub::uuid;
exception
  when invalid_text_representation then
    return null;
end;
$$;

comment on function dam_current_user_id() is
  'dam_users.id of the calling principal, or null for an unauthenticated or service-role connection.';

create or replace function dam_current_principal_type()
returns dam_principal_type
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v text;
begin
  v := dam_jwt_claims() ->> 'principal';
  if v is null then
    return 'system'::dam_principal_type;
  end if;
  return v::dam_principal_type;
exception
  when invalid_text_representation then
    return 'system'::dam_principal_type;
end;
$$;

-- The role is read from the claim, then verified against the row. The claim
-- alone is not trusted for privilege escalation: a token minted before a
-- demotion must not outlive it.
create or replace function dam_current_role()
returns dam_role
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_role dam_role;
begin
  v_id := dam_current_user_id();
  if v_id is null then
    return null;
  end if;
  select u.role into v_role
    from dam_users u
   where u.id = v_id
     and u.is_active
     and u.deleted_at is null;
  return v_role;
end;
$$;

comment on function dam_current_role() is
  'Role of the calling user, read from dam_users (not from the token) so a demotion takes effect immediately.';

create or replace function dam_is_at_least(p_role dam_role)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role dam_role;
begin
  v_role := dam_current_role();
  if v_role is null then
    return false;
  end if;
  -- Enum comparison follows declaration order: viewer < contributor < editor
  -- < studio_admin < global_admin < owner.
  return v_role >= p_role;
end;
$$;

create or replace function dam_is_global_admin()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return dam_is_at_least('global_admin'::dam_role);
end;
$$;

-- Studios the caller belongs to, including the children of any region group so
-- that membership of "Australia" implies its five offices.
create or replace function dam_current_studio_ids()
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_ids uuid[];
begin
  v_id := dam_current_user_id();
  if v_id is null then
    return array[]::uuid[];
  end if;
  select coalesce(array_agg(distinct s.id), array[]::uuid[])
    into v_ids
    from dam_user_studios us
    join dam_studios s
      on s.id = us.studio_id
      or s.parent_studio_id = us.studio_id
   where us.user_id = v_id
     and us.deleted_at is null
     and s.deleted_at is null;
  return v_ids;
end;
$$;

create or replace function dam_has_cross_studio()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_cross boolean;
begin
  v_id := dam_current_user_id();
  if v_id is null then
    return false;
  end if;
  select u.cross_studio_visibility into v_cross
    from dam_users u
   where u.id = v_id
     and u.deleted_at is null;
  return coalesce(v_cross, false);
end;
$$;

-- Does the caller administer this studio? True for a global admin, for a user
-- whose membership carries a studio_admin override, and for a studio_admin who
-- is a member of the studio (or of its parent region group).
create or replace function dam_can_manage_studio(p_studio_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if dam_is_global_admin() then
    return true;
  end if;
  if p_studio_id is null then
    return false;
  end if;
  return exists (
    select 1
      from dam_user_studios us
      join dam_studios s
        on s.id = us.studio_id
        or s.parent_studio_id = us.studio_id
     where us.user_id = dam_current_user_id()
       and s.id = p_studio_id
       and us.deleted_at is null
       and coalesce(us.role_override, dam_current_role()) >= 'studio_admin'::dam_role
  );
end;
$$;

-- ===========================================================================
-- Access-level evaluation
-- ===========================================================================
-- An access level answers "who may see rows carrying it": a minimum role, a
-- scope (firm-wide, the owning studio only, or nobody except named grants), and
-- an optional set of explicit grants to users and groups.

create or replace function dam_access_level_allows(p_level_id uuid, p_owner_studio_ids uuid[])
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_level record;
  v_user uuid;
  v_studios uuid[];
begin
  if dam_is_global_admin() then
    return true;
  end if;
  v_user := dam_current_user_id();
  if v_user is null then
    return false;   -- deny by default: anonymous access is via RPC only
  end if;

  select al.min_role, al.scope
    into v_level
    from dam_access_levels al
   where al.id = p_level_id
     and al.deleted_at is null;

  if not found then
    return false;   -- an unknown level is a closed level
  end if;

  if dam_current_role() < v_level.min_role then
    -- An explicit grant can still open a level the caller's role would not.
    return exists (
      select 1
        from dam_access_grants g
        left join dam_group_members gm
          on gm.group_id = g.group_id
         and gm.user_id = v_user
         and gm.deleted_at is null
       where g.access_level_id = p_level_id
         and g.deleted_at is null
         and (g.expires_at is null or g.expires_at > now())
         and (g.user_id = v_user or gm.user_id is not null)
    );
  end if;

  if v_level.scope = 'firm' then
    return true;
  end if;

  if v_level.scope = 'studio' then
    if dam_has_cross_studio() then
      return true;
    end if;
    v_studios := dam_current_studio_ids();
    -- A row with no owning studio (firm-wide brand material, an unassigned
    -- import) is visible to any signed-in user at or above the minimum role.
    if p_owner_studio_ids is null or cardinality(p_owner_studio_ids) = 0 then
      return true;
    end if;
    return p_owner_studio_ids && v_studios;
  end if;

  -- scope = 'grant_only'
  return exists (
    select 1
      from dam_access_grants g
      left join dam_group_members gm
        on gm.group_id = g.group_id
       and gm.user_id = v_user
       and gm.deleted_at is null
     where g.access_level_id = p_level_id
       and g.deleted_at is null
       and (g.expires_at is null or g.expires_at > now())
       and (g.user_id = v_user or gm.user_id is not null)
  );
end;
$$;

comment on function dam_access_level_allows(uuid, uuid[]) is
  'Core visibility predicate: role floor, studio scope (with cross-studio override) and explicit grants.';

-- ===========================================================================
-- Project, asset and related predicates used by policies
-- ===========================================================================

create or replace function dam_can_read_project(p_project_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_level uuid;
  v_studios uuid[];
  v_created_by uuid;
  v_deleted timestamptz;
begin
  if p_project_id is null then
    return false;
  end if;
  if dam_is_global_admin() then
    return true;
  end if;

  select p.access_level_id, p.created_by, p.deleted_at,
         array_remove(array[p.studio_id] || coalesce(
           (select array_agg(ps.studio_id)
              from dam_project_studios ps
             where ps.project_id = p.id
               and ps.deleted_at is null), array[]::uuid[]), null)
    into v_level, v_created_by, v_deleted, v_studios
    from dam_projects p
   where p.id = p_project_id;

  if not found or v_deleted is not null then
    return false;
  end if;

  return dam_access_level_allows(v_level, v_studios)
      or v_created_by = dam_current_user_id();
end;
$$;

create or replace function dam_can_write_project(p_project_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_studio uuid;
begin
  if not dam_can_read_project(p_project_id) then
    return false;
  end if;
  if dam_is_at_least('editor'::dam_role) then
    return true;
  end if;
  select p.studio_id into v_studio from dam_projects p where p.id = p_project_id;
  return dam_can_manage_studio(v_studio);
end;
$$;

create or replace function dam_can_read_category(p_category_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_level uuid;
begin
  if p_category_id is null then
    return true;   -- an asset with no category is governed by its own level
  end if;
  if dam_is_global_admin() then
    return true;
  end if;
  select c.access_level_id into v_level
    from dam_categories c
   where c.id = p_category_id
     and c.deleted_at is null;
  if not found then
    return false;
  end if;
  return dam_access_level_allows(v_level, null);
end;
$$;

-- Asset visibility: the asset's own level if it has one, otherwise the level of
-- any project it belongs to, otherwise its category's level. Unpublished assets
-- are visible to their creator and to editors and above.
create or replace function dam_can_read_asset(p_asset_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_asset record;
  v_studios uuid[];
  v_project_ok boolean;
begin
  if p_asset_id is null then
    return false;
  end if;
  if dam_is_global_admin() then
    return true;
  end if;

  select a.access_level_id, a.category_id, a.status, a.created_by, a.deleted_at
    into v_asset
    from dam_assets a
   where a.id = p_asset_id;

  if not found or v_asset.deleted_at is not null then
    return false;
  end if;

  if v_asset.status in ('pending', 'rejected')
     and v_asset.created_by is distinct from dam_current_user_id()
     and not dam_is_at_least('editor'::dam_role) then
    return false;
  end if;

  if v_asset.access_level_id is not null then
    select coalesce(array_agg(distinct p.studio_id), array[]::uuid[])
      into v_studios
      from dam_project_assets pa
      join dam_projects p on p.id = pa.project_id and p.deleted_at is null
     where pa.asset_id = p_asset_id
       and pa.deleted_at is null;
    return dam_access_level_allows(v_asset.access_level_id, v_studios);
  end if;

  -- Inherit from any linked project the caller can read.
  select exists (
    select 1
      from dam_project_assets pa
     where pa.asset_id = p_asset_id
       and pa.deleted_at is null
       and dam_can_read_project(pa.project_id)
  ) into v_project_ok;

  if v_project_ok then
    return true;
  end if;

  -- No project link: fall back to the category.
  if exists (select 1 from dam_project_assets pa
              where pa.asset_id = p_asset_id and pa.deleted_at is null) then
    return false;   -- it has projects, none readable
  end if;

  return dam_can_read_category(v_asset.category_id)
      or v_asset.created_by = dam_current_user_id();
end;
$$;

create or replace function dam_can_write_asset(p_asset_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_created_by uuid;
begin
  if not dam_can_read_asset(p_asset_id) then
    return false;
  end if;
  if dam_is_at_least('editor'::dam_role) then
    return true;
  end if;
  select a.created_by into v_created_by from dam_assets a where a.id = p_asset_id;
  -- A contributor may edit what they uploaded; a viewer may edit nothing.
  return dam_is_at_least('contributor'::dam_role)
     and v_created_by = dam_current_user_id();
end;
$$;

create or replace function dam_can_read_album(p_album_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_album record;
begin
  if p_album_id is null then
    return false;
  end if;
  if dam_is_global_admin() then
    return true;
  end if;
  select a.visibility, a.owner_id, a.deleted_at
    into v_album
    from dam_albums a
   where a.id = p_album_id;
  if not found or v_album.deleted_at is not null then
    return false;
  end if;
  if v_album.owner_id = dam_current_user_id() then
    return true;
  end if;
  if v_album.visibility = 'company' then
    return dam_current_user_id() is not null;
  end if;
  if v_album.visibility = 'shared' then
    -- A collaborator row names either a user or a group, so group membership
    -- has to be resolved here as well.
    return exists (
      select 1
        from dam_album_collaborators c
        left join dam_group_members gm
          on gm.group_id = c.group_id
         and gm.user_id = dam_current_user_id()
         and gm.deleted_at is null
       where c.album_id = p_album_id
         and c.deleted_at is null
         and (c.user_id = dam_current_user_id() or gm.user_id is not null));
  end if;
  return false;   -- personal, and the caller is not the owner
end;
$$;

create or replace function dam_can_read_employee(p_employee_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_visible boolean;
  v_deleted timestamptz;
begin
  if p_employee_id is null then
    return false;
  end if;
  select e.is_visible_in_directory, e.deleted_at
    into v_visible, v_deleted
    from dam_employees e
   where e.id = p_employee_id;
  if not found or v_deleted is not null then
    return false;
  end if;
  -- The staff directory is firm-wide by design: a bid team in one studio must
  -- be able to find credentials held in another.
  return dam_current_user_id() is not null
     and (v_visible or dam_is_at_least('editor'::dam_role));
end;
$$;

-- ===========================================================================
-- Rights status
-- ===========================================================================
-- Status is a function of the stored restriction and of TIME, which is why it
-- is computed rather than stored as the source of truth. It is materialised
-- into dam_asset_search by trigger and refreshed nightly by the rights sweep.

create or replace function dam_rights_status(p_asset_id uuid)
returns dam_rights_status
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_expiring_days int := 30;   -- SPEC default D-003
begin
  select ar.restriction, ar.expires_on, ar.embargo_until
    into r
    from dam_asset_rights ar
   where ar.asset_id = p_asset_id
     and ar.deleted_at is null;

  if not found or r.restriction is null then
    return 'unknown'::dam_rights_status;
  end if;
  if r.restriction in ('restricted', 'do_not_use', 'internal_only') then
    return 'restricted'::dam_rights_status;
  end if;
  if r.expires_on is not null and r.expires_on < current_date then
    return 'expired'::dam_rights_status;
  end if;
  if r.embargo_until is not null and r.embargo_until > now() then
    return 'restricted'::dam_rights_status;
  end if;
  if r.expires_on is not null
     and r.expires_on <= current_date + v_expiring_days then
    return 'expiring'::dam_rights_status;
  end if;
  return 'cleared'::dam_rights_status;
end;
$$;

-- ===========================================================================
-- Polymorphic target integrity
-- ===========================================================================
-- dam_keyword_links, dam_field_values and dam_external_ids address rows by
-- (target_type, target_id) and therefore cannot carry a foreign key. This
-- trigger is the substitute: it refuses a link to a row that does not exist or
-- is soft-deleted, and it checks that a keyword's namespace matches its target.

create or replace function dam_assert_target_exists()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_exists boolean;
begin
  execute format(
    'select exists (select 1 from %I where id = $1 and deleted_at is null)',
    case new.target_type
      when 'asset'      then 'dam_assets'
      when 'project'    then 'dam_projects'
      when 'employee'   then 'dam_employees'
      when 'album'      then 'dam_albums'
      when 'text_block' then 'dam_text_blocks'
      when 'client'     then 'dam_clients'
      when 'studio'     then 'dam_studios'
    end)
  into v_exists
  using new.target_id;

  if not v_exists then
    raise exception 'dam: % % does not exist or is deleted',
      new.target_type, new.target_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

create or replace function dam_assert_keyword_namespace()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_ns dam_keyword_namespace;
begin
  select k.namespace into v_ns from dam_keywords k where k.id = new.keyword_id;
  if v_ns is null then
    raise exception 'dam: keyword % does not exist', new.keyword_id
      using errcode = 'foreign_key_violation';
  end if;
  -- asset keywords tag assets, project keywords tag projects, employee
  -- keywords tag employees. Anything else is a taxonomy leak.
  if (v_ns = 'asset'    and new.target_type <> 'asset')
  or (v_ns = 'project'  and new.target_type <> 'project')
  or (v_ns = 'employee' and new.target_type <> 'employee') then
    raise exception 'dam: % keyword cannot tag a %', v_ns, new.target_type
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ===========================================================================
-- Audit
-- ===========================================================================
-- One AFTER trigger per business table writes the before and after images plus
-- the list of columns that actually changed, so the audit viewer can show a
-- diff without storing two full rows for a one-field edit.

create or replace function dam_audit_row()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old jsonb;
  v_new jsonb;
  -- INITIALISED, not merely declared. changed_keys is NOT NULL DEFAULT '{}',
  -- but naming a column in an INSERT overrides its default, so a bare
  -- `v_changed text[]` sends NULL on INSERT and DELETE (the two branches that
  -- never assign it) and every audited insert fails with 23502. The column's
  -- own default cannot save it; the variable has to carry the empty array.
  v_changed text[] := array[]::text[];
  -- fninsert:ok v_action — assigned on every reachable path. The branch
  -- below is exhaustive over tg_op, which for a FOR EACH ROW trigger can
  -- only be INSERT, UPDATE or DELETE (a TRUNCATE trigger must be FOR EACH
  -- STATEMENT and so cannot reach this function).
  v_action dam_audit_action;
  v_row_id uuid;
  v_request_id text;
  v_project_id uuid;
  v_studio_id uuid;
begin
  v_request_id := nullif(current_setting('dam.request_id', true), '');

  if tg_op = 'INSERT' then
    v_action := 'insert';
    v_new := to_jsonb(new);
    v_row_id := new.id;
  elsif tg_op = 'DELETE' then
    v_action := 'delete';
    v_old := to_jsonb(old);
    v_row_id := old.id;
  else
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    v_row_id := new.id;
    -- A soft delete and a restore are distinct actions, not generic updates:
    -- they are what the trash screen and the audit report are asked about.
    if old.deleted_at is null and new.deleted_at is not null then
      v_action := 'delete';
    elsif old.deleted_at is not null and new.deleted_at is null then
      v_action := 'restore';
    else
      v_action := 'update';
    end if;
    select coalesce(array_agg(key), array[]::text[])
      into v_changed
      from jsonb_each(v_new)
     where v_old -> key is distinct from v_new -> key
       and key <> 'updated_at';
    -- Nothing but the timestamp moved: not worth an audit row.
    if cardinality(v_changed) = 0 then
      return null;
    end if;
  end if;

  -- Denormalise the owning project and studio so the studio-scoped read policy
  -- (part 3) is an indexed comparison rather than a polymorphic lookup per row.
  if tg_table_name = 'dam_projects' then
    v_project_id := v_row_id;
    select p.studio_id into v_studio_id from dam_projects p where p.id = v_row_id;
  elsif tg_table_name = 'dam_assets' then
    select pa.project_id, p.studio_id
      into v_project_id, v_studio_id
      from dam_project_assets pa
      join dam_projects p on p.id = pa.project_id
     where pa.asset_id = v_row_id
       and pa.deleted_at is null
     order by pa.created_at, pa.id
     limit 1;
  end if;

  insert into dam_audit_log (
    table_name, row_id, action, actor_id, actor_type, request_id,
    project_id, studio_id, old_row, new_row, changed_keys, occurred_at)
  values (
    tg_table_name, v_row_id, v_action, dam_current_user_id(),
    dam_current_principal_type(), v_request_id,
    v_project_id, v_studio_id,
    v_old, v_new, v_changed, now());

  return null;   -- AFTER trigger: the return value is ignored
end;
$$;

comment on function dam_audit_row() is
  'AFTER INSERT/UPDATE/DELETE trigger writing to the partitioned dam_audit_log.';

-- ===========================================================================
-- Jobs
-- ===========================================================================

create or replace function dam_enqueue_job(
  p_kind dam_job_kind,
  p_payload jsonb default '{}'::jsonb,
  p_priority smallint default 50,
  p_run_after timestamptz default now(),
  p_idempotency_key text default null,
  p_parent_job_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into dam_jobs (kind, payload, priority, run_after, idempotency_key, parent_job_id, status)
  values (p_kind, p_payload, p_priority, p_run_after, p_idempotency_key, p_parent_job_id, 'queued')
  -- THE PREDICATE MUST MATCH THE INDEX'S, not merely overlap it. Postgres
  -- infers a partial unique index only when the predicate written here implies
  -- the index's own, and dam_jobs_idempotency_key_active_key is partial on BOTH
  -- conditions (D-333: the key means "not twice right now", not "never again").
  -- `where idempotency_key is not null` alone implies nothing about status, so
  -- inference fails and the first call raises 42P10 — at run time, never at
  -- CREATE FUNCTION.
  on conflict (idempotency_key)
    where idempotency_key is not null and status in ('queued', 'running')
  do nothing
  returning id into v_id;

  if v_id is null and p_idempotency_key is not null then
    -- Already enqueued: return the existing job so the caller can watch it.
    -- Narrowed to the same non-terminal window as the index. Without it this
    -- reads a FINISHED job that once held the key and hands the caller a
    -- completed id to poll, which never changes state again.
    select id into v_id
      from dam_jobs
     where idempotency_key = p_idempotency_key
       and status in ('queued', 'running')
     order by created_at desc
     limit 1;
  end if;
  return v_id;
end;
$$;

-- Enqueues a search-row rebuild for one asset. Called by triggers on every
-- table whose contents appear in dam_asset_search.
create or replace function dam_queue_reindex_asset()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_asset uuid;
begin
  v_asset := case tg_table_name
    when 'dam_assets' then coalesce(new.id, old.id)
    when 'dam_asset_rights' then coalesce(new.asset_id, old.asset_id)
    when 'dam_project_assets' then coalesce(new.asset_id, old.asset_id)
    else null
  end;
  if v_asset is not null then
    perform dam_enqueue_job(
      'reindex_asset'::dam_job_kind,
      jsonb_build_object('asset_id', v_asset),
      10::smallint,
      now(),
      'reindex_asset:' || v_asset::text);
  end if;
  return null;
end;
$$;

-- ===========================================================================
-- Guards used by CHECK constraints
-- ===========================================================================

-- Rejects a config blob that carries a secret rather than the NAME of one
-- (SPEC [D-338]). Two independent rules, because either alone is porous:
--
--   1. THE KEY NAME. Any key matching secret/token/password/api_key/
--      private_key/client_secret/credential is refused, UNLESS it ends in
--      `_name` or `_ref` — which is exactly how every seeded connector config
--      is written (`token_secret_name`, `api_key_secret_name`). A value-shape
--      rule alone cannot catch `{"api_key": "hunter2"}`, and "hurried
--      connector pastes the live key into the obvious field" is the failure
--      this constraint exists to prevent.
--   2. THE VALUE SHAPE. Any string that looks like a credential regardless of
--      what it is called: a PEM block, a Google API key, an OpenAI key, a
--      HubSpot personal access token, a Google OAuth access token, a JWT, a
--      credentialed Postgres URL, or a bare 40+ character base64 blob.
--
-- Walks the whole document, not just its top level: a secret nested three
-- objects down is still a secret.
--
-- Each string value is unwrapped and matched on its own, so the shape rules
-- anchor with ^ rather than a word-boundary escape. Worth recording why:
-- the earlier single-regex-over-the-whole-document version used \b for a
-- word boundary, and in Postgres's ARE dialect \b is the BACKSPACE
-- character — those branches matched nothing at all and the constraint
-- silently passed the very keys it names. If a word boundary is ever needed
-- here it is \m (beginning of word) or \y (either edge), never \b.
create or replace function dam_config_has_no_secrets(p_config jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_key text;
  v_val jsonb;
begin
  if p_config is null then
    return true;
  end if;

  case jsonb_typeof(p_config)

    when 'object' then
      for v_key, v_val in select key, value from jsonb_each(p_config) loop
        if v_key ~* '(secret|token|password|api_?key|private_key|client_secret|credential)'
           and v_key !~* '(_name|_ref)$' then
          return false;
        end if;
        if not dam_config_has_no_secrets(v_val) then
          return false;
        end if;
      end loop;
      return true;

    when 'array' then
      for v_val in select value from jsonb_array_elements(p_config) loop
        if not dam_config_has_no_secrets(v_val) then
          return false;
        end if;
      end loop;
      return true;

    when 'string' then
      -- #>> '{}' unwraps the jsonb string to text without the quotes that
      -- ::text would leave on, so the anchors below mean what they say.
      return (p_config #>> '{}') !~ '(-----BEGIN [A-Z ]*PRIVATE KEY|^ya29\.|^pat-|^sk-[A-Za-z0-9-]{20,}|^AIza[0-9A-Za-z_-]{20,}|^eyJ[A-Za-z0-9_-]{20,}|postgres(ql)?://[^:@[:space:]]+:[^@[:space:]]+@|^[A-Za-z0-9+/]{40,}={0,2}$)';

    else
      -- number, boolean, null: nothing to hide in one.
      return true;

  end case;
end;
$$;

comment on function dam_config_has_no_secrets(jsonb) is
  'CHECK helper [D-338]: false when a config blob holds a secret rather than the name of one — by key name (secret/token/password/api_key/..., unless suffixed _name or _ref) or by value shape (PEM block, AIza/sk-/pat-/ya29. token, JWT, credentialed postgres URL, bare 40+ char base64). Recurses through nested objects and arrays.';

-- Licence territories: either the single sentinel 'WW' (worldwide) or a list of
-- upper-case ISO 3166-1 alpha-2 codes. 'WW' may only appear alone, because
-- "worldwide except France" is not a thing this column can express and silently
-- accepting it would misstate a licence.
--
-- IMMUTABLE so it is legal inside a CHECK constraint (SPEC 2B.22); it depends
-- on nothing but its argument.
create or replace function dam_valid_territories(p_territories text[])
returns boolean
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select p_territories is null
      or (cardinality(p_territories) > 0
          and (
            -- the sentinel, alone
            p_territories = array['WW']
            -- or every element an ISO 3166-1 alpha-2 code, and no sentinel
            or (not ('WW' = any (p_territories))
                and not exists (
                  select 1
                    from unnest(p_territories) as t(code)
                   where t.code !~ '^[A-Z]{2}$'))
          ));
$$;

comment on function dam_valid_territories(text[]) is
  'CHECK helper: a territory list is either {WW} alone or ISO 3166-1 alpha-2 codes.';

-- Word count for the fixed-length employee bios (25/50/150 words).
create or replace function dam_word_count(p_text text)
returns int
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if p_text is null or btrim(p_text) = '' then
    return 0;
  end if;
  return array_length(regexp_split_to_array(btrim(p_text), '\s+'), 1);
end;
$$;


-- ===========================================================================
-- SECTION 1 — Core domain tables (SPEC part 02a, sections 2.1–2.29)
-- ===========================================================================
-- Target: PostgreSQL 15+ on Supabase. Runs after 00-preamble.sql, which owns
-- every extension, enum type and shared function this file names.
--
-- WHAT IS IN THIS FILE
--   `create table` only: columns, defaults, not-null, primary keys, check
--   constraints, foreign keys that can be declared inline, generated columns,
--   and comments on anything whose reason is not obvious from the name.
--
-- WHAT IS DELIBERATELY NOT IN THIS FILE
--   * Indexes, including every UNIQUE that the spec expresses as a *partial*
--     index (`... where deleted_at is null`) or over an *expression*
--     (`lower(code)`). Those cannot be table constraints, so they live in
--     30-indexes-search.sql. A plain `unique (a, b)` with no predicate does
--     sit on the table here.
--   * RLS policies and trigger definitions — 40-rls-policies.sql.
--   * Enum types and shared functions — 00-preamble.sql.
--   * Partition parents (`dam_audit_log`, `dam_usage_events`, …) — part 02b.
--
-- TABLE ORDER
--   Tables are written in dependency order, not in spec-section order, so that
--   every inline `references` target already exists. The visible effects are
--   that 2.18 `dam_storage_locations` is written before 2.19 `dam_assets`, and
--   that 2.6 `dam_project_assets` is written after it.
--
-- DEFERRED FOREIGN KEYS  (block at the END of this file)
--   Two kinds of FK are added later with `alter table … add constraint`:
--     1. Cycle breakers named in SPEC 2.0 — a pointer from an earlier table to
--        a later one (`dam_projects.hero_asset_id`, `dam_clients.logo_asset_id`,
--        `dam_assets.current_version_id`, …).
--     2. Every FK that points at a table owned by part 02b
--        (`dam_users`, `dam_access_levels`, `dam_photographers`, `dam_employees`,
--        `dam_upload_requests`, `dam_ai_suggestions`, `dam_api_keys`,
--        `dam_jobs`, `dam_sync_runs`, `dam_aspect_ratios`), because
--        20-supporting-tables.sql creates them after this file.
--   In particular the standard `created_by` / `updated_by` / `deleted_by`
--   columns are declared here as plain `uuid` and gain their
--   `references dam_users(id) on delete set null` in that block. SPEC 2.0
--   defines them as FK columns; nothing about them changes except *when* the
--   constraint is attached.
--
-- STANDARD COLUMNS (SPEC 2.0, rows S1–S7) — on every table below:
--   id uuid primary key default gen_random_uuid()
--   created_at  timestamptz not null default now()
--   updated_at  timestamptz not null default now()
--   created_by  uuid        (→ dam_users, deferred)
--   updated_by  uuid        (→ dam_users, deferred)
--   deleted_at  timestamptz
--   deleted_by  uuid        (→ dam_users, deferred)
-- The single documented exception is `dam_asset_search` (D-242); its own
-- comment says why.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 2.1  dam_studios — studios and region groups (DQ11)
-- ---------------------------------------------------------------------------
-- Seeded with the 15 codes of the existing vocabulary. `australia` is a region
-- group whose five child studios hold no assets until master data assigns
-- them. A studio is the unit of default visibility (DQ3) and of the
-- storage-by-studio analytics.
create table dam_studios (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  -- Stable slug used by /api/v1 `studio=` and by the seeds, e.g. `bangkok`,
  -- `ho-chi-minh-city`. Uniqueness is case-insensitive and ignores trashed
  -- rows, so it is the partial expression index dam_studios_code_key.
  code text not null
    constraint dam_studios_code_format_check
    check (code ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null
    constraint dam_studios_name_length_check
    check (length(name) between 1 and 80),
  -- Only where dwp has exactly one studio in the place: the existing rule is
  -- that no city is invented for a region group.
  city text,
  country_code char(2)
    constraint dam_studios_country_code_check
    check (country_code ~ '^[A-Z]{2}$'),
  -- [D-205] Marketing region label (APAC, MENA, UK & Europe, Australia,
  -- Americas) — free text with seeded values, not an enum, because marketing
  -- reorganises regions.
  region text,
  -- IANA name, e.g. `Asia/Bangkok`; used for digest scheduling.
  timezone text,
  parent_studio_id uuid
    references dam_studios (id) on delete restrict,
  -- True for `australia`. A group may own projects only until children are
  -- assigned.
  is_region_group boolean not null default false,
  -- Drive level-2 folder names that map to this studio ({Thailand},
  -- {Australia,AUS_ARCHIVED}, {UAE}), read by folder-walk ingest and by the
  -- migration.
  legacy_folder_names text[] not null default '{}',
  sort_order integer not null default 0,
  -- Inactive studios are hidden from pickers but keep their projects.
  is_active boolean not null default true,
  -- Map marker for the studio itself, never for its projects.
  latitude double precision
    constraint dam_studios_latitude_check
    check (latitude between -90 and 90),
  longitude double precision
    constraint dam_studios_longitude_check
    check (longitude between -180 and 180),

  constraint dam_studios_parent_not_self_check check (parent_studio_id <> id),
  -- [D-206] One level of grouping only: a region group may not itself have a
  -- parent. trg_dam_studios_no_cycle enforces the other half (a parent may not
  -- have a parent); together they keep the RLS studio helpers to a single join.
  constraint dam_studios_one_level_check
    check (not (is_region_group and parent_studio_id is not null))
);

comment on table dam_studios is
  'Studios and region groups (SPEC 2.1, DQ11). The unit of default visibility and of storage analytics.';
comment on column dam_studios.legacy_folder_names is
  'Drive level-2 folder names mapping to this studio; read by folder-walk ingest and the migration.';
comment on column dam_studios.is_region_group is
  'True for a grouping row such as australia; one level of grouping only (D-206).';


-- ---------------------------------------------------------------------------
-- 2.2  dam_clients — client organisations
-- ---------------------------------------------------------------------------
-- The project owner as marketing names it. Identity in HubSpot (company) and
-- Projectworks (client) is carried by dam_external_ids; this row keeps only
-- what the DAM displays and facets on.
create table dam_clients (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  name text not null
    constraint dam_clients_name_length_check
    check (length(btrim(name)) between 1 and 200),
  -- From Projectworks ClientName when it differs from the marketing name.
  legal_name text,
  -- [D-207] Trigger-maintained: lower(unaccent(name)) with a leading "The "
  -- moved to the end. Client lists sort by it.
  sort_name text not null,
  kind text
    constraint dam_clients_kind_check
    check (kind in ('developer','owner_operator','hospitality_group','corporate',
                    'government','institution','individual','other')),
  website text
    constraint dam_clients_website_check
    check (website ~* '^https?://'),
  -- Bare host, lower-cased; the HubSpot de-duplication key. Unique among live
  -- rows when not null, which is a partial index and so lives in the index file.
  domain text,
  country_code char(2)
    constraint dam_clients_country_code_check
    check (country_code ~ '^[A-Z]{2}$'),
  city text,
  parent_client_id uuid
    references dam_clients (id) on delete set null,
  -- (ALTER) → dam_assets(id) on delete set null. A Logos & Brand asset.
  logo_asset_id uuid,
  -- [D-208] A copy rule, not an access rule: document generation substitutes
  -- "Confidential client". Access is governed by dam_access_levels instead,
  -- which is why this is a flag rather than a level.
  is_confidential boolean not null default false,
  notes text,
  is_active boolean not null default true,

  constraint dam_clients_parent_not_self_check check (parent_client_id <> id)
);

comment on table dam_clients is
  'Client organisations (SPEC 2.2). Foreign identity lives in dam_external_ids, never in columns here.';
comment on column dam_clients.sort_name is
  'Trigger-maintained sort key (D-207): lower(unaccent(name)) with a leading "The " moved to the end.';
comment on column dam_clients.is_confidential is
  'Copy rule (D-208): the client name must not appear in external outputs. Not an access rule.';


-- ---------------------------------------------------------------------------
-- 2.3  dam_projects — the spine (BRIEF 1, 3)
-- ---------------------------------------------------------------------------
-- Identity (code) is owned by Projectworks when the connector is on, else by
-- marketing; everything marketing shows is DAM-owned. Description text is NOT
-- stored here — text blocks are looked up by (target_type='project',
-- target_id) in dam_text_blocks (02b). Sectors, services, certifications and
-- awards are project keywords (D-209), not columns and not child tables.
create table dam_projects (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  -- Project number, e.g. 15-0060, AUSYD-1234. Free text (D-021).
  -- Case-insensitive uniqueness among live rows is the partial expression
  -- index dam_projects_code_key.
  code text
    constraint dam_projects_code_format_check
    check (code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$'),
  code_source text
    constraint dam_projects_code_source_check
    check (code_source in ('projectworks','manual','folder','import')),
  name text not null
    constraint dam_projects_name_length_check
    check (length(btrim(name)) between 1 and 200),
  -- Projectworks ProjectName when it differs from the marketing name.
  internal_name text,
  -- [D-211] One-line card text. Grids and map pins need a line without joining
  -- the text-block table; anything longer is a text block.
  summary text
    constraint dam_projects_summary_length_check
    check (length(summary) <= 280),
  client_id uuid
    references dam_clients (id) on delete set null,
  -- End user / operator / brand when distinct from the client.
  operator_name text,
  -- (ALTER) → dam_employees(id) on delete set null, part 02b.
  -- The project manager of record: Projectworks owns it when the connector is
  -- on (it matches on email), else marketing sets it. Distinct from
  -- dam_project_employees, which records everyone who worked on the project
  -- and their roles — this is the single accountable person a proposal names.
  project_manager_employee_id uuid,
  -- Home studio. Nullable because the migration cannot derive one for about
  -- 8 % of folders; the completeness score penalises a null.
  studio_id uuid
    references dam_studios (id) on delete restrict,
  -- (ALTER) → dam_access_levels(id) on delete restrict, part 02b.
  -- trg_dam_projects_default_access_level fills the is_default level on insert.
  access_level_id uuid not null,
  -- [D-212] `unverified` is the entry state for migrated / folder-derived rows.
  -- There is deliberately no transition trigger on projects: statuses come from
  -- an external system with tenant-defined names, so the sync mapping is the
  -- gate, not the database.
  status dam_project_status not null default 'unverified',
  country_code char(2)
    constraint dam_projects_country_code_check
    check (country_code ~ '^[A-Z]{2}$'),
  state_province text,
  city text,
  -- Street address as geocoded.
  address text,
  postal_code text,
  -- PostGIS is not enabled; a geography(Point,4326) generated column can be
  -- added later without changing any writer.
  latitude double precision
    constraint dam_projects_latitude_check
    check (latitude between -90 and 90),
  longitude double precision
    constraint dam_projects_longitude_check
    check (longitude between -180 and 180),
  -- studio_hint = seeded from the studio's country only, and excluded from the
  -- map view.
  geocode_source text
    constraint dam_projects_geocode_source_check
    check (geocode_source in ('manual','google','import','studio_hint')),
  geocoded_at timestamptz,

  -- Canonical area; the basis is in size_basis.
  size_sqm numeric(12,2)
    constraint dam_projects_size_sqm_check
    check (size_sqm >= 0),
  -- [D-213] Generated stored so that "over 4,000 sqm" filters and US-facing
  -- documents both get an indexable column that can never drift from size_sqm.
  size_sqft numeric(12,2)
    generated always as (round(size_sqm * 10.7639104, 2)) stored,
  size_basis text not null default 'gfa'
    constraint dam_projects_size_basis_check
    check (size_basis in ('gfa','nla','cfa','site')),
  site_area_sqm numeric(12,2)
    constraint dam_projects_site_area_check
    check (site_area_sqm >= 0),
  -- Hotel keys.
  keys_count integer
    constraint dam_projects_keys_count_check
    check (keys_count >= 0),
  -- Residential units.
  units_count integer
    constraint dam_projects_units_count_check
    check (units_count >= 0),
  -- F&B / venue seats.
  seats_count integer
    constraint dam_projects_seats_count_check
    check (seats_count >= 0),
  storeys smallint
    constraint dam_projects_storeys_check
    check (storeys between 0 and 300),
  -- Construction cost (SF330 "project cost"), never the fee.
  construction_value numeric(14,2)
    constraint dam_projects_construction_value_check
    check (construction_value >= 0),
  currency_code char(3)
    constraint dam_projects_currency_code_check
    check (currency_code ~ '^[A-Z]{3}$'),
  value_basis text
    constraint dam_projects_value_basis_check
    check (value_basis in ('estimated','contract','final')),
  value_as_of date,

  -- Design / contract start.
  started_on date,
  -- Professional services complete (SF330 F).
  design_completed_on date,
  -- Construction / practical completion — the marketing "year completed".
  completed_on date,
  -- For live projects.
  expected_completion_on date,
  -- Generated stored: the facet and sort key for "completed projects by year".
  -- extract(year from <date>) is immutable, so it is legal in a generated
  -- expression; the timestamptz form would not be.
  year_completed smallint
    generated always as ((extract(year from completed_on))::smallint) stored,

  -- (ALTER) → dam_assets(id) on delete set null.
  -- [D-214] Denormalised from dam_project_assets.is_hero by
  -- trg_dam_project_assets_hero_pointer — never written by the app.
  hero_asset_id uuid,
  -- Marketing has cleared the project for external use; independent of asset
  -- rights.
  is_publishable boolean not null default false,
  -- [D-215] Embargo: before this date, documents and external shares must
  -- exclude the project. Confidentiality as an *access* rule is
  -- access_level_id (seed Confidential), which is why there is no
  -- is_confidential boolean here.
  confidential_until date,
  -- [D-012] checklist, computed by dam_project_completeness() from the
  -- reindex_project job.
  completeness_score smallint not null default 0
    constraint dam_projects_completeness_check
    check (completeness_score between 0 and 100),
  completeness_computed_at timestamptz,
  -- Code string as parsed from the legacy folder, kept even when Projectworks
  -- later renumbers.
  legacy_code text,
  -- First Drive path the project was derived from; further paths are
  -- dam_project_aliases rows of kind folder_path.
  legacy_folder_path text,
  -- [D-216] Review flags set by importers: needs_code, sector_conflict,
  -- needs_location, alias_review. Cleared by editors.
  flags text[] not null default '{}',

  -- [D-210] A code may be missing only while the row is `unverified`: the
  -- migration creates code-less projects from unparseable folder names and
  -- they must not block ingest.
  constraint dam_projects_code_required_check
    check (code is not null or status = 'unverified'),
  -- A half-set coordinate pair is a data error, not a partial location.
  constraint dam_projects_lat_lng_together_check
    check ((latitude is null) = (longitude is null)),
  constraint dam_projects_completed_after_started_check
    check (completed_on is null or started_on is null or completed_on >= started_on),
  -- A money amount without its currency is unusable in any document.
  constraint dam_projects_value_currency_together_check
    check ((construction_value is null) = (currency_code is null))
);

comment on table dam_projects is
  'Projects: the spine of the model (SPEC 2.3). Descriptions live in dam_text_blocks; sectors/services/certifications/awards are project keywords (D-209).';
comment on column dam_projects.size_sqft is
  'Generated from size_sqm (D-213) so the imperial filter and US documents never drift from the canonical area.';
comment on column dam_projects.hero_asset_id is
  'Denormalised pointer (D-214) maintained by trg_dam_project_assets_hero_pointer. The canonical hero is dam_project_assets.is_hero.';
comment on column dam_projects.status is
  'Lifecycle. No transition trigger (D-212): project status is owned by the external system, so the sync mapping is the gate.';


-- ---------------------------------------------------------------------------
-- 2.4  dam_project_aliases — alternate identifiers that must resolve
-- ---------------------------------------------------------------------------
-- Legacy codes, folder-name variants, OpenAsset codes, marketing nicknames.
-- Filename/folder intelligence (BRIEF 4.1) looks up lower(alias) here after the
-- exact code match fails.
create table dam_project_aliases (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  project_id uuid not null
    references dam_projects (id) on delete cascade,
  -- Stored as typed, matched on lower(alias).
  alias text not null
    constraint dam_project_aliases_alias_length_check
    check (length(btrim(alias)) between 1 and 300),
  -- [D-217] A folder_path alias is a full Drive path, so one project can own
  -- folders in several collections; code and name aliases are single tokens.
  kind text not null default 'name'
    constraint dam_project_aliases_kind_check
    check (kind in ('code','name','folder_path')),
  -- migration for folder-derived rows, import for OpenAsset/CSV, rule for
  -- filename-intelligence promotions.
  source dam_link_source not null default 'manual',
  -- A human confirmed the alias. Migration rows whose trailing token is outside
  -- {L,S,I,II,(1),(2)} start unverified and flag the project alias_review.
  is_verified boolean not null default false
);

comment on table dam_project_aliases is
  'Alternate project identifiers resolved by filename/folder intelligence (SPEC 2.4). Uniqueness is (kind, lower(alias)) among live rows.';


-- ---------------------------------------------------------------------------
-- 2.5  dam_project_studios — contributing studios per project (DQ11)
-- ---------------------------------------------------------------------------
-- The home studio lives on dam_projects.studio_id and is NOT repeated here;
-- the union of home + contributing studios is what dam_asset_search.studio_ids
-- carries and what default visibility tests.
create table dam_project_studios (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  project_id uuid not null
    references dam_projects (id) on delete cascade,
  studio_id uuid not null
    references dam_studios (id) on delete restrict,
  -- [D-218] archive_owner marks the studio whose Drive archive the files came
  -- from when it is not the design studio (the AUS_ARCHIVED case).
  role text not null default 'contributing'
    constraint dam_project_studios_role_check
    check (role in ('contributing','delivery','design','local_partner','archive_owner')),
  sort_order integer not null default 0
);

comment on table dam_project_studios is
  'Contributing studios per project (SPEC 2.5, DQ11). The home studio is dam_projects.studio_id and is never duplicated here.';


-- ---------------------------------------------------------------------------
-- 2.7  dam_categories — asset categories (BRIEF 3)
-- ---------------------------------------------------------------------------
-- The top-level bucket carrying a per-category field schema (2.16), a
-- keyword-category schema (2.12), a default access level and a review
-- requirement. Single-valued per asset. Seeded with the eight of [D-014];
-- requires_review is true only on Project Photography and Staff.
create table dam_categories (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  -- Soft delete is blocked by trigger while live assets reference the row.
  deleted_at timestamptz,
  deleted_by uuid,

  name text not null
    constraint dam_categories_name_length_check
    check (length(btrim(name)) between 1 and 80),
  -- API addressing: /categories/{id} accepts a slug.
  slug text not null
    constraint dam_categories_slug_format_check
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text
    constraint dam_categories_description_length_check
    check (length(description) <= 280),
  -- (ALTER) → dam_access_levels(id) on delete restrict, part 02b.
  -- The fallback level for an asset with no level of its own and no project.
  access_level_id uuid not null,
  -- [D-005] Forces status = 'pending' on ingest regardless of the uploader's
  -- role.
  requires_review boolean not null default false,
  -- [D-221] Advisory only: the wizard warns when a file's kind is outside the
  -- set. Never a constraint — marketing receives odd deliverables and a hard
  -- rule would push files back to Drive shares.
  default_file_kinds dam_file_kind[] not null default '{}',
  sort_order integer not null default 0,
  -- True on the eight seeded rows; trg_dam_categories_protect_system refuses
  -- delete and refuses a slug change.
  is_system boolean not null default false,
  -- Inactive categories stay valid on existing assets but are hidden from
  -- pickers.
  is_active boolean not null default true
);

comment on table dam_categories is
  'Asset categories (SPEC 2.7). Each carries a field schema, a keyword schema, a default access level and a review requirement.';
comment on column dam_categories.default_file_kinds is
  'Advisory only (D-221): the upload wizard warns, the database never refuses.';


-- ---------------------------------------------------------------------------
-- 2.8  dam_keyword_categories — the roots of the keyword trees (DQ2)
-- ---------------------------------------------------------------------------
-- One row per (namespace, tree), seeded per [D-015]. A category belongs to
-- exactly one namespace and a keyword never moves between namespaces.
create table dam_keyword_categories (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  -- Soft delete is blocked by trigger while the tree has live keywords.
  deleted_at timestamptz,
  deleted_by uuid,

  -- Immutable after insert (trg_dam_keyword_categories_immutable): links,
  -- aliases and paths are all namespace-scoped.
  namespace dam_keyword_namespace not null,
  name text not null
    constraint dam_keyword_categories_name_length_check
    check (length(btrim(name)) between 1 and 80),
  -- Used by the kw:/pkw: search prefixes and by the API.
  slug text not null
    constraint dam_keyword_categories_slug_format_check
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text
    constraint dam_keyword_categories_description_length_check
    check (length(description) <= 280),
  -- [D-484] caps a tree at five levels; the keyword path trigger enforces it
  -- per node.
  max_depth smallint not null default 5
    constraint dam_keyword_categories_max_depth_check
    check (max_depth between 1 and 5),
  -- [D-222] True = at most one live keyword from this category per target (a
  -- single-choice vocabulary such as Time of Day). A second value in such a
  -- category is a tagging error, not a refinement.
  is_exclusive boolean not null default false,
  -- Only on an asset-namespace row, pointing at a project-namespace row:
  -- holding at least one confirmed keyword here suppresses the paired project
  -- category's inherited keywords for that asset (DQ6, D-483). The
  -- namespace pairing itself is trg_dam_keyword_categories_pairing.
  overrides_category_id uuid
    references dam_keyword_categories (id) on delete set null,
  sort_order integer not null default 0,
  -- Seeded rows; protected from delete and from a slug change.
  is_system boolean not null default false,
  is_active boolean not null default true,

  constraint dam_keyword_categories_overrides_not_self_check
    check (overrides_category_id <> id)
);

comment on table dam_keyword_categories is
  'Roots of the keyword trees, one per (namespace, tree) (SPEC 2.8, DQ2). Namespace is immutable.';
comment on column dam_keyword_categories.overrides_category_id is
  'Asset category paired to a project category (D-483): a confirmed asset keyword here suppresses the project tree inherited onto that asset.';


-- ---------------------------------------------------------------------------
-- 2.9  dam_keywords — hierarchical, namespaced keywords (DQ2)
-- ---------------------------------------------------------------------------
-- `path` is the /-joined chain of slugs from the root, maintained by trigger,
-- so "include descendants" is a `path LIKE '<path>/%'` prefix scan and a rename
-- propagates by one prefix rewrite — no ltree dependency. Names are unique
-- among siblings only; the path disambiguates the same name under different
-- parents ([D-484]).
create table dam_keywords (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  -- Soft delete is blocked while the node has live children; its links are
  -- soft-deleted with it.
  deleted_at timestamptz,
  deleted_by uuid,

  -- Denormalised from the category so the alias and link constraints need no
  -- join. Maintained by trg_dam_keywords_path; immutable.
  namespace dam_keyword_namespace not null,
  category_id uuid not null
    references dam_keyword_categories (id) on delete restrict,
  -- Null = root of its category. The parent must share category_id, which the
  -- path trigger checks (a CHECK cannot read another row).
  parent_id uuid
    references dam_keywords (id) on delete restrict,
  name text not null
    constraint dam_keywords_name_length_check
    check (length(btrim(name)) between 1 and 120),
  -- Derived from name when the caller omits it; unique among siblings.
  slug text not null
    constraint dam_keywords_slug_format_check
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  -- Trigger-maintained: parent's path + '/' + slug.
  path text not null
    constraint dam_keywords_path_format_check
    check (path ~ '^[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*$'),
  -- Trigger-maintained; root = 1. The trigger additionally refuses
  -- depth > category.max_depth, which a CHECK cannot see.
  depth smallint not null
    constraint dam_keywords_depth_check
    check (depth between 1 and 5),
  -- [D-223] Cached subtree ids, maintained on root rows only (depth = 1): a
  -- Sector root has about 50 descendants and the sector facet expands it on
  -- every query. Deeper nodes expand with one path LIKE scan instead.
  descendant_ids uuid[] not null default '{}',
  description text
    constraint dam_keywords_description_length_check
    check (length(description) <= 500),
  source dam_link_source not null default 'manual',
  -- [D-224] Set by dam_merge_keywords() on the source node so the API resolves
  -- a retired id to its survivor: saved searches and external consumers hold
  -- keyword ids and must not 404 after a merge.
  merged_into_keyword_id uuid
    references dam_keywords (id) on delete set null,
  -- Manual order among siblings; ties fall back to name.
  sort_order integer not null default 0,
  -- Inactive keywords stay on existing links but cannot be newly chosen.
  is_active boolean not null default true,

  constraint dam_keywords_parent_not_self_check check (parent_id <> id)
);

comment on table dam_keywords is
  'Hierarchical namespaced keywords with a materialised path (SPEC 2.9, DQ2). Descendant search is a path prefix scan, not a recursive CTE.';
comment on column dam_keywords.descendant_ids is
  'Cached subtree ids on root rows only (D-223); deeper nodes expand by path LIKE.';
comment on column dam_keywords.merged_into_keyword_id is
  'Survivor of a merge (D-224) so a retired keyword id still resolves instead of 404ing.';


-- ---------------------------------------------------------------------------
-- 2.10  dam_keyword_aliases — synonyms that resolve to a keyword
-- ---------------------------------------------------------------------------
-- Spelling variants, the pre-rename name, OpenAsset alternate labels, legacy
-- flat tags folded into a node, folder-segment spellings. The search parser,
-- the auto-tag matcher, the importers and the picker all resolve an incoming
-- term through this table before giving up.
create table dam_keyword_aliases (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  keyword_id uuid not null
    references dam_keywords (id) on delete cascade,
  -- Copied from the keyword by trg_dam_keyword_aliases_namespace; carries
  -- DQ2's uniqueness scope (namespace, lower(alias)) without a join.
  namespace dam_keyword_namespace not null,
  -- Stored as typed, matched on lower(alias).
  alias text not null
    constraint dam_keyword_aliases_alias_length_check
    check (length(btrim(alias)) between 1 and 120),
  source dam_link_source not null default 'manual',
  -- BCP-47 when the row is a translated label rather than a synonym;
  -- null = language-neutral.
  locale text
);

comment on table dam_keyword_aliases is
  'Synonyms resolving to a keyword (SPEC 2.10). At most 20 live aliases per keyword (D-485), enforced by trigger.';


-- ---------------------------------------------------------------------------
-- 2.11  dam_keyword_links — confirmed keyword assignments (DQ2)
-- ---------------------------------------------------------------------------
-- The single polymorphic link table for CONFIRMED assignments on assets,
-- projects and employees. AI and rule proposals never land here: they live in
-- dam_ai_suggestions (02b) until a human accepts, at which point a row is
-- inserted with source='ai' and suggestion_id set. There is no FK on
-- target_id; integrity is trg_dam_keyword_links_assert_target.
create table dam_keyword_links (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Who confirmed the link.
  created_by uuid,
  updated_by uuid,
  -- Set in bulk when the target or the keyword is trashed.
  deleted_at timestamptz,
  deleted_by uuid,

  keyword_id uuid not null
    references dam_keywords (id) on delete cascade,
  -- [D-225] The enum also carries album, text_block, client and studio for the
  -- other polymorphic tables, but only these three have keyword namespaces.
  target_type dam_target_type not null
    constraint dam_keyword_links_target_type_check
    check (target_type in ('asset','project','employee')),
  -- No FK (polymorphic). Existence, liveness and namespace agreement are
  -- checked by dam_assert_keyword_target().
  target_id uuid not null,
  source dam_link_source not null default 'manual',
  -- Relevance of the keyword to the target. Orders the lightbox chips and the
  -- keyword names fed into search_tsv weight B; manual links are always 1.
  weight numeric(4,3) not null default 1.000
    constraint dam_keyword_links_weight_check
    check (weight > 0 and weight <= 1),
  -- (ALTER) → dam_ai_suggestions(id) on delete set null, part 02b.
  -- Provenance of an accepted proposal.
  suggestion_id uuid,
  -- created_at for a manual link, the acceptance time for an AI one.
  confirmed_at timestamptz not null default now(),

  -- An AI-sourced link without its suggestion has lost its provenance, which
  -- is the only thing that distinguishes it from a manual one.
  constraint dam_keyword_links_ai_has_suggestion_check
    check (source <> 'ai' or suggestion_id is not null)
);

comment on table dam_keyword_links is
  'Confirmed keyword assignments (SPEC 2.11, DQ2). Unconfirmed AI output lives in dam_ai_suggestions, never here.';
comment on column dam_keyword_links.target_id is
  'Polymorphic: no FK. dam_assert_keyword_target() checks existence, liveness and namespace-to-target-type agreement.';


-- ---------------------------------------------------------------------------
-- 2.12  dam_category_keyword_categories — per-category keyword schema
-- ---------------------------------------------------------------------------
-- Which keyword trees apply to which asset category, and which of them a human
-- must fill before an asset may be published (DQ2, BRIEF 4.2). Project and
-- employee keyword categories are never category-scoped, so only asset-
-- namespace rows appear here (trg_..._namespace enforces it).
create table dam_category_keyword_categories (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  category_id uuid not null
    references dam_categories (id) on delete cascade,
  -- Must be namespace = 'asset'; checked by trigger, because the namespace
  -- lives on the parent row.
  keyword_category_id uuid not null
    references dam_keyword_categories (id) on delete restrict,
  -- [D-488] At least min_count confirmed links from this tree before status
  -- may become published. Never blocks ingest or bulk edit.
  is_required boolean not null default false,
  min_count smallint not null default 1
    constraint dam_category_keyword_categories_min_count_check
    check (min_count >= 1),
  -- [D-226] Cardinality cap for this tree on this asset category — how "one
  -- Space Type on a Drawing, several on a Photograph" is expressed without
  -- forking the vocabulary. is_exclusive on the keyword category is the
  -- stricter global form.
  max_count smallint
    constraint dam_category_keyword_categories_max_count_check
    check (max_count is null or max_count >= min_count),
  sort_order integer not null default 0
);

comment on table dam_category_keyword_categories is
  'Per-category keyword schema (SPEC 2.12) read by GET /categories/{id}/schema. Asset-namespace keyword categories only.';


-- ---------------------------------------------------------------------------
-- 2.13  dam_field_categories — named groups of custom fields
-- ---------------------------------------------------------------------------
-- OpenAsset's field groups: "Project facts", "Sustainability", "Commercial",
-- "Photography technical". Purely presentational, but scoped, so a project
-- group never appears on an asset form.
create table dam_field_categories (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  -- Soft delete is blocked by trigger while live fields reference the group.
  deleted_at timestamptz,
  deleted_by uuid,

  -- [D-227] Every field in the group must carry the same scope: a group is a
  -- form section, and a form belongs to one entity.
  scope dam_field_scope not null,
  name text not null
    constraint dam_field_categories_name_length_check
    check (length(btrim(name)) between 1 and 80),
  slug text not null
    constraint dam_field_categories_slug_format_check
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text
    constraint dam_field_categories_description_length_check
    check (length(description) <= 280),
  sort_order integer not null default 0,
  is_system boolean not null default false,
  is_active boolean not null default true
);

comment on table dam_field_categories is
  'Presentational groups of custom fields, scoped to one entity kind (SPEC 2.13, D-227).';


-- ---------------------------------------------------------------------------
-- 2.14  dam_fields — admin-definable custom field definitions (DQ1)
-- ---------------------------------------------------------------------------
-- The definition owns the type, the scope, the validation, and the flags that
-- decide whether a field is a facet (copied into dam_asset_search.facet_fields)
-- and whether it cascades from project to asset (DQ6). `key` is the stable
-- identifier used by the API, by merge fields in templates and by the
-- CSV/OpenAsset importers (the rest_code equivalent).
create table dam_fields (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  -- Soft delete takes the field's options, category rows and values with it.
  deleted_at timestamptz,
  deleted_by uuid,

  -- Immutable after insert (trg_dam_fields_immutable): templates and API
  -- filters address it.
  key text not null
    constraint dam_fields_key_format_check
    check (key ~ '^[a-z][a-z0-9_]{1,60}$'),
  name text not null
    constraint dam_fields_name_length_check
    check (length(btrim(name)) between 1 and 80),
  -- Immutable once any live value exists.
  type dam_field_type not null,
  -- Immutable once any live value exists; must equal the field category's
  -- scope (trg_dam_fields_scope_matches_category).
  scope dam_field_scope not null,
  field_category_id uuid not null
    references dam_field_categories (id) on delete restrict,
  -- Copied into dam_asset_search.facet_fields under the key field:<key> and
  -- offered as a facet (DQ1); toggling enqueues a reindex.
  is_facet boolean not null default false,
  -- Project value cascades to the project's assets unless overridden (DQ6).
  is_inheritable boolean not null default false,
  -- Seed value for a new dam_category_fields row; enforcement is per category,
  -- never global.
  is_required_default boolean not null default false,
  -- [D-229] Values must be unique among live rows of this field: external
  -- reference numbers (certificate no., award entry id) are pasted twice often
  -- enough to be worth a constraint. Enforced by trg_dam_field_values_unique.
  is_unique boolean not null default false,
  -- Documented keys: min, max, step, min_length, max_length, regex, max_items,
  -- min_items, currencies (ISO-4217 array), date_min, date_max. Unknown keys
  -- are rejected by the definition's own Zod schema.
  validation jsonb not null default '{}'
    constraint dam_fields_validation_object_check
    check (jsonb_typeof(validation) = 'object'),
  -- Pre-filled in new forms and by the ingest wizard; validated against `type`
  -- by the same trigger as a value.
  default_value jsonb,
  -- Display suffix for a number field (sqm, keys, kWh/m2.yr). Never converted:
  -- the unit is documentation, not a conversion factor.
  unit text,
  help_text text
    constraint dam_fields_help_text_length_check
    check (length(help_text) <= 500),
  placeholder text,
  sort_order integer not null default 0,
  -- Seeded fields; protected from delete and from a key change.
  is_system boolean not null default false,
  -- Inactive fields keep their values and stay readable, but are hidden from
  -- editors.
  is_active boolean not null default true,

  -- Employee fields are not asset facets.
  constraint dam_fields_facet_scope_check
    check (not is_facet or scope in ('project','asset')),
  -- [D-228] Inheritance in this model only ever runs project to asset.
  constraint dam_fields_inheritable_scope_check
    check (not is_inheritable or scope = 'project'),
  constraint dam_fields_unit_number_only_check
    check (unit is null or type = 'number')
);

comment on table dam_fields is
  'Custom metadata field definitions (SPEC 2.14, DQ1). key is immutable; type and scope freeze once a live value exists.';
comment on column dam_fields.is_facet is
  'Copied into dam_asset_search.facet_fields as field:<key>; toggling enqueues a reindex.';
comment on column dam_fields.unit is
  'Display suffix only. The platform never converts units.';


-- ---------------------------------------------------------------------------
-- 2.15  dam_field_options — controlled vocabulary of a select field
-- ---------------------------------------------------------------------------
-- Values store the option KEY, never the label, so relabelling propagates
-- without touching a single value row (BRIEF 4.2).
create table dam_field_options (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  -- Soft delete is refused while live values reference the key, unless the API
  -- supplies replace_with_option_id and rewrites them first.
  deleted_at timestamptz,
  deleted_by uuid,

  field_id uuid not null
    references dam_fields (id) on delete cascade,
  -- Immutable (trg_dam_field_options_immutable) because values store it.
  key text not null
    constraint dam_field_options_key_format_check
    check (key ~ '^[a-z0-9][a-z0-9_-]{0,60}$'),
  -- Freely editable.
  label text not null
    constraint dam_field_options_label_length_check
    check (length(btrim(label)) between 1 and 120),
  description text
    constraint dam_field_options_description_length_check
    check (length(description) <= 280),
  sort_order integer not null default 0,
  -- Inactive options remain valid on existing values but cannot be newly
  -- chosen.
  is_active boolean not null default true
);

comment on table dam_field_options is
  'Controlled vocabulary of a single_select/multi_select field (SPEC 2.15). Referenced from dam_field_values by key, not by id (D-230).';


-- ---------------------------------------------------------------------------
-- 2.16  dam_category_fields — which fields appear on which category's form
-- ---------------------------------------------------------------------------
-- Order and per-category required-ness (DQ1), plus a second, narrower job:
-- switching project-to-asset inheritance off for one field on one category
-- (D-483).
create table dam_category_fields (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  category_id uuid not null
    references dam_categories (id) on delete cascade,
  -- [D-231] An asset-scope field is a schema row and may be required; a
  -- project-scope field is allowed only when it is is_inheritable, must have
  -- is_required = false, and exists solely to carry `inherits`. Enforced by
  -- trg_dam_category_fields_scope, not by a CHECK, because the scope lives on
  -- the field row.
  field_id uuid not null
    references dam_fields (id) on delete restrict,
  -- Required before status may become published (5.2.6).
  is_required boolean not null default false,
  -- Only meaningful on a project-scope row: false stops that inheritable
  -- project field from cascading to this category's assets ([D-483]).
  inherits boolean not null default true,
  sort_order integer not null default 0,
  -- Category-specific help replacing dam_fields.help_text.
  help_override text
    constraint dam_category_fields_help_override_length_check
    check (length(help_override) <= 500)
);

comment on table dam_category_fields is
  'Per-category field schema (SPEC 2.16). One join table serves both the asset form and the project-to-asset inheritance switch (D-231).';


-- ---------------------------------------------------------------------------
-- 2.17  dam_field_values — the typed EAV store (DQ1)
-- ---------------------------------------------------------------------------
-- One row per (field, target) with exactly one populated value column, chosen
-- by the field's type. Targets are polymorphic across project, asset and
-- employee — the same three the field scopes name. No JSONB blob on the
-- entity: facets need per-field indexes and required-per-category enforcement
-- needs rows.
create table dam_field_values (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  -- Clearing an asset override soft-deletes the row so the project value shows
  -- through again.
  deleted_at timestamptz,
  deleted_by uuid,

  field_id uuid not null
    references dam_fields (id) on delete cascade,
  -- Must match the field's scope; checked by trg_dam_field_values_validate,
  -- because the scope lives on the parent row.
  target_type dam_target_type not null
    constraint dam_field_values_target_type_check
    check (target_type in ('asset','project','employee')),
  -- No FK (polymorphic); dam_assert_target_exists() checks it.
  target_id uuid not null,

  -- text, url, and single_select (the option KEY).
  value_text text
    constraint dam_field_values_value_text_length_check
    check (length(value_text) <= 2000),
  value_long_text text
    constraint dam_field_values_value_long_text_length_check
    check (length(value_long_text) <= 20000),
  -- number, and the amount of currency.
  value_number numeric,
  value_date date,
  value_bool boolean,
  -- multi_select only: a JSON array of option keys.
  value_json jsonb
    constraint dam_field_values_value_json_array_check
    check (value_json is null or jsonb_typeof(value_json) = 'array'),
  -- ISO 4217 for a currency field; only meaningful with value_number.
  value_currency_code char(3)
    constraint dam_field_values_currency_code_check
    check (value_currency_code ~ '^[A-Z]{3}$'),
  source dam_link_source not null default 'manual',
  -- [D-232] The connector owns this field for this target: the UI shows it
  -- read-only and trg_dam_field_values_locked refuses a write whose
  -- source = 'manual'. ProjectWorks-owned facts must not be quietly retyped.
  is_locked boolean not null default false,

  -- DQ1: exactly one value column is populated. Which one must match the
  -- field's type, but that is a trigger, because the type lives on the parent.
  constraint dam_field_values_one_value_check
    check (num_nonnulls(value_text, value_long_text, value_number,
                        value_date, value_bool, value_json) = 1),
  constraint dam_field_values_currency_needs_number_check
    check (value_currency_code is null or value_number is not null)
);

comment on table dam_field_values is
  'Typed EAV store for custom fields (SPEC 2.17, DQ1). Exactly one value column per row; the type-to-column match is a trigger because the type lives on dam_fields.';
comment on column dam_field_values.is_locked is
  'Connector owns this field for this target (D-232): manual writes are refused.';


-- ---------------------------------------------------------------------------
-- 2.18  dam_storage_locations — one row per configured StorageProvider (DQ7)
-- ---------------------------------------------------------------------------
-- A Shared Drive, a GCS bucket, an S3 bucket, a Supabase Storage bucket, each
-- with a tier. Versions and derivatives reference a location plus an opaque
-- object_key, never a path: Drive paths go stale on rename/move and the
-- platform must survive a provider swap ([D-STOR-01]). Which provider holds
-- originals is OPEN (SPEC 10.1); this table is what makes the schema neutral
-- to that answer.
create table dam_storage_locations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  -- Soft delete is refused while any live version or derivative references it.
  deleted_at timestamptz,
  deleted_by uuid,

  -- Admin label, e.g. "Drive — dwp_Digital_Asset", "GCS — dam-originals-sea3".
  name text not null
    constraint dam_storage_locations_name_length_check
    check (length(btrim(name)) between 1 and 80),
  -- Used in object-key prefixes and in logs.
  slug text not null
    constraint dam_storage_locations_slug_format_check
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  -- Immutable after insert; the API returns 501 when no compiled
  -- implementation exists.
  provider dam_storage_provider not null,
  -- Drives dam_tiering_rules (02b) and the restore-on-demand path.
  tier dam_storage_tier not null default 'hot',
  -- Bucket name, or the Shared Drive id for google_drive; null only for a
  -- provider with a single implicit container.
  container text,
  -- Provider key of the subtree this location owns (a Drive folder id, a
  -- bucket prefix); ingest and ensureFolder never write outside it.
  root_key text,
  -- asia-southeast3 for GCS/Supabase; informational for Drive.
  region text,
  -- [D-233] Non-secret settings only: Secret Manager NAMES, never values
  -- (DQ7). trg_dam_storage_locations_no_secrets raises on a key that looks
  -- like a credential — a leaked key in a jsonb column is the failure mode
  -- this schema must make impossible.
  config jsonb not null default '{}'
    constraint dam_storage_locations_config_object_check
    check (jsonb_typeof(config) = 'object'),
  -- Last result of StorageProvider.capabilities(), refreshed by
  -- POST /storage-locations/{id}/test. Drive's strongListConsistency is false,
  -- and that is what forces the Changes API in 2.27.
  capabilities jsonb not null default '{}',
  capabilities_checked_at timestamptz,
  -- Hard refusal above this at upload-session time.
  max_object_bytes bigint
    constraint dam_storage_locations_max_object_bytes_check
    check (max_object_bytes is null or max_object_bytes > 0),
  -- Last QuotaInfo. Drive reports item counts against the 400k-per-Shared-Drive
  -- ceiling and no byte quota.
  quota jsonb,
  quota_checked_at timestamptz,
  -- At most one live row each; both are partial unique indexes over a constant
  -- expression, so they live in the index file.
  is_default_originals boolean not null default false,
  -- [D-STOR-02] Its provider must be supabase_storage, checked by trigger.
  is_default_derivatives boolean not null default false,
  -- [D-474] True on the Drive location that already holds the 34k-asset
  -- corpus: a walk registers objects where they lie instead of copying.
  allow_register_in_place boolean not null default false,
  -- Inactive locations still serve reads; no new writes are routed to them.
  is_active boolean not null default true,
  -- Operational notes (quota caveats, service-account name).
  notes text
);

comment on table dam_storage_locations is
  'Configured StorageProvider instances (SPEC 2.18, DQ7). Objects are addressed by (location, opaque object_key), never by path (D-STOR-01).';
comment on column dam_storage_locations.config is
  'Non-secret settings only (D-233): Secret Manager names, never credential values.';
comment on column dam_storage_locations.capabilities is
  'Last capabilities() probe. Drive reports strongListConsistency = false, which is why ingest uses the Changes API (2.27).';


-- ---------------------------------------------------------------------------
-- 2.19  dam_assets — the asset record (BRIEF 3 "Files")
-- ---------------------------------------------------------------------------
-- Identity, descriptive text, category, lifecycle, and the pointer to the
-- current immutable version. Bytes, hashes and EXIF live on the version
-- (2.20); facets live on the search row (2.23).
--
-- [D-234] mime_type, size_bytes, width, height, duration_ms and page_count are
-- trigger-maintained MIRRORS of the current version: the default API asset
-- shape and the grid read them on every row and must not join the version
-- table to do it.
create table dam_assets (
  id uuid primary key default gen_random_uuid(),
  -- Ingest time; the keyset sort key, paired with id.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The uploader — carries the "own uploads" permissions of part 3.
  created_by uuid,
  updated_by uuid,
  -- [D-002] purge_trash after 30 days also deletes the storage objects.
  deleted_at timestamptz,
  deleted_by uuid,

  -- Verbatim file name including extension. Renaming here renames the provider
  -- object only when the caller asks.
  filename text not null
    constraint dam_assets_filename_length_check
    check (length(btrim(filename)) between 1 and 512),
  -- [D-102] Seeded from the stem with _ and - turned into spaces.
  title text
    constraint dam_assets_title_length_check
    check (length(title) <= 300),
  -- Guards "only overwrite while still the filename-derived default" (5.1.5).
  title_source text
    constraint dam_assets_title_source_check
    check (title_source in ('filename','embedded','manual','ai')),
  -- Weight B in search_tsv.
  caption text
    constraint dam_assets_caption_length_check
    check (length(caption) <= 2000),
  caption_source text
    constraint dam_assets_caption_source_check
    check (caption_source in ('embedded','manual','ai')),
  -- Accessibility text (WCAG 2.1 AA, BRIEF 4.11).
  alt_text text
    constraint dam_assets_alt_text_length_check
    check (length(alt_text) <= 500),
  alt_text_source text
    constraint dam_assets_alt_text_source_check
    check (alt_text_source in ('embedded','manual','ai')),

  -- Single-valued (BRIEF 3).
  category_id uuid not null
    references dam_categories (id) on delete restrict,
  -- (ALTER) → dam_asset_versions(id) on delete set null.
  -- [D-481] Moves only after hash and generate_derivatives succeed for the new
  -- version; null only between insert and the first version.
  current_version_id uuid,
  -- Trigger-maintained count of live versions.
  version_count integer not null default 0,
  -- Transitions enforced by dam_assert_status_transition().
  status dam_asset_status not null default 'pending',
  -- Set by the transition trigger; orders the review queue.
  status_changed_at timestamptz,
  -- (ALTER) → dam_access_levels(id) on delete restrict, part 02b.
  -- null = inherit the most restrictive linked project's level, else the
  -- category's (D-362).
  access_level_id uuid,
  -- The owning studio for a project-less asset (brand, marketing collateral);
  -- ignored when the asset has project links.
  studio_id uuid
    references dam_studios (id) on delete restrict,
  -- (ALTER) → dam_photographers(id) on delete set null, part 02b.
  -- [D-235] MIRROR of dam_asset_rights.photographer_id, maintained by the
  -- rights trigger: the photographer facet, the credit line on a contact sheet
  -- and the completeness score all read it, and none should join the rights
  -- table.
  photographer_id uuid,
  -- (ALTER) → dam_upload_requests(id) on delete set null, part 02b.
  -- Set when an external photographer deposited the file.
  upload_request_id uuid,
  -- (ALTER) → dam_api_keys(id) on delete set null, part 02b.
  -- Which key created the row, for per-key attribution.
  api_key_id uuid,
  -- (ALTER) → dam_ingest_batches(id) on delete set null; the batch whose
  -- frozen metadata was applied.
  ingest_batch_id uuid,

  -- Detected by magic bytes, then declared MIME, then extension (5.1.8).
  file_kind dam_file_kind not null default 'other',
  -- Mirror of the current version.
  mime_type text not null default 'application/octet-stream'
    constraint dam_assets_mime_type_check
    check (mime_type ~ '^[-\w.+]+/[-\w.+*]+$'),
  -- Mirror; a sortable facet.
  size_bytes bigint not null default 0
    constraint dam_assets_size_bytes_check
    check (size_bytes >= 0),
  -- Mirror, after EXIF orientation.
  width integer
    constraint dam_assets_width_check
    check (width > 0),
  height integer
    constraint dam_assets_height_check
    check (height > 0),
  -- Mirror (video/audio).
  duration_ms integer
    constraint dam_assets_duration_ms_check
    check (duration_ms >= 0),
  -- Mirror (PDF, INDD).
  page_count integer
    constraint dam_assets_page_count_check
    check (page_count >= 0),

  -- [D-236] Generated stored from width/height: ratio >= 2.4 is panorama,
  -- 0.95-1.05 is square, otherwise landscape or portrait. One rule in one
  -- place, never drifting from the pixels.
  orientation dam_orientation
    generated always as (
      case
        when width is null or height is null then null
        when (greatest(width, height)::numeric / least(width, height)::numeric) >= 2.4
          then 'panorama'::dam_orientation
        when (width::numeric / height::numeric) between 0.95 and 1.05
          then 'square'::dam_orientation
        when width > height then 'landscape'::dam_orientation
        else 'portrait'::dam_orientation
      end
    ) stored,
  -- Generated stored: the "min resolution" facet.
  long_edge_px integer
    generated always as (greatest(width, height)) stored,
  megapixels numeric(6,2)
    generated always as (round((width::numeric * height) / 1000000, 2)) stored,

  -- Capture moment resolved by the fallback chain of 5.1.5.
  captured_at timestamptz,
  -- provider-sourced dates are excluded from the "has a real capture date"
  -- completeness test.
  captured_at_source text
    constraint dam_assets_captured_at_source_check
    check (captured_at_source in ('exif','xmp','iptc','filename','provider','manual')),
  -- "Make Model", with Make de-duplicated from Model.
  camera text,
  lens text,
  -- Feeds the "suggested project location" hint, never the project's own
  -- coordinates.
  gps_latitude double precision
    constraint dam_assets_gps_latitude_check
    check (gps_latitude between -90 and 90),
  gps_longitude double precision
    constraint dam_assets_gps_longitude_check
    check (gps_longitude between -180 and 180),
  -- Top five [{ "hex": "#8A6A45", "weight": 0.31 }] from the 320 px thumbnail.
  dominant_colours jsonb,
  -- 12 hue buckets plus 3 neutrals (black/grey/white) derived from
  -- dominant_colours; copied to the search row.
  colour_buckets smallint[] not null default '{}'
    constraint dam_assets_colour_buckets_check
    check (colour_buckets <@ array[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14]::smallint[]),

  -- Trigger-maintained from dam_ratings (02b).
  rating_avg numeric(3,2) not null default 0
    constraint dam_assets_rating_avg_check
    check (rating_avg between 0 and 5),
  rating_count integer not null default 0
    constraint dam_assets_rating_count_check
    check (rating_count >= 0),
  -- [D-012] checklist.
  completeness_score smallint not null default 0
    constraint dam_assets_completeness_check
    check (completeness_score between 0 and 100),
  completeness_computed_at timestamptz,
  -- [D-237] Set when the ingest chain reaches reindex_asset. `processing` in
  -- the API is exactly `processed_at is null`: one nullable timestamp beats a
  -- boolean plus a state machine, and it dates the completion for the ingest
  -- report.
  processed_at timestamptz,
  -- Set by merge (5.1.7); the API answers 301 for the old id.
  merged_into_asset_id uuid
    references dam_assets (id) on delete set null,
  -- Folder path as dropped or as walked. Ingest metadata and migration
  -- evidence only — NEVER an organising unit.
  ingest_relative_path text
    constraint dam_assets_ingest_relative_path_length_check
    check (length(ingest_relative_path) <= 2000),
  -- Legal or contractual hold ([D-346], read by 02b 2B.51): retention never
  -- purges this asset and the trash sweep skips it. A held row may still be
  -- soft-deleted, so the hold survives a user's delete and blocks only the
  -- irreversible step.
  legal_hold boolean not null default false,
  -- [D-238] Migration evidence with documented keys { folder_id, folder_path,
  -- subpath, web_view_link, publish_permission, tags }. One jsonb keeps six
  -- dead-after-migration columns off the hottest table; the v1 id itself is a
  -- dam_external_ids row (dwp_dam_v1), per DQ17, not a column here.
  legacy jsonb not null default '{}',
  -- Machine review flags: needs_project, needs_review, derivatives_failed,
  -- oversize, duplicate_open. Cleared by editors or by the job that fixed the
  -- cause.
  flags text[] not null default '{}',

  -- A half-set GPS pair is a data error, not a partial fix.
  constraint dam_assets_gps_together_check
    check ((gps_latitude is null) = (gps_longitude is null)),
  constraint dam_assets_merged_not_self_check check (merged_into_asset_id <> id),
  -- `superseded` exists only as the outcome of a merge, so it must name its
  -- survivor.
  constraint dam_assets_superseded_has_target_check
    check (status <> 'superseded' or merged_into_asset_id is not null)
);

comment on table dam_assets is
  'The asset record (SPEC 2.19). Bytes and EXIF live on dam_asset_versions; facets live on dam_asset_search. Faceted search never reads this table.';
comment on column dam_assets.mime_type is
  'Mirror of the current version (D-234): the grid reads it on every row and must not join dam_asset_versions.';
comment on column dam_assets.orientation is
  'Generated from width/height (D-236). Panorama at ratio >= 2.4, square at 0.95-1.05.';
comment on column dam_assets.processed_at is
  'Null means "still processing" (D-237). There is no separate processing boolean.';
comment on column dam_assets.photographer_id is
  'Mirror of dam_asset_rights.photographer_id (D-235), maintained by the rights trigger.';
comment on column dam_assets.legacy is
  'Migration evidence blob (D-238). The v1 asset id is a dam_external_ids row, not a column here.';


-- ---------------------------------------------------------------------------
-- 2.6  dam_project_assets — the project-to-asset link
-- ---------------------------------------------------------------------------
-- Written here, out of section order, because it references dam_assets.
-- BRIEF 3: "many-to-many with a per-link rank and is_hero flag". An asset may
-- belong to zero, one or many projects; the link carries the marketing
-- presentation order and the single hero flag. Everything else (keywords,
-- fields, rights, album membership) hangs off the asset, never off the link.
create table dam_project_assets (
  id uuid primary key default gen_random_uuid(),
  -- Also the primary-project tie-break (DQ6: primary = earliest link).
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  -- Soft delete is an unlink; the asset survives.
  deleted_at timestamptz,
  deleted_by uuid,

  project_id uuid not null
    references dam_projects (id) on delete cascade,
  asset_id uuid not null
    references dam_assets (id) on delete cascade,
  -- [D-219] Dense 1..n within the project, assigned max(rank)+1 on insert and
  -- re-densified by dam_rerank_project(). Drag ordering rewrites the whole
  -- list, so gaps buy nothing and a dense rank makes "position n" and
  -- sort=rank exact.
  rank integer not null
    constraint dam_project_assets_rank_check
    check (rank >= 1),
  -- [D-004] Exactly one per project — a partial unique index, so it is in the
  -- index file. dam_projects.hero_asset_id is its denormalised pointer
  -- (D-214).
  is_hero boolean not null default false,
  -- migration for folder-derived links, rule for filename-intelligence
  -- promotions, ai for an accepted project_match suggestion.
  source dam_link_source not null default 'manual',
  -- Confidence of the suggestion that produced the link; null for manual.
  suggestion_confidence numeric(4,3)
    constraint dam_project_assets_confidence_range_check
    check (suggestion_confidence between 0 and 1),

  constraint dam_project_assets_confidence_source_check
    check (suggestion_confidence is null or source in ('ai','rule'))
);

comment on table dam_project_assets is
  'Project-to-asset link (SPEC 2.6) carrying the marketing rank and the single hero flag. Linking is a project act, not an asset act.';
comment on column dam_project_assets.rank is
  'Dense 1..n per project (D-219); dam_rerank_project() rewrites the list under an advisory lock.';


-- ---------------------------------------------------------------------------
-- 2.20  dam_asset_versions — immutable file versions (DQ7)
-- ---------------------------------------------------------------------------
-- A replace inserts a new row and moves dam_assets.current_version_id; the
-- previous object is never overwritten, so history is byte-exact and
-- derivatives of older versions stay valid. Every hash and every embedded
-- metadata block lives here.
create table dam_asset_versions (
  id uuid primary key default gen_random_uuid(),
  -- Upload time of this version.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  -- [D-481] Soft-deleted only with the asset, or as a single non-current
  -- version purged by global_admin+.
  deleted_at timestamptz,
  deleted_by uuid,

  asset_id uuid not null
    references dam_assets (id) on delete cascade,
  -- 1, 2, 3 … per asset, assigned under
  -- pg_advisory_xact_lock(hashtext(asset_id::text)).
  version_no integer not null
    constraint dam_asset_versions_version_no_check
    check (version_no >= 1),
  -- Changes only when the tiering job moves the object.
  storage_location_id uuid not null
    references dam_storage_locations (id) on delete restrict,
  -- [D-STOR-01] Opaque provider key: a Drive fileId, or a bucket-relative key.
  object_key text not null
    constraint dam_asset_versions_object_key_length_check
    check (length(object_key) between 1 and 1024),
  -- Shared Drive id / bucket when it differs from the location's default.
  object_container text,
  -- Provider parent (Drive folder id / key prefix) as verified at
  -- finalizeUpload; reconciliation evidence, never an addressing scheme.
  object_parent_key text,
  -- The provider's own view URL (webViewLink); display and migration only —
  -- never fetched by the platform.
  provider_url text,
  original_filename text not null
    constraint dam_asset_versions_original_filename_length_check
    check (length(btrim(original_filename)) between 1 and 512),
  -- Detected, not declared.
  mime_type text not null
    constraint dam_asset_versions_mime_type_check
    check (mime_type ~ '^[-\w.+]+/[-\w.+*]+$'),
  -- Verified against the provider at finalizeUpload.
  size_bytes bigint not null
    constraint dam_asset_versions_size_bytes_check
    check (size_bytes >= 0),
  -- Lower-case hex, written by the hash job. Deliberately NOT unique: the same
  -- bytes may legitimately exist as two versions after a merge (5.1.7).
  sha256 char(64)
    constraint dam_asset_versions_sha256_check
    check (sha256 ~ '^[0-9a-f]{64}$'),
  -- Provider-supplied where available (Drive md5Checksum).
  md5 char(32)
    constraint dam_asset_versions_md5_check
    check (md5 ~ '^[0-9a-f]{32}$'),
  -- [D-007] 64-bit dHash of the 320 px greyscale render; null for non-visual
  -- kinds.
  phash bigint,
  -- [D-478] Generated stored 16-bit bands of phash. The four-band pre-filter
  -- is what makes a Hamming <= 6 candidate search indexable: by the pigeonhole
  -- principle a match at <= 6 bits shares at least one whole band.
  phash_b0 integer generated always as (((phash >> 48) & 65535)::int) stored,
  phash_b1 integer generated always as (((phash >> 32) & 65535)::int) stored,
  phash_b2 integer generated always as (((phash >> 16) & 65535)::int) stored,
  phash_b3 integer generated always as ((phash & 65535)::int) stored,
  -- After EXIF orientation.
  width integer
    constraint dam_asset_versions_width_check
    check (width > 0),
  height integer
    constraint dam_asset_versions_height_check
    check (height > 0),
  duration_ms integer
    constraint dam_asset_versions_duration_ms_check
    check (duration_ms >= 0),
  page_count integer
    constraint dam_asset_versions_page_count_check
    check (page_count >= 0),
  -- ICC description or ColorSpace; drives sRGB conversion in derivatives.
  colour_profile text,
  -- Pruned of MakerNotes and binary blobs, <= 64 KB (5.1.5).
  exif jsonb not null default '{}',
  iptc jsonb not null default '{}',
  xmp jsonb not null default '{}',
  -- Video/audio technical block (codec, frame rate, bit rate, rotation).
  media jsonb not null default '{}',
  -- (ALTER) → dam_users(id) on delete set null. Who produced THIS version;
  -- differs from the asset's created_by after a replace.
  uploaded_by uuid,
  -- Free text, plus the reserved forms merged_from:<asset id>,
  -- restore:<version_no> and rollback (5.1.9).
  replaced_reason text
    constraint dam_asset_versions_replaced_reason_length_check
    check (length(replaced_reason) <= 500),
  -- When extract_metadata last succeeded.
  extracted_at timestamptz,
  -- When tiering_sweep last moved the object between locations.
  tiered_at timestamptz,
  -- derivatives_failed, hash_failed, oversize, truncated; read by the admin
  -- Storage screen.
  flags text[] not null default '{}',

  -- Plain unique (no predicate in the spec): version numbers stay unique even
  -- across a soft-deleted version, so a purged number is never reused.
  constraint dam_asset_versions_asset_id_version_no_key unique (asset_id, version_no)
);

comment on table dam_asset_versions is
  'Immutable file versions (SPEC 2.20, DQ7). A version is an object; trg_dam_asset_versions_immutable refuses edits that would make it something else (D-239).';
comment on column dam_asset_versions.object_key is
  'Opaque provider key (D-STOR-01). Never a path: Drive paths go stale on rename or move.';
comment on column dam_asset_versions.sha256 is
  'Deliberately not unique: the same bytes may legitimately exist as two versions after a merge.';
comment on column dam_asset_versions.phash_b0 is
  'One of four generated 16-bit bands of phash (D-478); the pigeonhole pre-filter for Hamming <= 6 search.';


-- ---------------------------------------------------------------------------
-- 2.21  dam_derivatives — generated renditions per version (DQ7, [D-008])
-- ---------------------------------------------------------------------------
-- Thumbnail 320, preview 1200, proxy 2560 (longest edge), video poster and MP4
-- proxy, PDF first-page render, contact sheet, typed placeholder. Always in the
-- Supabase Storage location ([D-STOR-02]), served through the CDN with signed
-- URLs ([D-009]). Drive's thumbnailLink is never a derivative: it expires
-- within hours and is forbidden to Google Slides.
create table dam_derivatives (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Null for worker-written rows.
  created_by uuid,
  updated_by uuid,
  -- A regenerate replaces rather than accumulates.
  deleted_at timestamptz,
  deleted_by uuid,

  version_id uuid not null
    references dam_asset_versions (id) on delete cascade,
  -- [D-240] Denormalised from the version so the RLS predicate and "all
  -- derivatives of this asset" need no join.
  asset_id uuid not null
    references dam_assets (id) on delete cascade,
  kind dam_derivative_kind not null,
  -- The derivatives default location; trg_dam_derivatives_location refuses any
  -- other (D-STOR-02).
  storage_location_id uuid not null
    references dam_storage_locations (id) on delete restrict,
  -- Content-addressed key (derivatives/<version id>/<kind>-<page>.<format>),
  -- which is what lets the CDN cache it immutable.
  object_key text not null,
  format text not null
    constraint dam_derivatives_format_check
    check (format in ('webp','jpeg','png','avif','mp4','pdf','svg')),
  -- Null for mp4/pdf.
  width integer
    constraint dam_derivatives_width_check
    check (width > 0),
  height integer
    constraint dam_derivatives_height_check
    check (height > 0),
  -- Page or frame index for pdf_page / contact_sheet.
  page smallint not null default 1
    constraint dam_derivatives_page_check
    check (page >= 1),
  size_bytes bigint
    constraint dam_derivatives_size_bytes_check
    check (size_bytes >= 0),
  -- [D-479] `unsupported` means no real preview exists, so the UI never
  -- retries; `failed` is retryable.
  status dam_derivative_status not null default 'queued',
  -- [D-479] True when object_key points at the one placeholder rendered per
  -- (file_kind, extension) rather than at bytes of this version.
  is_shared_placeholder boolean not null default false,
  -- The generate_derivatives job stops at [D-018]'s limit.
  attempts smallint not null default 0
    constraint dam_derivatives_attempts_check
    check (attempts >= 0),
  -- Last failure, trimmed to 2,000 chars by the writer.
  error text,
  -- When status became ready.
  generated_at timestamptz,

  -- A ready derivative with no object is a lie the CDN would cache.
  constraint dam_derivatives_ready_has_object_check
    check (status <> 'ready' or object_key is not null)
);

comment on table dam_derivatives is
  'Generated renditions per version (SPEC 2.21). Machine-written, so no audit trigger (D-201).';
comment on column dam_derivatives.asset_id is
  'Denormalised from the version (D-240) to keep the RLS predicate join-free.';
comment on column dam_derivatives.is_shared_placeholder is
  'The object is the shared typed placeholder, not bytes of this version (D-479).';


-- ---------------------------------------------------------------------------
-- 2.22  dam_render_cache — on-the-fly renders, cached (BRIEF 4.5)
-- ---------------------------------------------------------------------------
-- "Never make the user download a 60 MB TIFF to get a 1200 px JPG." Keyed by
-- (version_id, params_hash) so the same request is rendered once ([D-508]).
-- A cache, not data: exempt from audit ([D-201]), evicted by the render_cache
-- retention policy, and rebuildable at any time.
create table dam_render_cache (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The principal whose request first produced the render; null for worker
  -- pre-renders.
  created_by uuid,
  updated_by uuid,
  -- Set by eviction before the object is deleted; rows are hard-deleted by
  -- purge_trash afterwards.
  deleted_at timestamptz,
  deleted_by uuid,

  version_id uuid not null
    references dam_asset_versions (id) on delete cascade,
  -- Denormalised for the RLS predicate, as in 2.21.
  asset_id uuid not null
    references dam_assets (id) on delete cascade,
  -- [D-241] SHA-256 hex of the canonicalised render parameters. The canonical
  -- form fixes key order and includes w, h, fit, dpi, format, quality, profile,
  -- crop, aspect_ratio, gravity, watermark — watermark and crop are INSIDE the
  -- hash so a watermarked variant can never be served in place of a clean one.
  params_hash text not null
    constraint dam_render_cache_params_hash_check
    check (params_hash ~ '^[0-9a-f]{64}$'),
  -- The canonical parameter object the hash was taken over; kept for debugging
  -- and for rebuilding after an eviction.
  params jsonb not null,
  -- The derivatives location, prefix renders/.
  storage_location_id uuid not null
    references dam_storage_locations (id) on delete restrict,
  object_key text not null,
  format text not null
    constraint dam_render_cache_format_check
    check (format in ('webp','jpeg','png','avif','tiff','pdf')),
  -- Actual output.
  width integer
    constraint dam_render_cache_width_check
    check (width > 0),
  height integer
    constraint dam_render_cache_height_check
    check (height > 0),
  size_bytes bigint
    constraint dam_render_cache_size_bytes_check
    check (size_bytes >= 0),
  -- Incremented by the render RPC, not by a trigger.
  hits integer not null default 1
    constraint dam_render_cache_hits_check
    check (hits >= 0),
  -- Eviction key: cold after 90 days ([D-508]).
  last_hit_at timestamptz not null default now()
);

comment on table dam_render_cache is
  'Cache of on-the-fly renders keyed by (version_id, params_hash) (SPEC 2.22, D-508). Rebuildable; no audit and no reindex trigger (D-201).';
comment on column dam_render_cache.params_hash is
  'Watermark and crop are inside the hash (D-241) so a watermarked render can never be served as a clean one.';


-- ---------------------------------------------------------------------------
-- 2.22a  dam_asset_crops — saved manual crop boxes, one per (asset, ratio)
-- ---------------------------------------------------------------------------
-- Defined as a sub-section of 2.22 rather than as a numbered table of its own.
-- Smart cropping (BRIEF 4.5, part 5 section 5.5) proposes a subject-aware box;
-- when a person drags it, the corrected box is stored here and every later
-- render and document placement at that ratio reuses it instead of re-running
-- the suggestion. Without this table a manual correction would live only in
-- the render cache and would be lost the moment the cache was evicted or the
-- asset re-derived.
create table dam_asset_crops (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Who corrected the crop.
  created_by uuid,
  updated_by uuid,
  -- A removed crop falls back to the suggestion.
  deleted_at timestamptz,
  deleted_by uuid,

  asset_id uuid not null
    references dam_assets (id) on delete cascade,
  -- (ALTER) → dam_aspect_ratios(id) on delete cascade, part 02b.
  aspect_ratio_id uuid not null,
  -- [D-255] The version the box was drawn against. A replace mints a new
  -- version, so a box drawn on the old one is advisory rather than
  -- authoritative and the editor re-confirms it — the subject may have moved.
  version_id uuid
    references dam_asset_versions (id) on delete set null,

  -- Fractions rather than pixels, so one box survives every derivative size.
  x numeric(6,5) not null
    constraint dam_asset_crops_x_check
    check (x >= 0 and x < 1),
  y numeric(6,5) not null
    constraint dam_asset_crops_y_check
    check (y >= 0 and y < 1),
  w numeric(6,5) not null
    constraint dam_asset_crops_w_check
    check (w > 0 and x + w <= 1),
  h numeric(6,5) not null
    constraint dam_asset_crops_h_check
    check (h > 0 and y + h <= 1),
  -- ai when an accepted `crop` suggestion produced it, manual when a person
  -- drew it.
  source dam_link_source not null default 'manual',
  -- (ALTER) → dam_ai_suggestions(id) on delete set null, part 02b.
  suggestion_id uuid,

  constraint dam_asset_crops_ai_has_suggestion_check
    check (source <> 'ai' or suggestion_id is not null)
);

comment on table dam_asset_crops is
  'Saved manual crop boxes, one per (asset, aspect ratio) (SPEC 2.22a). Boxes are fractions of the image so they survive every derivative size, and they outlive the render cache, which is the whole point of the table.';
comment on column dam_asset_crops.version_id is
  'The version the box was drawn against (D-255). After a replace the box is advisory until re-confirmed.';


-- ---------------------------------------------------------------------------
-- 2.23  dam_asset_search — the denormalised search and facet row (DQ5)
-- ---------------------------------------------------------------------------
-- 1:1 with dam_assets. Every list, facet count and permission predicate on the
-- hot path reads this table and nothing else; the raw tables are never joined
-- at query time. Machine-owned: written by row triggers for the asset's own
-- columns and by reindex_asset / reindex_project for cascaded and aggregate
-- changes, in batches of 1,000.
--
-- DEVIATION FROM SPEC 2.0 [D-242] — the one table in this part whose primary
-- key is not `id`. The PK is asset_id, because part 3's helper functions read
-- dam_asset_search(asset_id) by primary key and a second uuid per row buys
-- nothing. `id`, `updated_by` and `deleted_by` are omitted because no user
-- ever writes a row. created_at, updated_at, created_by and deleted_at are
-- COPIES OF THE ASSET'S values, not of this row's, because they are query
-- columns (keyset sort, "own uploads", trash filter) — which is also why this
-- table gets neither dam_set_updated_at() nor an audit trigger (D-201).
create table dam_asset_search (
  asset_id uuid primary key
    references dam_assets (id) on delete cascade,
  -- Copy of dam_assets.created_at; the keyset sort key.
  created_at timestamptz not null,
  -- Copy of dam_assets.updated_at.
  updated_at timestamptz not null,
  -- Copy; part of the read predicate ("or the caller created it").
  created_by uuid,
  -- Copy; every select predicate starts `deleted_at is null`.
  deleted_at timestamptz,
  -- When this row was last rebuilt; the staleness monitor compares it with
  -- updated_at.
  indexed_at timestamptz not null default now(),

  -- [D-011] Weights: A filename, title, project code; B caption, keyword names
  -- (asset + project), project name, client name, category name; C text blocks
  -- on the project, employee names on the project, photographer; D OCR text
  -- (first 200,000 characters, [D-243]). Built with the `simple` dictionary
  -- over dam_unaccent() — an IMMUTABLE wrapper, because unaccent() itself is
  -- not immutable and cannot be indexed.
  search_tsv tsvector not null default ''::tsvector,
  -- filename + title + project code + project name, space-joined; the
  -- misspelling fallback.
  trigram_text text not null default '',
  -- Sort key sort=filename.
  filename text not null default '',
  -- Sort key sort=title.
  title text,

  -- [D-244] Confirmed asset-namespace keyword ids, EXPANDED to include
  -- ancestors, so "include sub-keywords" is a plain &&/@> test instead of a
  -- subtree expansion per query.
  asset_keyword_ids uuid[] not null default '{}',
  -- Live project links.
  project_ids uuid[] not null default '{}',
  -- Union of the linked projects' keywords, ancestors included.
  project_keyword_ids uuid[] not null default '{}',
  -- Union of home + contributing studios of the linked projects, else the
  -- asset's own studio_id; the studio half of the RLS predicate.
  studio_ids uuid[] not null default '{}',
  client_ids uuid[] not null default '{}',
  -- Projects where this asset is the hero.
  hero_of_project_ids uuid[] not null default '{}',
  -- cardinality(hero_of_project_ids) > 0.
  is_hero_anywhere boolean not null default false,

  category_id uuid,
  photographer_id uuid,
  -- The primary project's country.
  country_code char(2),
  -- Date part of dam_assets.captured_at.
  captured_on date,
  orientation dam_orientation,
  long_edge_px integer,
  megapixels numeric(6,2),
  -- Sort key and the size:>50mb filter.
  size_bytes bigint not null default 0,
  file_kind dam_file_kind not null default 'other',
  mime_type text,
  -- From dam_rights_status(asset_id); moved by the nightly rights_sweep as
  -- well as by edits, because time alone changes it.
  rights_status dam_rights_status not null default 'unknown',
  -- [D-378] The later of the rights row's embargo and the project's
  -- confidential_until, copied so the read predicate needs no join.
  embargo_until date,
  -- 12 hues plus 3 neutrals.
  colour_buckets smallint[] not null default '{}',
  rating_avg numeric(3,2) not null default 0,
  rating_count integer not null default 0,
  -- Facet "Under-tagged" and sort=completeness_score.
  completeness_score smallint not null default 0,
  status dam_asset_status not null default 'pending',
  -- The EFFECTIVE level (D-362: explicit, else the most restrictive linked
  -- project's, else the category's).
  access_level_id uuid,
  -- The current version's, so sha: search and by-hash lookups need no join.
  sha256 char(64),
  -- The current version's; the similarity fallback when no embedding exists.
  phash bigint,
  has_embedding boolean not null default false,
  has_ocr boolean not null default false,
  has_rights boolean not null default false,
  has_gps boolean not null default false,
  -- Filter filter[ingest_batch_id] on the ingest report.
  ingest_batch_id uuid,
  -- [D-245] Everything facetable that is not worth a column. Reserved keys:
  -- city, project_status (array), project_codes (array), missing (array of
  -- project/keywords/caption/rights/photographer/category), and one
  -- field:<key> entry per dam_fields row with is_facet = true, carrying the
  -- EFFECTIVE value (asset override, else inheritable project value).
  facet_fields jsonb not null default '{}'
);

comment on table dam_asset_search is
  'Denormalised search and facet row, 1:1 with dam_assets (SPEC 2.23, DQ5). PK is asset_id, not id, and id/updated_by/deleted_by are omitted (D-242): part 3 reads this row by primary key, no user ever writes it, and a second uuid per row would buy nothing. created_at/updated_at/created_by/deleted_at are copies of the asset row, so this table takes neither dam_set_updated_at() nor an audit trigger (D-201). Written only by dam_rebuild_asset_search().';
comment on column dam_asset_search.asset_keyword_ids is
  'Ancestor-expanded (D-244) so subtree matching is one array operator, not a per-query tree walk.';
comment on column dam_asset_search.facet_fields is
  'Reserved keys plus one field:<key> per facetable custom field, carrying the effective value (D-245).';


-- ---------------------------------------------------------------------------
-- 2.24  dam_asset_embeddings — vectors for semantic and visual search
-- ---------------------------------------------------------------------------
-- Kept out of dam_asset_search so the search row stays narrow and a re-embed
-- never rewrites it. One row per asset; both vectors are nullable because they
-- arrive from different jobs at different times. The provider is OPEN (Q9);
-- the dimensions are fixed by [D-006] so the schema is stable whichever
-- provider wins — a dimension change is a full re-embed and a migration.
create table dam_asset_embeddings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Null: worker-written.
  created_by uuid,
  updated_by uuid,
  -- Soft-deleted with the asset.
  deleted_at timestamptz,
  deleted_by uuid,

  asset_id uuid not null
    references dam_assets (id) on delete cascade,
  -- Which version was embedded; a replace re-embeds and moves this pointer.
  version_id uuid
    references dam_asset_versions (id) on delete set null,

  -- [D-006] Joint image-text model (Vertex multimodalembedding@001 or
  -- equivalent); the source is the proxy derivative, or the video poster.
  image_embedding vector(1408),
  -- Provider + model + version string, e.g. vertex:multimodalembedding@001.
  -- Empty while unembedded; a mismatch with the configured model marks the row
  -- stale.
  image_model text not null default '',
  image_embedded_at timestamptz,
  image_source text
    constraint dam_asset_embeddings_image_source_check
    check (image_source in ('proxy','preview','poster','original','pdf_page')),

  -- [D-006] Text model (gemini-embedding-001 MRL or equivalent) over caption +
  -- alt text + keyword names + OCR summary + the project's approved
  -- description.
  text_embedding vector(768),
  text_model text not null default '',
  text_embedded_at timestamptz,
  -- [D-247] SHA-256 of the normalised text input. The embed job skips a
  -- re-embed when it is unchanged, which is what makes a keyword-merge
  -- reindex cheap.
  text_input_hash char(64),
  -- Last embedding failure, trimmed to 2,000 chars by the writer.
  last_error text,

  -- Plain unique (no predicate in the spec): the 1:1 relationship holds even
  -- for a soft-deleted row, because the row is only ever deleted with the
  -- asset.
  constraint dam_asset_embeddings_asset_id_key unique (asset_id),
  -- A vector whose model is unknown cannot be compared with anything.
  constraint dam_asset_embeddings_image_model_check
    check (image_embedding is null or image_model <> ''),
  constraint dam_asset_embeddings_text_model_check
    check (text_embedding is null or text_model <> '')
);

comment on table dam_asset_embeddings is
  'Image and text embeddings, 1:1 with dam_assets (SPEC 2.24). Dimensions are fixed by D-006; changing one is a full re-embed and a migration. Machine-written, so no audit trigger (D-201).';
comment on column dam_asset_embeddings.text_input_hash is
  'Skips a re-embed when the normalised text input is unchanged (D-247).';


-- ---------------------------------------------------------------------------
-- 2.25  dam_asset_ocr_text — extracted text, one row per page (BRIEF 4.3)
-- ---------------------------------------------------------------------------
-- A PDF's own text layer is preferred; OCR runs only when the layer yields
-- under 50 characters (5.1.8). Feeds search_tsv at weight D and the ocr:
-- search prefix, and carries its own tsvector so a page-level ts_headline
-- snippet ("Match on page 4") can be produced without re-reading the asset.
create table dam_asset_ocr_text (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Null: worker-written.
  created_by uuid,
  updated_by uuid,
  -- Soft-deleted with the version.
  deleted_at timestamptz,
  deleted_by uuid,

  -- OCR belongs to bytes, not to the asset.
  version_id uuid not null
    references dam_asset_versions (id) on delete cascade,
  -- Denormalised for the RLS predicate and the reindex read.
  asset_id uuid not null
    references dam_assets (id) on delete cascade,
  -- Images are always page 1.
  page smallint not null default 1
    constraint dam_asset_ocr_text_page_check
    check (page >= 1),
  -- Empty pages are not stored, which is why the lower bound is 1.
  text text not null
    constraint dam_asset_ocr_text_length_check
    check (length(text) between 1 and 1000000),
  -- Generated stored: the >= 50-character rule and the "text layer or OCR"
  -- decision read it.
  char_count integer generated always as (length(text)) stored,
  -- BCP-47 as detected (th, en, vi). Drives nothing today — the dictionary is
  -- `simple` ([D-011]) — and is kept for when stemming is revisited.
  language text,
  -- Null for a text layer, which is not a guess.
  confidence numeric(4,3)
    constraint dam_asset_ocr_text_confidence_check
    check (confidence between 0 and 1),
  source text not null
    constraint dam_asset_ocr_text_source_check
    check (source in ('pdf_text_layer','ocr')),
  -- pdftotext, tesseract:5.3, vertex:document-ocr; provenance for a re-run.
  engine text,
  -- [D-248] Generated stored. dam_unaccent() is the IMMUTABLE wrapper that a
  -- generated column and a GIN index both require; unaccent() itself is only
  -- STABLE. Page-level snippets come from here; the asset-level weight-D
  -- lexemes are built by the reindex job.
  ocr_tsv tsvector not null
    generated always as (to_tsvector('simple', dam_unaccent(text))) stored
);

comment on table dam_asset_ocr_text is
  'Text extracted from images and PDFs, one row per page (SPEC 2.25). Machine-written, so no audit trigger (D-201).';
comment on column dam_asset_ocr_text.ocr_tsv is
  'Generated with the immutable dam_unaccent() wrapper (D-248); unaccent() alone is not immutable and cannot be indexed.';


-- ---------------------------------------------------------------------------
-- 2.26  dam_asset_duplicates — candidate duplicate pairs and their resolution
-- ---------------------------------------------------------------------------
-- Exact pairs come from sha256, near pairs from the 64-bit dHash with Hamming
-- <= 6 ([D-007], [D-478]). A pair is stored once, never twice, and near
-- duplicates are never auto-resolved.
create table dam_asset_duplicates (
  id uuid primary key default gen_random_uuid(),
  -- Detection time.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Null for the dedupe job.
  created_by uuid,
  updated_by uuid,
  -- A pair whose asset is trashed is soft-deleted with it.
  deleted_at timestamptz,
  deleted_by uuid,

  -- The LOWER uuid of the pair.
  asset_id uuid not null
    references dam_assets (id) on delete cascade,
  -- The HIGHER uuid. [D-249] Canonical ordering stores a pair once, so the
  -- unique index alone prevents the mirrored row and the UI never shows the
  -- same pair twice. trg_dam_asset_duplicates_order swaps the ids when a
  -- caller supplies them the other way round.
  duplicate_asset_id uuid not null
    references dam_assets (id) on delete cascade,
  kind text not null
    constraint dam_asset_duplicates_kind_check
    check (kind in ('exact','near')),
  -- `embedding` is reserved for the similarity-driven sweep and is never
  -- auto-resolved.
  method text not null
    constraint dam_asset_duplicates_method_check
    check (method in ('sha256','md5','phash','embedding')),
  -- Hamming distance for phash; null for exact.
  distance smallint
    constraint dam_asset_duplicates_distance_check
    check (distance between 0 and 64),
  -- Cosine similarity for embedding.
  similarity numeric(5,4)
    constraint dam_asset_duplicates_similarity_check
    check (similarity between 0 and 1),
  -- The version of asset_id that matched, so a later replace does not make the
  -- pair confusing.
  version_id uuid
    references dam_asset_versions (id) on delete set null,
  duplicate_version_id uuid
    references dam_asset_versions (id) on delete set null,
  -- kept_both and not_duplicate suppress re-prompting for this pair forever.
  status text not null default 'open'
    constraint dam_asset_duplicates_status_check
    check (status in ('open','merged','skipped','kept_both','not_duplicate')),
  -- (ALTER) → dam_users(id) on delete set null.
  resolved_by uuid,
  resolved_at timestamptz,
  resolution_note text
    constraint dam_asset_duplicates_note_length_check
    check (length(resolution_note) <= 1000),
  -- (ALTER) → dam_jobs(id) on delete set null, part 02b. Which dedupe run
  -- found the pair.
  job_id uuid,

  -- [D-249] Canonical ordering: the pair is stored once, in uuid order.
  constraint dam_asset_duplicates_canonical_order_check
    check (asset_id < duplicate_asset_id),
  -- Resolved exactly when it is not open.
  constraint dam_asset_duplicates_resolved_check
    check ((status = 'open') = (resolved_at is null))
);

comment on table dam_asset_duplicates is
  'Candidate duplicate pairs and how a human resolved them (SPEC 2.26). This table IS audited, unlike the search and cache tables, because it records a human decision.';
comment on column dam_asset_duplicates.duplicate_asset_id is
  'The higher uuid of the canonically ordered pair (D-249); the ordering is what makes the mirrored row impossible.';


-- ---------------------------------------------------------------------------
-- 2.27  dam_ingest_sources — watched folders and scheduled walks (BRIEF 4.1)
-- ---------------------------------------------------------------------------
-- A source names a provider subtree, the defaults to apply to everything found
-- under it, and the CHANGE CURSOR that makes incremental ingest possible.
--
-- This table is where the measured Drive hazard is encoded: a whole-drive
-- files.list with a q filter is eventually consistent on a scale of HOURS
-- (measured 2026-09-04: folders created 40+ minutes earlier were still absent;
-- a probe folder never appeared in six minutes of polling), while
-- changes.list, files.get and parent-scoped listings are consistent within
-- seconds. So a source polls the Changes API from `cursor` and walks only
-- parent-scoped listings; a global q search is forbidden anywhere in the
-- platform.
create table dam_ingest_sources (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  -- A deleted source stops polling, but its batches survive.
  deleted_at timestamptz,
  deleted_by uuid,

  name text not null
    constraint dam_ingest_sources_name_length_check
    check (length(btrim(name)) between 1 and 120),
  -- [D-475] watched_folder is Changes-driven and polled every 5 min;
  -- scheduled_walk is a cron-driven parent-scoped walk; manual_walk is
  -- one-shot and sets is_active false when it finishes.
  kind dam_ingest_source_kind not null,
  storage_location_id uuid not null
    references dam_storage_locations (id) on delete restrict,
  -- Provider key of the watched subtree (a Drive folder id); validated with
  -- head() at create time.
  root_key text not null
    constraint dam_ingest_sources_root_key_length_check
    check (length(root_key) between 1 and 1024),
  -- Human path for the admin screen only — DISPLAY DATA, NEVER ADDRESSING,
  -- because paths go stale on rename.
  root_path_display text,

  -- Used when folder mapping finds nothing.
  default_project_id uuid
    references dam_projects (id) on delete set null,
  default_category_id uuid
    references dam_categories (id) on delete restrict,
  -- Asset-namespace keyword ids applied to everything ingested. No FK (it is
  -- an array); trg_dam_ingest_sources_validate_defaults checks them.
  default_keyword_ids uuid[] not null default '{}',
  -- (ALTER) → dam_access_levels(id) on delete restrict, part 02b.
  default_access_level_id uuid,
  -- The studio hint when the resolved project has none.
  default_studio_id uuid
    references dam_studios (id) on delete restrict,
  -- (ALTER) → dam_photographers(id) on delete set null, part 02b. A watched
  -- folder usually belongs to one photographer's deliveries.
  default_photographer_id uuid,
  -- Rights applied at creation: { copyright_holder_id, policy_id, restriction,
  -- expires_on, model_release }. Validated against the rights schema by the
  -- worker, not by a CHECK.
  default_rights jsonb not null default '{}',
  -- Folder-to-project/category/keyword rules: { project_code_regex,
  -- use_aliases, location_segments, collection_to_category,
  -- subpath_to_keywords }. The defaults reproduce 5.1.3.
  mapping_rules jsonb not null default '{}',
  -- [D-474] No bytes move when the subtree already lies inside this location;
  -- false forces a stream-copy into the originals location.
  register_in_place boolean not null default true,

  -- Five-field cron for a scheduled_walk. The spec notes an application-level
  -- default of '0 1 * * *'; the field table gives the column no database
  -- default, so none is declared here.
  schedule text,
  -- IANA name the cron is read in; defaults to the owning studio's, applied by
  -- the worker.
  timezone text,
  -- [D-250] PROVIDER CHANGE CURSOR — a Drive changes.list page token,
  -- persisted after every page so a cold worker resumes exactly where it
  -- stopped. Null means "take a fresh start token, then walk the subtree
  -- once".
  cursor text,
  cursor_updated_at timestamptz,
  -- [D-251] Last full parent-scoped reconciliation walk. A weekly walk is the
  -- safety net for anything the feed missed, and it REPLACES the reference
  -- app's 48-hour candidate-token promotion: that rule existed only because a
  -- cold instance's bootstrap LISTING lagged by hours, and v2 never bootstraps
  -- from a listing.
  reconcile_walk_at timestamptz,
  -- [D-475] What a `trashed` change event does to the registered asset.
  on_source_delete text not null default 'ignore'
    constraint dam_ingest_sources_on_source_delete_check
    check (on_source_delete in ('ignore','trash')),
  last_run_at timestamptz,
  -- { files_seen, files_added, files_updated, files_skipped, folders_seen,
  -- took_ms }.
  last_run_stats jsonb not null default '{}',
  -- Trimmed to 2,000 chars; shown on the Watched Folders screen.
  last_error text,
  -- The poller backs off and, at 10, deactivates the source and raises a
  -- sync_failed notification.
  consecutive_failures smallint not null default 0
    constraint dam_ingest_sources_consecutive_failures_check
    check (consecutive_failures >= 0),
  is_active boolean not null default true,

  constraint dam_ingest_sources_schedule_required_check
    check (kind <> 'scheduled_walk' or schedule is not null)
);

comment on table dam_ingest_sources is
  'Watched folders and scheduled walks (SPEC 2.27). Drive whole-drive listings are eventually consistent on a scale of hours, so ingest is driven by the Changes cursor and parent-scoped walks only.';
comment on column dam_ingest_sources.cursor is
  'Provider change cursor, persisted per page (D-250) so a cold worker resumes exactly where it stopped.';
comment on column dam_ingest_sources.root_path_display is
  'Display only. Paths go stale on rename; addressing is always (storage_location_id, root_key).';


-- ---------------------------------------------------------------------------
-- 2.28  dam_ingest_batches — an upload batch
-- ---------------------------------------------------------------------------
-- The metadata applied at point of upload (BRIEF 4.1) plus the resumable-
-- session bookkeeping that lets a reload continue an interrupted drop.
-- `metadata` is frozen at commit so a file that finishes uploading afterwards
-- is committed with exactly the same values as its siblings.
create table dam_ingest_batches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- [D-420] The uploader. An uncommitted batch is visible only to them.
  created_by uuid,
  updated_by uuid,
  -- Committed batches are kept as ingest history.
  deleted_at timestamptz,
  deleted_by uuid,

  -- Optional label ("Santiburi shoot, March").
  name text
    constraint dam_ingest_batches_name_length_check
    check (length(name) <= 200),
  -- draft -> uploading -> committed. Idle 7 days becomes abandoned by
  -- purge_trash, which also deletes the partial provider objects.
  status text not null default 'draft'
    constraint dam_ingest_batches_status_check
    check (status in ('draft','uploading','committed','abandoned','cancelled')),
  -- The originals location the sessions were opened against.
  storage_location_id uuid not null
    references dam_storage_locations (id) on delete restrict,
  -- Set on system batches created by a walk or a watched folder.
  ingest_source_id uuid
    references dam_ingest_sources (id) on delete set null,
  -- (ALTER) → dam_upload_requests(id) on delete set null, part 02b. Set when
  -- an external photographer's deposit created the batch.
  upload_request_id uuid,
  -- Also decides whether files land `pending` ([D-005]).
  category_id uuid
    references dam_categories (id) on delete restrict,
  -- (ALTER) → dam_access_levels(id) on delete restrict, part 02b.
  -- null = inherit.
  access_level_id uuid,
  -- Projects every file is linked to. No FK (it is an array); validated by
  -- trigger.
  project_ids uuid[] not null default '{}',
  -- The batch form: { keyword_ids[], fields{}, rights{}, title_prefix,
  -- photographer_id, studio_id }. Per-file overrides live on the child rows.
  metadata jsonb not null default '{}',
  -- Set at commit. After it, metadata, project_ids, category_id and
  -- access_level_id are immutable and PATCH returns 409 — bulk edit is the way
  -- to change committed assets.
  metadata_frozen_at timestamptz,

  -- Trigger-maintained from the child rows.
  files_total integer not null default 0
    constraint dam_ingest_batches_files_total_check
    check (files_total between 0 and 2000),
  files_uploaded integer not null default 0,
  files_committed integer not null default 0,
  files_failed integer not null default 0,
  -- [D-470] 200 GiB per batch.
  bytes_total bigint not null default 0
    constraint dam_ingest_batches_bytes_total_check
    check (bytes_total >= 0 and bytes_total <= 214748364800),
  -- [D-473] Refreshed by the client every 5 chunks or 10 s; powers the
  -- progress bar after a reload.
  bytes_uploaded bigint not null default 0,
  committed_at timestamptz,
  -- Draft lifetime; the resume list shows batches until then.
  expires_at timestamptz not null default (now() + interval '7 days'),
  last_error text,

  constraint dam_ingest_batches_committed_at_check
    check ((status = 'committed') = (committed_at is not null)),
  -- Metadata may only be frozen by a terminal state.
  constraint dam_ingest_batches_frozen_status_check
    check (metadata_frozen_at is null or status in ('committed','cancelled'))
);

comment on table dam_ingest_batches is
  'Upload batch (SPEC 2.28): the metadata applied at point of upload plus resumable-session bookkeeping. Metadata freezes at commit so late-finishing files get the same values as their siblings.';
comment on column dam_ingest_batches.metadata_frozen_at is
  'Once set, metadata/project_ids/category_id/access_level_id are immutable; changing committed assets is a bulk edit.';


-- ---------------------------------------------------------------------------
-- 2.28a  dam_ingest_batch_files — one row per file in a batch  [D-252]
-- ---------------------------------------------------------------------------
-- Described in prose in SPEC 2.28a rather than with a field table, and
-- deliberately absent from the DECISIONS section 2 inventory; the design
-- requires it, so it is created here. It carries the seven standard columns
-- (the spec text says "six", but section 2.0 defines seven and deleted_by is
-- present on every table in this part per [D-200]) plus the per-file
-- resumable-session state, the metadata overrides applied on top of the batch
-- defaults, and the duplicate decision taken at commit.
create table dam_ingest_batch_files (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  batch_id uuid not null
    references dam_ingest_batches (id) on delete cascade,
  -- Reserved at session open, filled at commit.
  asset_id uuid
    references dam_assets (id) on delete set null,
  filename text not null,
  relative_path text,
  mime_type text,
  size_bytes bigint,
  last_modified timestamptz,
  -- The browser's early duplicate check, before any bytes are sent.
  client_sha256 char(64),
  -- A file always has a state; a null would sit outside the CHECK's vocabulary
  -- without violating it, and every sibling column here declares one.
  state text not null default 'pending'
    constraint dam_ingest_batch_files_state_check
    check (state in ('pending','session_open','uploading','uploaded',
                     'committed','skipped','error','cancelled','expired')),
  -- ENCRYPTED AT REST WITH THE APP KEY: a resumable-session URL is a bearer
  -- credential, so it is never stored or logged in the clear.
  session_url text,
  session_expires_at timestamptz,
  provider_key text,
  committed_bytes bigint not null default 0,
  attempts smallint not null default 0,
  -- Per-file overrides of the batch metadata.
  overrides jsonb not null default '{}',
  duplicate_of_asset_id uuid
    references dam_assets (id),
  duplicate_action text
    constraint dam_ingest_batch_files_duplicate_action_check
    check (duplicate_action in ('skip','replace','keep_both')),
  needs_project boolean not null default false,
  error text
);

comment on table dam_ingest_batch_files is
  'One row per file in an upload batch (SPEC 2.28a, D-252). Uniqueness is (batch_id, lower(filename), coalesce(relative_path, '''')) — an expression index, so it lives in the index file.';
comment on column dam_ingest_batch_files.session_url is
  'Resumable-session URL: a bearer credential. Encrypted at rest with the app key, never logged.';


-- ---------------------------------------------------------------------------
-- 2.29  dam_external_ids — identifiers this platform did not mint (DQ17)
-- ---------------------------------------------------------------------------
-- OpenAsset integer ids, the v1 common_dam_assets uuid, HubSpot company and
-- deal ids, BambooHR employee ids, ProjectWorks client and project ids, Marq
-- document ids, Drive file ids for register-in-place assets. Every importer is
-- idempotent on (system, external_id), and every connector resolves its own
-- records through this table rather than by matching names.
create table dam_external_ids (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  -- Follows the target (SPEC 2.0).
  deleted_at timestamptz,
  deleted_by uuid,

  -- [D-253] Any of the seven values, with NO check narrowing it: external
  -- systems have opinions about studios, clients and albums too, and this is
  -- the one polymorphic table that should accept all of them.
  target_type dam_target_type not null,
  -- No FK (polymorphic); dam_assert_target_exists() checks it.
  target_id uuid not null,
  -- Immutable together with external_id: a re-pointed id is a delete plus an
  -- insert, so the audit log shows the move.
  system dam_external_system not null,
  -- The foreign key as that system spells it (OpenAsset integers as text,
  -- uuids, Drive fileId).
  external_id text not null
    constraint dam_external_ids_external_id_length_check
    check (length(btrim(external_id)) between 1 and 300),
  -- A second, human-facing identifier from the same system (ProjectWorks
  -- project number, HubSpot deal name) shown in the sync UI; never unique.
  external_code text,
  external_url text
    constraint dam_external_ids_external_url_check
    check (external_url is null or external_url ~* '^https?://'),
  -- Last small snapshot of the foreign record, used for conflict display.
  -- Never the full record, <= 16 KB.
  payload jsonb not null default '{}',
  -- Last successful sync touch; null means "linked but never synced".
  synced_at timestamptz,
  -- (ALTER) → dam_sync_runs(id) on delete set null, part 02b. Which run last
  -- wrote the row.
  sync_run_id uuid,
  -- Trimmed to 2,000 chars by the writer.
  last_error text
);

comment on table dam_external_ids is
  'Foreign identifiers (SPEC 2.29, DQ17). Uniqueness is (system, external_id) and (target_type, target_id, system) among live rows — both partial, so both live in the index file.';
comment on column dam_external_ids.target_type is
  'Deliberately unnarrowed (D-253): external systems have opinions about studios, clients and albums too.';


-- ===========================================================================
-- SECTION 2 — Supporting domain tables (SPEC part 02b, 2B.1–2B.53 plus 2B.45a)
-- ===========================================================================
-- Target: PostgreSQL 15+ on Supabase. Runs after 00-preamble.sql (extensions,
-- enum types, shared functions) and after 10-core-tables.sql, whose 31 tables
-- this file references inline wherever the target already exists.
--
-- WHAT IS IN THIS FILE
--   `create table` only: columns, defaults, not-null, primary keys, check
--   constraints, foreign keys that can be declared inline, generated columns,
--   the three RANGE-partitioned log parents with their first partitions, and
--   comments on anything whose reason is not obvious from the name.
--
-- WHAT IS DELIBERATELY NOT IN THIS FILE
--   * Indexes, including every UNIQUE that the spec expresses as a *partial*
--     index (`... where deleted_at is null`, `... where x is not null`) or over
--     an *expression* (`lower(name)`). Those cannot be table constraints, so
--     they live in 30-indexes-search.sql. A plain `unique (a, b)` with no
--     predicate does sit on the table here.
--   * RLS policies and trigger definitions — 40-rls-policies.sql. Every table
--     below is `enable row level security` there, never `force` (SPEC 2B.0).
--   * Enum types and shared functions — 00-preamble.sql.
--
-- TABLE ORDER
--   Dependency order, not spec-section order, so that every inline
--   `references` target already exists. The visible effects are that 2B.1
--   `dam_users` leads (every other table in both files points at it); that
--   2B.22 `dam_copyright_policies` and 2B.21 `dam_copyright_holders` are
--   written before 2B.20 `dam_photographers`, which carries a default of each,
--   and all three before 2B.23 `dam_asset_rights`, which points at all three;
--   that 2B.25 `dam_aspect_ratios` precedes 2B.24 `dam_sizes`; and that 2B.50
--   `dam_ai_runs` precedes 2B.49 `dam_ai_suggestions`.
--
-- DEFERRED FOREIGN KEYS  (block at the END of this file)
--   Two kinds of FK are added later with `alter table … add constraint`:
--     1. Cycle breakers — the reference runs both ways, so no ordering helps:
--        `dam_copyright_holders.photographer_id`,
--        `dam_text_blocks.current_version_id`,
--        `dam_templates.current_version_id`.
--     2. Forward references within this file — the target is created further
--        down for a dependency reason of its own: the two `ai_run_id` columns,
--        the three `suggestion_id` columns, and
--        `dam_jobs.integration_id` / `dam_jobs.webhook_delivery_id`.
--   No FK in this file points at 10-core-tables.sql and has to wait: every
--   such target already exists. The traffic runs the other way — that file
--   ends with its own `alter table … add constraint` block full of FKs
--   pointing AT the tables below (`dam_users`, `dam_access_levels`,
--   `dam_photographers`, `dam_employees`, `dam_upload_requests`,
--   `dam_ai_suggestions`, `dam_api_keys`, `dam_jobs`, `dam_sync_runs`,
--   `dam_aspect_ratios`).
--   BOTH blocks — that file's and this one's — are written to run after every
--   table in both files exists. Execute the two `create table` bodies first,
--   then the two deferred blocks.
--
-- STANDARD COLUMNS (SPEC 2B.0) — on every table below:
--   id uuid primary key default gen_random_uuid()
--   created_at  timestamptz not null default now()
--   updated_at  timestamptz not null default now()   (trg_<t>_set_updated_at)
--   created_by  uuid        (→ dam_users, deferred)
--   updated_by  uuid        (→ dam_users, deferred)
--   deleted_at  timestamptz
--   deleted_by  uuid        (→ dam_users, deferred) — ONLY on tables whose rows
--               appear in a trash UI. Several append-only tables (join rows,
--               logs, deliveries, runs) deliberately omit it; each says so.
-- The partitioned log parents (2B.36–2B.38) carry the columns they need and
-- their children inherit them; the children repeat nothing.
--
-- POLYMORPHIC TARGETS (SPEC 2B.0, D-349)
--   A `(target_type dam_target_type, target_id uuid)` pair never carries an FK
--   on target_id. `dam_assert_polymorphic_target()` is called from a BEFORE
--   INSERT OR UPDATE trigger (40-) and `dam_soft_delete_dependants()` from the
--   target tables' soft-delete triggers. One predicate, one cascade, instead
--   of five hand-written variants.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 2B.1  dam_users — every human or system principal (DQ4, D-102)
-- ---------------------------------------------------------------------------
-- Identity (email) comes from the dwp auth broker; role, studios and flags are
-- owned HERE and never read back from the broker's claim. The employee record
-- links from the other side (dam_employees.user_id) because contractors and
-- leavers are employees without accounts and workers are users without
-- employees.
--
-- This table leads the file: `created_by`/`updated_by`/`deleted_by` on every
-- table in BOTH files point at it, including its own (self-reference).
create table dam_users (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Null for first-login provisioning; the inviting admin otherwise.
  created_by uuid,
  updated_by uuid,
  -- Trash. Deactivation is is_active = false; deletion is reserved for
  -- mistaken and duplicate accounts.
  deleted_at timestamptz,
  deleted_by uuid,

  -- Normalised by trg_dam_users_normalise_email before the CHECK ever sees it,
  -- which is why the CHECK can be an equality rather than a tolerance. Plain
  -- `text`, not citext [D-270]: one fewer extension, and the trigger makes the
  -- constraint always hold. Unique over ALL rows, deleted included — an email
  -- identifies one principal forever — so it is a plain table constraint.
  email text not null
    constraint dam_users_email_check
    check (email = lower(btrim(email))
           and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  display_name text not null
    constraint dam_users_display_name_length_check
    check (length(display_name) between 1 and 120),
  -- Last `picture` claim seen at sign-in; a UI fallback only. Headshots come
  -- from dam_employee_headshots, never from SSO.
  sso_picture_url text,
  -- Optional library asset used as the avatar.
  avatar_asset_id uuid
    references dam_assets (id) on delete set null,
  -- Global role (DQ3). Per-studio elevation is dam_user_studios.role_override.
  role dam_role not null default 'viewer',
  -- [D-271] Auto-provisioned users start false unless their email domain is in
  -- setting `users.auto_activate_domains` (seeded ["dwp.com"]): staff on the
  -- firm domain are active on first sign-in, anyone else waits for an admin.
  is_active boolean not null default false,
  -- [D-272] Migration, worker, sync and ai principals, with fixed seed ids.
  is_system boolean not null default false,
  -- The §4.8 "see other studios' work" permission (DQ3, DQ11).
  cross_studio_visibility boolean not null default false,
  -- Reserved for a later Supabase Auth adoption; unique where not null, which
  -- is a partial index and so lives in the index file.
  auth_uid uuid,
  -- Written by the session exchange.
  last_login_at timestamptz,
  login_count integer not null default 0,
  -- BCP-47.
  locale text not null default 'en-GB',
  -- IANA name; null means the firm timezone (setting `firm.timezone`).
  timezone text,
  -- Per-user preferences, Zod-validated by the API: notifications per
  -- dam_notification_kind, grid_density, default_studio_id, appearance.
  -- Unknown keys are rejected there, not here.
  settings jsonb not null default '{}',

  constraint dam_users_email_key unique (email),
  -- [D-272] A system principal must be inert and must live on the reserved
  -- domain: it can never sign in and can never be confused with a colleague.
  constraint dam_users_system_principal_check
    check (not is_system
           or (not is_active and email like '%@system.dam.invalid'))
);

comment on table dam_users is
  'Every human or system principal (SPEC 2B.1, DQ4, D-102). Role, studios and flags are owned here, never by the auth broker.';
comment on column dam_users.email is
  'Unique over ALL rows including deleted: an email identifies one principal forever. Lower-cased and trimmed by trigger (D-270).';
comment on column dam_users.is_system is
  'Migration, worker, sync and ai principals with fixed seed ids (D-272); never active, always on @system.dam.invalid.';
comment on column dam_users.settings is
  'Zod-validated per-user preferences; unknown keys are rejected by the API, not by a CHECK here.';


-- ---------------------------------------------------------------------------
-- 2B.2  dam_groups — named sets of users (brief §3)
-- ---------------------------------------------------------------------------
-- Used by access grants and album collaboration. Optionally studio-scoped; a
-- null studio_id is a firm-wide group.
create table dam_groups (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  -- Unique case-insensitively among live rows, so the constraint is the
  -- partial expression index dam_groups_lower_name_key.
  name text not null
    constraint dam_groups_name_length_check
    check (length(btrim(name)) between 1 and 80),
  -- API-generated from name; unique over all rows, so a plain constraint.
  slug text not null
    constraint dam_groups_slug_format_check
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text,
  -- Null = firm-wide group.
  studio_id uuid
    references dam_studios (id) on delete set null,
  -- Seeded groups (marketing, bid-team, studio-directors) may be renamed but
  -- never deleted; trg_dam_groups_protect_system enforces it.
  is_system boolean not null default false,
  -- An inactive group confers nothing: dam_has_grant() ignores it.
  is_active boolean not null default true,
  -- Denormalised from dam_group_members live rows by
  -- trg_dam_group_members_count, so the admin list needs no per-row count.
  member_count integer not null default 0
    constraint dam_groups_member_count_check
    check (member_count >= 0),

  constraint dam_groups_slug_key unique (slug)
);

comment on table dam_groups is
  'Named sets of users for grants and album collaboration (SPEC 2B.2). Case-insensitive name uniqueness among live rows is a partial expression index, so it lives in the index file.';
comment on column dam_groups.member_count is
  'Trigger-maintained count of live dam_group_members rows.';


-- ---------------------------------------------------------------------------
-- 2B.3  dam_group_members — membership join
-- ---------------------------------------------------------------------------
-- One row per (group, user) EVER. Removal sets deleted_at and re-adding
-- clears it, so the same row carries the whole history and the audit log reads
-- as a sequence of changes rather than as unrelated inserts. That is why the
-- unique constraint covers all rows, not just live ones, and why it can be a
-- plain table constraint.
--
-- No deleted_by: the row is a join, not a trash-UI object (SPEC 2B.0).
create table dam_group_members (
  id uuid primary key default gen_random_uuid(),
  -- = added at.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Who added the member.
  created_by uuid,
  updated_by uuid,
  -- = removed at.
  deleted_at timestamptz,

  group_id uuid not null
    references dam_groups (id) on delete cascade,
  user_id uuid not null
    references dam_users (id) on delete cascade,

  constraint dam_group_members_group_id_user_id_key unique (group_id, user_id)
);

comment on table dam_group_members is
  'Membership join (SPEC 2B.3). Unique over ALL rows, deleted included: removal is deleted_at and re-adding restores the same row, so history stays auditable.';


-- ---------------------------------------------------------------------------
-- 2B.4  dam_user_studios — studio membership and per-studio elevation (DQ3, DQ11)
-- ---------------------------------------------------------------------------
-- Drives default visibility ("projects whose home or contributing studio is
-- one of mine") and carries the role override that makes someone a
-- studio_admin of one studio without any global rights.
--
-- dam_current_studio_ids() reads the `studio_ids` JWT claim, which the session
-- mint fills from this table's live rows — so a change here takes effect at
-- the next mint (<= 15 min) unless the API invalidates the mint cache, which
-- it does on write.
--
-- No deleted_by: a membership row is a join, not a trash-UI object.
create table dam_user_studios (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,

  user_id uuid not null
    references dam_users (id) on delete cascade,
  studio_id uuid not null
    references dam_studios (id) on delete cascade,
  -- `viewer` is pointless (it is the floor) and global_admin/owner are global
  -- by definition, so only the middle three may be granted per studio.
  role_override dam_role
    constraint dam_user_studios_role_override_check
    check (role_override in ('contributor', 'editor', 'studio_admin')),
  -- [D-274] Home studio; at most one LIVE row per user, which is a partial
  -- unique index and so lives in the index file. Used as the default
  -- upload/project studio and for BambooHR `location` reconciliation.
  is_primary boolean not null default false,

  constraint dam_user_studios_user_id_studio_id_key unique (user_id, studio_id)
);

comment on table dam_user_studios is
  'Studio membership and per-studio role elevation (SPEC 2B.4, DQ3, DQ11). Live rows feed the studio_ids JWT claim, so a change takes effect at the next token mint.';
comment on column dam_user_studios.is_primary is
  'Home studio (D-274). At most one live row per user — a partial unique index, so it lives in the index file.';


-- ---------------------------------------------------------------------------
-- 2B.5  dam_access_levels — named visibility tiers (brief §4.8, DQ3, D-013)
-- ---------------------------------------------------------------------------
-- Applied to categories, projects and individual assets. Four rows are seeded
-- and are the only ones most tenants need: Firm-wide, Studio (the default),
-- Restricted and Confidential. The FKs from dam_categories, dam_projects and
-- dam_assets are `restrict` (10-core-tables.sql), so a level in use can never
-- vanish; trg_dam_access_levels_protect_system stops the seeded four being
-- soft-deleted at all.
create table dam_access_levels (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  -- Unique case-insensitively among live rows: partial expression index.
  name text not null
    constraint dam_access_levels_name_length_check
    check (length(btrim(name)) between 1 and 60),
  slug text not null
    constraint dam_access_levels_slug_format_check
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text,
  -- Minimum global/effective role that satisfies the level without a grant.
  min_role dam_role not null,
  -- firm = any active user of sufficient role; studio = additionally requires
  -- studio membership or cross_studio_visibility; grant_only = requires a
  -- dam_access_grants row AND role >= min_role. Creators and global_admin+
  -- always pass, which is dam_access_level_allows()' business, not a CHECK's.
  scope dam_access_scope not null,
  -- Exactly one live default (the seeded `Studio` level), applied to new
  -- projects and categories when none is chosen. One-live-row uniqueness is a
  -- partial index, so it lives in the index file;
  -- trg_dam_access_levels_single_default clears the flag elsewhere on write.
  is_default boolean not null default false,
  -- [D-275] When set, renders served to callers whose effective role is below
  -- this carry the watermark (brief §4.5, "per access level"). Null = no
  -- level-driven watermark; all four seeded levels are null.
  watermark_below_role dam_role,
  sort_order integer not null default 0,
  is_system boolean not null default false,

  constraint dam_access_levels_slug_key unique (slug)
);

comment on table dam_access_levels is
  'Named visibility tiers for categories, projects and assets (SPEC 2B.5, D-013). Four seeded rows; case-insensitive name uniqueness and the single-live-default rule are partial indexes in the index file.';
comment on column dam_access_levels.scope is
  'firm / studio / grant_only. The creator and global_admin+ bypass is applied by dam_access_level_allows(), not by a constraint here.';
comment on column dam_access_levels.watermark_below_role is
  'D-275: renders for callers below this effective role are watermarked. Null on all four seeded levels.';


-- ---------------------------------------------------------------------------
-- 2B.6  dam_access_grants — extends a level to named users or groups (DQ3)
-- ---------------------------------------------------------------------------
-- The mechanism behind `grant_only` levels, and behind giving one outsider a
-- look at a Restricted project. Expired grants are NOT deleted — dam_has_grant()
-- simply ignores them, which keeps "who could see this in March" answerable.
--
-- No deleted_by: deleted_at here means revoked, and the revoker is the row's
-- updated_by.
create table dam_access_grants (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The grantor.
  created_by uuid,
  updated_by uuid,
  -- = revoked at.
  deleted_at timestamptz,

  access_level_id uuid not null
    references dam_access_levels (id) on delete cascade,
  user_id uuid
    references dam_users (id) on delete cascade,
  group_id uuid
    references dam_groups (id) on delete cascade,
  -- [D-276] Temporary grants (bid-period access); null = until revoked.
  expires_at timestamptz,
  -- Why the grant exists. Shown in the admin UI and kept in the audit row.
  note text,

  -- Exactly one of the two: a grant is to a user or to a group, never both and
  -- never neither.
  constraint dam_access_grants_subject_check
    check ((user_id is null) <> (group_id is null))
);

comment on table dam_access_grants is
  'Grants of an access level to a user or a group (SPEC 2B.6, DQ3). Both uniqueness rules are partial (one per subject among live rows), so they live in the index file. Expired grants are kept and ignored by dam_has_grant().';


-- ---------------------------------------------------------------------------
-- 2B.7  dam_api_keys — hashed bearer keys for /api/v2 and the /api/v1 shim
-- ---------------------------------------------------------------------------
-- Replaces the DAM_API_KEYS env list (DQ4, DQ10) with per-key hashing, scopes,
-- studio confinement, rate limits, expiry and revocation. A key resolves to a
-- principal and mints the same claims a session does.
--
-- The plaintext key is shown once at creation and never stored: only its
-- sha256 and its first 12 characters live here, and the row audit redacts
-- key_hash as well (2B.36).
create table dam_api_keys (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  -- Keys are revoked, not deleted; the trash exists only for mistakes.
  deleted_at timestamptz,
  deleted_by uuid,

  -- encode(sha256(key::bytea), 'hex') of the full key string. Unique over all
  -- rows, so a plain table constraint.
  key_hash text not null
    constraint dam_api_keys_key_hash_format_check
    check (key_hash ~ '^[0-9a-f]{64}$'),
  -- First 12 characters (`dam_live_` + 3 hex) for display and support
  -- lookups — enough to identify a key, useless as a credential.
  key_prefix text not null
    constraint dam_api_keys_key_prefix_format_check
    check (key_prefix ~ '^dam_(live|test)_[0-9a-f]{3}$'),
  name text not null
    constraint dam_api_keys_name_length_check
    check (length(btrim(name)) between 1 and 80),
  -- Personal key: the user. Service key: the responsible admin, optionally.
  owner_user_id uuid
    references dam_users (id) on delete cascade,
  -- Machine principal label (dwp-marketing-hub, studioai); null for a personal
  -- key. Its presence is what makes the key a service key.
  service_name text
    constraint dam_api_keys_service_name_format_check
    check (service_name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
           and length(service_name) between 1 and 60),
  -- Generated stored rather than a column the caller may disagree with:
  -- principal kind is a restatement of service_name, never an independent fact.
  principal_kind text
    generated always as (case when service_name is null then 'personal' else 'service' end) stored,
  -- [D-277] The role the key acts with. A personal key is capped at its
  -- owner's role and an `admin` scope requires global_admin+ — both enforced by
  -- trg_dam_api_keys_scope_role, which can read dam_users; a CHECK cannot.
  acting_role dam_role not null default 'viewer',
  scopes text[] not null default '{read}'
    constraint dam_api_keys_scopes_check
    check (scopes <@ array['read', 'write', 'admin', 'share', 'upload']::text[]
           and cardinality(scopes) >= 1),
  -- Confines the key to projects whose home or contributing studio is this
  -- one; replaces the DAM_SITE_ROOTS fence with a real scope. Null = the
  -- owner's visibility, or firm-wide for an unowned service key.
  studio_id uuid
    references dam_studios (id) on delete set null,
  -- [D-279] Token bucket lives in the API (DQ10); 600/min is roughly the burst
  -- the four v1 consumers show in logs today, with headroom.
  rate_limit_per_minute integer not null default 600
    constraint dam_api_keys_rate_limit_check
    check (rate_limit_per_minute > 0),
  -- Null = no expiry (the legacy keys); the admin UI warns at 30 days.
  expires_at timestamptz,
  -- Written at most once per 60 s per key: the API throttles the UPDATE so an
  -- image-heavy page does not turn one row into a hot spot.
  last_used_at timestamptz,
  -- Incremented with the throttled write, so approximate by design.
  use_count bigint not null default 0
    constraint dam_api_keys_use_count_check
    check (use_count >= 0),
  revoked_at timestamptz,
  revoked_by uuid
    references dam_users (id) on delete set null,
  -- owner_deactivated, rotated, compromised, or free text.
  revoked_reason text,
  -- [D-278] Legacy DAM_API_KEYS entry name (dwp_website2026, proposal-maker,
  -- dwp-marketing-hub, studioai), stamped by the v1 shim where v1 wrote
  -- uploaded_by. Unique where not null: a partial index, so it is in the index
  -- file.
  v1_site_name text,
  -- [D-278] Legacy DAM_SITE_ROOTS fence path, honoured by the v1 shim only.
  v1_site_root text,

  -- A key belongs to somebody: either a user owns it or it names a service.
  constraint dam_api_keys_principal_check
    check (owner_user_id is not null or service_name is not null),
  constraint dam_api_keys_key_hash_key unique (key_hash)
);

comment on table dam_api_keys is
  'Hashed bearer keys for /api/v2 and the /api/v1 shim (SPEC 2B.7, DQ4, DQ10). Plaintext is shown once and never stored; the row audit redacts key_hash.';
comment on column dam_api_keys.principal_kind is
  'Generated from service_name: a restatement, never an independent fact the caller can disagree with.';
comment on column dam_api_keys.acting_role is
  'D-277. The personal-key cap and the admin-scope floor need dam_users, so they are trigger rules (trg_dam_api_keys_scope_role), not CHECKs.';
comment on column dam_api_keys.v1_site_root is
  'D-278. The legacy DAM_SITE_ROOTS fence, honoured by the v1 shim only; /api/v2 uses studio_id instead.';


-- ---------------------------------------------------------------------------
-- 2B.8  dam_employees — staff records (brief §3, §4.6; DQ13)
-- ---------------------------------------------------------------------------
-- Identity and HR facts are owned by BambooHR when the connector is on;
-- marketing facts (titles, visibility, experience start) are owned here.
-- Expertise is NOT a column and NOT a child table: it is keyword links in the
-- `employee` namespace (dam_keyword_links with target_type = 'employee', 2A).
--
-- An employee and a user are linked by email from BOTH sides
-- (trg_dam_employees_link_user here, trg_dam_users_link_employee in 2B.1),
-- because contractors and leavers are employees without accounts.
create table dam_employees (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  -- Linked automatically by email; unique where not null, so a partial index.
  user_id uuid
    references dam_users (id) on delete set null,
  -- BambooHR employeeNumber. Also the join key to Projectworks
  -- ExternalReference and to headshot filenames. Unique where not null.
  employee_no text,
  first_name text not null
    constraint dam_employees_first_name_length_check
    check (length(btrim(first_name)) between 1 and 80),
  last_name text not null
    constraint dam_employees_last_name_length_check
    check (length(btrim(last_name)) between 1 and 80),
  preferred_name text
    constraint dam_employees_preferred_name_length_check
    check (length(btrim(preferred_name)) between 1 and 80),
  -- Generated, not a trigger: every input is local to the row.
  display_name text
    generated always as (coalesce(preferred_name, first_name) || ' ' || last_name) stored,
  -- [D-281] The directory sorts by surname, so the sort key is built surname
  -- first. Generated for the same reason as display_name.
  sort_name text
    generated always as (lower(last_name || ', ' || coalesce(preferred_name, first_name))) stored,
  -- HR job title (BambooHR jobTitle).
  title text,
  -- [D-282] The title CVs and proposals use when it differs from HR's
  -- ("Design Director"); templates read coalesce(marketing_title, title).
  marketing_title text,
  department text,
  -- BambooHR `location`, mapped through the integration's lookup transform.
  studio_id uuid
    references dam_studios (id) on delete set null,
  -- Org chart (§4.6). trg_dam_employees_manager_cycle walks up to 50 levels
  -- and raises on a cycle; a CHECK can only catch the self-reference.
  manager_id uuid
    references dam_employees (id) on delete set null,
  -- Work email, lower-cased by trigger. THE cross-system join key (D-702).
  -- Unique among live rows where not null, so a partial index.
  email text
    constraint dam_employees_email_normalised_check
    check (email is null or email = lower(btrim(email))),
  -- E.164 preferred; the shape is validated by Zod at the API, not here,
  -- because imported HR data is worth keeping even when it is untidy.
  phone text,
  pronouns text,
  -- { "linkedin": url, "website": url }.
  links jsonb not null default '{}',
  -- BambooHR hireDate.
  joined_on date,
  -- BambooHR terminationDate.
  left_on date,
  -- [D-283] The date total experience is counted from (SF330 E 14a:
  -- joined_on minus prior experience, entered by marketing). `years_experience`
  -- is NEVER stored: it is dam_employee_years_experience(years_experience_start)
  -- at read time, and "at least N years" compiles to
  -- years_experience_start <= current_date - (N * 365.25)::int — a plain btree
  -- range scan on this column, which a stored, daily-stale number could not be.
  years_experience_start date,
  -- Flipped false once left_on passes (trigger plus the nightly
  -- dam_employee_sweep()). Inactive staff stay for historic project credits.
  is_active boolean not null default true,
  -- Hidden staff still appear on project teams and in CVs they are on.
  is_visible_in_directory boolean not null default true,
  -- [D-555] Consent withdrawal for automated headshot matching (part 5 §5.10).
  -- A column and not a setting because the pipeline, not merely the interface,
  -- must honour it: no reference vector is derived and no employee_match
  -- suggestion may name this person.
  headshot_matching_opt_out boolean not null default false,

  constraint dam_employees_manager_not_self_check check (manager_id <> id),
  constraint dam_employees_left_on_check
    check (left_on is null or joined_on is null or left_on >= joined_on)
);

comment on table dam_employees is
  'Staff records (SPEC 2B.8, DQ13). Expertise lives in dam_keyword_links (namespace employee), never in columns here. The user link, employee_no and email uniqueness rules are all partial indexes, so they live in the index file.';
comment on column dam_employees.sort_name is
  'D-281: surname-first sort key, generated rather than trigger-maintained because every input is local to the row.';
comment on column dam_employees.years_experience_start is
  'D-283. Years of experience are computed, never stored, so an "N+ years" filter is a btree range scan on this date and can never go stale.';
comment on column dam_employees.headshot_matching_opt_out is
  'D-555: consent withdrawal honoured by the matcher itself — no reference vector, no employee_match suggestion.';


-- ---------------------------------------------------------------------------
-- 2B.9  dam_employee_bios — fixed-length bios per locale, with approval (DQ13)
-- ---------------------------------------------------------------------------
-- 25/50/150 words plus custom lengths. Deliberately NOT versioned: editing an
-- approved bio returns it to draft, and full version history belongs to text
-- blocks (2B.18). CV templates read only state = 'approved'.
--
-- No deleted_by: a bio is deleted from the employee page, not from a trash UI.
create table dam_employee_bios (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,

  employee_id uuid not null
    references dam_employees (id) on delete cascade,
  length dam_bio_length not null,
  custom_length_words integer,
  -- BCP-47.
  locale text not null default 'en-GB',
  -- Plain text or minimal Markdown. `length(body)` here is the FUNCTION, not
  -- the enum column named `length` above it: PostgreSQL resolves name(arg) as
  -- a function call whenever a matching function exists, and `body` is text,
  -- not a composite.
  body text not null
    constraint dam_employee_bios_body_length_check
    check (length(body) between 1 and 20000),
  -- Stamped by trg_dam_employee_bios_word_count from dam_word_count(body).
  -- Not generated, because the same trigger is what re-runs it on an edit that
  -- knocks the row back to draft.
  word_count integer not null,
  -- `superseded` is unused here; it is kept so the enum stays uniform across
  -- every text state in the system.
  state dam_text_state not null default 'draft',
  submitted_by uuid
    references dam_users (id) on delete set null,
  submitted_at timestamptz,
  approved_by uuid
    references dam_users (id) on delete set null,
  approved_at timestamptz,
  -- `ai` when drafted by draftDescription; `import` for OpenAsset/CSV.
  source dam_link_source not null default 'manual',
  -- (ALTER) → dam_ai_runs(id) on delete set null; 2B.50 is created later.
  ai_run_id uuid,

  -- A custom length carries a word target and no other length does.
  constraint dam_employee_bios_custom_length_check
    check ((length = 'custom') = (custom_length_words is not null)),
  constraint dam_employee_bios_custom_length_words_check
    check (custom_length_words is null or custom_length_words > 0),
  -- [D-284] Ten per cent over the nominal count, rounded up. A hard cap at the
  -- nominal number rejects legitimate copy that a hyphenation pushed over the
  -- line, and every layout the bios feed tolerates ten per cent.
  constraint dam_employee_bios_word_count_check
    check ((length <> 'w25' or word_count <= 28)
           and (length <> 'w50' or word_count <= 55)
           and (length <> 'w150' or word_count <= 165)
           and (length <> 'custom' or word_count <= ceil(custom_length_words * 1.1))),
  -- An approved bio names its approver and the moment: otherwise "approved" is
  -- an assertion nobody signed.
  constraint dam_employee_bios_approved_check
    check (state <> 'approved' or (approved_by is not null and approved_at is not null))
);

comment on table dam_employee_bios is
  'Fixed-length employee bios per locale with an approval state (SPEC 2B.9, DQ13). Not versioned by design; an edit of an approved bio returns it to draft. One live bio per (employee, length, locale) for non-custom lengths is a partial index in the index file.';
comment on column dam_employee_bios.word_count is
  'Trigger-set from dam_word_count(body), with a ten per cent tolerance on the nominal length (D-284).';


-- ---------------------------------------------------------------------------
-- 2B.10  dam_employee_headshots — staff photos by kind, with an optional crop
-- ---------------------------------------------------------------------------
-- Links a Staff-category asset to an employee, marks the primary used by the
-- directory and CVs, and records provenance (HR import, manual, AI match).
-- The "category must be Staff and file_kind must be an image" rule is enforced
-- by the API rather than here, because a category is data, not schema.
--
-- No deleted_by: the row is a link, removed from the employee page.
create table dam_employee_headshots (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,

  employee_id uuid not null
    references dam_employees (id) on delete cascade,
  asset_id uuid not null
    references dam_assets (id) on delete cascade,
  -- A BambooHR photo import lands as `formal` with source = 'import'.
  kind dam_headshot_kind not null default 'formal',
  -- At most one live primary per employee — a partial unique index, kept in
  -- step by trg_dam_employee_headshots_single_primary.
  is_primary boolean not null default false,
  -- Normalised box on the current version: { x, y, w, h } in 0–1 plus an
  -- optional aspect_ratio_id. The CHECK only asserts the four keys exist;
  -- their ranges are Zod's job, because a jsonb CHECK that walked the numbers
  -- would be unreadable for no extra safety.
  crop jsonb
    constraint dam_employee_headshots_crop_shape_check
    check (crop is null
           or (crop ? 'x' and crop ? 'y' and crop ? 'w' and crop ? 'h')),
  -- `ai` when accepted from a headshot_match suggestion.
  source dam_link_source not null default 'manual',
  -- (ALTER) → dam_ai_suggestions(id) on delete set null; 2B.49 is created later.
  suggestion_id uuid,
  sort_order integer not null default 0
);

comment on table dam_employee_headshots is
  'Staff photos linked to an employee by kind (SPEC 2B.10). Both uniqueness rules — one live link per (employee, asset, kind) and one live primary per employee — are partial indexes in the index file.';
comment on column dam_employee_headshots.crop is
  'Normalised { x, y, w, h } box plus an optional aspect_ratio_id. Key presence is checked here; ranges are validated by Zod.';


-- ---------------------------------------------------------------------------
-- 2B.11  dam_employee_education — education history for CVs (SF330 E 16)
-- ---------------------------------------------------------------------------
-- Owned by BambooHR's `education` table when synced. `include_in_cv` is always
-- DAM-owned, which is the whole point: HR data stays complete while CVs stay
-- curated.
--
-- No deleted_by: rows are removed from the employee page, and the connector
-- soft-deletes rows absent from a re-sync payload.
create table dam_employee_education (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,

  employee_id uuid not null
    references dam_employees (id) on delete cascade,
  institution text not null
    constraint dam_employee_education_institution_length_check
    check (length(btrim(institution)) between 1 and 200),
  -- Degree or award: "MArch", "BSc (Hons)".
  qualification text,
  -- Discipline: "Architecture".
  field text,
  country_code char(2)
    constraint dam_employee_education_country_code_check
    check (country_code ~ '^[A-Z]{2}$'),
  started_on date,
  -- The CV shows only the year.
  completed_on date,
  -- [D-285] The Vantagepoint-style "include in proposals" switch.
  include_in_cv boolean not null default true,
  -- Default order is completed_on desc nulls first; this overrides it.
  sort_order integer not null default 0,
  source dam_link_source not null default 'manual',
  -- [D-286] The source row id (a BambooHR table row id) so a re-sync upserts
  -- instead of duplicating. Unique per employee where not null: partial index.
  external_row_key text,

  constraint dam_employee_education_completed_on_check
    check (completed_on is null or started_on is null or completed_on >= started_on)
);

comment on table dam_employee_education is
  'Education history for CVs (SPEC 2B.11, SF330 E 16). The per-employee uniqueness of external_row_key is a partial index in the index file.';
comment on column dam_employee_education.external_row_key is
  'D-286: the source row id, so a BambooHR re-sync upserts rather than duplicating.';


-- ---------------------------------------------------------------------------
-- 2B.12  dam_employee_registrations — licences, memberships, certifications
-- ---------------------------------------------------------------------------
-- Brief §4.6, SF330 E 17–18, with expiry tracking on the same 90/30/7 ladder
-- as rights (D-003) so there is one mental model for "something is about to
-- run out". DAM-owned unless the tenant has a BambooHR custom table.
--
-- No deleted_by: as 2B.11.
create table dam_employee_registrations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,

  employee_id uuid not null
    references dam_employees (id) on delete cascade,
  -- [D-287] CHECK-constrained text rather than a new enum, so DECISIONS §3
  -- stays the only enum list. Certifications (LEED AP, WELL AP) share the
  -- table because a CV lists them together.
  kind text not null default 'registration'
    constraint dam_employee_registrations_kind_check
    check (kind in ('licence', 'registration', 'membership', 'certification')),
  -- "Registered Architect", "LEED AP BD+C".
  title text not null
    constraint dam_employee_registrations_title_length_check
    check (length(btrim(title)) between 1 and 160),
  -- The issuing body: "ARB", "RIBA", "CoA Thailand", "BOA Singapore", "USGBC".
  body text not null
    constraint dam_employee_registrations_body_length_check
    check (length(btrim(body)) between 1 and 160),
  registration_no text,
  -- Country or state; an ISO code where one applies.
  jurisdiction text,
  issued_on date,
  -- Null = does not expire.
  expires_on date,
  status dam_registration_status not null default 'active',
  -- The scanned certificate; a restricted access level is expected on it.
  evidence_asset_id uuid
    references dam_assets (id) on delete set null,
  -- [D-285]
  include_in_cv boolean not null default true,
  -- [D-288] The last expiry-alert stage sent, so the nightly sweep does not
  -- re-send one. Reset to null when expires_on moves forward.
  last_alert_days smallint
    constraint dam_employee_registrations_last_alert_days_check
    check (last_alert_days in (90, 30, 7)),
  notes text,
  source dam_link_source not null default 'manual',
  -- [D-286]; unique per employee where not null: partial index.
  external_row_key text,

  constraint dam_employee_registrations_expires_on_check
    check (expires_on is null or issued_on is null or expires_on >= issued_on)
);

comment on table dam_employee_registrations is
  'Professional registrations, licences, memberships and certifications with expiry tracking (SPEC 2B.12, brief §4.6). Status edges are trigger-driven; the nightly dam_employee_sweep() flips active to expired and sends the 90/30/7 alerts (D-288).';
comment on column dam_employee_registrations.kind is
  'D-287: CHECK-constrained text, not a new enum, so the DECISIONS §3 enum list stays authoritative.';
comment on column dam_employee_registrations.last_alert_days is
  'The 90/30/7 alert stage already sent; reset to null when expires_on moves forward. Same ladder as rights (D-003).';


-- ---------------------------------------------------------------------------
-- 2B.13  dam_employee_languages — languages and proficiency for CVs
-- ---------------------------------------------------------------------------
-- SF330 E "foreign language capabilities", and the staff search "speaks Thai
-- at C1 or better".
--
-- No deleted_by: as 2B.11.
create table dam_employee_languages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,

  employee_id uuid not null
    references dam_employees (id) on delete cascade,
  -- ISO 639-1/2 with an optional region: th, en, zh-Hant.
  language_code text not null
    constraint dam_employee_languages_language_code_check
    check (language_code ~ '^[a-z]{2,3}(-[A-Za-z]{2,4})?$'),
  -- [D-289] CEFR plus `native`: the scale HR and bid teams already quote, and
  -- it sorts naturally, so "C1 or better" is a range and not a lookup.
  proficiency text not null
    constraint dam_employee_languages_proficiency_check
    check (proficiency in ('a1', 'a2', 'b1', 'b2', 'c1', 'c2', 'native')),
  include_in_cv boolean not null default true,
  sort_order integer not null default 0,
  source dam_link_source not null default 'manual',
  -- [D-286]
  external_row_key text
);

comment on table dam_employee_languages is
  'Languages and CEFR proficiency for CVs and staff search (SPEC 2B.13, D-289). Both uniqueness rules are partial indexes in the index file.';


-- ---------------------------------------------------------------------------
-- 2B.14  dam_project_employees — who did what on which project (DQ13)
-- ---------------------------------------------------------------------------
-- Brief §3 and §4.6. The role is a controlled vocabulary (keyword category
-- "Project Role", namespace `employee`) with a free-text fallback, so the
-- same row reads sensibly from the project's Team tab and from the employee's
-- Experience table, which are two views of this one row.
--
-- No deleted_by: a credit is removed from either side's editor.
create table dam_project_employees (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,

  project_id uuid not null
    references dam_projects (id) on delete cascade,
  employee_id uuid not null
    references dam_employees (id) on delete cascade,
  -- Must be live with namespace = 'employee'; that is a cross-table assertion,
  -- so trg_dam_project_employees_role_keyword enforces it, not a CHECK. The
  -- API narrows the picker to the Project Role category.
  role_keyword_id uuid
    references dam_keywords (id) on delete set null,
  -- Display text, copied from the keyword name when a keyword is chosen and
  -- the title is blank.
  role_title text not null
    constraint dam_project_employees_role_title_length_check
    check (length(role_title) between 1 and 120),
  started_on date,
  -- Null = ongoing.
  ended_on date,
  -- "Key project" for CV selection; SF330 E 19 allows five.
  is_featured boolean not null default false,
  -- Order within the project team list and within the CV.
  sort_order integer not null default 0,
  -- [D-290] One-paragraph role description for CVs.
  description text,
  -- `import` for OpenAsset ProjectEmployees; `ai`/`rule` for an accepted
  -- employee_match suggestion, e.g. from Projectworks timesheets.
  source dam_link_source not null default 'manual',
  -- (ALTER) → dam_ai_suggestions(id) on delete set null; 2B.49 is created later.
  suggestion_id uuid,

  constraint dam_project_employees_ended_on_check
    check (ended_on is null or started_on is null or ended_on >= started_on)
);

comment on table dam_project_employees is
  'Employee-to-project credits with role and dates (SPEC 2B.14, DQ13). Uniqueness is (project_id, employee_id, role_title, started_on) NULLS NOT DISTINCT among live rows (D-291) — partial, so it lives in the index file; the same person may hold two roles or return in a later phase.';


-- ---------------------------------------------------------------------------
-- 2B.15  dam_albums — curated, ordered, nestable collections (brief §3, §4.4)
-- ---------------------------------------------------------------------------
-- Personal by default; `shared` adds collaborators; `company` is visible to
-- every active user. An album NEVER changes an asset's access level — an asset
-- the caller may not read is simply hidden inside any album they can open.
--
-- The on-delete `cascade` from parent to child fires only on a hard purge; the
-- soft-delete cascade is trg_dam_albums_soft_delete, which stamps children
-- with the parent's exact deleted_at so a restore can put back precisely the
-- rows that went down with it.
create table dam_albums (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- Also touched when items change, so an album list can sort by recency.
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  name text not null
    constraint dam_albums_name_length_check
    check (length(name) between 1 and 120),
  description text,
  parent_album_id uuid
    references dam_albums (id) on delete cascade,
  -- `restrict`: an album must always have an owner, so deleting the user is
  -- blocked until ownership is transferred (PATCH /albums/{id}).
  owner_id uuid not null
    references dam_users (id) on delete restrict,
  visibility dam_album_visibility not null default 'personal',
  -- Null = the first live item at read time, so a new album needs no cover.
  cover_asset_id uuid
    references dam_assets (id) on delete set null,
  -- Optional grouping for `company` albums in a studio's album list.
  studio_id uuid
    references dam_studios (id) on delete set null,
  -- [D-292] Live items, trigger-maintained, so album lists never count rows.
  item_count integer not null default 0
    constraint dam_albums_item_count_check
    check (item_count >= 0),
  -- [D-293] Trigger-maintained and cycle-checked. The hard ceiling of 5 is a
  -- CHECK so no trigger bug can produce an unbounded tree; the soft limit is
  -- setting `albums.max_depth`, which defaults to the same 5.
  depth smallint not null default 0
    constraint dam_albums_depth_check
    check (depth between 0 and 5),
  -- Among siblings.
  sort_order integer not null default 0,
  -- Provenance of a dam_duplicate_album() copy. Items are copied, not linked:
  -- the two albums diverge independently from that moment.
  duplicated_from_album_id uuid
    references dam_albums (id) on delete set null,

  constraint dam_albums_parent_not_self_check check (parent_album_id <> id)
);

comment on table dam_albums is
  'Curated, ordered, nestable collections (SPEC 2B.15, brief §4.4). An album never changes an asset''s access level. Uniqueness is (owner_id, parent_album_id, lower(name)) NULLS NOT DISTINCT among live rows — an expression index, so it lives in the index file.';
comment on column dam_albums.depth is
  'Trigger-maintained (D-293). The CHECK is the hard ceiling; the soft limit is setting albums.max_depth.';
comment on column dam_albums.duplicated_from_album_id is
  'Provenance of a dam_duplicate_album() copy. The copy owns its own items; the two albums diverge from then on.';


-- ---------------------------------------------------------------------------
-- 2B.16  dam_album_items — ordered membership with a per-item caption
-- ---------------------------------------------------------------------------
-- sort_order is kept DENSE (1..n) over live rows by trg_dam_album_items_rerank,
-- so drag-to-reorder is a single UPDATE rather than a renumbering round trip.
--
-- [D-294] There is deliberately NO uniqueness on sort_order: density is the
-- trigger's guarantee for live rows only, trashed rows keep their last
-- position so a restore can be re-ranked back into place, and a unique
-- constraint could be neither partial (to skip the trash) nor deferred-partial
-- at once.
--
-- No deleted_by: an item is removed from the album, not sent to a trash UI.
create table dam_album_items (
  id uuid primary key default gen_random_uuid(),
  -- = added at.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Who added it.
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,

  album_id uuid not null
    references dam_albums (id) on delete cascade,
  asset_id uuid not null
    references dam_assets (id) on delete cascade,
  -- Dense 1..n among live items. No default: trg_dam_album_items_default_sort
  -- appends when the caller sends null, which a column default cannot do
  -- because it would have to read the rest of the album.
  sort_order integer not null,
  -- Album-specific; it never touches the asset's own caption.
  caption text
    constraint dam_album_items_caption_length_check
    check (caption is null or length(caption) <= 2000)
);

comment on table dam_album_items is
  'Ordered album membership with a per-item caption (SPEC 2B.16). One live row per (album, asset) is a partial index in the index file; sort_order carries no uniqueness by design (D-294).';
comment on column dam_album_items.sort_order is
  'Dense 1..n over live rows, maintained by dam_rerank_album_items(). A moved row wins ties, so setting it to the target position places it before the item already there.';


-- ---------------------------------------------------------------------------
-- 2B.17  dam_album_collaborators — who else may view, contribute or manage
-- ---------------------------------------------------------------------------
-- Brief §4.4. The owner is an implicit `manage` and never appears here;
-- trg_dam_album_collaborators_not_owner rejects the row that would say so
-- twice. A user's effective permission is the greatest of their direct row and
-- the rows of their active groups.
--
-- No deleted_by: revoking a collaborator is not a trash operation.
create table dam_album_collaborators (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The inviter.
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,

  album_id uuid not null
    references dam_albums (id) on delete cascade,
  user_id uuid
    references dam_users (id) on delete cascade,
  group_id uuid
    references dam_groups (id) on delete cascade,
  -- view = read; contribute = add/remove/reorder items and edit captions;
  -- manage = everything the owner can do except transfer and delete.
  permission dam_album_permission not null default 'view',

  -- Exactly one subject, as in dam_access_grants.
  constraint dam_album_collaborators_subject_check
    check ((user_id is null) <> (group_id is null))
);

comment on table dam_album_collaborators is
  'Album collaborators (SPEC 2B.17, brief §4.4). The owner is implicit manage and never has a row. Both per-subject uniqueness rules are partial indexes in the index file.';


-- ---------------------------------------------------------------------------
-- 2B.18  dam_text_blocks — reusable approved copy (brief §3, DQ14)
-- ---------------------------------------------------------------------------
-- Project descriptions at fixed word counts, boilerplate, awards text,
-- sustainability narratives, service and sector statements. The BLOCK is the
-- stable handle; the words live in 2B.19 versions, and a generated document
-- references a version id, never the live body.
--
-- This is why dam_projects carries no description columns at all (2A): the
-- pointer to a project's 50-word description is
-- (target_type = 'project', target_id, kind = 'project_description',
--  length_words = 50), and the API creates the five length rows lazily.
create table dam_text_blocks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  kind dam_text_block_kind not null,
  -- Null = firm-wide copy (boilerplate). Narrowed to the four target types
  -- that can own copy; an album or an asset cannot.
  target_type dam_target_type
    constraint dam_text_blocks_target_type_check
    check (target_type is null
           or target_type in ('project', 'employee', 'client', 'studio')),
  -- Polymorphic, so no FK (D-349); dam_assert_polymorphic_target() checks it
  -- from a BEFORE INSERT OR UPDATE trigger.
  target_id uuid,
  -- e.g. "Project description — 50 words".
  title text not null
    constraint dam_text_blocks_title_length_check
    check (length(title) between 1 and 200),
  -- Project descriptions are separate rows at 25/50/100/150/300 words.
  length_words integer
    constraint dam_text_blocks_length_words_check
    check (length_words is null or length_words > 0),
  locale text not null default 'en-GB',
  -- (ALTER) → dam_text_block_versions(id) on delete set null. [D-296] The
  -- circular FK with 2B.19 is intentional — block, then version, then the
  -- pointer — so it is attached in the deferred block at the end of this file.
  -- Holds the latest APPROVED version, else null.
  current_version_id uuid,
  version_count integer not null default 0
    constraint dam_text_blocks_version_count_check
    check (version_count >= 0),
  -- Free labels for the library filter: awards, hospitality, boilerplate-en.
  tags text[] not null default '{}',
  -- [D-295] Weight A title, weight B the current version's body. Maintained by
  -- trg_dam_text_blocks_search_tsv and NOT a generated column, because the
  -- body it folds in lives in another table and a generated column may read
  -- only its own row.
  search_tsv tsvector,

  -- A target is a type and an id or neither; half a pointer is a bug.
  constraint dam_text_blocks_target_pair_check
    check ((target_type is null) = (target_id is null))
);

comment on table dam_text_blocks is
  'Reusable approved copy (SPEC 2B.18, DQ14). The block is the handle; the words live in dam_text_block_versions and documents cite a version id. Uniqueness is over coalesce(length_words, 0) — an expression index in the index file.';
comment on column dam_text_blocks.current_version_id is
  'The latest APPROVED version, else null (D-296). Circular with dam_text_block_versions.text_block_id, so the FK is attached in the deferred block at the end of this file.';
comment on column dam_text_blocks.search_tsv is
  'D-295: title at weight A, current version body at weight B. Trigger-maintained, not generated — the body is in another table.';


-- ---------------------------------------------------------------------------
-- 2B.19  dam_text_block_versions — immutable once approved
-- ---------------------------------------------------------------------------
-- draft → in_review → approved → superseded, with in_review → draft when
-- changes are requested. Documents, CVs and the API's include=description all
-- resolve to a version id, so an approved version is never edited and never
-- deleted: a rollback is approving an older version again, which makes it
-- current and supersedes the newer one. No copy is made.
--
-- No deleted_by: a version goes only when its block does, or when its own
-- author withdraws a draft.
create table dam_text_block_versions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The author.
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,

  text_block_id uuid not null
    references dam_text_blocks (id) on delete cascade,
  -- Assigned 1, 2, 3… per block by trg_dam_text_block_versions_number under a
  -- transaction advisory lock, so two concurrent drafts cannot claim the same
  -- number. No default: the trigger owns it.
  version_no integer not null
    constraint dam_text_block_versions_version_no_check
    check (version_no >= 1),
  -- Editable only while state = 'draft'; the guard trigger enforces that.
  body text not null
    constraint dam_text_block_versions_body_length_check
    check (length(body) between 1 and 50000),
  -- Trigger-set from dam_word_count(body). The "<= 110 % of the block's
  -- length_words" rule is enforced in the same trigger and not as a CHECK,
  -- because length_words lives on the parent row.
  word_count integer not null,
  state dam_text_state not null default 'draft',
  submitted_by uuid
    references dam_users (id) on delete set null,
  submitted_at timestamptz,
  approved_by uuid
    references dam_users (id) on delete set null,
  approved_at timestamptz,
  -- What changed and why.
  change_note text,
  -- `ai` for draftDescription output, which always lands as a draft and is
  -- never written straight to approved.
  source dam_link_source not null default 'manual',
  -- (ALTER) → dam_ai_runs(id) on delete set null; 2B.50 is created later.
  ai_run_id uuid,
  -- (ALTER) → dam_ai_suggestions(id) on delete set null; 2B.49 is created later.
  suggestion_id uuid,

  constraint dam_text_block_versions_block_version_key
    unique (text_block_id, version_no),
  -- An approved version names its approver and the moment.
  constraint dam_text_block_versions_approved_check
    check (state <> 'approved' or (approved_by is not null and approved_at is not null)),
  -- A version in review names who put it there.
  constraint dam_text_block_versions_in_review_check
    check (state <> 'in_review' or submitted_by is not null)
);

comment on table dam_text_block_versions is
  'Immutable-once-approved copy versions with an approval workflow (SPEC 2B.19). Approving a version supersedes the block''s other approved versions and repoints dam_text_blocks.current_version_id (D-296).';
comment on column dam_text_block_versions.version_no is
  'Trigger-assigned per block under pg_advisory_xact_lock, so concurrent drafts cannot claim the same number.';
comment on column dam_text_block_versions.word_count is
  'Trigger-set from dam_word_count(body). The +10 %% ceiling against the block''s length_words is a trigger rule, not a CHECK: length_words is on the parent row.';


-- ---------------------------------------------------------------------------
-- 2B.22  dam_copyright_policies — reusable licence terms (brief §4.7, DQ16)
-- ---------------------------------------------------------------------------
-- The permitted uses, territories, duration, credit and download rules that a
-- whole shoot shares. An asset points at one policy and overrides only what
-- differs, so correcting "five-year web licence" once fixes every asset on it.
--
-- Written before dam_copyright_holders and dam_photographers because both of
-- those point at it and it points at neither.
create table dam_copyright_policies (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  -- Unique case-insensitively among live rows: partial expression index.
  name text not null
    constraint dam_copyright_policies_name_length_check
    check (length(name) between 1 and 120),
  slug text not null
    constraint dam_copyright_policies_slug_format_check
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  -- One line shown in the rights-badge tooltip.
  summary text
    constraint dam_copyright_policies_summary_length_check
    check (summary is null or length(summary) <= 300),
  -- Full licence text or the agreed wording.
  terms text
    constraint dam_copyright_policies_terms_length_check
    check (terms is null or length(terms) <= 20000),
  -- The signed licence PDF in the library.
  terms_asset_id uuid
    references dam_assets (id) on delete set null,
  -- [D-300] The base restriction the policy confers. An asset may tighten it
  -- and never loosen it; trg_dam_asset_rights_tighten_only (2B.23) is what
  -- enforces that, because the comparison spans two tables.
  restriction dam_rights_restriction not null default 'cleared',
  -- Empty is meaningless: a policy that permits nothing is do_not_use.
  permitted_uses dam_permitted_use[] not null default '{}'
    constraint dam_copyright_policies_permitted_uses_check
    check (cardinality(permitted_uses) > 0),
  -- [D-301] Every element is 'WW' (worldwide) or an upper-case ISO 3166-1
  -- alpha-2 code, and 'WW' may only appear alone. A sentinel beats a nullable
  -- column here because "worldwide" and "unspecified" are different facts.
  --
  -- MISSING FROM 00-preamble.sql: SPEC 2B.22 declares
  -- dam_valid_territories(text[]) returns boolean IMMUTABLE, but the preamble
  -- does not define it, and a CHECK naming an absent function fails at CREATE
  -- TABLE. It must be added to 00- before this file runs. It is written as the
  -- spec states it rather than inlined here, because dam_asset_rights uses the
  -- same predicate and one definition is the point.
  territories text[] not null default '{WW}'
    constraint dam_copyright_policies_territories_check
    check (dam_valid_territories(territories)),
  -- [D-302] Null = perpetual. Used to derive dam_asset_rights.expires_on.
  duration_months integer
    constraint dam_copyright_policies_duration_months_check
    check (duration_months is null or duration_months > 0),
  credit_required boolean not null default false,
  -- Tokens {{photographer}}, {{company}}, {{holder}}, {{year}}, {{project}},
  -- rendered by the API and never stored on the asset unless overridden.
  credit_template text,
  -- Forces the watermark on every render whatever the size preset or the
  -- share setting says.
  watermark_required boolean not null default false,
  -- False blocks the asset from share links and upload-request previews.
  allow_external_share boolean not null default true,
  -- False means renders only, whatever the caller's role.
  allow_download_original boolean not null default true,
  -- Identifiable people; drives the §4.7 warning and the completeness score.
  requires_model_release boolean not null default false,
  -- Identifiable private property or trademarked buildings.
  requires_property_release boolean not null default false,
  -- Floor for any download under this policy; null lets the part 3 matrix
  -- decide alone.
  min_role_download dam_role,
  -- Exactly one live default, applied when a rights row names no policy;
  -- one-live-row uniqueness is a partial index.
  is_default boolean not null default false,
  is_system boolean not null default false,
  sort_order integer not null default 0,
  notes text,

  constraint dam_copyright_policies_slug_key unique (slug),
  -- A policy that demands a credit must say how to render it.
  constraint dam_copyright_policies_credit_template_check
    check (not credit_required or credit_template is not null)
);

comment on table dam_copyright_policies is
  'Reusable licence terms (SPEC 2B.22, DQ16). Five rows are seeded as is_system (D-300). Name uniqueness and the single-live-default rule are partial indexes in the index file.';
comment on column dam_copyright_policies.territories is
  'D-301: ''WW'' or upper-case ISO 3166-1 alpha-2 codes, ''WW'' only on its own. Checked by the IMMUTABLE dam_valid_territories(), which is what makes it legal in a CHECK.';
comment on column dam_copyright_policies.duration_months is
  'D-302: null = perpetual. dam_asset_rights.expires_on is derived from it on write, not computed on read, so the nightly sweep can range-scan a real column.';


-- ---------------------------------------------------------------------------
-- 2B.21  dam_copyright_holders — who owns the copyright (brief §3, DQ16)
-- ---------------------------------------------------------------------------
-- The firm, the photographer, a client, an agency or a stock library. Kept
-- separate from the photographer because dwp frequently owns work it did not
-- shoot and clients frequently own work dwp did shoot.
--
-- photographer_id points at 2B.20, which is created next and which points back
-- here through default_copyright_holder_id: the cycle is broken in the
-- deferred block at the end of this file.
create table dam_copyright_holders (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  -- Unique case-insensitively among live rows: partial expression index.
  name text not null
    constraint dam_copyright_holders_name_length_check
    check (length(name) between 1 and 160),
  -- [D-299] Six values with no enum in DECISIONS §3, so the 2B.0 text+CHECK
  -- convention of D-287 applies and the enum list stays authoritative.
  holder_type text not null default 'other'
    constraint dam_copyright_holders_holder_type_check
    check (holder_type in ('firm', 'photographer', 'client', 'agency', 'stock', 'other')),
  -- Set when holder_type = 'client', so client-owned imagery can be listed
  -- from the client record.
  client_id uuid
    references dam_clients (id) on delete set null,
  -- (ALTER) → dam_photographers(id) on delete set null; set when
  -- holder_type = 'photographer'. Cycle breaker, see the block at the end.
  photographer_id uuid,
  contact_name text
    constraint dam_copyright_holders_contact_name_length_check
    check (contact_name is null or length(contact_name) <= 160),
  -- Lower-cased by trigger.
  contact_email text
    constraint dam_copyright_holders_contact_email_normalised_check
    check (contact_email is null or contact_email = lower(btrim(contact_email))),
  contact_phone text,
  website text
    constraint dam_copyright_holders_website_check
    check (website is null or website ~ '^https?://'),
  -- The jurisdiction whose copyright term applies.
  country_code char(2)
    constraint dam_copyright_holders_country_code_check
    check (country_code ~ '^[A-Z]{2}$'),
  notes text,
  -- [D-299] Exactly one live default — the firm's own holder, used when an
  -- uploader states nothing. That is what lets the migration write a complete
  -- rights row for 34k firm-owned assets without inventing per-asset facts.
  is_default boolean not null default false,
  is_active boolean not null default true,

  -- A holder that claims to BE a client or a photographer must say which one.
  constraint dam_copyright_holders_client_check
    check (holder_type <> 'client' or client_id is not null),
  constraint dam_copyright_holders_photographer_check
    check (holder_type <> 'photographer' or photographer_id is not null)
);

comment on table dam_copyright_holders is
  'Copyright owners (SPEC 2B.21, DQ16). Separate from the photographer because ownership and authorship diverge in both directions. Name uniqueness and the single-live-default rule are partial indexes in the index file.';
comment on column dam_copyright_holders.is_default is
  'D-299: the firm''s own holder, used when an uploader states nothing. dam_asset_rights.copyright_holder_id is restrict, so a cited holder can never be purged.';


-- ---------------------------------------------------------------------------
-- 2B.20  dam_photographers — credit records (brief §4.7, DQ16)
-- ---------------------------------------------------------------------------
-- One row per person or practice that shot or authored an asset, in-house or
-- external. The row carries the DEFAULTS that ingest copies into a new
-- dam_asset_rights row, which is why crediting a photographer is usually the
-- only rights work an uploader does: with a default holder and a default
-- policy on the credit, the asset leaves upload with a complete rights row
-- instead of `unknown`.
create table dam_photographers (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  -- Unique case-insensitively among live rows: partial expression index. The
  -- OpenAsset importer matches on lower(name) then email, so it never creates
  -- a second row for a name differing only in case or trailing punctuation.
  name text not null
    constraint dam_photographers_name_length_check
    check (length(name) between 1 and 160),
  -- The practice or agency the individual shoots for.
  company text
    constraint dam_photographers_company_length_check
    check (company is null or length(company) <= 160),
  -- Lower-cased by trigger; the import de-duplication key after the name.
  email text
    constraint dam_photographers_email_normalised_check
    check (email is null or email = lower(btrim(email))),
  -- E.164 preferred; shape validated by Zod, as on dam_employees.
  phone text,
  website text
    constraint dam_photographers_website_check
    check (website is null or website ~ '^https?://'),
  -- [D-297] In-house photography is credited to a staff member, so the
  -- directory entry and the credit stay ONE record rather than two names that
  -- drift apart. Unique where not null among live rows: partial index.
  employee_id uuid
    references dam_employees (id) on delete set null,
  -- Copied into new rights rows.
  default_copyright_holder_id uuid
    references dam_copyright_holders (id) on delete set null,
  -- [D-298] The licence is a property of the engagement, not of the individual
  -- asset, so the default lives on the credit and ingest can fill
  -- dam_asset_rights from the photographer alone.
  default_policy_id uuid
    references dam_copyright_policies (id) on delete set null,
  -- Overrides the policy's template for this photographer; same {{…}} tokens.
  credit_line_template text,
  notes text,
  -- An inactive photographer stays selectable on existing rights rows but
  -- leaves the picker.
  is_active boolean not null default true
);

comment on table dam_photographers is
  'Credit records for people and practices that shot or authored an asset (SPEC 2B.20, DQ16). The defaults here are what ingest copies into dam_asset_rights. dam_asset_rights.photographer_id is restrict, so a credited photographer cannot be purged while any asset cites them.';
comment on column dam_photographers.employee_id is
  'D-297: in-house credits point at the staff record, so the directory and the credit never drift. Unique where not null among live rows — a partial index.';
comment on column dam_photographers.default_policy_id is
  'D-298: the licence belongs to the engagement, so ingest can complete a rights row from the credit alone and the asset never lands on `unknown`.';


-- ---------------------------------------------------------------------------
-- 2B.23  dam_asset_rights — the per-asset rights record (brief §4.7, DQ16)
-- ---------------------------------------------------------------------------
-- Exactly one live row per asset, pointing at a policy and overriding only the
-- fields that differ. It holds the dates that make rights move on their own —
-- embargo, expiry — and the release statuses a bid team is asked about.
--
-- [D-303] THERE IS NO STATUS COLUMN HERE, deliberately. The single
-- materialisation is dam_asset_search.rights_status (2A), written by this
-- table's triggers and by the nightly sweep, so every badge, filter and
-- API filter[rights_status] reads it without a join — and so an asset with no
-- rights row at all still has a status, which only the search row can carry.
-- dam_rights_status(asset_id) is the one definition of the rule.
--
-- No deleted_by: the row is deleted only with its asset.
create table dam_asset_rights (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,

  -- 1:1 with the asset; one live row per asset is a partial unique index.
  asset_id uuid not null
    references dam_assets (id) on delete cascade,
  -- `restrict` on all three: reference data cited by a rights row must not be
  -- able to vanish underneath it.
  photographer_id uuid
    references dam_photographers (id) on delete restrict,
  -- Defaulted from the photographer, else the default holder.
  copyright_holder_id uuid
    references dam_copyright_holders (id) on delete restrict,
  -- Null = the default policy applies.
  policy_id uuid
    references dam_copyright_policies (id) on delete restrict,
  -- Override; null = inherit the policy. May only be a SUBSET of the policy's
  -- uses — a cross-table comparison, so trg_dam_asset_rights_tighten_only
  -- enforces it rather than a CHECK.
  permitted_uses dam_permitted_use[]
    constraint dam_asset_rights_permitted_uses_check
    check (permitted_uses is null or cardinality(permitted_uses) > 0),
  -- Override; null = inherit. Same 'WW'-or-ISO rule as the policy.
  territories text[]
    constraint dam_asset_rights_territories_check
    check (territories is null or dam_valid_territories(territories)),
  -- Anchor for the policy's duration_months; defaults to the capture date,
  -- else the asset's first version upload date.
  licence_starts_on date,
  -- Publication embargo (unbuilt schemes, unannounced clients). Until this
  -- date the asset reads `restricted` however clear the licence is.
  embargo_until date,
  -- [D-302] Stored, not computed on read: the nightly sweep and the
  -- `expiring` index both have to range-scan a real column. Derived on write
  -- from licence_starts_on + policy.duration_months when the user supplies
  -- nothing, kept when supplied, recomputed by policy propagation.
  expires_on date,
  -- True when the trigger derived expires_on. A user edit clears it so
  -- propagation stops overwriting a negotiated date.
  expires_is_derived boolean not null default false,
  model_release dam_release_status not null default 'none',
  property_release dam_release_status not null default 'none',
  -- [D-304] The signed release scan, so "full release" is evidenced rather
  -- than asserted.
  release_asset_id uuid
    references dam_assets (id) on delete set null,
  -- Null = not stated, which reads as status `unknown` (D-020) — where every
  -- migrated legacy asset starts. May only equal or tighten the policy's.
  restriction dam_rights_restriction,
  -- Literal override; null = rendered from the policy's credit_template.
  credit_line text,
  -- The three permission overrides; null = inherit the policy, and each may
  -- only tighten it (trg_dam_asset_rights_tighten_only).
  allow_external_share boolean,
  allow_download_original boolean,
  watermark_required boolean,
  -- [D-304] What the licence cost.
  licence_fee numeric(14,2)
    constraint dam_asset_rights_licence_fee_check
    check (licence_fee is null or licence_fee >= 0),
  -- ISO 4217.
  licence_currency char(3),
  -- Invoice, PO or contract reference.
  licence_ref text,
  -- [D-305] Mirrors dam_employee_registrations, so registrations and rights
  -- share one 90/30/7 ladder and one idempotency rule.
  last_alert_days smallint
    constraint dam_asset_rights_last_alert_days_check
    check (last_alert_days in (90, 30, 7)),
  notes text,
  -- `import` for OpenAsset/CSV, `rule` when ingest copied the photographer's
  -- defaults, `migration` for the v1 corpus.
  source dam_link_source not null default 'manual',

  constraint dam_asset_rights_expires_on_check
    check (expires_on is null or licence_starts_on is null or expires_on >= licence_starts_on),
  -- A fee without a currency is not a fee.
  constraint dam_asset_rights_licence_currency_check
    check ((licence_fee is null) = (licence_currency is null))
);

comment on table dam_asset_rights is
  'Per-asset rights, one live row per asset (SPEC 2B.23, DQ16). D-303: no status column — the single materialisation is dam_asset_search.rights_status, so a rights query needs no join and an asset with no rights row still has a status. dam_effective_rights() is the one merge of override over policy over default.';
comment on column dam_asset_rights.restriction is
  'Null = not stated, which reads as `unknown` (D-020). May equal or tighten the policy''s restriction, never loosen it (trg_dam_asset_rights_tighten_only).';
comment on column dam_asset_rights.expires_on is
  'D-302: stored rather than computed, because the nightly sweep and the expiring-window index must range-scan a real column.';
comment on column dam_asset_rights.expires_is_derived is
  'True while expires_on is the trigger''s arithmetic. A user edit clears it, so policy propagation never overwrites a negotiated date.';


-- ---------------------------------------------------------------------------
-- 2B.25  dam_aspect_ratios — named crop ratios (brief §4.5)
-- ---------------------------------------------------------------------------
-- Used by sizes, by the smart-crop suggestion and by the manual crop UI.
-- Tiny, closed and seeded. Written before dam_sizes, which points at it.
create table dam_aspect_ratios (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  -- "16:9", "A-series portrait". Unique case-insensitively among live rows.
  name text not null
    constraint dam_aspect_ratios_name_length_check
    check (length(name) between 1 and 40),
  -- 16-9, a-series-portrait.
  slug text not null
    constraint dam_aspect_ratios_slug_format_check
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  -- [D-309] An integer pair rather than a float, so 4:3 stays 4:3 in the UI.
  -- A-series is stored as 1000:1414, which is root two to four figures.
  ratio_w integer not null
    constraint dam_aspect_ratios_ratio_w_check
    check (ratio_w between 1 and 10000),
  ratio_h integer not null
    constraint dam_aspect_ratios_ratio_h_check
    check (ratio_h between 1 and 10000),
  -- What matching and sorting actually use. Generated, so it can never
  -- disagree with the pair above it.
  -- numeric(10,5), NOT numeric(8,5). Precision 8 with scale 5 leaves three
  -- digits before the point, so the largest value it can hold is 999.99999 —
  -- but the CHECKs above admit ratio_w = 10000 with ratio_h = 1, which computes
  -- 10000.00000 and raises `numeric field overflow` on the insert. The column's
  -- own domain has to cover everything its table's constraints allow, and
  -- precision 10 covers the full 1..10000 by 1..10000 grid with room to spare.
  ratio numeric(10,5)
    generated always as (round(ratio_w::numeric / ratio_h::numeric, 5)) stored,
  -- Same thresholds as the asset's own orientation (2A), so the two filters
  -- agree about what a panorama is.
  -- Every arm is cast individually and the CASE is NOT cast as a whole. With
  -- bare literals the CASE resolves to text, and the outer ::dam_orientation
  -- becomes a run-time text-to-enum coercion calling enum_in(), which is
  -- STABLE, not IMMUTABLE — and a generated column refuses a non-immutable
  -- expression, so CREATE TABLE itself would fail. Casting each arm makes
  -- them enum constants at parse time and the whole expression immutable.
  --
  -- The thresholds are deliberately identical to dam_assets.orientation (2A):
  -- greatest/least so the test is direction-agnostic, 2.4 for panorama, and a
  -- 0.95-1.05 band for square. They must agree, or a crop preset and the
  -- assets it fits would be filed under different orientations.
  orientation dam_orientation
    generated always as (
      case
        when greatest(ratio_w, ratio_h)::numeric / least(ratio_w, ratio_h)::numeric >= 2.4
          then 'panorama'::dam_orientation
        when ratio_w::numeric / ratio_h::numeric between 0.95 and 1.05
          then 'square'::dam_orientation
        when ratio_w > ratio_h then 'landscape'::dam_orientation
        else 'portrait'::dam_orientation
      end
    ) stored,
  -- Relative tolerance when deciding whether an asset already matches the
  -- ratio and needs no crop at all.
  tolerance numeric(4,3) not null default 0.010
    constraint dam_aspect_ratios_tolerance_check
    check (tolerance between 0 and 0.2),
  -- Pre-selected in the crop UI; exactly one live row (partial index).
  is_default boolean not null default false,
  is_system boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,

  constraint dam_aspect_ratios_slug_key unique (slug)
);

comment on table dam_aspect_ratios is
  'Named crop ratios (SPEC 2B.25, brief §4.5). Seven seeded is_system rows. Name uniqueness, the single-live-default rule and the one-row-per-ratio rule are all partial indexes in the index file — two rows with the same ratio would make crop matching ambiguous.';
comment on column dam_aspect_ratios.ratio_w is
  'D-309: an integer pair, so 4:3 stays 4:3 in the UI; A-series is 1000:1414.';
comment on column dam_aspect_ratios.orientation is
  'Generated with the same thresholds as dam_assets.orientation (2A), so the two filters agree.';


-- ---------------------------------------------------------------------------
-- 2B.24  dam_sizes — named output presets (brief §4.5)
-- ---------------------------------------------------------------------------
-- The list behind "download as…". A size is a COMPLETE render recipe —
-- geometry, fit, resolution, format, colour profile, quality, watermark —
-- plus the minimum role allowed to take it, so "Original" can be governed like
-- any other option instead of being a special case. A custom one-off render
-- reuses the same parameter set without a row.
create table dam_sizes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  -- Unique case-insensitively among live rows: partial expression index.
  name text not null
    constraint dam_sizes_name_length_check
    check (length(name) between 1 and 60),
  -- The value used in /api/v2/assets/{id}/renditions/{slug} and in ZIP
  -- manifests, so it is unique over all rows and a plain constraint.
  slug text not null
    constraint dam_sizes_slug_format_check
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  -- Shown under the name in the download dialog.
  description text,
  width integer
    constraint dam_sizes_width_check
    check (width is null or width between 1 and 30000),
  height integer
    constraint dam_sizes_height_check
    check (height is null or height between 1 and 30000),
  -- [D-306] sharp's vocabulary, because the render worker is sharp:
  -- `inside` = fit inside the bounding box (the Slides rule), `cover` = crop
  -- to fill, `contain` = pad with `background`.
  fit text not null default 'inside'
    constraint dam_sizes_fit_check
    check (fit in ('inside', 'outside', 'cover', 'contain', 'exact', 'width', 'height')),
  -- Metadata only for raster formats; real for PDF output.
  dpi integer
    constraint dam_sizes_dpi_check
    check (dpi is null or dpi between 36 and 1200),
  -- [D-306] `original` passes the source bytes through untouched and forces
  -- is_original.
  format text not null default 'jpeg'
    constraint dam_sizes_format_check
    check (format in ('jpeg', 'png', 'webp', 'avif', 'tiff', 'pdf', 'original')),
  -- Ignored for lossless formats.
  quality smallint default 82
    constraint dam_sizes_quality_check
    check (quality is null or quality between 1 and 100),
  -- [D-306] Print presets use a CMYK profile; `preserve` keeps whatever the
  -- source embedded.
  colour_profile text not null default 'srgb'
    constraint dam_sizes_colour_profile_check
    check (colour_profile in ('srgb', 'adobe_rgb', 'display_p3',
                              'cmyk_fogra39', 'cmyk_swop', 'preserve')),
  -- Used by fit = 'contain'.
  background text
    constraint dam_sizes_background_check
    check (background is null or background ~ '^#[0-9A-Fa-f]{6}$'),
  -- When set, the render crops to that ratio first (smart crop, with a manual
  -- per-asset override honoured).
  aspect_ratio_id uuid
    references dam_aspect_ratios (id) on delete set null,
  -- Mild output sharpening after a downscale.
  sharpen boolean not null default true,
  -- Strips EXIF/IPTC/XMP. External shares default to a size that strips.
  strip_metadata boolean not null default false,
  -- The EFFECTIVE decision is size.watermark OR share.watermark OR
  -- rights.watermark_required OR the access level's (2B.5): any one is enough,
  -- which is why none of them can be the single source of truth.
  watermark boolean not null default false,
  -- Null = dam_setting('watermark.default_text') (D-017).
  watermark_text text,
  -- A logo PNG overrides the text mark.
  watermark_asset_id uuid
    references dam_assets (id) on delete set null,
  watermark_opacity numeric(3,2) not null default 0.30
    constraint dam_sizes_watermark_opacity_check
    check (watermark_opacity between 0.05 and 1.00),
  -- Optional cap: the worker steps quality down until it fits, then fails the
  -- render rather than shipping something over the limit.
  max_bytes bigint
    constraint dam_sizes_max_bytes_check
    check (max_bytes is null or max_bytes > 0),
  -- [D-307] Minimum effective role allowed to request this size, enforced by
  -- dam_can_download_size (part 3) and by the share link's max_size_id. §4.5
  -- wants press-quality output available and §4.7 wants it governed;
  -- role-per-size is the smallest thing that does both.
  min_role dam_role not null default 'viewer',
  -- The pass-through preset; at most one live row (partial index).
  is_original boolean not null default false,
  -- Pre-selected in the download dialog; exactly one live row (partial index).
  is_default boolean not null default false,
  is_system boolean not null default false,
  is_active boolean not null default true,
  -- Empty = every kind. Otherwise the preset only appears for these kinds: a
  -- print preset is meaningless on a DWG.
  applies_to dam_file_kind[] not null default '{}',
  sort_order integer not null default 0,
  -- Bumped in place by trg_dam_sizes_invalidate_cache whenever any render
  -- parameter changes. It is an input to dam_render_cache.params_hash, so an
  -- edited preset re-renders instead of serving yesterday's bytes. Nothing
  -- outside the cache reads it.
  params_version smallint not null default 1,

  constraint dam_sizes_slug_key unique (slug),
  -- is_original and format = 'original' are the same fact stated twice; this
  -- keeps them from disagreeing.
  constraint dam_sizes_original_format_check
    check (is_original = (format = 'original')),
  -- A preset that is not a pass-through must constrain at least one dimension,
  -- or it is not a recipe for anything.
  constraint dam_sizes_dimension_check
    check (is_original or width is not null or height is not null)
);

comment on table dam_sizes is
  'Named output presets — the list behind "download as…" (SPEC 2B.24, brief §4.5). Six seeded is_system rows (D-016). Name uniqueness and the single-live original/default rules are partial indexes in the index file.';
comment on column dam_sizes.min_role is
  'D-307/D-308: Original is seeded at contributor — §4.5''s complaint is that people are made to download 60 MB TIFFs, not that originals are secret.';
comment on column dam_sizes.params_version is
  'Bumped when any render parameter changes; an input to dam_render_cache.params_hash, so an edited preset re-renders rather than serving stale bytes.';


-- ---------------------------------------------------------------------------
-- 2B.26  dam_saved_searches — persisted queries (brief §3, §4.3)
-- ---------------------------------------------------------------------------
-- "F&B in Dubai, completed, with photography" kept on the sidebar, shared with
-- a team, or published externally as a share link of scope `search`. The query
-- column is the canonical filter object the API already accepts, so a saved
-- search and a URL are the same thing and neither needs translating.
create table dam_saved_searches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  name text not null
    constraint dam_saved_searches_name_length_check
    check (length(name) between 1 and 120),
  description text,
  -- `restrict`, as on an album: a saved search must always have an owner.
  owner_id uuid not null
    references dam_users (id) on delete restrict,
  -- [D-310] The album enum is reused rather than cloned: the three tiers and
  -- the UI are identical, and a second enum with the same members would only
  -- invite drift. `shared` is readable by anyone the query's own RLS lets read
  -- the results, so there is no per-search collaborator table.
  visibility dam_album_visibility not null default 'personal',
  -- Which corpus the query runs against; drives which endpoint it opens.
  target text not null default 'asset'
    constraint dam_saved_searches_target_check
    check (target in ('asset', 'project', 'employee')),
  -- The canonical query object, identical to the API's parsed query:
  -- { q?, filter: { <field>: { <op>: value } }, sort?, include? }. Unknown
  -- keys are rejected by Zod at the API, not by a CHECK here.
  query jsonb not null default '{}'
    constraint dam_saved_searches_query_object_check
    check (jsonb_typeof(query) = 'object'),
  -- Bumped when the filter DSL changes shape. The API migrates older objects
  -- on read and rewrites them on the next save.
  query_version smallint not null default 1,
  -- Shows in the owner's sidebar.
  pinned boolean not null default false,
  -- Approximate by design: written at most once per 60 s per row.
  run_count bigint not null default 0,
  last_run_at timestamptz,
  -- Last known count for the sidebar badge; never authoritative.
  result_count_cached integer,
  counted_at timestamptz,
  -- [D-312] Saved-search alerts: a daily send_notification when new matching
  -- rows appear. The bid team's real question is "has anything new landed for
  -- this pitch", and the alternative is re-running the search by hand.
  notify_on_new boolean not null default false,
  -- High-water mark of the last alert; the job matches created_at > this
  -- inside the query.
  notify_cursor timestamptz,
  last_notified_at timestamptz,
  -- Seeded searches (Needs rights, Untagged, Expiring rights, My uploads)
  -- cannot be deleted.
  is_system boolean not null default false
);

comment on table dam_saved_searches is
  'Persisted queries (SPEC 2B.26, brief §4.3). Uniqueness is (owner_id, lower(name)) among live rows — an expression index in the index file. Results are always re-filtered by the caller''s own RLS, so a shared search never leaks rows.';
comment on column dam_saved_searches.visibility is
  'D-310: the album visibility enum reused deliberately — same three tiers, same UI, and a parallel enum would only drift.';
comment on column dam_saved_searches.query is
  'The API''s own parsed query object. Zod owns the key vocabulary; the CHECK only insists it is an object.';


-- ---------------------------------------------------------------------------
-- 2B.27  dam_share_links — external share links (brief §4.4, DQ15)
-- ---------------------------------------------------------------------------
-- A scoped, expiring, optionally password-protected, optionally watermarked
-- window onto an album, a selection, one asset or a saved search, for people
-- with no account.
--
-- The token itself is NEVER stored — only its SHA-256 — and every anonymous
-- read goes through a SECURITY DEFINER RPC granted to service_role alone, so
-- these tables need no anonymous policy at all.
--
-- [D-314] Password VERIFICATION happens in the API, not here: Postgres has no
-- argon2id (pgcrypto offers only bf/md5/xdes) and DQ15 fixes argon2id. The
-- route handler verifies with @node-rs/argon2 and passes a boolean into
-- dam_share_open(); since the RPC is unreachable from `anon`, the assertion
-- cannot be forged. Token hashing, expiry, revocation, view caps, lockout and
-- counting all stay in SQL, where they are enforced once.
create table dam_share_links (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The sharer. Their identity at this moment is what scope_snapshot freezes.
  created_by uuid,
  updated_by uuid,
  -- Deletion is for mistakes; revocation is the normal end of life.
  deleted_at timestamptz,
  deleted_by uuid,

  -- Unique over ALL rows, revoked and deleted included: a token is never
  -- reissued, so this is a plain table constraint.
  token_hash text not null
    constraint dam_share_links_token_hash_format_check
    check (token_hash ~ '^[0-9a-f]{64}$'),
  -- [D-313] The first 8 characters of the 43-character base64url token — the
  -- only part shown in the admin list and in support requests.
  token_prefix text not null
    constraint dam_share_links_token_prefix_format_check
    check (token_prefix ~ '^[A-Za-z0-9_-]{8}$'),
  scope dam_share_scope not null,
  album_id uuid
    references dam_albums (id) on delete cascade,
  asset_id uuid
    references dam_assets (id) on delete cascade,
  saved_search_id uuid
    references dam_saved_searches (id) on delete set null,
  -- Frozen copy of the saved search's query at creation: editing the saved
  -- search must not change a link that is already out in the world.
  query jsonb,
  -- [D-311] The creator's effective access captured at creation
  -- ({ dam_role, studio_ids, cross_studio, access_level_ids }), which is what
  -- the query is evaluated with. A live re-evaluation would silently widen an
  -- external link when the creator is promoted, and evaluating as `anon` would
  -- return nothing; a frozen snapshot is the only version an auditor can
  -- reason about, and revoking the link is how it ends.
  scope_snapshot jsonb,
  -- Heading on the share page; null = the album's name.
  title text
    constraint dam_share_links_title_length_check
    check (title is null or length(title) <= 160),
  -- The note to the recipient.
  message text
    constraint dam_share_links_message_length_check
    check (message is null or length(message) <= 2000),
  -- argon2id encoded string; null = no password. Verified in the API (D-314).
  password_hash text
    constraint dam_share_links_password_hash_format_check
    check (password_hash is null or password_hash like '$argon2id$%'),
  -- The viewer must give an email before the first asset loads; it is captured
  -- into the usage event's meta.
  require_email boolean not null default false,
  -- Whom the link was sent to, for the admin list and for "resend". NOT an
  -- access control: anyone with the token can open it.
  recipient_emails text[] not null default '{}',
  -- Null = no expiry; the UI defaults the picker to
  -- now() + dam_setting('shares.default_ttl_days').
  expires_at timestamptz,
  -- The RPC refuses once view_count >= max_views.
  max_views integer
    constraint dam_share_links_max_views_check
    check (max_views is null or max_views > 0),
  -- Off by default: a share is for looking at.
  allow_download boolean not null default false,
  -- The largest preset the link may download; `restrict` because a size in use
  -- must not vanish. Null with allow_download = the default size only.
  max_size_id uuid
    references dam_sizes (id) on delete restrict,
  -- On by default (D-017). May be turned off only by editor+ and only when the
  -- effective rights do not require it (trg_dam_share_links_watermark_floor).
  watermark boolean not null default true,
  -- Captions and credits on the share page. EXIF is never exposed.
  show_metadata boolean not null default false,
  -- Denormalised from the usage events by the RPC.
  view_count integer not null default 0,
  download_count integer not null default 0,
  last_viewed_at timestamptz,
  -- [D-315] A 256-bit token is not guessable but a four-word password is, and
  -- rate limiting in the edge layer alone does not survive a restart. Ten
  -- failures inside fifteen minutes set locked_until; the RPC refuses while it
  -- is set and zeroes both on success.
  failed_attempts smallint not null default 0,
  locked_until timestamptz,
  -- The real "off" switch.
  revoked_at timestamptz,
  revoked_by uuid
    references dam_users (id) on delete set null,
  -- manual, rights_changed, owner_deactivated, or free text.
  revoked_reason text,

  constraint dam_share_links_token_hash_key unique (token_hash),
  -- The scope matrix: each scope carries exactly its own pointer and a
  -- selection carries none, because its contents live in 2B.28.
  constraint dam_share_links_scope_album_check
    check ((scope = 'album') = (album_id is not null)),
  constraint dam_share_links_scope_asset_check
    check ((scope = 'asset') = (asset_id is not null)),
  constraint dam_share_links_scope_search_check
    check ((scope = 'search')
           = (saved_search_id is not null and query is not null and scope_snapshot is not null)),
  constraint dam_share_links_scope_selection_check
    check (scope <> 'selection'
           or (album_id is null and asset_id is null and saved_search_id is null)),
  -- A download ceiling means nothing on a link that cannot download at all.
  constraint dam_share_links_max_size_check
    check (max_size_id is null or allow_download)
);

comment on table dam_share_links is
  'External share links (SPEC 2B.27, DQ15). The token is never stored, only its SHA-256; anonymous reads go through SECURITY DEFINER RPCs granted to service_role alone, so no policy grants anon anything. The row audit redacts token_hash and password_hash (2B.36).';
comment on column dam_share_links.scope_snapshot is
  'D-311: the creator''s effective access frozen at creation. A live re-evaluation would widen the link on the creator''s promotion; evaluating as anon would return nothing.';
comment on column dam_share_links.password_hash is
  'argon2id. D-314: verified by the API and asserted into dam_share_open() as a boolean, because Postgres has no argon2id.';
comment on column dam_share_links.locked_until is
  'D-315: set after ten wrong passwords in fifteen minutes. The lockout lives in SQL so it survives an edge-layer restart.';


-- ---------------------------------------------------------------------------
-- 2B.28  dam_share_link_items — the frozen contents of a `selection` share
-- ---------------------------------------------------------------------------
-- [D-316] Album shares have NO rows here: a share of an album is a share of
-- "that collection as it evolves", and curators expect adding a photo to the
-- album to add it to the link. A selection has no owner but the link, so it
-- must be frozen — which is the only reason this table exists.
--
-- As in 2B.16, sort_order carries no uniqueness (D-294).
--
-- No deleted_by: removing an item from a live share is not a trash operation.
create table dam_share_link_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  -- Removing an item from a live share.
  deleted_at timestamptz,

  share_link_id uuid not null
    references dam_share_links (id) on delete cascade,
  asset_id uuid not null
    references dam_assets (id) on delete cascade,
  -- Dense 1..n among live rows; no default, because the append trigger has to
  -- read the rest of the selection.
  sort_order integer not null,
  -- Overrides the asset caption on the share page only.
  caption text
    constraint dam_share_link_items_caption_length_check
    check (caption is null or length(caption) <= 2000)
);

comment on table dam_share_link_items is
  'The frozen contents of a selection share (SPEC 2B.28, D-316). Album shares follow their album live and have no rows here. One live row per (link, asset) is a partial index in the index file.';


-- ---------------------------------------------------------------------------
-- 2B.29  dam_upload_requests — deposit links for external photographers
-- ---------------------------------------------------------------------------
-- Brief §4.4, DQ15. A link that lets someone with no account put files
-- straight into a project. The request carries the destination and the
-- metadata defaults, so what arrives is already filed, keyworded and
-- rights-stamped — and lands in the review queue, not in the live library.
--
-- [D-318] Deposits always land `pending`, whatever the category's
-- requires_review flag says and whatever D-005's role rule would allow: the
-- depositor has no role, so review is the only safe default.
--
-- [D-319] The finalise RPC never creates a dam_photographers row from the
-- uploader's free-text name. Anonymous text would seed the credit vocabulary
-- with misspellings; the name and email go on the file rows and into the
-- ingest note, and an editor promotes them to a real credit in one click.
create table dam_upload_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The requester. Deposits are attributed to them, never to `anon`.
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  -- Unique over all rows, as on a share link: a token is never reissued.
  token_hash text not null
    constraint dam_upload_requests_token_hash_format_check
    check (token_hash ~ '^[0-9a-f]{64}$'),
  -- [D-313]
  token_prefix text not null
    constraint dam_upload_requests_token_prefix_format_check
    check (token_prefix ~ '^[A-Za-z0-9_-]{8}$'),
  -- The heading on the upload page: "Marina Bay — final selects".
  title text not null
    constraint dam_upload_requests_title_length_check
    check (length(title) between 1 and 160),
  -- What to send, and how it will be credited.
  instructions text
    constraint dam_upload_requests_instructions_length_check
    check (instructions is null or length(instructions) <= 4000),
  -- The destination project; null only for un-projected material (brand,
  -- stock). `restrict`, because deposits already filed against it must not be
  -- orphaned.
  project_id uuid
    references dam_projects (id) on delete restrict,
  -- Drives the field and keyword schema of everything deposited.
  category_id uuid not null
    references dam_categories (id) on delete restrict,
  -- Defaults from the project; used for routing notifications.
  studio_id uuid
    references dam_studios (id) on delete set null,
  -- Null = the default originals location.
  storage_location_id uuid
    references dam_storage_locations (id) on delete restrict,
  -- Applied to every deposited asset as dam_keyword_links with source =
  -- 'rule'. Validated against live asset-namespace keywords by trigger, not by
  -- a CHECK, because the check is a cross-table lookup.
  default_keyword_ids uuid[] not null default '{}',
  -- Zod-validated subset of 2B.23 applied by the finalise RPC:
  -- { photographer_id, copyright_holder_id, policy_id, permitted_uses,
  --   territories, restriction, licence_starts_on }.
  default_rights jsonb not null default '{}'
    constraint dam_upload_requests_default_rights_object_check
    check (jsonb_typeof(default_rights) = 'object'),
  -- Typed custom-field values applied to every deposit (shoot date, brief ref).
  default_field_values jsonb not null default '{}'
    constraint dam_upload_requests_default_field_values_object_check
    check (jsonb_typeof(default_field_values) = 'object'),
  -- Whom the link was issued to.
  uploader_name text
    constraint dam_upload_requests_uploader_name_length_check
    check (uploader_name is null or length(uploader_name) <= 160),
  -- Lower-cased by trigger; the "received" notification address.
  uploader_email text
    constraint dam_upload_requests_uploader_email_normalised_check
    check (uploader_email is null or uploader_email = lower(btrim(uploader_email))),
  -- argon2id, verified in the API exactly as 2B.27 (D-314).
  password_hash text
    constraint dam_upload_requests_password_hash_format_check
    check (password_hash is null or password_hash like '$argon2id$%'),
  max_files integer not null default 200
    constraint dam_upload_requests_max_files_check
    check (max_files between 1 and 2000),
  -- 20 GiB.
  max_bytes bigint not null default 21474836480
    constraint dam_upload_requests_max_bytes_check
    check (max_bytes > 0),
  -- Per-file cap; null = dam_setting('uploads.max_file_bytes').
  max_file_bytes bigint
    constraint dam_upload_requests_max_file_bytes_check
    check (max_file_bytes is null or max_file_bytes > 0),
  -- Empty = the category's own allowance; otherwise an explicit list.
  allowed_mime_types text[] not null default '{}',
  -- Trigger-maintained from dam_upload_request_files.
  received_file_count integer not null default 0
    constraint dam_upload_requests_received_file_count_check
    check (received_file_count >= 0),
  received_bytes bigint not null default 0
    constraint dam_upload_requests_received_bytes_check
    check (received_bytes >= 0),
  -- Created on the first deposit, so the request shows in the ingest UI like
  -- any other batch.
  ingest_batch_id uuid
    references dam_ingest_batches (id) on delete set null,
  -- open → closed | expired | revoked. The only edge back to `open` is an
  -- explicit reopen by the creator while expires_at is still in the future.
  status dam_upload_request_status not null default 'open',
  -- Null = no expiry; the UI defaults to
  -- now() + dam_setting('upload_requests.default_ttl_days').
  expires_at timestamptz,
  -- Set when the creator closes it or a cap is reached.
  closed_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid
    references dam_users (id) on delete set null,
  -- Times the page was opened.
  open_count integer not null default 0,
  last_opened_at timestamptz,
  -- [D-315] As 2B.27.
  failed_attempts smallint not null default 0,
  locked_until timestamptz,

  constraint dam_upload_requests_token_hash_key unique (token_hash),
  -- A terminal status names the moment it became terminal.
  constraint dam_upload_requests_revoked_check
    check (status <> 'revoked' or revoked_at is not null),
  constraint dam_upload_requests_closed_check
    check (status <> 'closed' or closed_at is not null)
);

comment on table dam_upload_requests is
  'Deposit links for external photographers (SPEC 2B.29, DQ15). Deposits always land pending (D-318) and never create a photographer row from anonymous text (D-319). The row audit redacts token_hash and password_hash.';
comment on column dam_upload_requests.default_keyword_ids is
  'Applied to every deposit as dam_keyword_links with source = ''rule''. Validated against live asset-namespace keywords by trigger, since a CHECK cannot read another table.';
comment on column dam_upload_requests.status is
  'open → closed | expired | revoked, with no edge back except an explicit reopen by the creator before expires_at.';


-- ---------------------------------------------------------------------------
-- 2B.30  dam_upload_request_files — the receipt for every deposited file
-- ---------------------------------------------------------------------------
-- One row per file a depositor sent, kept whether or not it became an asset
-- (DQ15): what arrived, how big, from whom, and why it was rejected if it was.
--
-- No deleted_by: rows go only with the parent request.
create table dam_upload_request_files (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The request's creator; the depositor has no account.
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,

  upload_request_id uuid not null
    references dam_upload_requests (id) on delete cascade,
  -- Null until the asset row exists, and permanently null for a rejected or
  -- failed file. Unique where not null: partial index.
  asset_id uuid
    references dam_assets (id) on delete set null,
  -- The version the bytes became.
  version_id uuid
    references dam_asset_versions (id) on delete set null,
  -- Kept verbatim, including the depositor's spelling: it is the receipt.
  original_filename text not null
    constraint dam_upload_request_files_original_filename_length_check
    check (length(original_filename) between 1 and 512),
  size_bytes bigint
    constraint dam_upload_request_files_size_bytes_check
    check (size_bytes is null or size_bytes >= 0),
  -- As declared by the browser, then as sniffed by the ingest job.
  mime_type text,
  -- Lets a re-sent file be recognised instead of duplicated; one live row per
  -- (request, sha256) is a partial index.
  sha256 text
    constraint dam_upload_request_files_sha256_format_check
    check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  -- Where the bytes landed before the asset existed.
  object_key text,
  -- [D-287 convention] received = bytes stored; accepted = asset created;
  -- duplicate = matched an existing sha256; rejected = an editor refused it in
  -- review; failed = the transfer or the ingest broke.
  status text not null default 'pending'
    constraint dam_upload_request_files_status_check
    check (status in ('pending', 'received', 'accepted', 'rejected', 'failed', 'duplicate')),
  -- Shown to the depositor for `failed`, to the reviewer for `rejected`.
  error text,
  -- Per file, because one link may be forwarded.
  uploader_name text,
  -- Lower-cased by trigger.
  uploader_email text
    constraint dam_upload_request_files_uploader_email_normalised_check
    check (uploader_email is null or uploader_email = lower(btrim(uploader_email))),
  -- encode(sha256((ip || <salt>)::bytea), 'hex'), the salt read from Secret
  -- Manager per privacy.ip_hash_salt_secret_name (2B.53) and applied in the
  -- API. NEVER the raw address.
  ip_hash text,
  -- When the bytes finished arriving.
  received_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid
    references dam_users (id) on delete set null
);

comment on table dam_upload_request_files is
  'One row per deposited file, kept whether or not it became an asset (SPEC 2B.30, DQ15). Both uniqueness rules are partial indexes in the index file; a resend of the same sha256 is the same row.';
comment on column dam_upload_request_files.ip_hash is
  'Salted SHA-256 of the depositor''s address, hashed in the API with the secret named by privacy.ip_hash_salt_secret_name. The raw address is never stored.';


-- ---------------------------------------------------------------------------
-- 2B.31  dam_comments — threaded comments on assets, albums and projects
-- ---------------------------------------------------------------------------
-- Brief §4.4. @-mentions notify, and an optional pinned region on an image
-- makes "this corner is blown out" point at the corner. Review OUTCOMES are
-- not comments — they are 2B.32.
create table dam_comments (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The author.
  created_by uuid,
  updated_by uuid,
  -- A deleted comment leaves a tombstone in the thread ("comment removed") so
  -- the replies under it keep their context.
  deleted_at timestamptz,
  deleted_by uuid,

  target_type dam_target_type not null
    constraint dam_comments_target_type_check
    check (target_type in ('asset', 'album', 'project')),
  -- Polymorphic, so no FK (D-349); dam_assert_polymorphic_target() checks it.
  target_id uuid not null,
  -- Null = a thread root.
  parent_comment_id uuid
    references dam_comments (id) on delete cascade,
  -- Trigger-set to coalesce(parent.thread_root_id, parent.id, new.id), which
  -- makes "load this thread" one indexed read instead of a recursive walk.
  thread_root_id uuid not null,
  -- [D-320] Threads are one reply level deep. This is review feedback, not a
  -- forum: arbitrary nesting makes the panel unreadable, and every AEC DAM
  -- that allows it ends up flattening it in the UI anyway.
  depth smallint not null default 0
    constraint dam_comments_depth_check
    check (depth in (0, 1)),
  -- Plain text with @[display](uuid) mention tokens, rendered by the client.
  body text not null
    constraint dam_comments_body_length_check
    check (length(btrim(body)) between 1 and 8000),
  -- Parsed from the body by trigger, keeping only live active users who can
  -- read the target; drives the comment_mention notifications.
  mentions uuid[] not null default '{}',
  -- [D-321] The version the comment was written against, so replacing an asset
  -- does not silently move old feedback onto new pixels.
  asset_version_id uuid
    references dam_asset_versions (id) on delete set null,
  -- Normalised region on that version: { x, y, w, h, page? }. As on
  -- dam_employee_headshots.crop, the CHECK asserts key presence only and Zod
  -- validates the ranges.
  annotation jsonb
    constraint dam_comments_annotation_shape_check
    check (annotation is null
           or (annotation ? 'x' and annotation ? 'y'
               and annotation ? 'w' and annotation ? 'h')),
  -- Thread roots only; replies inherit the root's state in the UI.
  is_resolved boolean not null default false,
  resolved_at timestamptz,
  resolved_by uuid
    references dam_users (id) on delete set null,
  -- Live replies, trigger-maintained on the root.
  reply_count integer not null default 0
    constraint dam_comments_reply_count_check
    check (reply_count >= 0),
  -- Stamped on any body change after creation; the UI shows "edited". There is
  -- no edit window, because the audit row holds the previous text.
  edited_at timestamptz,

  -- A root has no parent and a reply has one: depth and the pointer are the
  -- same fact, so they may not disagree.
  constraint dam_comments_depth_parent_check
    check ((parent_comment_id is null) = (depth = 0)),
  -- Only a root can be resolved.
  constraint dam_comments_resolved_root_check
    check (is_resolved = false or parent_comment_id is null),
  -- Resolution names both who and when, or neither.
  constraint dam_comments_resolved_pair_check
    check ((resolved_at is null) = (resolved_by is null)),
  -- A region is meaningless without the version it is a region of.
  constraint dam_comments_annotation_version_check
    check (annotation is null or asset_version_id is not null)
);

comment on table dam_comments is
  'Threaded comments on assets, albums and projects (SPEC 2B.31, brief §4.4). One reply level only (D-320). Commenting is how a viewer participates, so the write policy reaches down to viewer.';
comment on column dam_comments.thread_root_id is
  'Trigger-set, so loading a thread is one indexed read rather than a recursive walk.';
comment on column dam_comments.asset_version_id is
  'D-321: the version the feedback was written against, so replacing an asset does not move old comments onto new pixels.';


-- ---------------------------------------------------------------------------
-- 2B.32  dam_review_decisions — the approval record (brief §4.4, D-005)
-- ---------------------------------------------------------------------------
-- Who approved, rejected or asked for changes, on which version, and why.
-- Decisions are EVENTS, not a state column: the state they produce lives on
-- dam_assets.status and the history stays here.
--
-- [D-322] Append-only. trg_dam_review_decisions_immutable freezes every column
-- but is_current and deleted_at, so a changed mind is a new row — an approval
-- that can be edited afterwards is not evidence, and the review history is
-- exactly what an auditor or an unhappy client asks for.
--
-- [D-323] trg_dam_review_decisions_apply is the ONLY writer of
-- dam_assets.status in the review path, so the status and its evidence can
-- never disagree. Note that `approved` does not publish: publishing stays a
-- separate explicit act (D-005).
--
-- No deleted_by: a decision goes only with its target.
create table dam_review_decisions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The reviewer.
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,

  target_type dam_target_type not null
    constraint dam_review_decisions_target_type_check
    check (target_type in ('asset', 'album')),
  -- Polymorphic, so no FK (D-349).
  target_id uuid not null,
  -- The version reviewed. Required when target_type = 'asset' and the asset
  -- has a current version — a cross-table condition, so the trigger enforces
  -- it rather than a CHECK.
  asset_version_id uuid
    references dam_asset_versions (id) on delete set null,
  decision dam_review_decision not null,
  -- The status before the decision; null for albums.
  from_status dam_asset_status,
  -- The status the trigger applied; null for albums and for
  -- changes_requested, which leaves the asset at `pending`.
  to_status dam_asset_status,
  -- Required for `rejected` and `changes_requested` (trigger). Nothing is
  -- required to approve.
  note text
    constraint dam_review_decisions_note_length_check
    check (note is null or length(note) <= 4000),
  -- When the reviewer wrote the detail as an annotated comment, the decision
  -- cites it instead of repeating it.
  comment_id uuid
    references dam_comments (id) on delete set null,
  -- [D-322] Trigger-maintained: exactly one live current decision per target,
  -- which is a partial unique index in the index file.
  is_current boolean not null default true,
  -- The event time. created_at is the row time; in practice they are equal,
  -- but a back-dated import writes a decided_at the row time cannot carry.
  decided_at timestamptz not null default now(),

  -- An album decision is advisory and changes no status, so it carries none.
  constraint dam_review_decisions_album_status_check
    check (target_type <> 'album' or (from_status is null and to_status is null))
);

comment on table dam_review_decisions is
  'Approval records for assets and albums (SPEC 2B.32, D-005). Append-only (D-322): a changed mind is a new row. The one-live-current-decision rule is a partial unique index in the index file.';
comment on column dam_review_decisions.is_current is
  'D-322: exactly one live current decision per target, cleared on the others by trg_dam_review_decisions_current.';
comment on column dam_review_decisions.to_status is
  'D-323: written by the same trigger that sets dam_assets.status, so the status and its evidence cannot disagree. `approved` does not publish.';


-- ---------------------------------------------------------------------------
-- 2B.33  dam_notifications — in-app notifications and the digest state machine
-- ---------------------------------------------------------------------------
-- Brief §4.4. One row per recipient per event: a fan-out table, deliberately
-- cheap to write and cheap to prune. Rows are written only by the
-- send_notification job, never by the UI.
--
-- NO AUDIT TRIGGER (2B.0, D-019 / D-345): a notification is derived from an
-- event that is itself audited, so auditing the fan-out would double every
-- interesting row for no new information.
--
-- No deleted_by: deleted_at means dismissed, and only the recipient can
-- dismiss.
create table dam_notifications (
  id uuid primary key default gen_random_uuid(),
  -- The event time.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The actor who caused it; null for system events.
  created_by uuid,
  updated_by uuid,
  -- = dismissed.
  deleted_at timestamptz,

  -- The recipient.
  user_id uuid not null
    references dam_users (id) on delete cascade,
  -- Drives the icon, the copy and the per-user delivery preference held in
  -- dam_users.settings.notifications.
  kind dam_notification_kind not null,
  -- Already rendered: British spelling, sentence case.
  title text not null
    constraint dam_notifications_title_length_check
    check (length(title) between 1 and 200),
  -- One line of detail.
  body text
    constraint dam_notifications_body_length_check
    check (body is null or length(body) <= 2000),
  -- Where the notification points; null for firm-level events such as
  -- job_dead.
  target_type dam_target_type,
  -- Polymorphic and deliberately NOT asserted: the target may legitimately be
  -- soft-deleted by the time the row is read, and the UI degrades to a dead
  -- link rather than the write failing.
  target_id uuid,
  -- The relative path the row opens, e.g. /assets/{id}?comment={id}.
  action_url text,
  -- Everything the digest template needs without a join.
  payload jsonb not null default '{}',
  -- [D-324] Collapses repeats: '<kind>:<target_id>:<yyyy-mm-dd>'. Unique per
  -- user among UNREAD live rows (a partial index), so twenty views of one
  -- share produce one unread row whose count is incremented. Fan-out
  -- notification systems fail by volume, not by absence.
  dedupe_key text,
  occurrence_count integer not null default 1
    constraint dam_notifications_occurrence_count_check
    check (occurrence_count >= 1),
  -- Null = unread; the bell badge counts these.
  read_at timestamptz,
  -- [D-324] pending awaits the next digest run; instant_sent was emailed
  -- immediately (per-user preference `instant`); digested was included in a
  -- digest; skipped means the preference is `off` or the row was read before
  -- the digest ran.
  digest_state text not null default 'pending'
    constraint dam_notifications_digest_state_check
    check (digest_state in ('pending', 'instant_sent', 'digested', 'skipped')),
  email_sent_at timestamptz,
  -- [D-325] Auto-pruned by the purge_trash job. A notification is a nudge with
  -- a short half-life and nothing else references these rows; ninety days
  -- keeps a quarter of history for support questions without needing a
  -- partitioned table.
  expires_at timestamptz not null default (now() + interval '90 days'),

  -- Half a pointer is a bug, here as everywhere.
  constraint dam_notifications_target_pair_check
    check ((target_type is null) = (target_id is null))
);

comment on table dam_notifications is
  'In-app notifications and the digest state machine (SPEC 2B.33, brief §4.4). Written only by the send_notification job. No audit trigger (D-019/D-345): the events behind these rows are audited already. No admin may read another user''s notifications.';
comment on column dam_notifications.dedupe_key is
  'D-324: unique per user among unread live rows, so repeats increment occurrence_count instead of adding rows.';
comment on column dam_notifications.target_id is
  'Deliberately not asserted by dam_assert_polymorphic_target: the target may be soft-deleted by read time, and a dead link beats a failed write.';


-- ---------------------------------------------------------------------------
-- 2B.34  dam_ratings — star ratings, one per user per asset
-- ---------------------------------------------------------------------------
-- Distinct from dam_project_assets.rank (2A), which is the curated order of an
-- asset WITHIN a project and is a property of the link, not an opinion.
--
-- Uniqueness is over ALL rows: re-rating updates the row, so the history is
-- one row per (asset, user) pair and the constraint can sit on the table.
--
-- No deleted_by: deleted_at means the user cleared their rating.
create table dam_ratings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Equal to user_id; kept for column uniformity across every table.
  created_by uuid,
  updated_by uuid,
  -- = rating cleared. Clearing soft-deletes rather than storing a 0, so the
  -- CHECK below can stay a plain 1..5.
  deleted_at timestamptz,

  asset_id uuid not null
    references dam_assets (id) on delete cascade,
  user_id uuid not null
    references dam_users (id) on delete cascade,
  rating smallint not null
    constraint dam_ratings_rating_check
    check (rating between 1 and 5),

  constraint dam_ratings_asset_user_key unique (asset_id, user_id)
);

comment on table dam_ratings is
  'Star ratings, one per user per asset (SPEC 2B.34). D-326: the aggregate is materialised into dam_asset_search.rating_avg/rating_count, so sorting a 500k-row grid by rating joins and aggregates nothing.';


-- ---------------------------------------------------------------------------
-- 2B.35  dam_favourites — personal bookmarks (brief §3)
-- ---------------------------------------------------------------------------
-- The asset, project, album or employee a user wants one click away. Private
-- by construction: no one else, admins included, reads another user's
-- favourites.
--
-- [D-327] Favourites and ratings are deliberately NOT in the
-- dam_soft_delete_dependants cascade (2B.0). Soft-deleting an asset leaves the
-- bookmark alone, the panel filters dead targets out at read time, and
-- purge_trash removes the rows when the target is finally purged — so
-- trashing an asset by accident and restoring it restores everyone's
-- bookmarks with it, which a cascade that stamped its own deleted_at would
-- make fragile.
--
-- Uniqueness is over ALL rows: re-favouriting restores the row and its note.
--
-- No deleted_by: deleted_at means unfavourited, by the owner alone.
create table dam_favourites (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Equal to user_id.
  created_by uuid,
  updated_by uuid,
  -- = unfavourited.
  deleted_at timestamptz,

  user_id uuid not null
    references dam_users (id) on delete cascade,
  target_type dam_target_type not null
    constraint dam_favourites_target_type_check
    check (target_type in ('asset', 'project', 'album', 'employee')),
  -- Polymorphic, so no FK; asserted on insert only, because a target that is
  -- trashed later must not make the row unwritable.
  target_id uuid not null,
  -- The user's own reminder: "shortlist for the Riyadh pitch".
  note text
    constraint dam_favourites_note_length_check
    check (note is null or length(note) <= 500),
  -- Manual order in the favourites panel; ties break on created_at desc.
  sort_order integer not null default 0,

  constraint dam_favourites_user_target_key unique (user_id, target_type, target_id)
);

comment on table dam_favourites is
  'Personal bookmarks (SPEC 2B.35). Private by construction — there is no admin read policy. D-327: not in the soft-delete cascade, so restoring a trashed asset restores everyone''s bookmarks with it.';


-- ===========================================================================
-- THE THREE PARTITIONED LOG TABLES (2B.36–2B.38)
-- ===========================================================================
-- All three are RANGE-partitioned monthly on occurred_at, and all three share
-- the same shape for the same reasons [D-329, D-330]:
--
--   * `primary key (id, occurred_at)` — a partitioned table's primary key must
--     contain the partition key, so the id alone cannot be it.
--   * NO FOREIGN KEYS AT ALL, not even on created_by/updated_by. A log outlives
--     the rows it describes; a log row that a purge could delete or null out is
--     not evidence. This is why these three tables are excluded from the
--     standard-audit-column block at the end of this file.
--   * A DEFAULT partition plus the first three months are created here. The
--     default must stay EMPTY in steady state and is alerted on: a row landing
--     there means the create_partitions job (dam_job_kind = 'create_partitions',
--     pg_cron 04:00 on the 25th) has stopped running.
--     dam_create_monthly_partitions(regclass, int) creates the rest and drops
--     nothing.
--   * Retention is `alter table … detach partition` + `drop table`, never
--     DELETE: deleting tens of millions of rows costs a vacuum and a bloated
--     index, while dropping a child is instant and returns the disk.
--   * Append-only: no set_updated_at trigger, no audit trigger, and UPDATE and
--     DELETE are revoked in the policy file.
--
-- Boundaries are written as timestamps in the firm timezone (Asia/Bangkok,
-- UTC+7 year-round, no daylight saving), matching the child naming convention
-- dam_<table>_yYYYYmMM: the September partition holds the firm's September.
--
-- THE OFFSET IS WRITTEN OUT ON PURPOSE. A bare '2026-09-01' in a bound is cast
-- to timestamptz using the SESSION's TimeZone, which on Supabase is UTC, so the
-- bare form silently gives UTC boundaries and makes the sentence above false.
-- Worse, it makes the bound depend on who ran the statement: the monthly
-- create_partitions job running under a different TimeZone would compute a
-- lower bound that does not meet the previous partition's upper bound, and
-- Postgres would either refuse the overlap or accept a gap — and a gap routes
-- those rows to the default partition, which retention never drops. Explicit
-- offsets make every bound mean the same instant in every session.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 2B.36  dam_audit_log — row-level audit of every business table (brief §4.8)
-- ---------------------------------------------------------------------------
-- Plus the non-row events that matter: login, download, share and every
-- permission change. Written by dam_audit_row() (the row trigger) and by
-- dam_audit_event() (the explicit writer); nothing in the application ever
-- updates or deletes a row.
--
-- [D-328] Redaction is a SETTING, not code: dam_setting('audit.redacted_columns')
-- is seeded with key_hash, token_hash, password_hash, secret_hash, api_secret
-- and private_key, and dam_audit_row() strips those keys from both blobs. The
-- next secret column must not require redeploying a function, and a secret
-- that reaches the audit log is unrecoverable once written.
create table dam_audit_log (
  -- Part of the PK, not the whole of it.
  id uuid not null default gen_random_uuid(),
  -- PARTITION KEY, and the sort key of every query against this table.
  occurred_at timestamptz not null default now(),
  -- Equal to occurred_at in practice; kept because SPEC 2B.0 says every table
  -- carries it.
  created_at timestamptz not null default now(),
  -- No set_updated_at trigger: rows are never updated.
  updated_at timestamptz not null default now(),
  -- Mirrors actor_id.
  created_by uuid,
  -- Always null.
  updated_by uuid,
  -- Always null: retention drops whole partitions instead.
  deleted_at timestamptz,

  -- Hyphen-free so it can be fed to format('%I') without quoting games.
  table_name text not null
    constraint dam_audit_log_table_name_check
    check (table_name ~ '^dam_[a-z0-9_]+$'),
  -- The affected row; null for non-row events such as login.
  row_id uuid,
  action dam_audit_action not null,
  -- dam_current_user_id() at the time. NO FK: a log must survive the purge of
  -- the user it names.
  actor_id uuid,
  actor_type dam_principal_type not null default 'user',
  -- No FK; set when actor_type = 'api_key'.
  api_key_id uuid,
  -- No FK; set when actor_type = 'share_link'.
  share_link_id uuid,
  -- The API's request_id, which is also in every error envelope (DQ10), so a
  -- support ticket joins a log line to the response the user saw.
  request_id text,
  -- Salted SHA-256, never the raw address.
  ip_hash text,
  -- Truncated to 400 characters by the writer.
  user_agent text,
  -- [D-331] Denormalised at write time from the affected row's primary
  -- project; no FK.
  project_id uuid,
  -- [D-331] Denormalised likewise, and REQUIRED by the studio-scoped read
  -- policy: part 3 §3.7 filters audit rows with dam_can_manage_studio().
  -- Resolving a studio from (table_name, row_id) at read time would be a
  -- polymorphic lookup per row across thirty-six partitions, which is why
  -- dam_audit_row() writes it once.
  studio_id uuid,
  -- to_jsonb(OLD) minus the redacted keys; null on insert.
  old_row jsonb,
  -- to_jsonb(NEW) minus the redacted keys; null on delete.
  new_row jsonb,
  -- Keys whose value differs; empty on insert and delete. The diff view reads
  -- this, not the two blobs. dam_audit_row() writes nothing at all when an
  -- update changes no key.
  changed_keys text[] not null default '{}',
  -- Event-specific payload for the non-row actions: download carries asset,
  -- size, purpose and any override reason; login the method; share the
  -- token_prefix.
  detail jsonb not null default '{}',

  -- [D-329] A partitioned table's primary key must contain the partition key.
  constraint dam_audit_log_pkey primary key (id, occurred_at)
)
partition by range (occurred_at);

comment on table dam_audit_log is
  'Row-level audit of every business table plus login/download/share/permission_change (SPEC 2B.36, DQ9). Monthly RANGE partitions on occurred_at; append-only; no foreign keys, because audit rows outlive the rows they describe. Retention drops partitions (D-330).';
comment on column dam_audit_log.studio_id is
  'D-331: denormalised at write time because part 3 §3.7 filters audit reads by dam_can_manage_studio(studio_id), and resolving it per row across every partition is not a read path.';
comment on column dam_audit_log.changed_keys is
  'The diff view reads this rather than the two blobs. Redacted keys appear here with no value (D-328).';

-- The default partition must stay EMPTY in steady state; a row here means
-- create_partitions has stopped running, and the monitor alerts on it.
create table dam_audit_log_default partition of dam_audit_log default;

-- The first three months. dam_create_monthly_partitions('dam_audit_log', 3),
-- called by the create_partitions job, makes every one after these.
create table dam_audit_log_y2026m09 partition of dam_audit_log
  for values from (timestamptz '2026-09-01 00:00+07') to (timestamptz '2026-10-01 00:00+07');
create table dam_audit_log_y2026m10 partition of dam_audit_log
  for values from (timestamptz '2026-10-01 00:00+07') to (timestamptz '2026-11-01 00:00+07');
create table dam_audit_log_y2026m11 partition of dam_audit_log
  for values from (timestamptz '2026-11-01 00:00+07') to (timestamptz '2026-12-01 00:00+07');


-- ---------------------------------------------------------------------------
-- 2B.37  dam_usage_events — who took what, at what size, and why (brief §4.7)
-- ---------------------------------------------------------------------------
-- The evidence behind "who downloaded what, when and why", and the input to
-- every dashboard. Written only by dam_record_usage(); no serve path inserts
-- directly. Dashboards read the nightly materialised views (D-024), never the
-- raw partitions.
create table dam_usage_events (
  id uuid not null default gen_random_uuid(),
  -- PARTITION KEY.
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  -- No set_updated_at trigger.
  updated_at timestamptz not null default now(),
  -- Mirrors user_id.
  created_by uuid,
  -- Always null.
  updated_by uuid,
  -- Always null: retention drops partitions.
  deleted_at timestamptz,

  event dam_usage_event not null,
  -- No FK (the log outlives purges). Null for a share_view of a whole link and
  -- for document_generate.
  asset_id uuid,
  -- No FK; which bytes were served.
  version_id uuid,
  principal_type dam_principal_type not null default 'user',
  -- The four principal columns, all without FKs.
  user_id uuid,
  api_key_id uuid,
  share_link_id uuid,
  -- The placement and share_view equivalents for a deposit page.
  upload_request_id uuid,
  -- The dam_sizes row served; null for an original or a custom render.
  size_id uuid,
  -- The delivered format: jpeg, webp, pdf, original.
  format text,
  -- Delivered pixels, so "what sizes do people actually take" is answerable.
  width integer,
  height integer,
  -- Egress accounting by studio.
  bytes bigint
    constraint dam_usage_events_bytes_check
    check (bytes is null or bytes >= 0),
  -- The declared use ("Riyadh RFP", "Instagram"). Required by policy for
  -- download_original on rights-bearing assets, but refused by the API rather
  -- than by the table: a `view` event has no purpose, so the column stays
  -- nullable.
  purpose text
    constraint dam_usage_events_purpose_length_check
    check (purpose is null or length(purpose) <= 200),
  -- Filled when a global_admin forced a download the rights forbade (2B.23).
  override_reason text,
  -- [D-331] Denormalised from the asset's primary project at write time, no
  -- FK. "Storage and egress by studio over 12 months" must not join a
  -- 500k-row asset table across thirty-six partitions — and the asset's
  -- project may change afterwards without rewriting history.
  project_id uuid,
  studio_id uuid,
  -- Salted SHA-256.
  ip_hash text,
  -- Truncated to 400 characters by the writer.
  user_agent text,
  -- For share pages and v1 consumers; truncated to 500.
  referrer text,
  -- Joins to dam_audit_log.
  request_id text,
  -- [D-317] Per-event context not worth a column: the share page's email
  -- capture, the ZIP manifest id, the document generator's inputs — one-line
  -- facts that three different events each need exactly one of.
  meta jsonb not null default '{}',

  constraint dam_usage_events_pkey primary key (id, occurred_at),
  -- At most one principal pointer is set; which one is named by
  -- principal_type.
  constraint dam_usage_events_one_principal_check
    check (num_nonnulls(user_id, api_key_id, share_link_id, upload_request_id) <= 1),
  constraint dam_usage_events_principal_type_check
    check ((principal_type = 'user') = (user_id is not null) or principal_type = 'system')
)
partition by range (occurred_at);

comment on table dam_usage_events is
  'Every view, preview, download, export, share and placement (SPEC 2B.37, DQ9). Monthly RANGE partitions; append-only; no foreign keys. dam_record_usage() is the only writer.';
comment on column dam_usage_events.meta is
  'D-317: per-event context not worth a column — viewer_email, zip_job_id, document_id, template_id, query.';
comment on column dam_usage_events.purpose is
  'Nullable by design: a view has no purpose. The API, not the table, refuses a download_original of a rights-bearing asset without one.';

create table dam_usage_events_default partition of dam_usage_events default;

create table dam_usage_events_y2026m09 partition of dam_usage_events
  for values from (timestamptz '2026-09-01 00:00+07') to (timestamptz '2026-10-01 00:00+07');
create table dam_usage_events_y2026m10 partition of dam_usage_events
  for values from (timestamptz '2026-10-01 00:00+07') to (timestamptz '2026-11-01 00:00+07');
create table dam_usage_events_y2026m11 partition of dam_usage_events
  for values from (timestamptz '2026-11-01 00:00+07') to (timestamptz '2026-12-01 00:00+07');


-- ---------------------------------------------------------------------------
-- 2B.38  dam_search_log — every query, including the ones that found nothing
-- ---------------------------------------------------------------------------
-- Brief §4.8: "top search terms, zero-result searches". A zero-result search
-- is the taxonomy's to-do list, so it is a first-class generated column rather
-- than something derived later.
--
-- Kept 12 months, shorter than the other two logs, because query text is the
-- most personal thing the platform stores.
--
-- Written by the search RPC itself, one row per executed search, never by the
-- client. Queries from is_system principals and from health checks are not
-- logged at all. The ONE permitted mutation is the click write-back, narrowed
-- to clicked_asset_id, clicked_rank and updated_at by
-- trg_dam_search_log_click_only.
create table dam_search_log (
  id uuid not null default gen_random_uuid(),
  -- PARTITION KEY.
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  -- This table's only mutation is the click write-back, which sets this.
  updated_at timestamptz not null default now(),
  -- Mirrors user_id.
  created_by uuid,
  -- Always null.
  updated_by uuid,
  -- Always null: retention drops partitions.
  deleted_at timestamptz,

  -- Which corpus was searched.
  target text not null default 'asset'
    constraint dam_search_log_target_check
    check (target in ('asset', 'project', 'employee', 'album', 'text_block')),
  -- The raw q, verbatim; null for a pure filter query.
  query_text text
    constraint dam_search_log_query_text_length_check
    check (query_text is null or length(query_text) <= 500),
  -- lower(dam_unaccent(btrim(query_text))) with runs of whitespace collapsed,
  -- written by the search RPC. It is what "top search terms" groups by, so
  -- "Lobby " and "lobby" are one term. Not a generated column, because the
  -- collapsing is the RPC's normalisation and not a property of the row.
  query_normalised text,
  -- The parsed filter object (DQ10 shape), so "which facets do people actually
  -- use" is answerable.
  filters jsonb not null default '{}',
  sort text,
  result_count integer not null default 0
    constraint dam_search_log_result_count_check
    check (result_count >= 0),
  -- Generated stored: the zero-result report's partial index is built on it,
  -- and a derived flag must not be able to disagree with its own count.
  is_zero_result boolean
    generated always as (result_count = 0) stored,
  -- The p95 that the §4.11 latency budget is measured against.
  took_ms integer
    constraint dam_search_log_took_ms_check
    check (took_ms is null or took_ms >= 0),
  -- DQ5's modes plus §4.10's conversational path, so their relevance can be
  -- compared against each other.
  search_mode text not null default 'keyword'
    constraint dam_search_log_search_mode_check
    check (search_mode in ('keyword', 'semantic', 'hybrid', 'similar', 'conversational')),
  -- No FK; set when the query came from a saved search.
  saved_search_id uuid,
  -- [D-332] The row the user opened from these results, and its 1-based
  -- position, written by a follow-up PATCH /search/{log_id}/click in the same
  -- session. Click-through at rank is the only honest measure of whether a
  -- ranking change helped; without it "improve search" is guesswork.
  clicked_asset_id uuid,
  clicked_rank smallint
    constraint dam_search_log_clicked_rank_check
    check (clicked_rank is null or clicked_rank > 0),
  principal_type dam_principal_type not null default 'user',
  -- The three principal columns, all without FKs.
  user_id uuid,
  api_key_id uuid,
  -- Searches inside a search-scoped share.
  share_link_id uuid,
  -- [D-331] The searcher's primary studio, denormalised.
  studio_id uuid,
  request_id text,
  ip_hash text,

  constraint dam_search_log_pkey primary key (id, occurred_at),
  constraint dam_search_log_one_principal_check
    check (num_nonnulls(user_id, api_key_id, share_link_id) <= 1),
  -- An empty search is not logged at all.
  constraint dam_search_log_not_empty_check
    check (query_text is not null or filters <> '{}'),
  -- A click is a row and a rank together, or neither.
  constraint dam_search_log_click_pair_check
    check ((clicked_asset_id is null) = (clicked_rank is null))
)
partition by range (occurred_at);

comment on table dam_search_log is
  'Every executed search, zero-result ones included (SPEC 2B.38, DQ9). Monthly RANGE partitions, 12-month retention — shorter than the other two logs because query text is the most personal thing the platform stores.';
comment on column dam_search_log.query_normalised is
  'Written by the search RPC as lower(dam_unaccent(btrim(query_text))) with whitespace collapsed, so "Lobby " and "lobby" group as one term.';
comment on column dam_search_log.clicked_rank is
  'D-332: click-through at rank, written back by PATCH /search/{log_id}/click. The only honest measure of whether a ranking change helped.';

create table dam_search_log_default partition of dam_search_log default;

create table dam_search_log_y2026m09 partition of dam_search_log
  for values from (timestamptz '2026-09-01 00:00+07') to (timestamptz '2026-10-01 00:00+07');
create table dam_search_log_y2026m10 partition of dam_search_log
  for values from (timestamptz '2026-10-01 00:00+07') to (timestamptz '2026-11-01 00:00+07');
create table dam_search_log_y2026m11 partition of dam_search_log
  for values from (timestamptz '2026-11-01 00:00+07') to (timestamptz '2026-12-01 00:00+07');


-- ---------------------------------------------------------------------------
-- 2B.39  dam_jobs — the background queue (DQ8)
-- ---------------------------------------------------------------------------
-- Every slow thing the platform does. Request handlers never do slow work;
-- they enqueue. Jobs are claimed with `for update skip locked` in one
-- statement (dam_claim_jobs), so N workers need no external broker and there
-- is no SELECT-then-UPDATE race.
--
-- [D-334] Not partitioned, because purge_trash keeps it small: succeeded rows
-- go after 14 days, dead rows are kept 90 so a failure can still be diagnosed
-- and replayed.
--
-- No audit trigger (D-019).
create table dam_jobs (
  -- The handle a client polls.
  id uuid primary key default gen_random_uuid(),
  -- = enqueued at.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Who caused the work; the worker or sync system principal for scheduled
  -- jobs.
  created_by uuid,
  updated_by uuid,
  -- Unused in practice: jobs are pruned, not trashed.
  deleted_at timestamptz,

  kind dam_job_kind not null,
  -- Job input, Zod-validated per kind on the worker side. Holds ids, never
  -- bytes and never secrets.
  payload jsonb not null default '{}'
    constraint dam_jobs_payload_object_check
    check (jsonb_typeof(payload) = 'object'),
  -- queued → running → succeeded | failed → queued (retry) → dead;
  -- cancelled from queued or running.
  status dam_job_status not null default 'queued',
  -- [D-334] LOWER RUNS FIRST. 10 = interactive (a user waiting on a render),
  -- 100 = normal ingest, 500 = backfills and sweeps. One numeric with a
  -- documented direction beats an enum nobody remembers the order of, and it
  -- leaves room between the three bands.
  priority smallint not null default 100,
  -- Lets the heavy TIFF and video work run on a worker pool of its own
  -- without a second table.
  queue text not null default 'default'
    constraint dam_jobs_queue_format_check
    check (queue ~ '^[a-z0-9_-]{1,32}$'),
  -- Not claimable before this; how delays and exponential backoff are both
  -- expressed.
  run_after timestamptz not null default now(),
  -- Incremented by the claim itself, so a crashed worker still burns an
  -- attempt and a poison job cannot loop forever.
  attempts integer not null default 0
    constraint dam_jobs_attempts_check
    check (attempts >= 0),
  -- D-018.
  max_attempts integer not null default 5
    constraint dam_jobs_max_attempts_check
    check (max_attempts between 1 and 50),
  -- Worker instance id, <revision>/<pid>/<uuid>.
  locked_by text
    constraint dam_jobs_locked_by_length_check
    check (locked_by is null or length(locked_by) <= 120),
  locked_at timestamptz,
  -- Visibility timeout (D-018), extended by the heartbeat. This is what makes
  -- a killed Cloud Run instance harmless: dam_reclaim_stale_jobs() requeues
  -- anything whose lease has lapsed.
  lock_expires_at timestamptz,
  heartbeat_at timestamptz,
  -- Drives the upload and ingest progress bars.
  progress smallint
    constraint dam_jobs_progress_check
    check (progress is null or progress between 0 and 100),
  -- [D-333] Unique only among rows in a NON-TERMINAL state, which is a partial
  -- unique index and so lives in the index file. The key means "do not queue
  -- this twice right now" (reindex_project:<id>, derivatives:<version_id>),
  -- not "never again" — a plain unique would make the second reindex of the
  -- same project impossible for the life of the table.
  idempotency_key text
    constraint dam_jobs_idempotency_key_length_check
    check (idempotency_key is null or length(idempotency_key) <= 200),
  -- The ingest chain hash → extract_metadata → generate_derivatives → dedupe
  -- → embed → ocr → reindex_asset links each step to the one that scheduled
  -- it.
  parent_job_id uuid
    references dam_jobs (id) on delete set null,
  -- Trigger-set to the chain's origin, so "show me this ingest" is one
  -- indexed read instead of a recursive walk.
  root_job_id uuid
    references dam_jobs (id) on delete set null,
  -- Set when the job is about one asset; the asset page shows its in-flight
  -- work.
  asset_id uuid
    references dam_assets (id) on delete cascade,
  project_id uuid
    references dam_projects (id) on delete cascade,
  version_id uuid
    references dam_asset_versions (id) on delete cascade,
  -- (ALTER) → dam_integrations(id) on delete cascade; set for sync_run. 2B.42
  -- is created later.
  integration_id uuid,
  -- (ALTER) → dam_webhook_deliveries(id) on delete cascade; set for
  -- webhook_deliver. 2B.41 is created later.
  webhook_delivery_id uuid,
  -- What the handler returned; read by the poller and by the parent step.
  result jsonb not null default '{}',
  last_error text
    constraint dam_jobs_last_error_length_check
    check (last_error is null or length(last_error) <= 4000),
  -- `permanent` skips the remaining attempts and goes straight to dead.
  error_class text
    constraint dam_jobs_error_class_check
    check (error_class is null
           or error_class in ('transient', 'permanent', 'rate_limited', 'cancelled')),
  -- Co-operative cancellation of a RUNNING job: the API stamps this, the
  -- worker sees it at its next heartbeat and stops. Writing status =
  -- 'cancelled' directly would race the worker's own terminal write, so the
  -- worker performs the status change itself.
  cancel_requested_at timestamptz,
  -- First claim.
  started_at timestamptz,
  finished_at timestamptz,
  -- Set on completion; the worker dashboard's p95.
  duration_ms integer
    constraint dam_jobs_duration_ms_check
    check (duration_ms is null or duration_ms >= 0),

  -- A running job is held by somebody.
  constraint dam_jobs_running_locked_check
    check (status <> 'running' or locked_by is not null),
  -- A terminal job says when it became terminal.
  constraint dam_jobs_finished_check
    check (status not in ('succeeded', 'failed', 'dead', 'cancelled')
           or finished_at is not null)
);

comment on table dam_jobs is
  'The background queue (SPEC 2B.39, DQ8). Claimed with for-update-skip-locked in one statement, so N workers need no broker. Not partitioned (D-334): purge_trash keeps succeeded rows 14 days and dead rows 90. No audit trigger (D-019).';
comment on column dam_jobs.priority is
  'D-334: LOWER RUNS FIRST. 10 interactive, 100 normal ingest, 500 backfills and sweeps.';
comment on column dam_jobs.idempotency_key is
  'D-333: unique only while status is queued or running — a partial index. The key means "not twice right now", not "never again".';
comment on column dam_jobs.cancel_requested_at is
  'Co-operative cancellation. Setting status directly would race the worker''s own terminal write, so the worker makes the status change after it sees this.';


-- ---------------------------------------------------------------------------
-- 2B.40  dam_webhooks — outbound subscriptions (brief §4.9, DQ10)
-- ---------------------------------------------------------------------------
-- A consumer registers a URL and a set of events and receives signed JSON when
-- they happen.
--
-- [D-335] THE ROW HOLDS NO SECRET. DQ10 asked for a `secret_hash`, but an HMAC
-- cannot be computed from a hash — the platform must hold the real secret to
-- sign with it. So the row keeps the Secret Manager NAME of the signing secret
-- and a twelve-character fingerprint of it: the name is what the signer
-- resolves, and the fingerprint is what the admin UI shows so a consumer can
-- confirm they hold the same secret and can see a rotation happen. The
-- fingerprint verifies nothing.
create table dam_webhooks (
  -- Sent as X-DAM-Webhook-Id.
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  -- Unique case-insensitively among live rows: partial expression index.
  name text not null
    constraint dam_webhooks_name_length_check
    check (length(name) between 1 and 80),
  -- HTTPS only, with no exceptions — not even for localhost.
  url text not null
    constraint dam_webhooks_url_check
    check (url ~ '^https://' and length(url) <= 2000),
  description text,
  -- The ten events of DECISIONS §3. An empty subscription is not a
  -- subscription.
  events dam_webhook_event[] not null default '{}'
    constraint dam_webhooks_events_check
    check (cardinality(events) > 0),
  -- Optional narrowing evaluated BEFORE a delivery row is created:
  -- { studio_ids, category_ids, project_ids }.
  filter jsonb not null default '{}'
    constraint dam_webhooks_filter_object_check
    check (jsonb_typeof(filter) = 'object'),
  -- Subscription scope (part 4, D-461). Empty = every studio the owner may
  -- see. Checked IN ADDITION to the owner's own visibility, never instead
  -- of it.
  studio_ids uuid[] not null default '{}',
  -- [D-335] The Secret Manager name (DAM_WEBHOOK_SECRET_<slug>), never the
  -- secret. Keeping the value out of the table honours DECISIONS §4 and leaves
  -- the row fully auditable.
  secret_name text not null
    constraint dam_webhooks_secret_name_format_check
    check (secret_name ~ '^[A-Z0-9_]{4,120}$'),
  -- [D-335] left(encode(sha256(secret), 'hex'), 12). Display only.
  secret_fingerprint text,
  -- [D-335] During rotation both secrets sign the request for
  -- dam_setting('webhooks.rotation_overlap_hours'), so a consumer can roll
  -- over without dropping events.
  previous_secret_name text
    constraint dam_webhooks_previous_secret_name_format_check
    check (previous_secret_name is null or previous_secret_name ~ '^[A-Z0-9_]{4,120}$'),
  secret_rotated_at timestamptz,
  -- Non-secret headers the consumer needs, e.g. {"X-Tenant": "dwp"}. The same
  -- guard as dam_integrations.config applies, because a "custom header" is
  -- exactly where a token would otherwise be smuggled in.
  custom_headers jsonb not null default '{}'
    constraint dam_webhooks_custom_headers_no_secrets_check
    check (dam_config_has_no_secrets(custom_headers)),
  -- The payload shape. A future v3 can be delivered to new subscriptions only.
  api_version text not null default 'v2',
  timeout_ms integer not null default 10000
    constraint dam_webhooks_timeout_ms_check
    check (timeout_ms between 1000 and 30000),
  is_active boolean not null default true,
  -- Reset on any success. [D-336] At twenty, trg_dam_webhooks_failure_count
  -- disables the subscription and notifies: a consumer dead for a hundred
  -- deliveries will not accept the hundred-and-first, and an un-disabled
  -- subscription is how a queue fills up.
  consecutive_failures integer not null default 0
    constraint dam_webhooks_consecutive_failures_check
    check (consecutive_failures >= 0),
  disabled_at timestamptz,
  -- consecutive_failures, invalid_url, manual.
  disabled_reason text,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  delivery_count bigint not null default 0
);

comment on table dam_webhooks is
  'Outbound webhook subscriptions (SPEC 2B.40, brief §4.9). D-335: the row holds the NAME of the signing secret and a fingerprint, never the secret — an HMAC cannot be computed from a hash. Name uniqueness and the (url, events) rule are partial indexes in the index file.';
comment on column dam_webhooks.secret_name is
  'D-335: the Secret Manager name of the signing secret. The signer resolves it; the table never sees the value.';
comment on column dam_webhooks.secret_fingerprint is
  'D-335: twelve hex characters for the admin UI, so a consumer can confirm they hold the same secret. Never used to verify anything.';
comment on column dam_webhooks.studio_ids is
  'Part 4 D-461: narrows the subscription. Applied in addition to the owner''s own visibility, never instead of it.';


-- ---------------------------------------------------------------------------
-- 2B.41  dam_webhook_deliveries — one row per (event, subscription) pair
-- ---------------------------------------------------------------------------
-- The replay buffer and the debugging surface: an admin sees the body, the
-- response code and the reason, and can re-send. A re-send CLONES the row with
-- a new id and attempt = 0 rather than resetting it, so the history of the
-- original stays true.
--
-- The payload is frozen at creation, because the signature is computed over
-- the exact bytes and any re-serialisation would break it.
--
-- No audit trigger (2B.0, D-345) — a delivery log is already a log.
-- No deleted_by: deliveries are pruned (D-337), never trashed.
create table dam_webhook_deliveries (
  -- Sent as X-DAM-Delivery; consumers de-duplicate on it.
  id uuid primary key default gen_random_uuid(),
  -- The event time.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The actor whose change raised the event.
  created_by uuid,
  updated_by uuid,
  -- Unused; deliveries are pruned.
  deleted_at timestamptz,

  webhook_id uuid not null
    references dam_webhooks (id) on delete cascade,
  event dam_webhook_event not null,
  -- The exact object serialised into the body, frozen at creation so a retry
  -- sends the same bytes and the same signature is reproducible.
  payload jsonb not null,
  -- Convenience for filtering the delivery list; no FK.
  target_type dam_target_type,
  target_id uuid,
  -- [D-287 convention]
  status text not null default 'pending'
    constraint dam_webhook_deliveries_status_check
    check (status in ('pending', 'delivering', 'succeeded', 'failed', 'dead', 'cancelled')),
  attempt smallint not null default 0
    constraint dam_webhook_deliveries_attempt_check
    check (attempt >= 0),
  max_attempts smallint not null default 5
    constraint dam_webhook_deliveries_max_attempts_check
    check (max_attempts >= 1),
  -- [D-336] Five attempts at 0, 1, 5, 15 and 30 minutes, about 51 minutes in
  -- all. Null once terminal.
  next_attempt_at timestamptz default now(),
  -- 2xx is success; 410 is treated as permanent and disables the subscription.
  response_code integer
    constraint dam_webhook_deliveries_response_code_check
    check (response_code is null or response_code between 100 and 599),
  -- First 2000 characters only.
  response_body text,
  -- A safe subset: content-type, retry-after.
  response_headers jsonb,
  -- Transport errors: DNS, TLS, timeout.
  error text,
  duration_ms integer,
  -- The `t` used in the last signature.
  signed_at timestamptz,
  -- First 2xx.
  delivered_at timestamptz,

  -- A terminal delivery has nothing scheduled.
  constraint dam_webhook_deliveries_terminal_check
    check (status not in ('succeeded', 'dead', 'cancelled') or next_attempt_at is null)
);

comment on table dam_webhook_deliveries is
  'One row per (event, subscription) pair with every attempt''s outcome (SPEC 2B.41, DQ10). The payload is frozen so a retry reproduces the signature. No audit trigger (D-345). D-337: succeeded rows pruned after 30 days, dead after 90.';
comment on column dam_webhook_deliveries.payload is
  'Frozen at creation. The signature is HMAC over these exact bytes, so re-serialising would invalidate it.';


-- ---------------------------------------------------------------------------
-- 2B.42  dam_integrations — one row per configured connector (brief §4.9)
-- ---------------------------------------------------------------------------
-- HubSpot, BambooHR, Projectworks, Google Drive/Sheets, Marq, generic CSV and
-- the OpenAsset importer. Holds the schedule, the direction, the conflict
-- policy, the change cursor and the run status the sync UI shows — and the
-- NAMES of the secrets it needs, never the secrets.
--
-- [D-338] The config CHECK is dam_config_has_no_secrets(): DECISIONS §4
-- forbids secrets in tables, and a rule enforced only in review is a rule that
-- lasts until the first hurried connector.
create table dam_integrations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  -- The same enum dam_external_ids.system uses, so a synced row's external id
  -- and its connector always agree about which system they mean.
  system dam_external_system not null,
  -- Unique case-insensitively among live rows: one tenant may legitimately
  -- have two Drive connectors for two Shared Drives.
  name text not null
    constraint dam_integrations_name_length_check
    check (length(name) between 1 and 80),
  description text,
  -- New connectors start OFF; activation is an explicit, audited act.
  is_active boolean not null default false,
  -- The default for this connector's mappings.
  direction dam_sync_direction not null default 'inbound',
  -- The default for this connector's mappings (integrations sheet D-703).
  conflict_policy dam_conflict_policy not null default 'source_wins',
  -- Everything else the connector needs, SECRET NAMES ONLY — e.g.
  -- { "subdomain": "dwp", "api_key_secret_name": "BAMBOOHR_API_KEY" }.
  config jsonb not null default '{}'
    constraint dam_integrations_config_no_secrets_check
    check (dam_config_has_no_secrets(config)),
  -- Which object types this connector syncs; empty = every object it supports.
  enabled_objects text[] not null default '{}',
  -- Five-field cron in the firm timezone; null = manual or webhook-driven
  -- only. trg_dam_integrations_schedule reconciles cron.job from this column,
  -- so nothing is ever scheduled by hand.
  schedule_cron text
    constraint dam_integrations_schedule_cron_check
    check (schedule_cron is null or schedule_cron ~ '^[-0-9*/, ]{5,100}$'),
  -- Maintained from schedule_cron for the UI's "next run in 40 minutes".
  next_run_at timestamptz,
  -- The connector's change token: Drive's startPageToken, BambooHR's `since`,
  -- HubSpot's hs_lastmodifieddate high-water mark, Projectworks' page state.
  -- Written only by a SUCCESSFUL run, so a failure re-reads its window.
  cursor jsonb not null default '{}',
  last_run_at timestamptz,
  -- Copied from the latest run by trg_dam_sync_runs_rollup.
  last_status dam_sync_run_status,
  last_error text,
  -- At dam_setting('integrations.max_consecutive_failures') the connector
  -- deactivates itself and notifies (sync_failed).
  consecutive_failures integer not null default 0
    constraint dam_integrations_consecutive_failures_check
    check (consecutive_failures >= 0),
  -- What the connector throttles itself to. Per row because HubSpot's 110
  -- calls per 10 s and BambooHR's per-tenant cap are different numbers.
  rate_limit_per_minute integer
    constraint dam_integrations_rate_limit_check
    check (rate_limit_per_minute is null or rate_limit_per_minute > 0),
  -- A connector confined to one studio's data.
  studio_id uuid
    references dam_studios (id) on delete set null
);

comment on table dam_integrations is
  'One row per configured connector (SPEC 2B.42, DQ17). D-338: config holds secret NAMES only, enforced by dam_config_has_no_secrets(). Name uniqueness and the one-active-firm-wide-connector-per-system rule are partial indexes in the index file.';
comment on column dam_integrations.cursor is
  'The connector''s change token, written only by a successful run — so a failed run leaves it alone and the next run re-reads the same window.';
comment on column dam_integrations.schedule_cron is
  'Reconciled into cron.job by dam_sync_pg_cron(); one entry per active integration. Nothing here is scheduled by hand.';


-- ---------------------------------------------------------------------------
-- 2B.43  dam_integration_field_mappings — where each value comes from
-- ---------------------------------------------------------------------------
-- The explicit answer to brief §4.9's "treat one external system as the source
-- of truth per field and make that explicit": one row per
-- (integration, object, field) saying where the value comes from, which way it
-- flows, who wins, and how it is transformed. The sync UI is a table view of
-- this table.
--
-- [D-339] Source of truth is PER MAPPING, and "detach" is a row, not a flag: a
-- field with is_source_of_truth renders read-only, and editing it requires an
-- explicit detach that writes dam_sync_field_state.is_detached with a reason
-- and is audited as a permission_change-class event.
--
-- No deleted_by: a mapping is removed from the sync UI, not trashed.
create table dam_integration_field_mappings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,

  integration_id uuid not null
    references dam_integrations (id) on delete cascade,
  -- The DAM object the mapping writes.
  object_type text not null
    constraint dam_integration_field_mappings_object_type_check
    check (object_type in ('project', 'client', 'employee', 'employee_education',
                           'employee_registration', 'employee_language',
                           'project_employee', 'asset', 'album', 'keyword', 'studio')),
  -- The remote object (Deal, Company, employees, Project, User, education);
  -- null for CSV, where the sheet is the object.
  source_object text,
  -- The remote field path (amount, hs_parent_company_id, workEmail,
  -- ProjectNumber, education.degree); null for an outbound-only mapping.
  source_field text,
  target_table text not null
    constraint dam_integration_field_mappings_target_table_check
    check (target_table ~ '^dam_[a-z0-9_]+$'),
  -- A real column. Existence, and the ban on the standard six, are asserted by
  -- trg_dam_integration_field_mappings_target against the catalogue.
  target_column text,
  -- [D-339] A custom field (DQ1's typed EAV), so a tenant can map Deal.amount
  -- to a bd_amount custom field without a migration.
  target_field_id uuid
    references dam_fields (id) on delete restrict,
  -- Overrides the integration default per field.
  direction dam_sync_direction not null default 'inbound',
  -- [D-339] True = the remote system owns this field: the DAM UI renders it
  -- read-only while the connector is active, and a local edit requires a
  -- detach.
  is_source_of_truth boolean not null default false,
  -- Null = inherit the integration's.
  conflict_policy dam_conflict_policy,
  -- A fixed, auditable vocabulary. There is deliberately NO expression
  -- language in the database.
  transform text not null default 'none'
    constraint dam_integration_field_mappings_transform_check
    check (transform in ('none', 'trim', 'lower', 'upper', 'iso_country', 'iso_currency',
                         'date_only', 'html_to_text', 'lookup', 'template', 'split_array')),
  -- lookup = { map, on_missing }, which is how BambooHR's free-text `location`
  -- becomes dam_employees.studio_id and Projectworks' ProjectStatusID becomes
  -- a dam_project_status; template = { pattern }; split_array = { separator }.
  transform_config jsonb not null default '{}'
    constraint dam_int_field_mappings_transform_config_no_secrets_check
    check (dam_config_has_no_secrets(transform_config)),
  -- A run that cannot resolve a required mapping fails the RECORD rather than
  -- writing a partial row.
  is_required boolean not null default false,
  -- Part of the match key for upserts (employeeNumber, workEmail,
  -- ProjectNumber). At least one must remain per (integration, object_type),
  -- which the target trigger asserts.
  is_key boolean not null default false,
  -- Used when the source is absent and the mapping is required.
  default_value jsonb,
  is_active boolean not null default true,
  -- Display order in the sync UI.
  sort_order integer not null default 0,
  notes text,

  -- [D-339] Exactly one target: a real column or a custom field.
  constraint dam_integration_field_mappings_target_check
    check ((target_column is null) <> (target_field_id is null)),
  -- An inbound mapping must say what it reads.
  constraint dam_integration_field_mappings_inbound_check
    check (direction <> 'inbound' or source_field is not null)
);

comment on table dam_integration_field_mappings is
  'One mapping per (integration, object, field): source, direction, ownership and transform (SPEC 2B.43, brief §4.9). Uniqueness is over coalesce(target_column, '''') and coalesce(target_field_id, …) — an expression index in the index file.';
comment on column dam_integration_field_mappings.is_source_of_truth is
  'D-339: the remote system owns this field. The UI renders it read-only and a local edit requires an audited detach (dam_sync_field_state).';
comment on column dam_integration_field_mappings.transform is
  'A fixed, auditable vocabulary. There is no expression language in the database, deliberately.';


-- ---------------------------------------------------------------------------
-- 2B.44  dam_sync_runs — one row per execution of a connector (brief §4.9)
-- ---------------------------------------------------------------------------
-- The counts, the cursor either side of the run, and a bounded error log, so
-- the sync UI answers "what happened last night" without anyone opening the
-- worker logs.
--
-- No audit trigger (2B.0, D-345): the run IS a log, and the rows it wrote are
-- audited individually.
--
-- No deleted_by: runs are pruned with the jobs retention.
create table dam_sync_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The `sync` system principal, or the admin who pressed Run.
  created_by uuid,
  updated_by uuid,
  -- Unused; runs are pruned.
  deleted_at timestamptz,

  integration_id uuid not null
    references dam_integrations (id) on delete cascade,
  -- The sync_run job that executed it.
  job_id uuid
    references dam_jobs (id) on delete set null,
  trigger text not null default 'schedule'
    constraint dam_sync_runs_trigger_check
    check (trigger in ('schedule', 'manual', 'webhook', 'backfill', 'retry')),
  -- `partial` = some records failed but the cursor advanced.
  status dam_sync_run_status not null default 'running',
  -- Null = every enabled object; set when a run was scoped to one.
  object_type text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer,
  records_read integer not null default 0,
  records_created integer not null default 0,
  records_updated integer not null default 0,
  -- Unchanged since the last run.
  records_skipped integer not null default 0,
  records_failed integer not null default 0,
  -- Rows written to dam_sync_conflicts.
  conflicts_opened integer not null default 0,
  -- Drive and BambooHR photo runs.
  assets_ingested integer not null default 0,
  -- Against the remote quota.
  api_calls integer not null default 0,
  -- 429s absorbed by the connector's backoff.
  rate_limited_count integer not null default 0,
  cursor_before jsonb not null default '{}',
  -- Written only on succeeded/partial. A failed run leaves the integration's
  -- cursor untouched so the next run re-reads the same window.
  cursor_after jsonb not null default '{}',
  -- The fatal error for `failed`.
  error text,
  -- [{ record, field, message, at }], newest last, CAPPED AT 200 entries with
  -- a trailing {"truncated": N}. An unbounded array on a nightly job is how a
  -- 34k-record failure turns into an unreadable row.
  error_log jsonb not null default '[]'
    constraint dam_sync_runs_error_log_array_check
    check (jsonb_typeof(error_log) = 'array'),
  -- Per-object counts for the UI table.
  summary jsonb not null default '{}',

  -- A run that is not running has finished.
  constraint dam_sync_runs_finished_check
    check (status = 'running' or finished_at is not null)
);

comment on table dam_sync_runs is
  'One row per connector execution (SPEC 2B.44, DQ17). No audit trigger (D-345) — the run is itself a log. The one-running-run-per-integration rule is a partial unique index in the index file, and it is what makes the cursor safe.';
comment on column dam_sync_runs.cursor_after is
  'Written only on succeeded or partial; a failed run leaves dam_integrations.cursor alone so the same window is re-read.';
comment on column dam_sync_runs.error_log is
  'Capped at 200 entries with a trailing {"truncated": N}: an unbounded array on a nightly job makes a 34k-record failure unreadable.';


-- ---------------------------------------------------------------------------
-- 2B.45  dam_sync_conflicts — a field the connector could not decide (DQ17)
-- ---------------------------------------------------------------------------
-- The remote value and the DAM value both changed since the last run and the
-- policy is `manual`; or a lookup transform found no match; or a required key
-- resolved to two rows. One row per (run, target row, field), waiting for a
-- human.
--
-- A nightly run that re-raises the same conflict updates the open row rather
-- than adding a hundredth copy — that is the partial unique index on the open
-- rows, in the index file.
--
-- No deleted_by: a conflict is resolved, ignored or superseded, not trashed.
create table dam_sync_conflicts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The `sync` principal.
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,

  -- The run that raised it.
  sync_run_id uuid not null
    references dam_sync_runs (id) on delete cascade,
  -- Denormalised, so the open-conflicts list and its badge need no join.
  integration_id uuid not null
    references dam_integrations (id) on delete cascade,
  -- Null when the conflict is structural (an ambiguous key, an unmatched
  -- lookup) and so belongs to no single mapping.
  field_mapping_id uuid
    references dam_integration_field_mappings (id) on delete set null,
  kind text not null default 'value'
    constraint dam_sync_conflicts_kind_check
    check (kind in ('value', 'ambiguous_key', 'missing_target', 'lookup_miss', 'validation')),
  target_table text not null
    constraint dam_sync_conflicts_target_table_check
    check (target_table ~ '^dam_[a-z0-9_]+$'),
  -- Null for ambiguous_key and missing_target: there is no one row yet.
  target_row_id uuid,
  -- A column name, or field:<uuid> for a custom field.
  target_field text,
  -- The remote record's id.
  external_id text,
  -- What the DAM held, and when.
  dam_value jsonb,
  dam_updated_at timestamptz,
  -- What the connector read, and when.
  source_value jsonb,
  source_updated_at timestamptz,
  -- The policy in force when the conflict was raised — not the policy now, so
  -- the record stays readable after an admin changes the connector.
  policy_applied dam_conflict_policy not null,
  -- Candidate rows for ambiguous_key, the unmatched literal for lookup_miss,
  -- the Zod issue for validation.
  detail jsonb not null default '{}',
  -- `superseded` when a later run raised the same conflict.
  status text not null default 'open'
    constraint dam_sync_conflicts_status_check
    check (status in ('open', 'resolved', 'ignored', 'superseded')),
  -- source writes source_value to the target; dam writes nothing and records
  -- the divergence; manual writes resolved_value; detach stops the connector
  -- touching that field at all.
  resolution text
    constraint dam_sync_conflicts_resolution_check
    check (resolution is null or resolution in ('source', 'dam', 'manual', 'detach')),
  -- What was written for `manual`.
  resolved_value jsonb,
  resolved_at timestamptz,
  resolved_by uuid
    references dam_users (id) on delete set null,
  note text,

  -- Resolved and resolution are the same fact stated twice.
  constraint dam_sync_conflicts_resolved_check
    check ((status = 'resolved') = (resolution is not null)),
  -- Resolution names both who and when, or neither.
  constraint dam_sync_conflicts_resolved_pair_check
    check ((resolved_at is null) = (resolved_by is null))
);

comment on table dam_sync_conflicts is
  'Fields a connector could not decide (SPEC 2B.45, DQ17). One open row per disputed field — the re-raise-updates-the-open-row rule is a partial expression unique index in the index file.';
comment on column dam_sync_conflicts.policy_applied is
  'The policy in force when the conflict was raised, not the policy now, so the record stays readable after an admin changes the connector.';


-- ---------------------------------------------------------------------------
-- 2B.45a  dam_sync_field_state — the shadow store behind detach / re-attach
-- ---------------------------------------------------------------------------
-- NOT IN THE DECISIONS §2 INVENTORY. This is the one table this part adds, and
-- it is reported as such: "source wins, DAM keeps a shadow" cannot be
-- implemented without somewhere to keep the shadow.
--
-- [D-340] A separate table rather than three columns per synced column,
-- because the mastered set is per tenant and changes with the mapping table —
-- widening every business table is not an option, one narrow key-value row per
-- mastered field is, and it is exactly what the detach / re-attach UI reads.
--
-- target_row_id carries no FK: the table is polymorphic across every business
-- table a connector can master.
--
-- No deleted_by.
create table dam_sync_field_state (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,

  integration_id uuid not null
    references dam_integrations (id) on delete cascade,
  field_mapping_id uuid
    references dam_integration_field_mappings (id) on delete set null,
  -- Denormalised from the integration, so the form render reads one row.
  source_system dam_external_system not null,
  target_table text not null
    constraint dam_sync_field_state_target_table_check
    check (target_table ~ '^dam_[a-z0-9_]+$'),
  -- No FK: polymorphic across the business tables.
  target_row_id uuid not null,
  -- A column name, or field:<uuid> for a custom field.
  target_field text not null,
  -- The last value the source sent, BEFORE the transform.
  source_value jsonb,
  -- What was actually written, after the transform.
  applied_value jsonb,
  source_synced_at timestamptz,
  -- The remote record id.
  source_record_id text,
  -- True = the DAM owns this field now and the connector skips it.
  is_detached boolean not null default false,
  detached_at timestamptz,
  detached_by uuid
    references dam_users (id) on delete set null,
  -- Required when detaching (trigger), so the divergence always has a stated
  -- reason in the audit trail.
  detach_reason text,
  -- What the user replaced it with, so re-attach can show the diff before it
  -- restores source_value.
  dam_value_at_detach jsonb,

  -- A detach is dated and explained, or it has not happened.
  constraint dam_sync_field_state_detach_check
    check (is_detached = false
           or (detached_at is not null and detach_reason is not null))
);

comment on table dam_sync_field_state is
  'The shadow store behind source-of-truth detach and re-attach (SPEC 2B.45a, D-339/D-340). NOT in the DECISIONS §2 inventory — the one table this part adds. One live shadow per (target_table, target_row_id, target_field), which is a partial unique index in the index file.';
comment on column dam_sync_field_state.is_detached is
  'D-339: the DAM owns this field now. Setting it is audited as a permission_change-class event; re-attach restores source_value and enqueues a scoped sync_run.';
comment on column dam_sync_field_state.target_row_id is
  'No FK by design: this table is polymorphic across every business table a connector can master.';


-- ---------------------------------------------------------------------------
-- 2B.46  dam_templates — the document template library (brief §4.5)
-- ---------------------------------------------------------------------------
-- Project sheets, CVs, qualification packs, credentials decks, award
-- submissions and contact sheets. The template is the stable handle and the
-- thing an admin administers; the file, the merge-field manifest and the brand
-- lock live in 2B.47 versions — exactly as text blocks work.
create table dam_templates (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  kind dam_template_kind not null,
  -- Unique case-insensitively among live rows: partial expression index.
  name text not null
    constraint dam_templates_name_length_check
    check (length(name) between 1 and 120),
  -- Used in POST /documents { "template": "project-sheet-a4" }.
  slug text not null
    constraint dam_templates_slug_format_check
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text,
  -- What the template is generated FOR, and therefore which id the generate
  -- call takes.
  subject_type text not null
    constraint dam_templates_subject_type_check
    check (subject_type in ('project', 'employee', 'album', 'selection', 'client', 'studio')),
  output_formats dam_document_format[] not null default '{pdf}'
    constraint dam_templates_output_formats_check
    check (cardinality(output_formats) > 0),
  -- [D-287 convention] internal_pdf renders HTML+CSS server-side; docx/pptx
  -- fill an Office source file; indd produces a tagged package for InDesign;
  -- marq delegates to the Marq connector.
  engine text not null default 'internal_pdf'
    constraint dam_templates_engine_check
    check (engine in ('internal_pdf', 'docx', 'pptx', 'indd', 'marq')),
  -- (ALTER) → dam_template_versions(id) on delete set null. The latest
  -- APPROVED version, else null. Circular with 2B.47 exactly as 2B.18/2B.19
  -- (D-296), so the FK is attached in the deferred block at the end.
  current_version_id uuid,
  version_count integer not null default 0
    constraint dam_templates_version_count_check
    check (version_count >= 0),
  -- The preset images are placed at, so a deck never embeds a 60 MB TIFF.
  -- `restrict`, because a size in use must not vanish.
  default_size_id uuid
    references dam_sizes (id) on delete restrict,
  -- The crop image placeholders use.
  default_aspect_ratio_id uuid
    references dam_aspect_ratios (id) on delete set null,
  page_size text not null default 'a4'
    constraint dam_templates_page_size_check
    check (page_size in ('a4', 'a3', 'letter', 'tabloid', '16:9', '4:3', 'custom')),
  orientation text not null default 'portrait'
    constraint dam_templates_orientation_check
    check (orientation in ('portrait', 'landscape')),
  -- Which locale's text blocks and date formats it pulls.
  locale text not null default 'en-GB',
  -- A studio-specific variant of a firm template.
  studio_id uuid
    references dam_studios (id) on delete set null,
  -- [D-341] Brand lock ON by default.
  brand_locked boolean not null default true,
  -- Minimum effective role allowed to generate from it.
  min_role dam_role not null default 'contributor',
  -- The card image in the template picker.
  thumbnail_asset_id uuid
    references dam_assets (id) on delete set null,
  tags text[] not null default '{}',
  is_active boolean not null default true,
  is_system boolean not null default false,
  sort_order integer not null default 0,
  -- Trigger-maintained from dam_generated_documents; answers "which templates
  -- are actually used".
  generate_count bigint not null default 0,

  constraint dam_templates_slug_key unique (slug),
  -- The Marq connector returns a PDF, so a marq template that does not offer
  -- pdf offers nothing.
  constraint dam_templates_marq_format_check
    check (engine <> 'marq' or 'pdf' = any(output_formats))
);

comment on table dam_templates is
  'The document template library (SPEC 2B.46, brief §4.5). Five seeded is_system rows. Name uniqueness is a partial expression index in the index file; current_version_id is the circular FK attached at the end of this file.';
comment on column dam_templates.default_size_id is
  'The preset images are placed at, so a generated deck never embeds a 60 MB TIFF.';


-- ---------------------------------------------------------------------------
-- 2B.47  dam_template_versions — versioned bodies, approval and brand lock
-- ---------------------------------------------------------------------------
-- Brief §4.5, "template library with versioning and brand locking". A
-- generated document always cites a VERSION id, so a document produced last
-- quarter can be explained after the template has changed. An approved or
-- superseded version is never edited; a rollback is approving an older version
-- again.
--
-- [D-341] The brand lock is a database rule, not an application one:
-- trg_dam_template_versions_brand_lock lets only global_admin+ change
-- locked_regions or brand_tokens on a locked template, in any state. The whole
-- point of a brand lock is that the person under deadline pressure cannot
-- quietly move the logo, and an application-only rule is one bad code path
-- away from being no rule.
--
-- No deleted_by: a version goes with its template, or its author withdraws a
-- draft.
create table dam_template_versions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The author.
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,

  template_id uuid not null
    references dam_templates (id) on delete cascade,
  -- Assigned per template under an advisory lock, as 2B.19.
  version_no integer not null
    constraint dam_template_versions_version_no_check
    check (version_no >= 1),
  -- Only an `approved` version may be generated from.
  state dam_text_state not null default 'draft',
  -- HTML+CSS for engine = 'internal_pdf'.
  body text
    constraint dam_template_versions_body_length_check
    check (body is null or length(body) <= 500000),
  -- The .docx/.pptx/.indd source file in the library, for the file-based
  -- engines. `restrict`: deleting the source out from under an approved
  -- template version must be impossible.
  source_asset_id uuid
    references dam_assets (id) on delete restrict,
  -- SHA-256 of the source bytes at approval. A replaced asset whose checksum
  -- differs invalidates the version (trigger), so a silent file swap cannot
  -- change what an approved template produces.
  source_checksum text,
  -- Engine options: margins, fonts to embed, the Marq template id, the
  -- InDesign tag map.
  engine_config jsonb not null default '{}'
    constraint dam_template_versions_engine_config_no_secrets_check
    check (dam_config_has_no_secrets(engine_config)),
  -- [D-342] The merge-field manifest: an array of
  -- { token, label, source, path, type, required, … }. The shape is
  -- Zod-validated on write and every source/path pair is checked against a
  -- static registry, so an unknown token is rejected AT SAVE rather than
  -- discovered at render. Generation fails with validation_failed when a
  -- required token resolves to null, rather than emitting a document with a
  -- blank where the client's name should be.
  merge_fields jsonb not null default '[]'
    constraint dam_template_versions_merge_fields_array_check
    check (jsonb_typeof(merge_fields) = 'array'),
  -- [D-341] Region ids (docx content-control tags, pptx shape names, CSS
  -- selectors) a generator may fill but never restyle or move.
  locked_regions jsonb not null default '[]',
  -- [D-341] The locked brand surface: fonts, colours, logo_asset_id,
  -- min_logo_mm, clear_space_mm.
  brand_tokens jsonb not null default '{}',
  -- A rendered sample page.
  preview_asset_id uuid
    references dam_assets (id) on delete set null,
  change_note text,
  submitted_by uuid
    references dam_users (id) on delete set null,
  submitted_at timestamptz,
  approved_by uuid
    references dam_users (id) on delete set null,
  approved_at timestamptz,

  constraint dam_template_versions_template_version_key
    unique (template_id, version_no),
  -- A version is a body or a source file, never both and never neither.
  constraint dam_template_versions_source_check
    check ((body is null) <> (source_asset_id is null)),
  -- An approved version names its approver and the moment.
  constraint dam_template_versions_approved_check
    check (state <> 'approved' or (approved_by is not null and approved_at is not null)),
  constraint dam_template_versions_json_shape_check
    check (jsonb_typeof(locked_regions) = 'array' and jsonb_typeof(brand_tokens) = 'object')
);

comment on table dam_template_versions is
  'Versioned template bodies with approval and the brand lock (SPEC 2B.47, brief §4.5). D-341: the lock is enforced by trigger, because an application-only rule is one bad code path away from being no rule.';
comment on column dam_template_versions.merge_fields is
  'D-342: the manifest. Every source/path pair is checked against a static registry at save, so an unknown token is never discovered at render time.';
comment on column dam_template_versions.source_checksum is
  'SHA-256 of the source bytes at approval. A replaced asset with a different checksum invalidates the version, so a silent file swap cannot change what an approved template produces.';


-- ---------------------------------------------------------------------------
-- 2B.48  dam_generated_documents — every document the platform produced
-- ---------------------------------------------------------------------------
-- Brief §4.5. What template version made it, for which subject, from exactly
-- which inputs, where the output file is, and who has downloaded it.
-- Reproducibility is the point: a CV sent to a client last March must be
-- explainable today.
--
-- [D-343] Which is why `inputs` cites VERSION ids and never live bodies. Text
-- enters as a dam_text_block_versions id or an approved dam_employee_bios id,
-- images as an asset_version_id plus a size_id. A document that cited live
-- bodies would change meaning every time someone edited a text block, and
-- "which words did we send them" would become unanswerable.
--
-- A regeneration is a NEW ROW, never an overwrite.
create table dam_generated_documents (
  id uuid primary key default gen_random_uuid(),
  -- = generated at.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Who generated it.
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  -- `restrict` on both: a document must always be able to name what made it.
  template_id uuid not null
    references dam_templates (id) on delete restrict,
  -- The exact version used.
  template_version_id uuid not null
    references dam_template_versions (id) on delete restrict,
  format dam_document_format not null,
  -- The rendered filename stem.
  title text not null
    constraint dam_generated_documents_title_length_check
    check (length(title) between 1 and 200),
  -- Copied from the template.
  subject_type text not null
    constraint dam_generated_documents_subject_type_check
    check (subject_type in ('project', 'employee', 'album', 'selection', 'client', 'studio')),
  -- No FK (polymorphic); null for a `selection`.
  subject_id uuid,
  -- [D-343] The reproducibility record: asset_ids, asset_version_ids,
  -- employee_ids, project_ids, text_block_version_ids, bio_ids, size_id,
  -- aspect_ratio_id, locale, options, merge_values.
  inputs jsonb not null default '{}'
    constraint dam_generated_documents_inputs_object_check
    check (jsonb_typeof(inputs) = 'object'),
  -- Set when the document is filed in the library (category Marketing
  -- Collateral), which is the default for decks and award submissions.
  output_asset_id uuid
    references dam_assets (id) on delete set null,
  -- Used when the output is ephemeral and not an asset.
  storage_location_id uuid
    references dam_storage_locations (id) on delete restrict,
  object_key text,
  page_count integer
    constraint dam_generated_documents_page_count_check
    check (page_count is null or page_count > 0),
  size_bytes bigint,
  -- SHA-256 of the output. Identical inputs and version produce an identical
  -- file for the deterministic engines, which is how a regeneration is proved
  -- equivalent to the copy that was sent.
  checksum text,
  -- [D-287 convention]
  status text not null default 'queued'
    constraint dam_generated_documents_status_check
    check (status in ('queued', 'rendering', 'ready', 'failed', 'expired')),
  -- The generate_document job.
  job_id uuid
    references dam_jobs (id) on delete set null,
  -- Including the validation_failed list of unresolved required merge fields.
  error text,
  -- A regeneration is a new row pointing at its predecessor.
  regenerated_from_id uuid
    references dam_generated_documents (id) on delete set null,
  -- Ephemeral outputs only; null once output_asset_id is set.
  expires_at timestamptz,
  -- Keeps the row and its file past the retention policy: the copy actually
  -- sent to a client.
  is_pinned boolean not null default false,
  download_count integer not null default 0,
  last_downloaded_at timestamptz,
  -- When the document was handed over as a link.
  share_link_id uuid
    references dam_share_links (id) on delete set null,

  -- A storage pointer is a location and a key together.
  constraint dam_generated_documents_object_key_check
    check ((storage_location_id is null) = (object_key is null)),
  -- A ready document has bytes somewhere.
  constraint dam_generated_documents_ready_check
    check (status <> 'ready' or output_asset_id is not null or object_key is not null),
  -- Pinning is the opposite of expiring.
  constraint dam_generated_documents_pinned_check
    check (not is_pinned or expires_at is null)
);

comment on table dam_generated_documents is
  'Every document the platform produced (SPEC 2B.48, brief §4.5). D-343: inputs cite version ids, never live bodies, so "which words did we send them" stays answerable. A regeneration is a new row.';
comment on column dam_generated_documents.inputs is
  'D-343: text enters as a text_block_version_id or an approved bio id, images as an asset_version_id plus a size_id. The GIN index on it answers "which documents used this text block version".';
comment on column dam_generated_documents.checksum is
  'SHA-256 of the output. For the deterministic engines, identical inputs and version reproduce the file byte for byte.';


-- ---------------------------------------------------------------------------
-- 2B.50  dam_ai_runs — one row per provider call
-- ---------------------------------------------------------------------------
-- Every AI result carries { provider, model, inputTokens, outputTokens,
-- thoughtTokens?, cachedInputTokens?, latencyMs, costEstimateUsd? }, and today
-- none of it is recorded. The analytics dashboard needs per-task spend, and a
-- bad prompt revision needs to be findable.
--
-- Written before dam_ai_suggestions, which points at it.
--
-- No audit trigger (2B.0, D-345): the suggestions this produced are audited,
-- and the run itself is a log.
--
-- No deleted_by: runs are pruned, not trashed.
create table dam_ai_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The `ai` system principal, or the user who triggered it.
  created_by uuid,
  updated_by uuid,
  -- Unused; runs are pruned.
  deleted_at timestamptz,

  -- [D-287 convention] The adapter method that ran.
  task text not null
    constraint dam_ai_runs_task_check
    check (task in ('autotag', 'caption', 'alt_text', 'describe', 'ocr', 'embed',
                    'headshot_match', 'crop', 'converse', 'rerank', 'rfp_parse')),
  provider dam_ai_provider not null,
  -- The exact model id (gemini-3.7-flash), never a date-suffixed alias: an
  -- alias makes a historical row un-diagnosable.
  model text not null,
  -- Revision tag of the prompt template, so a bad batch can be found and
  -- expired.
  prompt_version text,
  -- The knobs that were actually sent, the thinking ladder's rung included —
  -- which is how a dialect failure is diagnosed after the fact.
  config jsonb not null default '{}',
  target_type dam_target_type,
  -- No FK on any of these five: this is a log.
  target_id uuid,
  -- The image or document that was sent.
  asset_id uuid,
  version_id uuid,
  -- The job that made the call.
  job_id uuid,
  -- Groups the calls of one batch run, such as a 500k-asset backfill.
  batch_id uuid,
  -- SHA-256 of (model, prompt_version, config, input digest). Lets a repeated
  -- identical call be served from `result` instead of the provider. NOT
  -- unique: an identical request may legitimately run again after a model
  -- change.
  request_hash text,
  status text not null default 'succeeded'
    constraint dam_ai_runs_status_check
    check (status in ('succeeded', 'failed', 'refused', 'truncated', 'rate_limited', 'cached')),
  -- The bare 400s the Gemini dialect and enum-size rules produce are exactly
  -- what this column is for.
  http_status integer,
  error text
    constraint dam_ai_runs_error_length_check
    check (error is null or length(error) <= 4000),
  attempt smallint not null default 1,
  input_tokens integer
    constraint dam_ai_runs_input_tokens_check
    check (input_tokens is null or input_tokens >= 0),
  output_tokens integer
    constraint dam_ai_runs_output_tokens_check
    check (output_tokens is null or output_tokens >= 0),
  -- Charged against the output budget; separated because it is the reason a
  -- thinking rung truncates JSON.
  thought_tokens integer
    constraint dam_ai_runs_thought_tokens_check
    check (thought_tokens is null or thought_tokens >= 0),
  cached_input_tokens integer
    constraint dam_ai_runs_cached_input_tokens_check
    check (cached_input_tokens is null or cached_input_tokens >= 0),
  total_tokens integer
    generated always as (coalesce(input_tokens, 0)
                         + coalesce(output_tokens, 0)
                         + coalesce(thought_tokens, 0)) stored,
  -- Computed by the adapter from its own price table AT CALL TIME, because
  -- list prices change and a historical row must keep what it cost then. USD
  -- always: one currency keeps the dashboards addable, and conversion is a
  -- reporting concern.
  cost_estimate_usd numeric(12,6)
    constraint dam_ai_runs_cost_estimate_check
    check (cost_estimate_usd is null or cost_estimate_usd >= 0),
  latency_ms integer
    constraint dam_ai_runs_latency_ms_check
    check (latency_ms is null or latency_ms >= 0),
  -- Time spent waiting on the client-side concurrency limiter.
  queued_ms integer
    constraint dam_ai_runs_queued_ms_check
    check (queued_ms is null or queued_ms >= 0),
  -- Image or document bytes sent AFTER the sharp re-encode.
  input_bytes bigint,
  suggestion_count integer not null default 0,
  -- Trigger-maintained as those suggestions are accepted. The acceptance rate
  -- per model and prompt version is the only honest quality metric available.
  accepted_count integer not null default 0,
  -- finish_reason, safety verdicts, the schema-repair flag, the provider's
  -- request id.
  response_meta jsonb not null default '{}',
  -- The parsed result for small payloads (tags, caption). Large text (OCR)
  -- goes to dam_asset_ocr_text and is not duplicated here.
  result jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,

  -- A succeeded run finished.
  constraint dam_ai_runs_finished_check
    check (status <> 'succeeded' or finished_at is not null)
);

comment on table dam_ai_runs is
  'One row per provider call (SPEC 2B.50). No audit trigger (D-345) — the suggestions it produced are audited and the run is itself a log. Pruned against dam_setting(''ai.runs_retention_months'').';
comment on column dam_ai_runs.model is
  'The exact model id, never a date-suffixed alias: an alias makes a historical row un-diagnosable.';
comment on column dam_ai_runs.request_hash is
  'Deliberately NOT unique: an identical request may legitimately run again after a model change. It is an index, not a constraint.';
comment on column dam_ai_runs.cost_estimate_usd is
  'Computed by the adapter at call time from its own price table, because list prices change and a historical row must keep what it cost then.';


-- ---------------------------------------------------------------------------
-- 2B.49  dam_ai_suggestions — everything a model proposes, held for review
-- ---------------------------------------------------------------------------
-- Brief §4.10 is explicit that auto-tagging writes into a SUGGESTED state that
-- a human confirms, never silently into the live taxonomy. Keywords, captions,
-- alt text, descriptions, headshot matches, crops, project and employee
-- matches all land here, and dam_accept_suggestion() is the ONLY route from a
-- model's output to live data.
--
-- [D-344] The only state edges are suggested → accepted | rejected | expired,
-- all through the three RPCs; trg_dam_ai_suggestions_state raises when
-- anything else touches the column. Auto-accept is off by default, and when an
-- admin turns it on it is bounded to `keyword` suggestions whose keyword_id is
-- already in the live tree, each still writing a normal accepted row with
-- decided_by = the `ai` principal, so the audit trail shows a machine decision.
--
-- This table IS audited: accept and reject are the events a reviewer is
-- answerable for.
--
-- No deleted_by.
create table dam_ai_suggestions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The `ai` system principal, or the user who pressed "Suggest tags".
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,

  kind dam_ai_suggestion_kind not null,
  target_type dam_target_type not null
    constraint dam_ai_suggestions_target_type_check
    check (target_type in ('asset', 'project', 'employee', 'album')),
  -- Polymorphic, so no FK (D-349).
  target_id uuid not null,
  state dam_suggestion_state not null default 'suggested',
  -- The provider's own 0–1 score, surfaced in the UI and used for the
  -- auto-accept threshold.
  confidence numeric(4,3)
    constraint dam_ai_suggestions_confidence_check
    check (confidence is null or confidence between 0 and 1),
  -- Order within one run's suggestions for the same target and kind.
  rank smallint,
  -- Set when the proposed label matched the live tree.
  keyword_id uuid
    references dam_keywords (id) on delete cascade,
  -- The model's literal text when it did not match, so the UI can offer
  -- "create keyword".
  raw_label text
    constraint dam_ai_suggestions_raw_label_length_check
    check (raw_label is null or length(raw_label) <= 200),
  -- The proposal proper, shaped per kind and Zod-validated there.
  value jsonb not null default '{}',
  -- Why the model says so; shown in the review UI.
  evidence text
    constraint dam_ai_suggestions_evidence_length_check
    check (evidence is null or length(evidence) <= 1000),
  provider dam_ai_provider not null,
  -- The exact model id, never a date-suffixed alias.
  model text not null,
  -- The call that produced it.
  ai_run_id uuid
    references dam_ai_runs (id) on delete set null,
  -- Which prompt revision, so a bad batch can be found and expired.
  prompt_version text,
  decided_by uuid
    references dam_users (id) on delete set null,
  decided_at timestamptz,
  -- Why it was rejected; feeds prompt tuning.
  decision_note text,
  -- What acceptance created: dam_keyword_links, dam_employee_headshots,
  -- dam_text_block_versions, dam_project_assets, dam_project_employees,
  -- dam_assets.
  applied_table text,
  applied_row_id uuid,
  -- Unreviewed suggestions expire rather than accumulating.
  expires_at timestamptz not null default (now() + interval '90 days'),

  -- A keyword suggestion names a keyword or the raw text it could not match.
  constraint dam_ai_suggestions_keyword_check
    check (kind <> 'keyword' or keyword_id is not null or raw_label is not null),
  -- The applied pointer is a table and a row together.
  constraint dam_ai_suggestions_applied_pair_check
    check ((applied_table is null) = (applied_row_id is null)),
  -- An accepted suggestion says what it created; otherwise "accepted" is
  -- unverifiable.
  constraint dam_ai_suggestions_accepted_check
    check (state <> 'accepted' or applied_table is not null),
  -- A decision names both who and when, or neither.
  constraint dam_ai_suggestions_decided_pair_check
    check ((decided_at is null) = (decided_by is null)),
  -- Only the two terminal states a human reaches require a decider; `expired`
  -- is the sweep's doing and has none.
  constraint dam_ai_suggestions_decider_check
    check (state = 'suggested' or state = 'expired' or decided_by is not null)
);

comment on table dam_ai_suggestions is
  'Everything a model proposes, held in a reviewable state (SPEC 2B.49, brief §4.10). dam_accept_suggestion() is the only route from model output to live data (D-344). Audited, because accept and reject are what a reviewer is answerable for.';
comment on column dam_ai_suggestions.state is
  'D-344: suggested → accepted | rejected | expired, only through the three RPCs. Auto-accept is off by default and bounded to keywords already in the live tree.';
comment on column dam_ai_suggestions.value is
  'The proposal, shaped per kind. A reviewer''s edit is stored as value.accepted_value so the model''s original proposal survives.';
comment on column dam_ai_suggestions.applied_table is
  'What acceptance created. The open-suggestion uniqueness rule is an expression index over coalesce(keyword_id, …) and coalesce(lower(raw_label), ''''), so it lives in the index file.';


-- ---------------------------------------------------------------------------
-- 2B.51  dam_retention_policies — how long anything is kept (brief §4.8, DQ12)
-- ---------------------------------------------------------------------------
-- Trash before purge, the three log tables, generated documents, the render
-- cache. One row per (target, optional category, optional studio); the purge
-- job reads nothing else.
--
-- [D-346] MOST SPECIFIC WINS, AND PURGE IS THE ONLY DELETER. Resolution for a
-- candidate row: the live active policy matching both category_id and
-- studio_id, else category_id, else studio_id, else the firm-wide row for that
-- target — and if none matches, nothing is deleted. The absence of a policy
-- never means "delete".
create table dam_retention_policies (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  target dam_retention_target not null,
  -- Narrows a `trash` policy to one category: Staff photography may need a
  -- longer or shorter tail than Renderings. Null = every category.
  category_id uuid
    references dam_categories (id) on delete cascade,
  -- Null = firm-wide.
  studio_id uuid
    references dam_studios (id) on delete cascade,
  -- 0 = purge on the next run.
  days integer not null
    constraint dam_retention_policies_days_check
    check (days between 0 and 36500),
  -- `purge` deletes the rows AND their storage objects; `archive` copies to
  -- archive_storage_location_id first, then deletes.
  action dam_retention_action not null default 'purge',
  archive_storage_location_id uuid
    references dam_storage_locations (id) on delete restrict,
  is_active boolean not null default true,
  -- The six seeded rows may be edited but never deleted.
  is_system boolean not null default false,
  last_run_at timestamptz,
  -- Rows or partitions removed on the last run.
  last_run_count integer,
  notes text,

  -- An archive policy names its destination and a purge policy has none.
  constraint dam_retention_policies_archive_check
    check ((action = 'archive') = (archive_storage_location_id is not null))
);

comment on table dam_retention_policies is
  'Retention windows and their end action (SPEC 2B.51, DQ12). D-346: most specific wins, and the absence of a policy never means "delete". Scope uniqueness is (target, category_id, studio_id) NULLS NOT DISTINCT among live rows — partial, so it lives in the index file.';
comment on column dam_retention_policies.action is
  'purge deletes the rows and their storage objects; archive copies to archive_storage_location_id first. The purge_trash job skips any asset on legal_hold.';


-- ---------------------------------------------------------------------------
-- 2B.52  dam_tiering_rules — move cold originals down, bring them back
-- ---------------------------------------------------------------------------
-- Brief §4.8, DQ12: "no usage in N days, bigger than M, not a hero, not on a
-- live bid" → archive. Rules are DATA so the policy can change without a
-- deploy, and they are evaluated by the tiering job, never by the database.
--
-- [D-347] `condition` is a CLOSED, VALIDATED KEY SET — never SQL. A SQL
-- fragment in a config row executed by a service_role worker is a privilege
-- escalation with extra steps; a fixed vocabulary is auditable and still
-- covers every rule the brief asks for. The job compiles the keys into one
-- parameterised query.
--
-- Nothing is ever deleted by tiering: a move that fails leaves the original
-- where it was.
create table dam_tiering_rules (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,

  -- Unique case-insensitively among live rows: partial expression index.
  name text not null
    constraint dam_tiering_rules_name_length_check
    check (length(name) between 1 and 80),
  description text,
  -- `restrict` on both: a location a rule names must not vanish.
  storage_location_from uuid not null
    references dam_storage_locations (id) on delete restrict,
  storage_location_to uuid not null
    references dam_storage_locations (id) on delete restrict,
  -- [D-347] Recognised keys only: no_usage_days, older_than_days,
  -- min_size_bytes, file_kinds, category_ids, studio_ids, project_status,
  -- exclude_hero, exclude_published, exclude_rights_status,
  -- exclude_legal_hold. Unknown keys are rejected on write by the Zod schema
  -- and by trg_dam_tiering_rules_condition.
  condition jsonb not null default '{}',
  -- Lower is evaluated first; the first matching rule claims a version.
  priority smallint not null default 100,
  -- `promote` rules bring frequently-restored material back to hot.
  direction text not null default 'demote'
    constraint dam_tiering_rules_direction_check
    check (direction in ('demote', 'promote')),
  -- A request for an archived original enqueues restore_from_archive and
  -- returns 202 with a poll handle, instead of failing.
  restore_on_access boolean not null default true,
  -- Bounds the nightly egress bill.
  max_moves_per_run integer not null default 5000
    constraint dam_tiering_rules_max_moves_check
    check (max_moves_per_run between 1 and 1000000),
  -- New rules start in dry run: the job logs what it WOULD move into its job
  -- result and moves nothing. Leaving dry run needs global_admin+ and writes
  -- a permission_change audit event.
  dry_run boolean not null default true,
  is_active boolean not null default false,
  last_run_at timestamptz,
  last_moved_count integer,
  total_moved_count bigint not null default 0,
  total_bytes_moved bigint not null default 0,

  constraint dam_tiering_rules_locations_differ_check
    check (storage_location_from <> storage_location_to),
  -- A rule with no condition would move everything, which is the one outcome
  -- nobody wants from a tiering sweep.
  constraint dam_tiering_rules_condition_check
    check (jsonb_typeof(condition) = 'object' and condition <> '{}')
);

comment on table dam_tiering_rules is
  'Storage tiering rules as data (SPEC 2B.52, DQ12). D-347: condition is a closed validated key set, never SQL — a SQL fragment executed by a service_role worker is a privilege escalation with extra steps.';
comment on column dam_tiering_rules.dry_run is
  'New rules start here. Leaving dry run requires global_admin+ and writes a permission_change audit event.';


-- ---------------------------------------------------------------------------
-- 2B.53  dam_settings — firm-wide configuration as data (DQ12)
-- ---------------------------------------------------------------------------
-- One row per key, a typed JSON value, a default, and who may change it.
-- RUNTIME configuration only: never a secret, never a NEXT_PUBLIC_* value,
-- never anything the Docker builder would have to know.
--
-- [D-348] dam_setting(key) returns value, falling back to default_value, and
-- RAISES dam_unknown_setting when the key does not exist — a typo in a trigger
-- must fail loudly rather than silently behave as null.
--
-- One row per key rather than one JSON blob, because that is what buys per-key
-- permissions, per-key validation, per-key audit rows, and a settings page
-- that writes one field at a time.
--
-- No deleted_by: only a tenant-added key can be deleted at all.
create table dam_settings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  -- Only for a tenant-added key; trg_dam_settings_protect_system stops the
  -- rest.
  deleted_at timestamptz,

  -- Dotted, lower snake, at least one dot: rights.expiring_days. Unique over
  -- ALL rows, so a plain table constraint.
  key text not null
    constraint dam_settings_key_format_check
    check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  value jsonb not null,
  value_type text not null
    constraint dam_settings_value_type_check
    check (value_type in ('string', 'integer', 'number', 'boolean', 'array', 'object', 'null')),
  -- What a reset restores, and what dam_setting() falls back to when the row
  -- is missing entirely.
  default_value jsonb not null,
  -- One line, shown in the admin UI.
  description text not null
    constraint dam_settings_description_length_check
    check (length(description) between 1 and 300),
  -- The settings page's sections.
  group_name text not null default 'general'
    constraint dam_settings_group_name_check
    check (group_name in ('general', 'uploads', 'search', 'rights', 'sharing',
                          'notifications', 'jobs', 'ai', 'integrations',
                          'privacy', 'appearance', 'retention')),
  -- Bounds the UI and the API enforce: { min, max, enum, pattern }.
  validation jsonb not null default '{}',
  -- A few operational keys are studio_admin-editable; nothing is editable
  -- below that.
  min_role_to_edit dam_role not null default 'global_admin',
  -- System keys can be re-valued or reset, never deleted, and their key and
  -- type may not change.
  is_system boolean not null default true,
  -- True when a change takes effect at the next worker start rather than
  -- immediately.
  requires_restart boolean not null default false,

  constraint dam_settings_key_key unique (key),
  -- jsonb has no `integer` type of its own, so an integer setting is checked
  -- against jsonb's `number`.
  constraint dam_settings_value_type_match_check
    check (jsonb_typeof(value) = value_type
           or (value_type = 'integer' and jsonb_typeof(value) = 'number'))
);

comment on table dam_settings is
  'Firm-wide configuration as data (SPEC 2B.53, DQ12). Runtime configuration only — never a secret, never a NEXT_PUBLIC_* value. One row per key buys per-key permissions, validation and audit rows (D-348).';
comment on column dam_settings.value is
  'Type-checked against value_type. jsonb has no integer type, so an integer setting is matched against jsonb''s number.';
comment on column dam_settings.is_system is
  'Defaults TRUE: the seeded keys are the normal case, and a tenant-added key is the exception.';


-- ===========================================================================
-- DEFERRED CONSTRAINTS
-- ===========================================================================
-- Everything below is a foreign key that could not be declared inline, for one
-- of two reasons:
--
--   (1) CYCLE BREAKERS named in SPEC 2.0 — the referencing table is created
--       before the referenced one, and no ordering fixes that because the
--       reference runs both ways.
--   (2) CROSS-PART targets owned by part 02b (dam_users, dam_access_levels,
--       dam_photographers, dam_upload_requests, dam_ai_suggestions,
--       dam_api_keys, dam_jobs, dam_sync_runs, dam_employees,
--       dam_aspect_ratios), created by the next file.
--
-- So this block runs AFTER 20-supporting-tables.sql, not at the end of this
-- file's own execution. The on-delete actions follow SPEC 2.0: `restrict` for
-- reference data, `set null` for optional pointers.
-- ===========================================================================

-- --- (1) cycle breakers within this part ------------------------------------

-- The hero pointer, denormalised from dam_project_assets.is_hero (D-214).
alter table dam_projects
  add constraint dam_projects_hero_asset_id_fkey
  foreign key (hero_asset_id) references dam_assets (id) on delete set null;

-- A Logos & Brand asset standing in for the client.
alter table dam_clients
  add constraint dam_clients_logo_asset_id_fkey
  foreign key (logo_asset_id) references dam_assets (id) on delete set null;

-- The asset points at its current version and the version points back at its
-- asset: the textbook cycle.
alter table dam_assets
  add constraint dam_assets_current_version_id_fkey
  foreign key (current_version_id) references dam_asset_versions (id) on delete set null;

-- The batch whose frozen metadata was applied. dam_ingest_batches is created
-- after dam_assets because it depends on dam_ingest_sources.
alter table dam_assets
  add constraint dam_assets_ingest_batch_id_fkey
  foreign key (ingest_batch_id) references dam_ingest_batches (id) on delete set null;

-- --- (2) cross-part targets owned by part 02b --------------------------------

-- Provenance of an accepted AI proposal.
alter table dam_keyword_links
  add constraint dam_keyword_links_suggestion_id_fkey
  foreign key (suggestion_id) references dam_ai_suggestions (id) on delete set null;

alter table dam_asset_crops
  add constraint dam_asset_crops_suggestion_id_fkey
  foreign key (suggestion_id) references dam_ai_suggestions (id) on delete set null;

-- The ratio a saved crop box belongs to. `cascade`: a box for a retired ratio
-- has no meaning of its own.
alter table dam_asset_crops
  add constraint dam_asset_crops_aspect_ratio_id_fkey
  foreign key (aspect_ratio_id) references dam_aspect_ratios (id) on delete cascade;

-- Mirror of dam_asset_rights.photographer_id (D-235).
alter table dam_assets
  add constraint dam_assets_photographer_id_fkey
  foreign key (photographer_id) references dam_photographers (id) on delete set null;

-- The single accountable project manager; distinct from dam_project_employees.
alter table dam_projects
  add constraint dam_projects_project_manager_employee_id_fkey
  foreign key (project_manager_employee_id) references dam_employees (id) on delete set null;

-- A watched folder usually belongs to one photographer's deliveries.
alter table dam_ingest_sources
  add constraint dam_ingest_sources_default_photographer_id_fkey
  foreign key (default_photographer_id) references dam_photographers (id) on delete set null;

-- Set when an external photographer deposited the file.
alter table dam_assets
  add constraint dam_assets_upload_request_id_fkey
  foreign key (upload_request_id) references dam_upload_requests (id) on delete set null;

alter table dam_ingest_batches
  add constraint dam_ingest_batches_upload_request_id_fkey
  foreign key (upload_request_id) references dam_upload_requests (id) on delete set null;

-- Per-key attribution of API-created assets.
alter table dam_assets
  add constraint dam_assets_api_key_id_fkey
  foreign key (api_key_id) references dam_api_keys (id) on delete set null;

-- Access levels are reference data, so `restrict`: a hard delete must never
-- orphan a business row.
alter table dam_projects
  add constraint dam_projects_access_level_id_fkey
  foreign key (access_level_id) references dam_access_levels (id) on delete restrict;

alter table dam_categories
  add constraint dam_categories_access_level_id_fkey
  foreign key (access_level_id) references dam_access_levels (id) on delete restrict;

alter table dam_assets
  add constraint dam_assets_access_level_id_fkey
  foreign key (access_level_id) references dam_access_levels (id) on delete restrict;

alter table dam_ingest_sources
  add constraint dam_ingest_sources_default_access_level_id_fkey
  foreign key (default_access_level_id) references dam_access_levels (id) on delete restrict;

alter table dam_ingest_batches
  add constraint dam_ingest_batches_access_level_id_fkey
  foreign key (access_level_id) references dam_access_levels (id) on delete restrict;

-- Which dedupe run found the pair.
alter table dam_asset_duplicates
  add constraint dam_asset_duplicates_job_id_fkey
  foreign key (job_id) references dam_jobs (id) on delete set null;

-- Which sync run last wrote the external id row.
alter table dam_external_ids
  add constraint dam_external_ids_sync_run_id_fkey
  foreign key (sync_run_id) references dam_sync_runs (id) on delete set null;

-- Two user pointers that are not part of the standard S4/S5/S7 set.
alter table dam_asset_versions
  add constraint dam_asset_versions_uploaded_by_fkey
  foreign key (uploaded_by) references dam_users (id) on delete set null;

alter table dam_asset_duplicates
  add constraint dam_asset_duplicates_resolved_by_fkey
  foreign key (resolved_by) references dam_users (id) on delete set null;

-- --- (3) the standard audit columns -----------------------------------------
-- SPEC 2.0 rows S4, S5 and S7 are `references dam_users(id) on delete set
-- null` on EVERY table in this part. dam_users belongs to part 02b, so all 92
-- of those constraints are attached here. The table list is written out rather
-- than discovered from the catalogue, so this block can never silently pick up
-- a table it was not meant to touch; the column guard exists because
-- dam_asset_search deliberately omits updated_by and deleted_by (D-242).
do $$
declare
  v_table text;
  v_column text;
begin
  foreach v_table in array array[
    'dam_studios', 'dam_clients', 'dam_projects', 'dam_project_aliases',
    'dam_project_studios', 'dam_categories', 'dam_keyword_categories',
    'dam_keywords', 'dam_keyword_aliases', 'dam_keyword_links',
    'dam_category_keyword_categories', 'dam_field_categories', 'dam_fields',
    'dam_field_options', 'dam_category_fields', 'dam_field_values',
    'dam_storage_locations', 'dam_assets', 'dam_project_assets',
    'dam_asset_versions', 'dam_derivatives', 'dam_render_cache',
    'dam_asset_crops',
    'dam_asset_search', 'dam_asset_embeddings', 'dam_asset_ocr_text',
    'dam_asset_duplicates', 'dam_ingest_sources', 'dam_ingest_batches',
    'dam_ingest_batch_files', 'dam_external_ids'
  ]
  loop
    foreach v_column in array array['created_by', 'updated_by', 'deleted_by']
    loop
      if exists (
        select 1
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = v_table
          and column_name = v_column
      ) then
        execute format(
          'alter table %I add constraint %I foreign key (%I) references dam_users (id) on delete set null',
          v_table, v_table || '_' || v_column || '_fkey', v_column
        );
      end if;
    end loop;
  end loop;
end
$$;


-- ===========================================================================
-- DEFERRED CONSTRAINTS
-- ===========================================================================
-- Everything below is a foreign key that could not be declared inline, for one
-- of two reasons:
--
--   (1) CYCLE BREAKERS — the referencing table is created before the
--       referenced one and no ordering fixes that, because the reference runs
--       both ways (a credit points at its default holder and a holder points
--       at its photographer; a block points at its current version and a
--       version points back at its block).
--   (2) FORWARD REFERENCES WITHIN THIS FILE — the target is created further
--       down for a dependency reason of its own (dam_ai_runs and
--       dam_ai_suggestions come last because they point at keywords and users;
--       dam_integrations and dam_webhook_deliveries come after dam_jobs
--       because dam_sync_runs points at dam_jobs).
--
-- 10-core-tables.sql ends with a block of the same shape, holding its own
-- cycle breakers plus every FK that points AT a table in this file. NEITHER
-- block belongs to its own file's execution: run both `create table` bodies
-- first, then both deferred blocks. The on-delete actions follow SPEC 2B.0 —
-- `restrict` for reference data, `set null` for optional pointers, `cascade`
-- for a child whose life has no meaning without its parent.
-- ===========================================================================

-- --- (1) cycle breakers ------------------------------------------------------

-- A holder of type `photographer` names the credit it stands for, while
-- dam_photographers.default_copyright_holder_id points the other way.
alter table dam_copyright_holders
  add constraint dam_copyright_holders_photographer_id_fkey
  foreign key (photographer_id) references dam_photographers (id) on delete set null;

-- [D-296] The block points at its latest approved version and the version
-- points back at its block. Insert order is block → version → pointer.
alter table dam_text_blocks
  add constraint dam_text_blocks_current_version_id_fkey
  foreign key (current_version_id) references dam_text_block_versions (id) on delete set null;

-- The same shape for templates, deliberately: 2B.46/2B.47 are 2B.18/2B.19 with
-- a different payload, and the two pairs are meant to read alike.
alter table dam_templates
  add constraint dam_templates_current_version_id_fkey
  foreign key (current_version_id) references dam_template_versions (id) on delete set null;

-- --- (2) forward references within this file ---------------------------------

-- Which provider call drafted the bio or the copy. `set null`: pruning a run
-- must never take the words with it.
alter table dam_employee_bios
  add constraint dam_employee_bios_ai_run_id_fkey
  foreign key (ai_run_id) references dam_ai_runs (id) on delete set null;

alter table dam_text_block_versions
  add constraint dam_text_block_versions_ai_run_id_fkey
  foreign key (ai_run_id) references dam_ai_runs (id) on delete set null;

-- Provenance of an accepted AI proposal, matching the two equivalent
-- constraints that 10-core-tables.sql attaches to dam_keyword_links and
-- dam_asset_crops.
alter table dam_employee_headshots
  add constraint dam_employee_headshots_suggestion_id_fkey
  foreign key (suggestion_id) references dam_ai_suggestions (id) on delete set null;

alter table dam_project_employees
  add constraint dam_project_employees_suggestion_id_fkey
  foreign key (suggestion_id) references dam_ai_suggestions (id) on delete set null;

alter table dam_text_block_versions
  add constraint dam_text_block_versions_suggestion_id_fkey
  foreign key (suggestion_id) references dam_ai_suggestions (id) on delete set null;

-- The two job pointers whose targets are created after dam_jobs. `cascade` on
-- both: a sync_run job for a deleted connector, or a webhook_deliver job for a
-- deleted delivery, has nothing left to do.
alter table dam_jobs
  add constraint dam_jobs_integration_id_fkey
  foreign key (integration_id) references dam_integrations (id) on delete cascade;

alter table dam_jobs
  add constraint dam_jobs_webhook_delivery_id_fkey
  foreign key (webhook_delivery_id) references dam_webhook_deliveries (id) on delete cascade;

-- --- (3) the standard audit columns -----------------------------------------
-- SPEC 2B.0 makes created_by / updated_by / deleted_by
-- `references dam_users(id) on delete set null` on every table in this part,
-- dam_users included (it self-references). They are attached here rather than
-- inline for the same reason as in 10-core-tables.sql: dam_users is one table
-- among many and the declaration order would otherwise dictate the file order.
--
-- The table list is written out rather than discovered from the catalogue, so
-- this block can never silently pick up a table it was not meant to touch. The
-- column guard exists because many tables below deliberately omit deleted_by
-- (SPEC 2B.0: only rows that appear in a trash UI carry it).
--
-- THE THREE PARTITIONED LOG PARENTS ARE ABSENT ON PURPOSE. dam_audit_log,
-- dam_usage_events and dam_search_log carry created_by and updated_by but take
-- NO foreign keys at all (2B.36): a log row that a user purge could null out
-- is not evidence. Their partition children are absent for the same reason and
-- because a child inherits the parent's constraints anyway.
do $$
declare
  v_table text;
  v_column text;
begin
  foreach v_table in array array[
    'dam_users', 'dam_groups', 'dam_group_members', 'dam_user_studios',
    'dam_access_levels', 'dam_access_grants', 'dam_api_keys',
    'dam_employees', 'dam_employee_bios', 'dam_employee_headshots',
    'dam_employee_education', 'dam_employee_registrations',
    'dam_employee_languages', 'dam_project_employees',
    'dam_albums', 'dam_album_items', 'dam_album_collaborators',
    'dam_text_blocks', 'dam_text_block_versions',
    'dam_copyright_policies', 'dam_copyright_holders', 'dam_photographers',
    'dam_asset_rights', 'dam_aspect_ratios', 'dam_sizes',
    'dam_saved_searches', 'dam_share_links', 'dam_share_link_items',
    'dam_upload_requests', 'dam_upload_request_files',
    'dam_comments', 'dam_review_decisions', 'dam_notifications',
    'dam_ratings', 'dam_favourites',
    'dam_jobs', 'dam_webhooks', 'dam_webhook_deliveries',
    'dam_integrations', 'dam_integration_field_mappings',
    'dam_sync_runs', 'dam_sync_conflicts', 'dam_sync_field_state',
    'dam_templates', 'dam_template_versions', 'dam_generated_documents',
    'dam_ai_runs', 'dam_ai_suggestions',
    'dam_retention_policies', 'dam_tiering_rules', 'dam_settings'
  ]
  loop
    foreach v_column in array array['created_by', 'updated_by', 'deleted_by']
    loop
      if exists (
        select 1
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = v_table
          and column_name = v_column
      ) then
        execute format(
          'alter table %I add constraint %I foreign key (%I) references dam_users (id) on delete set null',
          v_table, v_table || '_' || v_column || '_fkey', v_column
        );
      end if;
    end loop;
  end loop;
end
$$;


-- ===========================================================================
-- SECTION 3 — Indexes (SPEC part 02a §2.1–2.29, part 02b §2.31–2.84)
-- ===========================================================================
-- Target: PostgreSQL 15+ on Supabase. Runs after 10-core-tables.sql and
-- 20-supporting-tables.sql, which own every table this file indexes, and after
-- 00-preamble.sql, which owns `dam_unaccent()` and the extensions
-- (`pg_trgm`, `vector`) that the operator classes below come from.
--
-- WHAT IS IN THIS FILE
--   `create index` and `create unique index` only. Nothing else.
--
--   In particular every UNIQUE the spec expresses as a *partial* index
--   (`… where deleted_at is null`) or over an *expression* (`lower(code)`,
--   `coalesce(parent_id, …)`, `(true)`) lives here, because PostgreSQL cannot
--   express either as a table constraint. These are not performance objects:
--   `dam_project_assets_hero_key` is what makes "one hero per project" true,
--   `dam_project_aliases_alias_key` is what makes an alias resolve to exactly
--   one project, and `dam_storage_locations_default_originals_key` is what
--   makes "the default originals location" a singular noun. A missing one is a
--   correctness bug.
--
--   The sixteen uniques the spec states WITHOUT a predicate or expression are
--   ordinary table constraints and are declared in 10-core-tables.sql and
--   20-supporting-tables.sql, not repeated here — the two on
--   `dam_asset_versions` and `dam_asset_embeddings`, the slug keys on
--   `dam_groups`, `dam_access_levels`, `dam_copyright_policies`,
--   `dam_aspect_ratios`, `dam_sizes` and `dam_templates`, and the
--   over-all-rows keys on `dam_users(email)`, `dam_api_keys(key_hash)`,
--   `dam_share_links(token_hash)`, `dam_upload_requests(token_hash)`,
--   `dam_settings(key)`, `dam_group_members`, `dam_user_studios`,
--   `dam_text_block_versions`, `dam_template_versions`, `dam_ratings` and
--   `dam_favourites`. Each one is noted in place below, under its table.
--
-- NO `CONCURRENTLY`
--   This file is applied as one migration, inside a transaction, and
--   `create index concurrently` cannot run in one. The spec flags no index for
--   a concurrent build. On an already-populated production database the large
--   ones — the `dam_asset_search` GIN indexes and the two HNSW indexes on
--   `dam_asset_embeddings` — should be added by hand with `concurrently`,
--   outside a transaction, and this file's copy dropped first; at install time
--   the tables are empty and the ordinary form is correct.
--
-- FOREIGN-KEY INDEXES
--   PostgreSQL indexes the parent side of a foreign key, never the child side.
--   Every index below marked `-- FK index (added, not in the spec list)`
--   exists so that a delete of the parent row, or a join from the parent, does
--   not degrade into a sequential scan of the child. They are additions to the
--   spec's `Indexes:` lines, not transcriptions of them.
--
--   Two classes of foreign key are deliberately left unindexed.
--
--   1. USER POINTERS. The standard S4/S5/S7 audit columns (`created_by`,
--      `updated_by`, `deleted_by` → `dam_users`) on all 85 tables, and the
--      named ones beside them: `uploaded_by`, `resolved_by`, `revoked_by`,
--      `submitted_by`, `approved_by`, `reviewed_by`, `detached_by`,
--      `decided_by`. That would be roughly 260 indexes carried on every write
--      to buy a faster hard delete of a user row — and a user row is
--      deactivated (`is_active = false`) or soft-deleted, never hard-deleted
--      (2B.1). Where a query really does read by author, the spec names the
--      index itself: `dam_assets_created_by_idx`,
--      `dam_ingest_batches_created_by_status_idx`,
--      `dam_share_links_created_by_idx`, `dam_comments_created_by_idx`,
--      `dam_review_decisions_created_by_idx`,
--      `dam_generated_documents_created_by_idx`.
--
--   2. SMALL REFERENCE AND CONFIGURATION TABLES — `dam_access_levels`,
--      `dam_copyright_policies`, `dam_sizes`, `dam_aspect_ratios`,
--      `dam_templates`, `dam_retention_policies`, `dam_tiering_rules`,
--      `dam_settings`. These hold tens of rows; the spec says of several of
--      them that they need nothing beyond their constraints, and a sequential
--      scan of tens of rows is cheaper than an index probe. Their outbound
--      foreign keys (`dam_sizes.aspect_ratio_id`,
--      `dam_templates.thumbnail_asset_id`, …) are therefore not indexed.
--      Foreign keys POINTING AT them from large tables are indexed as usual
--      (`dam_share_links_max_size_id_idx`).
--
-- NAMING
--   `<table>_<cols>_idx`, and `<table>_<cols>_key` when unique — the name the
--   spec gives, verbatim, wherever it gives one.
-- ===========================================================================


-- ===========================================================================
-- CORE / ORGANISATION — studios, clients, projects            (SPEC 2.1–2.5)
-- ===========================================================================

-- --- 2.1  dam_studios -------------------------------------------------------

-- Case-insensitive uniqueness among live rows: `studio=bangkok` on /api/v1 and
-- the seed loader both resolve a studio by its slug, whatever its casing.
create unique index dam_studios_code_key
  on dam_studios (lower(code))
  where deleted_at is null;

create index dam_studios_parent_studio_id_idx
  on dam_studios (parent_studio_id);

-- Folder-walk ingest and the migration map a Drive level-2 folder name onto a
-- studio: `legacy_folder_names @> array['Thailand']`.
create index dam_studios_legacy_folder_names_idx
  on dam_studios using gin (legacy_folder_names);

-- --- 2.2  dam_clients -------------------------------------------------------

create unique index dam_clients_name_key
  on dam_clients (lower(name))
  where deleted_at is null;

-- HubSpot de-duplicates on the bare host, so it must be unique where present.
create unique index dam_clients_domain_key
  on dam_clients (domain)
  where deleted_at is null and domain is not null;

-- Client lists sort by the trigger-maintained sort_name, not by name.
create index dam_clients_sort_name_idx
  on dam_clients (sort_name);

-- Type-ahead on the client picker.
create index dam_clients_name_trgm_idx
  on dam_clients using gin (name gin_trgm_ops);

create index dam_clients_parent_client_id_idx
  on dam_clients (parent_client_id);

-- FK index (added, not in the spec list): dam_clients.logo_asset_id →
-- dam_assets. `on delete set null`, so purging an asset scans this table.
create index dam_clients_logo_asset_id_idx
  on dam_clients (logo_asset_id)
  where logo_asset_id is not null;

-- --- 2.3  dam_projects ------------------------------------------------------

-- The project code is the identity Projectworks owns; case-insensitively
-- unique among live rows.
create unique index dam_projects_code_key
  on dam_projects (lower(code))
  where deleted_at is null;

create index dam_projects_studio_id_idx
  on dam_projects (studio_id);

create index dam_projects_client_id_idx
  on dam_projects (client_id);

create index dam_projects_status_idx
  on dam_projects (status)
  where deleted_at is null;

create index dam_projects_country_code_idx
  on dam_projects (country_code);

create index dam_projects_year_completed_idx
  on dam_projects (year_completed);

create index dam_projects_size_sqm_idx
  on dam_projects (size_sqm);

create index dam_projects_name_trgm_idx
  on dam_projects using gin (name gin_trgm_ops);

-- Fragment search on the project code (`q=2401`).
create index dam_projects_code_trgm_idx
  on dam_projects using gin (code gin_trgm_ops);

-- Map bounding-box queries. A studio-hint geocode is the studio's own pin, not
-- the project's, so it is excluded rather than drawn on top of its siblings.
create index dam_projects_lat_lng_idx
  on dam_projects (latitude, longitude)
  where latitude is not null and geocode_source <> 'studio_hint';

create index dam_projects_access_level_id_idx
  on dam_projects (access_level_id);

-- FK index (added, not in the spec list): dam_projects.hero_asset_id →
-- dam_assets, `on delete set null`.
create index dam_projects_hero_asset_id_idx
  on dam_projects (hero_asset_id)
  where hero_asset_id is not null;

-- FK index (added, not in the spec list):
-- dam_projects.project_manager_employee_id → dam_employees, and the
-- "projects I manage" list.
create index dam_projects_project_manager_employee_id_idx
  on dam_projects (project_manager_employee_id)
  where project_manager_employee_id is not null;

-- --- 2.4  dam_project_aliases -----------------------------------------------

-- One alias resolves to exactly one project.
create unique index dam_project_aliases_alias_key
  on dam_project_aliases (kind, lower(alias))
  where deleted_at is null;

create index dam_project_aliases_project_id_idx
  on dam_project_aliases (project_id);

-- Fuzzy folder matching during the folder walk.
create index dam_project_aliases_alias_trgm_idx
  on dam_project_aliases using gin (alias gin_trgm_ops);

-- --- 2.5  dam_project_studios -----------------------------------------------

-- Also serves project_id lookups as its leading column.
create unique index dam_project_studios_project_id_studio_id_key
  on dam_project_studios (project_id, studio_id)
  where deleted_at is null;

create index dam_project_studios_studio_id_idx
  on dam_project_studios (studio_id);


-- ===========================================================================
-- CORE / TAXONOMY — categories, keyword trees, aliases, links (SPEC 2.7–2.12)
-- ===========================================================================

-- --- 2.7  dam_categories ----------------------------------------------------

create unique index dam_categories_name_key
  on dam_categories (lower(name))
  where deleted_at is null;

create unique index dam_categories_slug_key
  on dam_categories (slug)
  where deleted_at is null;

-- The category rail, in its admin-defined order. ("Assets in a category" is
-- served by dam_assets_category_id_idx on the child side.)
create index dam_categories_sort_order_idx
  on dam_categories (sort_order)
  where deleted_at is null;

-- FK index (added, not in the spec list): dam_categories.access_level_id →
-- dam_access_levels, `on delete restrict` — the restrict check reads this.
create index dam_categories_access_level_id_idx
  on dam_categories (access_level_id);

-- --- 2.8  dam_keyword_categories --------------------------------------------

create unique index dam_keyword_categories_namespace_name_key
  on dam_keyword_categories (namespace, lower(name))
  where deleted_at is null;

create unique index dam_keyword_categories_namespace_slug_key
  on dam_keyword_categories (namespace, slug)
  where deleted_at is null;

-- Picker and admin tree.
create index dam_keyword_categories_namespace_idx
  on dam_keyword_categories (namespace, sort_order)
  where deleted_at is null;

-- FK index (added, not in the spec list): the self-pointer
-- dam_keyword_categories.overrides_category_id, `on delete set null`.
create index dam_keyword_categories_overrides_category_id_idx
  on dam_keyword_categories (overrides_category_id)
  where overrides_category_id is not null;

-- --- 2.9  dam_keywords ------------------------------------------------------

-- Sibling uniqueness. A root keyword has a null parent_id, and null is not
-- equal to null in a unique index, so the parent is coalesced to a sentinel
-- uuid — without it two roots of the same name would both be admissible.
create unique index dam_keywords_sibling_name_key
  on dam_keywords (
    category_id,
    coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  )
  where deleted_at is null;

create unique index dam_keywords_sibling_slug_key
  on dam_keywords (
    namespace,
    coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    slug
  )
  where deleted_at is null;

-- The materialised path is the descendant key, so it must be unique per
-- namespace: a duplicate path would make subtree expansion return two trees.
create unique index dam_keywords_namespace_path_key
  on dam_keywords (namespace, path)
  where deleted_at is null;

-- Tree render.
create index dam_keywords_category_parent_idx
  on dam_keywords (category_id, parent_id, sort_order)
  where deleted_at is null;

-- Descendant expansion, `path LIKE 'sector/hospitality/%'`. text_pattern_ops
-- because a prefix LIKE cannot use a default-collation btree.
create index dam_keywords_path_prefix_idx
  on dam_keywords (namespace, path text_pattern_ops);

-- Type-ahead, `q` on /keywords.
create index dam_keywords_name_trgm_idx
  on dam_keywords using gin (name gin_trgm_ops);

-- Redirect a merged keyword to its survivor.
create index dam_keywords_merged_into_idx
  on dam_keywords (merged_into_keyword_id)
  where merged_into_keyword_id is not null;

-- FK index (added, not in the spec list): the self-pointer
-- dam_keywords.parent_id is `on delete restrict`, and the restrict check
-- probes parent_id alone — dam_keywords_category_parent_idx leads with
-- category_id and cannot serve it.
create index dam_keywords_parent_id_idx
  on dam_keywords (parent_id)
  where parent_id is not null;

-- --- 2.10  dam_keyword_aliases ----------------------------------------------

-- An alias resolves to exactly one keyword per namespace; a 409 names the
-- owning keyword. Also serves exact resolution.
create unique index dam_keyword_aliases_namespace_alias_key
  on dam_keyword_aliases (namespace, lower(alias))
  where deleted_at is null;

create index dam_keyword_aliases_keyword_id_idx
  on dam_keyword_aliases (keyword_id)
  where deleted_at is null;

-- Fuzzy resolution during ingest and auto-tag.
create index dam_keyword_aliases_alias_trgm_idx
  on dam_keyword_aliases using gin (alias gin_trgm_ops);

-- --- 2.11  dam_keyword_links ------------------------------------------------

-- Serves the idempotent upsert.
create unique index dam_keyword_links_keyword_target_key
  on dam_keyword_links (keyword_id, target_type, target_id)
  where deleted_at is null;

-- Every target's chip list and the reindex read.
create index dam_keyword_links_target_idx
  on dam_keyword_links (target_type, target_id)
  where deleted_at is null;

-- Merge, keyword stats, "targets of this keyword".
create index dam_keyword_links_keyword_id_idx
  on dam_keyword_links (keyword_id)
  where deleted_at is null;

-- FK index (added, not in the spec list): dam_keyword_links.suggestion_id →
-- dam_ai_suggestions, `on delete set null`, and the provenance join from an
-- accepted suggestion back to the link it created.
create index dam_keyword_links_suggestion_id_idx
  on dam_keyword_links (suggestion_id)
  where suggestion_id is not null;

-- --- 2.12  dam_category_keyword_categories ----------------------------------

-- Serves "schema of this category".
create unique index dam_category_keyword_categories_pair_key
  on dam_category_keyword_categories (category_id, keyword_category_id)
  where deleted_at is null;

-- Impact analysis before retiring a tree.
create index dam_category_keyword_categories_keyword_category_id_idx
  on dam_category_keyword_categories (keyword_category_id);


-- ===========================================================================
-- CORE / CUSTOM FIELDS — field categories, fields, options,
--                        category bindings, values              (SPEC 2.13–2.17)
-- ===========================================================================

-- --- 2.13  dam_field_categories ---------------------------------------------

create unique index dam_field_categories_scope_name_key
  on dam_field_categories (scope, lower(name))
  where deleted_at is null;

create unique index dam_field_categories_scope_slug_key
  on dam_field_categories (scope, slug)
  where deleted_at is null;

-- The form's section order, per scope.
create index dam_field_categories_scope_idx
  on dam_field_categories (scope, sort_order)
  where deleted_at is null;

-- --- 2.14  dam_fields -------------------------------------------------------

-- The API key of a field is unique within its scope; it is what
-- `filter[field:<key>]` and `facet_fields->'field:<key>'` name.
create unique index dam_fields_scope_key_key
  on dam_fields (scope, key)
  where deleted_at is null;

create unique index dam_fields_scope_name_key
  on dam_fields (scope, lower(name))
  where deleted_at is null;

create index dam_fields_scope_idx
  on dam_fields (scope, sort_order)
  where deleted_at is null;

create index dam_fields_field_category_id_idx
  on dam_fields (field_category_id);

-- The reindex job reads the facet set on every rebuild.
create index dam_fields_is_facet_idx
  on dam_fields (scope)
  where is_facet and deleted_at is null;

-- --- 2.15  dam_field_options ------------------------------------------------

-- Serves validation lookups: is this submitted key an option of that field?
create unique index dam_field_options_field_id_key_key
  on dam_field_options (field_id, key)
  where deleted_at is null;

create unique index dam_field_options_field_id_label_key
  on dam_field_options (field_id, lower(label))
  where deleted_at is null;

-- The select's option list, in its admin-defined order.
create index dam_field_options_field_id_idx
  on dam_field_options (field_id, sort_order)
  where deleted_at is null;

-- --- 2.16  dam_category_fields ----------------------------------------------

-- Serves GET /categories/{id}/schema.
create unique index dam_category_fields_pair_key
  on dam_category_fields (category_id, field_id)
  where deleted_at is null;

-- Impact analysis before retiring a field.
create index dam_category_fields_field_id_idx
  on dam_category_fields (field_id);

-- --- 2.17  dam_field_values -------------------------------------------------

-- Serves the upsert: one value per field per target.
create unique index dam_field_values_field_target_key
  on dam_field_values (field_id, target_type, target_id)
  where deleted_at is null;

-- The entity's whole form in one scan.
create index dam_field_values_target_idx
  on dam_field_values (target_type, target_id)
  where deleted_at is null;

-- The three facet/range indexes of DQ1: one per value column that is faceted
-- or filtered on, so a facet count reads only the rows of that one field.
create index dam_field_values_field_text_idx
  on dam_field_values (field_id, value_text)
  where value_text is not null and deleted_at is null;

create index dam_field_values_field_number_idx
  on dam_field_values (field_id, value_number)
  where value_number is not null and deleted_at is null;

create index dam_field_values_field_date_idx
  on dam_field_values (field_id, value_date)
  where value_date is not null and deleted_at is null;

-- Multi-select containment.
create index dam_field_values_value_json_idx
  on dam_field_values using gin (value_json jsonb_path_ops);


-- ===========================================================================
-- CORE / STORAGE — storage locations                              (SPEC 2.18)
-- ===========================================================================

-- --- 2.18  dam_storage_locations --------------------------------------------

create unique index dam_storage_locations_name_key
  on dam_storage_locations (lower(name))
  where deleted_at is null;

create unique index dam_storage_locations_slug_key
  on dam_storage_locations (slug)
  where deleted_at is null;

-- At most one live default for originals, and one for derivatives. The index
-- is over the constant `true`, so every qualifying row collides with every
-- other one: that is how "the default" is made a singular noun.
create unique index dam_storage_locations_default_originals_key
  on dam_storage_locations ((true))
  where is_default_originals and deleted_at is null;

create unique index dam_storage_locations_default_derivatives_key
  on dam_storage_locations ((true))
  where is_default_derivatives and deleted_at is null;

-- The tiering sweep's source/target lookup. Everything else on this table is
-- served by the unique indexes above — it has tens of rows at most.
create index dam_storage_locations_provider_tier_idx
  on dam_storage_locations (provider, tier)
  where is_active and deleted_at is null;


-- ===========================================================================
-- CORE / ASSETS — assets, project links, versions, derivatives,
--                 render cache, crops                  (SPEC 2.19–2.22a, 2.6)
-- ===========================================================================
-- Faceted and free-text search never touches dam_assets: it reads
-- dam_asset_search (2.23). The indexes here serve the record pages, the
-- queues and the sweeps, not the search box.

-- --- 2.19  dam_assets -------------------------------------------------------

create index dam_assets_category_id_idx
  on dam_assets (category_id)
  where deleted_at is null;

-- Review queue.
create index dam_assets_status_idx
  on dam_assets (status, status_changed_at)
  where deleted_at is null;

-- Keyset paging on non-search listings and the migration page loop. `id`
-- breaks created_at ties, without which a page boundary drops and repeats rows.
create index dam_assets_created_at_id_idx
  on dam_assets (created_at desc, id);

-- "My uploads", own-row permissions.
create index dam_assets_created_by_idx
  on dam_assets (created_by)
  where deleted_at is null;

create index dam_assets_current_version_id_idx
  on dam_assets (current_version_id);

create index dam_assets_ingest_batch_id_idx
  on dam_assets (ingest_batch_id)
  where ingest_batch_id is not null;

create index dam_assets_photographer_id_idx
  on dam_assets (photographer_id)
  where photographer_id is not null;

create index dam_assets_filename_trgm_idx
  on dam_assets using gin (filename gin_trgm_ops);

create index dam_assets_captured_at_idx
  on dam_assets (captured_at)
  where captured_at is not null;

create index dam_assets_merged_into_idx
  on dam_assets (merged_into_asset_id)
  where merged_into_asset_id is not null;

-- The ingest progress panel: assets accepted but not yet through the pipeline.
create index dam_assets_processing_idx
  on dam_assets (created_at)
  where processed_at is null and deleted_at is null;

-- Trash and purge sweep.
create index dam_assets_deleted_at_idx
  on dam_assets (deleted_at)
  where deleted_at is not null;

-- Migration reconciliation: find the asset that came from a given Drive
-- folder id. Partial, because only migrated rows carry the key.
create index dam_assets_legacy_folder_id_idx
  on dam_assets ((legacy ->> 'folder_id'))
  where legacy ? 'folder_id';

-- FK index (added, not in the spec list): dam_assets.studio_id → dam_studios,
-- `on delete restrict`, and the project-less asset listing for a studio.
create index dam_assets_studio_id_idx
  on dam_assets (studio_id)
  where studio_id is not null;

-- FK index (added, not in the spec list): dam_assets.access_level_id →
-- dam_access_levels, `on delete restrict`.
create index dam_assets_access_level_id_idx
  on dam_assets (access_level_id)
  where access_level_id is not null;

-- FK index (added, not in the spec list): dam_assets.upload_request_id →
-- dam_upload_requests, and the "what did this request deposit?" listing.
create index dam_assets_upload_request_id_idx
  on dam_assets (upload_request_id)
  where upload_request_id is not null;

-- FK index (added, not in the spec list): dam_assets.api_key_id →
-- dam_api_keys; per-key attribution of API-created assets.
create index dam_assets_api_key_id_idx
  on dam_assets (api_key_id)
  where api_key_id is not null;

-- --- 2.6  dam_project_assets ------------------------------------------------

-- Serves project-scoped reads as well as the uniqueness of the link itself.
create unique index dam_project_assets_project_id_asset_id_key
  on dam_project_assets (project_id, asset_id)
  where deleted_at is null;

-- [D-004] Exactly one hero per project. This partial unique index is the whole
-- enforcement — nothing in the table definition says it — and it doubles as
-- the hero lookup.
create unique index dam_project_assets_hero_key
  on dam_project_assets (project_id)
  where is_hero and deleted_at is null;

-- The project list of an asset, and the reindex fan-in.
create index dam_project_assets_asset_id_idx
  on dam_project_assets (asset_id)
  where deleted_at is null;

-- Project detail → Assets, ordered.
create index dam_project_assets_project_rank_idx
  on dam_project_assets (project_id, rank)
  where deleted_at is null;

-- --- 2.20  dam_asset_versions -----------------------------------------------
-- The plain unique (asset_id, version_no) is a table constraint in
-- 10-core-tables.sql; it also serves the history view, read descending.

-- One row may own one object. Register-in-place depends on this to be
-- idempotent.
create unique index dam_asset_versions_object_key_key
  on dam_asset_versions (storage_location_id, object_key)
  where deleted_at is null;

-- Exact-duplicate lookup and `sha:` search.
create index dam_asset_versions_sha256_idx
  on dam_asset_versions (sha256)
  where sha256 is not null and deleted_at is null;

-- Near-duplicate candidates. The 64-bit perceptual hash is split into four
-- 16-bit bands (generated columns); two images within Hamming distance 3 must
-- agree on at least one band, so four equality probes replace a full scan.
create index dam_asset_versions_phash_b0_idx
  on dam_asset_versions (phash_b0)
  where phash is not null;

create index dam_asset_versions_phash_b1_idx
  on dam_asset_versions (phash_b1)
  where phash is not null;

create index dam_asset_versions_phash_b2_idx
  on dam_asset_versions (phash_b2)
  where phash is not null;

create index dam_asset_versions_phash_b3_idx
  on dam_asset_versions (phash_b3)
  where phash is not null;

-- Storage-by-location analytics, tiering sweep.
create index dam_asset_versions_storage_location_id_idx
  on dam_asset_versions (storage_location_id);

-- --- 2.21  dam_derivatives --------------------------------------------------

-- Serves the per-version fetch of the lightbox.
create unique index dam_derivatives_version_kind_key
  on dam_derivatives (version_id, kind, format, page)
  where deleted_at is null;

create index dam_derivatives_asset_id_idx
  on dam_derivatives (asset_id)
  where deleted_at is null;

-- The retry sweep of the worker, and the admin "derivatives failed" view.
create index dam_derivatives_status_idx
  on dam_derivatives (status, updated_at)
  where status in ('queued', 'failed');

-- Storage analytics.
create index dam_derivatives_storage_location_id_idx
  on dam_derivatives (storage_location_id);

-- Orphan reconciliation at purge: is this object still referenced?
create index dam_derivatives_object_key_idx
  on dam_derivatives (storage_location_id, object_key);

-- --- 2.22  dam_render_cache -------------------------------------------------

-- The lookup: a rendered variant is identified by its version and the hash of
-- its render parameters.
create unique index dam_render_cache_version_params_key
  on dam_render_cache (version_id, params_hash)
  where deleted_at is null;

-- Eviction sweep.
create index dam_render_cache_last_hit_at_idx
  on dam_render_cache (last_hit_at)
  where deleted_at is null;

create index dam_render_cache_asset_id_idx
  on dam_render_cache (asset_id);

-- FK index (added, not in the spec list): dam_render_cache
-- .storage_location_id → dam_storage_locations, `on delete restrict`, and the
-- per-location eviction pass.
create index dam_render_cache_storage_location_id_idx
  on dam_render_cache (storage_location_id);

-- --- 2.22a  dam_asset_crops -------------------------------------------------

-- One saved box per ratio; serves the lookup of the render path (asset+ratio).
create unique index dam_asset_crops_asset_ratio_key
  on dam_asset_crops (asset_id, aspect_ratio_id)
  where deleted_at is null;

-- Invalidate boxes after a replace.
create index dam_asset_crops_version_id_idx
  on dam_asset_crops (version_id)
  where deleted_at is null;

-- FK index (added, not in the spec list): dam_asset_crops.aspect_ratio_id →
-- dam_aspect_ratios is `on delete cascade`, and the cascade cannot use
-- dam_asset_crops_asset_ratio_key, which leads with asset_id.
create index dam_asset_crops_aspect_ratio_id_idx
  on dam_asset_crops (aspect_ratio_id);

-- FK index (added, not in the spec list): dam_asset_crops.suggestion_id →
-- dam_ai_suggestions, `on delete set null`.
create index dam_asset_crops_suggestion_id_idx
  on dam_asset_crops (suggestion_id)
  where suggestion_id is not null;


-- ===========================================================================
-- CORE / SEARCH AND DERIVED TEXT — the search row, embeddings,
--                                  OCR, duplicates         (SPEC 2.23–2.26)
-- ===========================================================================

-- --- 2.23  dam_asset_search -------------------------------------------------
-- The index plan of DQ5, in full. Every list, facet count and permission
-- predicate on the hot path reads this table and nothing else, so this is the
-- one place in the schema where index count is bought deliberately: the row is
-- machine-written in batches by dam_rebuild_asset_search(), never by a user
-- typing, so write amplification here is a background cost, not a UI cost.
--
-- The PK is (asset_id) and is declared in 10-core-tables.sql (D-242).

-- Free text.
create index dam_asset_search_tsv_idx
  on dam_asset_search using gin (search_tsv);

-- Misspellings, `similarity >= 0.3`.
create index dam_asset_search_trigram_idx
  on dam_asset_search using gin (trigram_text gin_trgm_ops);

-- The array facets. Keyword AND is `@>`, OR is `&&`; both need GIN. The id
-- arrays are pre-expanded to include ancestors (D-244), which is what makes
-- "include sub-keywords" a plain containment test rather than a subtree
-- expansion per query.
create index dam_asset_search_asset_keyword_ids_idx
  on dam_asset_search using gin (asset_keyword_ids);

create index dam_asset_search_project_ids_idx
  on dam_asset_search using gin (project_ids);

create index dam_asset_search_project_keyword_ids_idx
  on dam_asset_search using gin (project_keyword_ids);

-- The studio half of the RLS predicate, evaluated set-wise.
create index dam_asset_search_studio_ids_idx
  on dam_asset_search using gin (studio_ids);

create index dam_asset_search_client_ids_idx
  on dam_asset_search using gin (client_ids);

create index dam_asset_search_hero_of_project_ids_idx
  on dam_asset_search using gin (hero_of_project_ids);

create index dam_asset_search_colour_buckets_idx
  on dam_asset_search using gin (colour_buckets);

-- Custom facets, city, project status. jsonb_path_ops is the smaller operator
-- class and supports the only operator this column is queried with, `@>`.
create index dam_asset_search_facet_fields_idx
  on dam_asset_search using gin (facet_fields jsonb_path_ops);

-- The btree singles: one filter or sort key each.
create index dam_asset_search_category_id_idx
  on dam_asset_search (category_id);

create index dam_asset_search_rights_status_idx
  on dam_asset_search (rights_status);

create index dam_asset_search_captured_on_idx
  on dam_asset_search (captured_on);

create index dam_asset_search_photographer_id_idx
  on dam_asset_search (photographer_id);

create index dam_asset_search_file_kind_idx
  on dam_asset_search (file_kind);

create index dam_asset_search_status_idx
  on dam_asset_search (status);

create index dam_asset_search_access_level_id_idx
  on dam_asset_search (access_level_id);

create index dam_asset_search_long_edge_px_idx
  on dam_asset_search (long_edge_px);

-- Sort, and the `size:>50mb` filter.
create index dam_asset_search_size_bytes_idx
  on dam_asset_search (size_bytes);

create index dam_asset_search_rating_avg_idx
  on dam_asset_search (rating_avg desc);

-- Facet "Under-tagged" and `sort=completeness_score`.
create index dam_asset_search_completeness_score_idx
  on dam_asset_search (completeness_score);

-- `filter[ingest_batch_id]` on the ingest report.
create index dam_asset_search_ingest_batch_id_idx
  on dam_asset_search (ingest_batch_id)
  where ingest_batch_id is not null;

-- `sha:` search and by-hash lookups, without a join to dam_asset_versions.
create index dam_asset_search_sha256_idx
  on dam_asset_search (sha256)
  where sha256 is not null;

-- The default keyset cursor. asset_id breaks created_at ties, without which a
-- page boundary both drops and repeats rows.
create index dam_asset_search_created_at_idx
  on dam_asset_search (created_at desc, asset_id);

-- [D-246] The published, non-deleted set is the shape of essentially every
-- viewer query. These four partial copies keep the hot index resident at
-- 500k rows, where the full-table equivalents would not be.
create index dam_asset_search_published_category_id_idx
  on dam_asset_search (category_id)
  where deleted_at is null and status = 'published';

create index dam_asset_search_published_captured_on_idx
  on dam_asset_search (captured_on desc)
  where deleted_at is null and status = 'published';

create index dam_asset_search_published_created_at_idx
  on dam_asset_search (created_at desc, asset_id)
  where deleted_at is null and status = 'published';

create index dam_asset_search_published_asset_keyword_ids_idx
  on dam_asset_search using gin (asset_keyword_ids)
  where deleted_at is null and status = 'published';

-- Staleness monitor: a row whose rebuild is older than the asset it projects.
create index dam_asset_search_indexed_at_idx
  on dam_asset_search (indexed_at)
  where indexed_at < updated_at;

-- --- 2.24  dam_asset_embeddings ---------------------------------------------
-- The plain unique (asset_id) is a table constraint in 10-core-tables.sql.
--
-- Dimensions are fixed by [D-006] and are part of the column type, not of the
-- index: image_embedding is vector(1408) (a joint image-text model), and
-- text_embedding is vector(768). Both are well inside the 2000-dimension HNSW
-- limit. Changing either dimension is a full re-embed and a migration, not an
-- index rebuild.
--
-- Query-time settings that go with these indexes (D-493), set per session by
-- the search RPC rather than here: `hnsw.ef_search = 100` and
-- `hnsw.iterative_scan = relaxed_order`, so that filtered recall holds when
-- the structured predicate is selective.

-- Visual similarity. Cosine, because the providers of [D-006] return vectors
-- normalised for cosine distance.
create index dam_asset_embeddings_image_hnsw_idx
  on dam_asset_embeddings using hnsw (image_embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64)
  where image_embedding is not null and deleted_at is null;

-- Semantic text search over caption, alt text, keyword names, the OCR summary
-- and the approved project description.
create index dam_asset_embeddings_text_hnsw_idx
  on dam_asset_embeddings using hnsw (text_embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64)
  where text_embedding is not null and deleted_at is null;

create index dam_asset_embeddings_version_id_idx
  on dam_asset_embeddings (version_id);

-- Backfill queue: rows with one vector still missing.
create index dam_asset_embeddings_stale_idx
  on dam_asset_embeddings (updated_at)
  where image_embedding is null or text_embedding is null;

-- --- 2.25  dam_asset_ocr_text -----------------------------------------------

-- Serves page fetch.
create unique index dam_asset_ocr_text_version_page_key
  on dam_asset_ocr_text (version_id, page)
  where deleted_at is null;

-- The `ocr:` prefix and snippet matching. Page-level, so ts_headline can say
-- "Match on page 4" without re-reading the asset.
create index dam_asset_ocr_text_tsv_idx
  on dam_asset_ocr_text using gin (ocr_tsv);

create index dam_asset_ocr_text_asset_id_idx
  on dam_asset_ocr_text (asset_id)
  where deleted_at is null;

-- --- 2.26  dam_asset_duplicates ---------------------------------------------

-- Serves the pair lookup. The check (asset_id < duplicate_asset_id) on the
-- table is what stops the mirrored row, so this index sees each pair once.
create unique index dam_asset_duplicates_pair_key
  on dam_asset_duplicates (asset_id, duplicate_asset_id)
  where deleted_at is null;

-- The other half of "pairs involving this asset" — the API unions the two.
create index dam_asset_duplicates_duplicate_asset_id_idx
  on dam_asset_duplicates (duplicate_asset_id)
  where deleted_at is null;

-- The /upload → Duplicates tab.
create index dam_asset_duplicates_open_idx
  on dam_asset_duplicates (created_at desc)
  where status = 'open' and deleted_at is null;

-- FK index (added, not in the spec list): dam_asset_duplicates.version_id →
-- dam_asset_versions, `on delete set null`; a replace retires a version and
-- must find the pairs that cite it.
create index dam_asset_duplicates_version_id_idx
  on dam_asset_duplicates (version_id)
  where version_id is not null;

-- FK index (added, not in the spec list):
-- dam_asset_duplicates.duplicate_version_id → dam_asset_versions.
create index dam_asset_duplicates_duplicate_version_id_idx
  on dam_asset_duplicates (duplicate_version_id)
  where duplicate_version_id is not null;

-- FK index (added, not in the spec list): dam_asset_duplicates.job_id →
-- dam_jobs, and the "what did this dedupe run find?" report.
create index dam_asset_duplicates_job_id_idx
  on dam_asset_duplicates (job_id)
  where job_id is not null;


-- ===========================================================================
-- CORE / INGEST AND EXTERNAL IDENTITY — sources, batches, batch files,
--                                       external ids       (SPEC 2.27–2.29)
-- ===========================================================================

-- --- 2.27  dam_ingest_sources -----------------------------------------------

create unique index dam_ingest_sources_name_key
  on dam_ingest_sources (lower(name))
  where deleted_at is null;

-- One source owns one subtree, so two pollers cannot race on the same folder.
-- Also serves the ancestor check when an event arrives.
create unique index dam_ingest_sources_root_key
  on dam_ingest_sources (storage_location_id, root_key)
  where deleted_at is null;

-- The pg_cron enqueue pass.
create index dam_ingest_sources_active_idx
  on dam_ingest_sources (kind, is_active)
  where deleted_at is null;

create index dam_ingest_sources_storage_location_id_idx
  on dam_ingest_sources (storage_location_id);

-- FK index (added, not in the spec list): dam_ingest_sources.default_project_id
-- → dam_projects, `on delete set null`.
create index dam_ingest_sources_default_project_id_idx
  on dam_ingest_sources (default_project_id)
  where default_project_id is not null;

-- FK index (added, not in the spec list):
-- dam_ingest_sources.default_category_id → dam_categories.
create index dam_ingest_sources_default_category_id_idx
  on dam_ingest_sources (default_category_id)
  where default_category_id is not null;

-- FK index (added, not in the spec list): dam_ingest_sources.default_studio_id
-- → dam_studios, `on delete restrict`.
create index dam_ingest_sources_default_studio_id_idx
  on dam_ingest_sources (default_studio_id)
  where default_studio_id is not null;

-- FK index (added, not in the spec list):
-- dam_ingest_sources.default_photographer_id → dam_photographers.
create index dam_ingest_sources_default_photographer_id_idx
  on dam_ingest_sources (default_photographer_id)
  where default_photographer_id is not null;

-- FK index (added, not in the spec list):
-- dam_ingest_sources.default_access_level_id → dam_access_levels,
-- `on delete restrict`.
create index dam_ingest_sources_default_access_level_id_idx
  on dam_ingest_sources (default_access_level_id)
  where default_access_level_id is not null;

-- --- 2.28  dam_ingest_batches -----------------------------------------------

-- "Resume uploads".
create index dam_ingest_batches_created_by_status_idx
  on dam_ingest_batches (created_by, status, created_at desc)
  where deleted_at is null;

-- The abandon sweep.
create index dam_ingest_batches_open_idx
  on dam_ingest_batches (expires_at)
  where status in ('draft', 'uploading');

create index dam_ingest_batches_ingest_source_id_idx
  on dam_ingest_batches (ingest_source_id)
  where ingest_source_id is not null;

-- FK index (added, not in the spec list):
-- dam_ingest_batches.storage_location_id → dam_storage_locations,
-- `on delete restrict`.
create index dam_ingest_batches_storage_location_id_idx
  on dam_ingest_batches (storage_location_id);

-- FK index (added, not in the spec list): dam_ingest_batches.category_id →
-- dam_categories, `on delete restrict`.
create index dam_ingest_batches_category_id_idx
  on dam_ingest_batches (category_id)
  where category_id is not null;

-- FK index (added, not in the spec list): dam_ingest_batches.access_level_id →
-- dam_access_levels, `on delete restrict`.
create index dam_ingest_batches_access_level_id_idx
  on dam_ingest_batches (access_level_id)
  where access_level_id is not null;

-- FK index (added, not in the spec list):
-- dam_ingest_batches.upload_request_id → dam_upload_requests.
create index dam_ingest_batches_upload_request_id_idx
  on dam_ingest_batches (upload_request_id)
  where upload_request_id is not null;

-- --- 2.28a  dam_ingest_batch_files ------------------------------------------

-- [D-252] One row per file in a batch. Two files may share a name only if
-- their relative paths differ; relative_path is coalesced to the empty string
-- because null is not equal to null in a unique index, and a flat drop with
-- two identically named files must still collide. The spec gives this index
-- no name, so it takes the standard one.
create unique index dam_ingest_batch_files_batch_filename_key
  on dam_ingest_batch_files (batch_id, lower(filename), coalesce(relative_path, ''));

-- The progress panel of a batch, and the commit pass, which walks one state
-- at a time.
create index dam_ingest_batch_files_batch_id_state_idx
  on dam_ingest_batch_files (batch_id, state);

-- The asset reserved at session open and filled at commit.
create index dam_ingest_batch_files_asset_id_idx
  on dam_ingest_batch_files (asset_id);

-- FK index (added, not in the spec list):
-- dam_ingest_batch_files.duplicate_of_asset_id → dam_assets; the duplicate
-- decision taken at commit points at an asset that may later be purged.
create index dam_ingest_batch_files_duplicate_of_asset_id_idx
  on dam_ingest_batch_files (duplicate_of_asset_id)
  where duplicate_of_asset_id is not null;

-- --- 2.29  dam_external_ids -------------------------------------------------

-- A foreign record maps to exactly one DAM row — the idempotency key of the
-- importer.
create unique index dam_external_ids_system_external_id_key
  on dam_external_ids (system, external_id)
  where deleted_at is null;

-- A DAM row has at most one id per system. The two unique indexes carry both
-- lookup directions.
create unique index dam_external_ids_target_system_key
  on dam_external_ids (target_type, target_id, system)
  where deleted_at is null;

-- The "External ids" panel of a record, and the include on every resource.
create index dam_external_ids_target_idx
  on dam_external_ids (target_type, target_id)
  where deleted_at is null;

-- FK index (added, not in the spec list): dam_external_ids.sync_run_id →
-- dam_sync_runs, and the "what did this run write?" report.
create index dam_external_ids_sync_run_id_idx
  on dam_external_ids (sync_run_id)
  where sync_run_id is not null;


-- ===========================================================================
-- SUPPORTING / IDENTITY AND ACCESS — users, groups, studio membership,
--                                    access levels, grants, API keys
--                                                         (SPEC 2B.1–2B.7)
-- ===========================================================================

-- --- 2B.1  dam_users --------------------------------------------------------
-- The plain unique (email) is a table constraint in 20-supporting-tables.sql:
-- it holds over ALL rows, deleted included, because an email identifies one
-- principal forever.

-- Reserved for Supabase Auth; unique where present.
create unique index dam_users_auth_uid_key
  on dam_users (auth_uid)
  where auth_uid is not null;

create index dam_users_role_idx
  on dam_users (role);

-- The set of principals who may sign in. Indexed on id alone: the predicate
-- carries the selectivity, and the payload is only the key.
create index dam_users_is_active_idx
  on dam_users (id)
  where is_active and deleted_at is null;

create index dam_users_last_login_at_idx
  on dam_users (last_login_at desc);

-- The people picker.
create index dam_users_display_name_trgm_idx
  on dam_users using gin (display_name gin_trgm_ops);

-- FK index (added, not in the spec list): dam_users.avatar_asset_id →
-- dam_assets, `on delete set null`, so purging an asset probes this table.
create index dam_users_avatar_asset_id_idx
  on dam_users (avatar_asset_id)
  where avatar_asset_id is not null;

-- --- 2B.2  dam_groups -------------------------------------------------------
-- The plain unique (slug) is a table constraint.

create unique index dam_groups_lower_name_key
  on dam_groups (lower(name))
  where deleted_at is null;

create index dam_groups_studio_id_idx
  on dam_groups (studio_id);

-- --- 2B.3  dam_group_members ------------------------------------------------
-- The plain unique (group_id, user_id) over all rows is a table constraint,
-- and it serves group_id lookups as its leading column.

create index dam_group_members_user_id_idx
  on dam_group_members (user_id)
  where deleted_at is null;

-- --- 2B.4  dam_user_studios -------------------------------------------------
-- The plain unique (user_id, studio_id) over all rows is a table constraint.

-- One primary studio per user.
create unique index dam_user_studios_primary_key
  on dam_user_studios (user_id)
  where is_primary and deleted_at is null;

create index dam_user_studios_studio_id_idx
  on dam_user_studios (studio_id)
  where deleted_at is null;

-- --- 2B.5  dam_access_levels ------------------------------------------------
-- The plain unique (slug) is a table constraint. Nothing beyond the
-- constraints: a tiny table, cached by the permission helpers.

create unique index dam_access_levels_lower_name_key
  on dam_access_levels (lower(name))
  where deleted_at is null;

-- At most one live default level.
create unique index dam_access_levels_default_key
  on dam_access_levels (is_default)
  where is_default and deleted_at is null;

-- --- 2B.6  dam_access_grants ------------------------------------------------

-- A grant names a user or a group, never both (table CHECK); each side gets
-- its own partial unique so a level is granted to a principal once.
create unique index dam_access_grants_level_user_key
  on dam_access_grants (access_level_id, user_id)
  where user_id is not null and deleted_at is null;

create unique index dam_access_grants_level_group_key
  on dam_access_grants (access_level_id, group_id)
  where group_id is not null and deleted_at is null;

create index dam_access_grants_user_id_idx
  on dam_access_grants (user_id)
  where deleted_at is null;

create index dam_access_grants_group_id_idx
  on dam_access_grants (group_id)
  where deleted_at is null;

-- The expiry sweep.
create index dam_access_grants_expires_at_idx
  on dam_access_grants (expires_at)
  where expires_at is not null and deleted_at is null;

-- --- 2B.7  dam_api_keys -----------------------------------------------------
-- The plain unique (key_hash) is a table constraint; authentication is a
-- single-row lookup by exact hash and needs nothing else.

-- The /api/v1 per-site key name, unique where set.
create unique index dam_api_keys_v1_site_name_key
  on dam_api_keys (v1_site_name)
  where v1_site_name is not null;

create index dam_api_keys_owner_user_id_idx
  on dam_api_keys (owner_user_id)
  where revoked_at is null;

create index dam_api_keys_service_name_idx
  on dam_api_keys (service_name);

-- The expiry sweep.
create index dam_api_keys_expires_at_idx
  on dam_api_keys (expires_at)
  where revoked_at is null and expires_at is not null;

-- FK index (added, not in the spec list): dam_api_keys.studio_id →
-- dam_studios, and the "keys scoped to this studio" admin list.
create index dam_api_keys_studio_id_idx
  on dam_api_keys (studio_id)
  where studio_id is not null;


-- ===========================================================================
-- SUPPORTING / PEOPLE — employees and everything hanging off them
--                                                        (SPEC 2B.8–2B.14)
-- ===========================================================================

-- --- 2B.8  dam_employees ----------------------------------------------------

-- An employee maps to at most one user account.
create unique index dam_employees_user_id_key
  on dam_employees (user_id)
  where user_id is not null;

create unique index dam_employees_employee_no_key
  on dam_employees (employee_no)
  where employee_no is not null;

create unique index dam_employees_email_key
  on dam_employees (email)
  where email is not null and deleted_at is null;

create index dam_employees_studio_id_idx
  on dam_employees (studio_id)
  where deleted_at is null;

create index dam_employees_manager_id_idx
  on dam_employees (manager_id);

create index dam_employees_sort_name_idx
  on dam_employees (sort_name);

create index dam_employees_display_name_trgm_idx
  on dam_employees using gin (display_name gin_trgm_ops);

-- The public directory, already in display order.
create index dam_employees_directory_idx
  on dam_employees (studio_id, sort_name)
  where is_visible_in_directory and is_active and deleted_at is null;

create index dam_employees_years_experience_start_idx
  on dam_employees (years_experience_start);

-- --- 2B.9  dam_employee_bios ------------------------------------------------

-- One bio per employee per nominal length per locale. `custom` is excluded:
-- an employee may hold several custom-length bios.
create unique index dam_employee_bios_employee_length_locale_key
  on dam_employee_bios (employee_id, length, locale)
  where deleted_at is null and length <> 'custom';

create index dam_employee_bios_employee_id_idx
  on dam_employee_bios (employee_id)
  where deleted_at is null;

-- The approval queue.
create index dam_employee_bios_state_idx
  on dam_employee_bios (state)
  where state = 'in_review' and deleted_at is null;

-- --- 2B.10  dam_employee_headshots ------------------------------------------

create unique index dam_employee_headshots_employee_asset_kind_key
  on dam_employee_headshots (employee_id, asset_id, kind)
  where deleted_at is null;

-- One primary headshot per employee.
create unique index dam_employee_headshots_primary_key
  on dam_employee_headshots (employee_id)
  where is_primary and deleted_at is null;

-- The lightbox "people in this photo" panel, and the asset trash cascade.
create index dam_employee_headshots_asset_id_idx
  on dam_employee_headshots (asset_id)
  where deleted_at is null;

-- --- 2B.11  dam_employee_education ------------------------------------------

-- The importer key: one row per foreign row, so a re-sync updates.
create unique index dam_employee_education_employee_external_key
  on dam_employee_education (employee_id, external_row_key)
  where external_row_key is not null;

create index dam_employee_education_employee_id_idx
  on dam_employee_education (employee_id)
  where deleted_at is null;

-- --- 2B.12  dam_employee_registrations --------------------------------------

create unique index dam_employee_registrations_employee_external_key
  on dam_employee_registrations (employee_id, external_row_key)
  where external_row_key is not null;

create index dam_employee_registrations_employee_id_idx
  on dam_employee_registrations (employee_id)
  where deleted_at is null;

-- The 90/30/7 renewal alert scan.
create index dam_employee_registrations_expires_on_idx
  on dam_employee_registrations (expires_on)
  where status = 'active' and expires_on is not null and deleted_at is null;

-- "Search staff by credential". title and body are both not null, so the
-- concatenation is never null and every row is indexed.
create index dam_employee_registrations_credential_trgm_idx
  on dam_employee_registrations using gin ((title || ' ' || body) gin_trgm_ops);

-- FK index (added, not in the spec list):
-- dam_employee_registrations.evidence_asset_id → dam_assets.
create index dam_employee_registrations_evidence_asset_id_idx
  on dam_employee_registrations (evidence_asset_id)
  where evidence_asset_id is not null;

-- --- 2B.13  dam_employee_languages ------------------------------------------

create unique index dam_employee_languages_employee_language_key
  on dam_employee_languages (employee_id, language_code)
  where deleted_at is null;

create unique index dam_employee_languages_employee_external_key
  on dam_employee_languages (employee_id, external_row_key)
  where external_row_key is not null;

create index dam_employee_languages_employee_id_idx
  on dam_employee_languages (employee_id)
  where deleted_at is null;

-- Staff search, "speaks Thai at C1+".
create index dam_employee_languages_language_code_idx
  on dam_employee_languages (language_code, proficiency)
  where deleted_at is null;

-- --- 2B.14  dam_project_employees -------------------------------------------

-- [D-291] NULLS NOT DISTINCT (PostgreSQL 15+) so a null started_on still
-- deduplicates. The same person may legitimately hold two roles on a project,
-- or return in a later phase, so the role and the start date are part of the
-- key.
create unique index dam_project_employees_project_employee_role_start_key
  on dam_project_employees (project_id, employee_id, role_title, started_on)
  nulls not distinct
  where deleted_at is null;

-- The CV: every project this person worked on, most recent first.
create index dam_project_employees_employee_id_idx
  on dam_project_employees (employee_id, started_on desc)
  where deleted_at is null;

-- The project team panel, in display order.
create index dam_project_employees_project_id_idx
  on dam_project_employees (project_id, sort_order)
  where deleted_at is null;

create index dam_project_employees_role_keyword_id_idx
  on dam_project_employees (role_keyword_id)
  where deleted_at is null;


-- ===========================================================================
-- SUPPORTING / ALBUMS AND TEXT — albums, their items and collaborators,
--                                text blocks and versions
--                                                       (SPEC 2B.15–2B.19)
-- ===========================================================================

-- --- 2B.15  dam_albums ------------------------------------------------------

-- Unique name among an owner's siblings. NULLS NOT DISTINCT so two root
-- albums (null parent) of the same name still collide.
create unique index dam_albums_owner_parent_lower_name_key
  on dam_albums (owner_id, parent_album_id, lower(name))
  nulls not distinct
  where deleted_at is null;

-- "My albums", most recently touched first.
create index dam_albums_owner_id_idx
  on dam_albums (owner_id, updated_at desc)
  where deleted_at is null;

create index dam_albums_parent_album_id_idx
  on dam_albums (parent_album_id, sort_order)
  where deleted_at is null;

-- The company-visible album list for a studio.
create index dam_albums_company_idx
  on dam_albums (studio_id, name)
  where visibility = 'company' and deleted_at is null;

create index dam_albums_cover_asset_id_idx
  on dam_albums (cover_asset_id);

-- FK index (added, not in the spec list): the self-pointer
-- dam_albums.duplicated_from_album_id, and "albums copied from this one".
create index dam_albums_duplicated_from_album_id_idx
  on dam_albums (duplicated_from_album_id)
  where duplicated_from_album_id is not null;

-- --- 2B.16  dam_album_items -------------------------------------------------
-- [D-294] No uniqueness on sort_order: density is a trigger invariant for live
-- rows, and a deferred unique constraint cannot be partial.

create unique index dam_album_items_album_asset_key
  on dam_album_items (album_id, asset_id)
  where deleted_at is null;

-- The album, in order.
create index dam_album_items_album_sort_idx
  on dam_album_items (album_id, sort_order)
  where deleted_at is null;

-- The "in albums" panel, and the asset trash cascade.
create index dam_album_items_asset_id_idx
  on dam_album_items (asset_id)
  where deleted_at is null;

-- --- 2B.17  dam_album_collaborators -----------------------------------------

create unique index dam_album_collaborators_album_user_key
  on dam_album_collaborators (album_id, user_id)
  where user_id is not null and deleted_at is null;

create unique index dam_album_collaborators_album_group_key
  on dam_album_collaborators (album_id, group_id)
  where group_id is not null and deleted_at is null;

-- "Albums shared with me", the user half and the group half.
create index dam_album_collaborators_user_id_idx
  on dam_album_collaborators (user_id)
  where deleted_at is null;

create index dam_album_collaborators_group_id_idx
  on dam_album_collaborators (group_id)
  where deleted_at is null;

-- --- 2B.18  dam_text_blocks -------------------------------------------------

-- One block per target per kind per nominal length per locale. length_words is
-- coalesced to 0 because null is not equal to null in a unique index and two
-- unsized blocks of the same kind must still collide.
create unique index dam_text_blocks_target_kind_length_locale_key
  on dam_text_blocks (
    target_type,
    target_id,
    kind,
    coalesce(length_words, 0),
    locale
  )
  where target_id is not null and deleted_at is null;

-- Every block on a record, in one scan.
create index dam_text_blocks_target_idx
  on dam_text_blocks (target_type, target_id)
  where deleted_at is null;

-- Free text over approved copy; also the weight-C contribution to the asset
-- search row.
create index dam_text_blocks_search_tsv_idx
  on dam_text_blocks using gin (search_tsv);

create index dam_text_blocks_tags_idx
  on dam_text_blocks using gin (tags);

create index dam_text_blocks_kind_locale_idx
  on dam_text_blocks (kind, locale)
  where deleted_at is null;

-- --- 2B.19  dam_text_block_versions -----------------------------------------
-- The plain unique (text_block_id, version_no) is a table constraint.

-- The history view, newest first.
create index dam_text_block_versions_block_idx
  on dam_text_block_versions (text_block_id, version_no desc);

-- The copy review queue.
create index dam_text_block_versions_review_queue_idx
  on dam_text_block_versions (submitted_at)
  where state = 'in_review' and deleted_at is null;


-- ===========================================================================
-- SUPPORTING / RIGHTS — photographers, copyright holders and policies,
--                       the per-asset rights row       (SPEC 2B.20–2B.23)
-- ===========================================================================

-- --- 2B.20  dam_photographers -----------------------------------------------

create unique index dam_photographers_lower_name_key
  on dam_photographers (lower(name))
  where deleted_at is null;

-- A staff photographer is one person, so the employee link is one-to-one.
create unique index dam_photographers_employee_id_key
  on dam_photographers (employee_id)
  where employee_id is not null and deleted_at is null;

-- The credit picker.
create index dam_photographers_name_trgm_idx
  on dam_photographers using gin (name gin_trgm_ops);

-- De-duplication on import.
create index dam_photographers_email_idx
  on dam_photographers (email)
  where email is not null and deleted_at is null;

create index dam_photographers_employee_id_idx
  on dam_photographers (employee_id);

-- FK index (added, not in the spec list):
-- dam_photographers.default_copyright_holder_id → dam_copyright_holders and
-- .default_policy_id → dam_copyright_policies. Both parents are `restrict`,
-- and the restrict check probes this table, which is the larger of the two.
create index dam_photographers_default_copyright_holder_id_idx
  on dam_photographers (default_copyright_holder_id)
  where default_copyright_holder_id is not null;

create index dam_photographers_default_policy_id_idx
  on dam_photographers (default_policy_id)
  where default_policy_id is not null;

-- --- 2B.21  dam_copyright_holders -------------------------------------------

create unique index dam_copyright_holders_lower_name_key
  on dam_copyright_holders (lower(name))
  where deleted_at is null;

-- At most one live default holder.
create unique index dam_copyright_holders_default_key
  on dam_copyright_holders (is_default)
  where is_default and deleted_at is null;

create index dam_copyright_holders_name_trgm_idx
  on dam_copyright_holders using gin (name gin_trgm_ops);

create index dam_copyright_holders_client_id_idx
  on dam_copyright_holders (client_id)
  where client_id is not null and deleted_at is null;

-- --- 2B.22  dam_copyright_policies ------------------------------------------
-- The plain unique (slug) is a table constraint. Nothing else beyond these:
-- a tenant has tens of rows and they are cached by dam_effective_rights.

create unique index dam_copyright_policies_lower_name_key
  on dam_copyright_policies (lower(name))
  where deleted_at is null;

create unique index dam_copyright_policies_default_key
  on dam_copyright_policies (is_default)
  where is_default and deleted_at is null;

-- "Which policies allow advertising".
create index dam_copyright_policies_permitted_uses_idx
  on dam_copyright_policies using gin (permitted_uses);

-- --- 2B.23  dam_asset_rights ------------------------------------------------
-- No separate asset_id index: the partial unique below is it.

create unique index dam_asset_rights_asset_id_key
  on dam_asset_rights (asset_id)
  where deleted_at is null;

-- The nightly rights sweep and the 90/30/7 alert scan.
create index dam_asset_rights_expires_on_idx
  on dam_asset_rights (expires_on)
  where expires_on is not null and deleted_at is null;

-- The same sweep, embargo half.
create index dam_asset_rights_embargo_until_idx
  on dam_asset_rights (embargo_until)
  where embargo_until is not null and deleted_at is null;

-- Policy propagation: re-derive every asset when a policy changes.
create index dam_asset_rights_policy_id_idx
  on dam_asset_rights (policy_id)
  where deleted_at is null;

-- "Everything by this photographer".
create index dam_asset_rights_photographer_id_idx
  on dam_asset_rights (photographer_id)
  where deleted_at is null;

create index dam_asset_rights_copyright_holder_id_idx
  on dam_asset_rights (copyright_holder_id)
  where deleted_at is null;

-- FK index (added, not in the spec list): dam_asset_rights.release_asset_id →
-- dam_assets; the model or property release is itself a library asset, and
-- purging it must find the rights rows that cite it.
create index dam_asset_rights_release_asset_id_idx
  on dam_asset_rights (release_asset_id)
  where release_asset_id is not null;


-- ===========================================================================
-- SUPPORTING / OUTPUT PRESETS — download sizes and crop ratios
--                                                       (SPEC 2B.24–2B.25)
-- ===========================================================================

-- --- 2B.24  dam_sizes -------------------------------------------------------
-- The plain unique (slug) is a table constraint.

create unique index dam_sizes_lower_name_key
  on dam_sizes (lower(name))
  where deleted_at is null;

-- Exactly one pass-through preset, and exactly one default.
create unique index dam_sizes_original_key
  on dam_sizes (is_original)
  where is_original and deleted_at is null;

create unique index dam_sizes_default_key
  on dam_sizes (is_default)
  where is_default and deleted_at is null;

-- The download dialog, already in display order.
create index dam_sizes_active_idx
  on dam_sizes (sort_order, name)
  where is_active and deleted_at is null;

create index dam_sizes_applies_to_idx
  on dam_sizes using gin (applies_to);

-- --- 2B.25  dam_aspect_ratios -----------------------------------------------
-- The plain unique (slug) is a table constraint.

create unique index dam_aspect_ratios_lower_name_key
  on dam_aspect_ratios (lower(name))
  where deleted_at is null;

-- Two rows with the same ratio and different names would make crop matching
-- ambiguous.
create unique index dam_aspect_ratios_ratio_key
  on dam_aspect_ratios (ratio)
  where deleted_at is null;

create unique index dam_aspect_ratios_default_key
  on dam_aspect_ratios (is_default)
  where is_default and deleted_at is null;

create index dam_aspect_ratios_active_idx
  on dam_aspect_ratios (sort_order, ratio)
  where is_active and deleted_at is null;


-- ===========================================================================
-- SUPPORTING / SAVED SEARCHES, SHARING AND EXTERNAL UPLOAD
--                                                       (SPEC 2B.26–2B.30)
-- ===========================================================================

-- --- 2B.26  dam_saved_searches ----------------------------------------------

create unique index dam_saved_searches_owner_lower_name_key
  on dam_saved_searches (owner_id, lower(name))
  where deleted_at is null;

-- "My searches", most recently touched first.
create index dam_saved_searches_owner_idx
  on dam_saved_searches (owner_id, updated_at desc)
  where deleted_at is null;

-- The pinned rail in the sidebar, sorted by name (the spec says "sort by
-- name", which is this).
create index dam_saved_searches_pinned_idx
  on dam_saved_searches (owner_id, name)
  where pinned and deleted_at is null;

-- The shared and company-visible search lists.
create index dam_saved_searches_shared_idx
  on dam_saved_searches (visibility, name)
  where visibility <> 'personal' and deleted_at is null;

-- The scan of the alert job.
create index dam_saved_searches_notify_idx
  on dam_saved_searches (last_notified_at)
  where notify_on_new and deleted_at is null;

-- --- 2B.27  dam_share_links -------------------------------------------------
-- The plain unique (token_hash) over all rows is a table constraint, and a
-- share is resolved by exact hash in a single row — no further index on it.

-- The "my shares" list.
create index dam_share_links_created_by_idx
  on dam_share_links (created_by, created_at desc)
  where deleted_at is null;

create index dam_share_links_album_id_idx
  on dam_share_links (album_id)
  where album_id is not null and deleted_at is null;

-- Rights revocation (2B.23) has to find every live share of an asset.
create index dam_share_links_asset_id_idx
  on dam_share_links (asset_id)
  where asset_id is not null and deleted_at is null;

-- The expiry sweep.
create index dam_share_links_expires_at_idx
  on dam_share_links (expires_at)
  where revoked_at is null and expires_at is not null;

-- Support lookup: the operator reads the prefix off the link, never the hash.
create index dam_share_links_token_prefix_idx
  on dam_share_links (token_prefix);

-- FK index (added, not in the spec list): dam_share_links.saved_search_id →
-- dam_saved_searches; a `search`-scope share cites the saved search, and
-- deleting one must find its shares.
create index dam_share_links_saved_search_id_idx
  on dam_share_links (saved_search_id)
  where saved_search_id is not null;

-- FK index (added, not in the spec list): dam_share_links.max_size_id →
-- dam_sizes. Retiring a download preset probes the full share table.
create index dam_share_links_max_size_id_idx
  on dam_share_links (max_size_id)
  where max_size_id is not null;

-- --- 2B.28  dam_share_link_items --------------------------------------------
-- [D-294] No uniqueness on sort_order, as 2B.16.

create unique index dam_share_link_items_link_asset_key
  on dam_share_link_items (share_link_id, asset_id)
  where deleted_at is null;

-- The share, in order.
create index dam_share_link_items_link_sort_idx
  on dam_share_link_items (share_link_id, sort_order)
  where deleted_at is null;

-- Rights revocation and the asset trash cascade.
create index dam_share_link_items_asset_id_idx
  on dam_share_link_items (asset_id)
  where deleted_at is null;

-- --- 2B.29  dam_upload_requests ---------------------------------------------
-- The plain unique (token_hash) over all rows is a table constraint.

create index dam_upload_requests_project_id_idx
  on dam_upload_requests (project_id)
  where deleted_at is null;

create index dam_upload_requests_created_by_idx
  on dam_upload_requests (created_by, created_at desc)
  where deleted_at is null;

-- The expiry job.
create index dam_upload_requests_status_expires_idx
  on dam_upload_requests (expires_at)
  where status = 'open' and deleted_at is null;

create index dam_upload_requests_token_prefix_idx
  on dam_upload_requests (token_prefix);

-- FK indexes (added, not in the spec list): the four defaults an upload
-- request carries, each pointing at a parent that can be retired —
-- category_id → dam_categories, studio_id → dam_studios,
-- storage_location_id → dam_storage_locations,
-- ingest_batch_id → dam_ingest_batches.
create index dam_upload_requests_category_id_idx
  on dam_upload_requests (category_id)
  where category_id is not null;

create index dam_upload_requests_studio_id_idx
  on dam_upload_requests (studio_id)
  where studio_id is not null;

create index dam_upload_requests_storage_location_id_idx
  on dam_upload_requests (storage_location_id)
  where storage_location_id is not null;

create index dam_upload_requests_ingest_batch_id_idx
  on dam_upload_requests (ingest_batch_id)
  where ingest_batch_id is not null;

-- --- 2B.30  dam_upload_request_files ----------------------------------------

-- A resend is the same row.
create unique index dam_upload_request_files_request_sha_key
  on dam_upload_request_files (upload_request_id, sha256)
  where sha256 is not null and deleted_at is null;

-- A deposited file becomes at most one asset.
create unique index dam_upload_request_files_asset_id_key
  on dam_upload_request_files (asset_id)
  where asset_id is not null;

-- The request's manifest, in arrival order.
create index dam_upload_request_files_request_idx
  on dam_upload_request_files (upload_request_id, created_at)
  where deleted_at is null;

-- The stuck-transfer sweep.
create index dam_upload_request_files_status_idx
  on dam_upload_request_files (status)
  where status in ('pending', 'received') and deleted_at is null;

-- Named separately by the spec. It overlaps the partial unique above, which
-- covers every non-null asset_id; this one also carries the nulls, so the
-- asset purge cascade can use it without evaluating the predicate.
create index dam_upload_request_files_asset_id_idx
  on dam_upload_request_files (asset_id);

-- FK index (added, not in the spec list):
-- dam_upload_request_files.version_id → dam_asset_versions.
create index dam_upload_request_files_version_id_idx
  on dam_upload_request_files (version_id)
  where version_id is not null;


-- ===========================================================================
-- SUPPORTING / COLLABORATION — comments, review decisions, notifications,
--                              ratings, favourites      (SPEC 2B.31–2B.35)
-- ===========================================================================

-- --- 2B.31  dam_comments ----------------------------------------------------

-- The comment panel on a record.
create index dam_comments_target_idx
  on dam_comments (target_type, target_id, created_at desc)
  where deleted_at is null;

-- One thread, oldest first.
create index dam_comments_thread_idx
  on dam_comments (thread_root_id, created_at)
  where deleted_at is null;

-- "Comments that mention me".
create index dam_comments_mentions_idx
  on dam_comments using gin (mentions);

-- The unresolved badge: root comments only, still open.
create index dam_comments_open_idx
  on dam_comments (target_type, target_id)
  where parent_comment_id is null and not is_resolved and deleted_at is null;

create index dam_comments_created_by_idx
  on dam_comments (created_by, created_at desc);

-- FK index (added, not in the spec list): the self-pointer
-- dam_comments.parent_comment_id. dam_comments_open_idx mentions the column
-- only in its predicate, which does not index it, and the reply cascade needs
-- it.
create index dam_comments_parent_comment_id_idx
  on dam_comments (parent_comment_id)
  where parent_comment_id is not null;

-- FK index (added, not in the spec list): dam_comments.asset_version_id →
-- dam_asset_versions; an annotation is pinned to the version it was drawn on.
create index dam_comments_asset_version_id_idx
  on dam_comments (asset_version_id)
  where asset_version_id is not null;

-- --- 2B.32  dam_review_decisions --------------------------------------------

-- One current decision per target; the history rows keep is_current false.
create unique index dam_review_decisions_current_key
  on dam_review_decisions (target_type, target_id)
  where is_current and deleted_at is null;

-- The history panel.
create index dam_review_decisions_target_idx
  on dam_review_decisions (target_type, target_id, decided_at desc)
  where deleted_at is null;

create index dam_review_decisions_created_by_idx
  on dam_review_decisions (created_by, decided_at desc);

-- The "waiting on the uploader" list.
create index dam_review_decisions_queue_idx
  on dam_review_decisions (decided_at)
  where decision = 'changes_requested' and is_current and deleted_at is null;

-- FK indexes (added, not in the spec list):
-- dam_review_decisions.asset_version_id → dam_asset_versions and
-- .comment_id → dam_comments.
create index dam_review_decisions_asset_version_id_idx
  on dam_review_decisions (asset_version_id)
  where asset_version_id is not null;

create index dam_review_decisions_comment_id_idx
  on dam_review_decisions (comment_id)
  where comment_id is not null;

-- --- 2B.33  dam_notifications -----------------------------------------------

-- Collapse repeats into one unread row: a second identical event bumps
-- occurrence_count instead of adding a line to the bell. Read rows are
-- excluded, so the same notification can recur after it has been seen.
create unique index dam_notifications_user_dedupe_key
  on dam_notifications (user_id, dedupe_key)
  where dedupe_key is not null and read_at is null and deleted_at is null;

-- The bell.
create index dam_notifications_user_unread_idx
  on dam_notifications (user_id, created_at desc)
  where read_at is null and deleted_at is null;

-- The full list.
create index dam_notifications_user_created_idx
  on dam_notifications (user_id, created_at desc)
  where deleted_at is null;

-- The scan of the digest job.
create index dam_notifications_digest_idx
  on dam_notifications (user_id)
  where digest_state = 'pending' and deleted_at is null;

-- The pruner.
create index dam_notifications_expires_at_idx
  on dam_notifications (expires_at)
  where deleted_at is null;

-- --- 2B.34  dam_ratings -----------------------------------------------------
-- The plain unique (asset_id, user_id) over all rows is a table constraint: a
-- user who re-rates updates their row.

-- "My ratings".
create index dam_ratings_user_id_idx
  on dam_ratings (user_id, updated_at desc)
  where deleted_at is null;

-- The aggregate recompute that writes dam_assets.rating_avg.
create index dam_ratings_asset_id_idx
  on dam_ratings (asset_id)
  where deleted_at is null;

-- --- 2B.35  dam_favourites --------------------------------------------------
-- The plain unique (user_id, target_type, target_id) over all rows is a table
-- constraint: re-favouriting restores the row and its note.

-- The favourites panel.
create index dam_favourites_user_idx
  on dam_favourites (user_id, target_type, sort_order)
  where deleted_at is null;

-- The "N people favourited this" count, which is only ever shown as a count.
create index dam_favourites_target_idx
  on dam_favourites (target_type, target_id)
  where deleted_at is null;


-- ===========================================================================
-- SUPPORTING / LOGS — audit, usage and search, all partitioned by month
--                                                       (SPEC 2B.36–2B.38)
-- ===========================================================================
-- [D-329] Each index below is created on the PARENT, so every existing child
-- gets it and every child that `dam_create_monthly_partitions()` adds later
-- inherits it automatically. None of these tables has a foreign key at all —
-- a log row outlives the row it describes — so there is nothing here to index
-- for a cascade, only for the reports.

-- --- 2B.36  dam_audit_log ---------------------------------------------------

-- The per-row history panel.
create index dam_audit_log_table_row_idx
  on dam_audit_log (table_name, row_id, occurred_at desc);

-- "What did this person do" — the per-user activity feed (brief §4.4).
create index dam_audit_log_actor_idx
  on dam_audit_log (actor_id, occurred_at desc);

-- The permission-change and download reports.
create index dam_audit_log_action_idx
  on dam_audit_log (action, occurred_at desc);

-- Support lookups by request id.
create index dam_audit_log_request_id_idx
  on dam_audit_log (request_id)
  where request_id is not null;

-- --- 2B.37  dam_usage_events ------------------------------------------------

-- The per-asset usage log.
create index dam_usage_events_asset_idx
  on dam_usage_events (asset_id, occurred_at desc);

-- Most-downloaded and most-viewed.
create index dam_usage_events_event_idx
  on dam_usage_events (event, occurred_at desc);

-- The per-user activity feed.
create index dam_usage_events_user_idx
  on dam_usage_events (user_id, occurred_at desc)
  where user_id is not null;

-- Share analytics.
create index dam_usage_events_share_idx
  on dam_usage_events (share_link_id, occurred_at desc)
  where share_link_id is not null;

-- The studio dashboards.
create index dam_usage_events_studio_idx
  on dam_usage_events (studio_id, occurred_at desc)
  where studio_id is not null;

create index dam_usage_events_project_idx
  on dam_usage_events (project_id, occurred_at desc)
  where project_id is not null;

-- --- 2B.38  dam_search_log --------------------------------------------------

-- Top terms.
create index dam_search_log_normalised_idx
  on dam_search_log (query_normalised, occurred_at desc)
  where query_normalised is not null;

-- The zero-result report — the one the taxonomy admin actually opens.
create index dam_search_log_zero_idx
  on dam_search_log (query_normalised, occurred_at desc)
  where is_zero_result and query_normalised is not null;

-- "Recent searches" in the UI.
create index dam_search_log_user_idx
  on dam_search_log (user_id, occurred_at desc)
  where user_id is not null;

-- Mode comparison.
create index dam_search_log_mode_idx
  on dam_search_log (search_mode, occurred_at desc);

-- Latency percentiles.
create index dam_search_log_took_ms_idx
  on dam_search_log (occurred_at desc, took_ms);


-- ===========================================================================
-- SUPPORTING / JOBS                                            (SPEC 2B.39)
-- ===========================================================================

-- --- 2B.39  dam_jobs --------------------------------------------------------

-- [D-333] One live job per idempotency key. Finished jobs drop out of the
-- predicate, so the same key may be enqueued again once its predecessor has
-- ended — which is what makes a retry safe and a double-submit a no-op.
create unique index dam_jobs_idempotency_key_active_key
  on dam_jobs (idempotency_key)
  where idempotency_key is not null and status in ('queued', 'running');

-- The only index the claim query needs, and it is the hot one: every worker
-- poll is an index-only scan of the head of this index.
create index dam_jobs_claim_idx
  on dam_jobs (queue, priority, run_after, created_at)
  where status = 'queued';

-- The reclaimer: jobs whose lock has lapsed.
create index dam_jobs_lock_expiry_idx
  on dam_jobs (lock_expires_at)
  where status = 'running';

-- Work outstanding for one asset.
create index dam_jobs_asset_id_idx
  on dam_jobs (asset_id)
  where status in ('queued', 'running');

create index dam_jobs_root_job_id_idx
  on dam_jobs (root_job_id);

-- The admin queue view.
create index dam_jobs_kind_status_idx
  on dam_jobs (kind, status, created_at desc);

-- The dead-letter list.
create index dam_jobs_dead_idx
  on dam_jobs (finished_at desc)
  where status = 'dead';

-- FK index (added, not in the spec list): the self-pointer
-- dam_jobs.parent_job_id, `on delete set null`. root_job_id already has one.
create index dam_jobs_parent_job_id_idx
  on dam_jobs (parent_job_id)
  where parent_job_id is not null;

-- FK index (added, not in the spec list): dam_jobs.asset_id is
-- `on delete cascade`, and dam_jobs_asset_id_idx above is partial on status,
-- so the cascade cannot use it. This unrestricted copy is what an asset purge
-- probes.
create index dam_jobs_asset_id_all_idx
  on dam_jobs (asset_id)
  where asset_id is not null;

-- FK indexes (added, not in the spec list): dam_jobs.project_id and
-- dam_jobs.version_id, both `on delete cascade`.
create index dam_jobs_project_id_idx
  on dam_jobs (project_id)
  where project_id is not null;

create index dam_jobs_version_id_idx
  on dam_jobs (version_id)
  where version_id is not null;


-- ===========================================================================
-- SUPPORTING / WEBHOOKS                                  (SPEC 2B.40–2B.41)
-- ===========================================================================

-- --- 2B.40  dam_webhooks ----------------------------------------------------

create unique index dam_webhooks_lower_name_key
  on dam_webhooks (lower(name))
  where deleted_at is null;

-- The same URL twice for the same events is always a mistake. The event list
-- is an array, which btree orders element-wise, so two subscriptions to the
-- same set in the same order collide and a genuinely different set does not.
create unique index dam_webhooks_url_events_key
  on dam_webhooks (url, events)
  where deleted_at is null;

-- The fan-out query in dam_emit_webhook_event: which live subscriptions name
-- this event?
create index dam_webhooks_events_idx
  on dam_webhooks using gin (events)
  where is_active and deleted_at is null;

create index dam_webhooks_active_idx
  on dam_webhooks (is_active)
  where deleted_at is null;

-- --- 2B.41  dam_webhook_deliveries ------------------------------------------

-- The sender's scan: what is due to go out now?
create index dam_webhook_deliveries_due_idx
  on dam_webhook_deliveries (next_attempt_at)
  where status in ('pending', 'failed');

-- The per-subscription delivery list.
create index dam_webhook_deliveries_webhook_idx
  on dam_webhook_deliveries (webhook_id, created_at desc);

-- The dead-letter view.
create index dam_webhook_deliveries_dead_idx
  on dam_webhook_deliveries (created_at desc)
  where status = 'dead';

-- "What was sent about this record?"
create index dam_webhook_deliveries_target_idx
  on dam_webhook_deliveries (target_type, target_id, created_at desc);


-- ===========================================================================
-- SUPPORTING / INTEGRATIONS — connectors, field mappings, sync runs,
--                             conflicts and field shadows
--                                                      (SPEC 2B.42–2B.45a)
-- ===========================================================================

-- --- 2B.42  dam_integrations -----------------------------------------------

create unique index dam_integrations_lower_name_key
  on dam_integrations (lower(name))
  where deleted_at is null;

-- At most one active firm-wide connector per system. Studio-scoped connectors
-- (studio_id not null) are outside the predicate and may coexist with it.
create unique index dam_integrations_system_default_key
  on dam_integrations (system)
  where is_active and deleted_at is null and studio_id is null;

create index dam_integrations_system_idx
  on dam_integrations (system)
  where deleted_at is null;

-- The scheduler's next-due scan.
create index dam_integrations_next_run_idx
  on dam_integrations (next_run_at)
  where is_active and deleted_at is null;

-- FK index (added, not in the spec list): dam_integrations.studio_id →
-- dam_studios; the partial unique above leads with `system`, not studio_id.
create index dam_integrations_studio_id_idx
  on dam_integrations (studio_id)
  where studio_id is not null;

-- --- 2B.43  dam_integration_field_mappings ----------------------------------

-- One mapping per target per connector. A target is either a plain column or
-- a custom field (table CHECK), and both are coalesced to a sentinel so that
-- the unused half of the pair does not turn the whole key into a null.
create unique index dam_integration_field_mappings_unique_target_key
  on dam_integration_field_mappings (
    integration_id,
    object_type,
    target_table,
    coalesce(target_column, ''),
    coalesce(target_field_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where deleted_at is null;

create index dam_integration_field_mappings_integration_idx
  on dam_integration_field_mappings (integration_id, object_type, sort_order)
  where deleted_at is null;

-- "Is this field read-only for me?" — asked on every form render, which is
-- why it is its own index rather than a filter over the previous one.
create index dam_integration_field_mappings_sot_idx
  on dam_integration_field_mappings (target_table, target_column)
  where is_source_of_truth and is_active and deleted_at is null;

-- FK index (added, not in the spec list):
-- dam_integration_field_mappings.target_field_id → dam_fields; retiring a
-- custom field must find the mappings that write it.
create index dam_integration_field_mappings_target_field_id_idx
  on dam_integration_field_mappings (target_field_id)
  where target_field_id is not null;

-- --- 2B.44  dam_sync_runs ---------------------------------------------------

-- A connector never runs twice at once, which is what makes the cursor safe.
create unique index dam_sync_runs_one_running_key
  on dam_sync_runs (integration_id)
  where status = 'running' and deleted_at is null;

-- The run list.
create index dam_sync_runs_integration_idx
  on dam_sync_runs (integration_id, started_at desc);

-- The failures dashboard.
create index dam_sync_runs_status_idx
  on dam_sync_runs (status, started_at desc)
  where status in ('failed', 'partial');

-- FK index (added, not in the spec list): dam_sync_runs.job_id → dam_jobs.
create index dam_sync_runs_job_id_idx
  on dam_sync_runs (job_id)
  where job_id is not null;

-- --- 2B.45  dam_sync_conflicts ----------------------------------------------

-- A nightly run re-raising the same conflict updates the open row instead of
-- adding a hundredth copy. Three nullable parts of the identity are coalesced
-- for the same reason as everywhere else in this file.
create unique index dam_sync_conflicts_open_key
  on dam_sync_conflicts (
    integration_id,
    target_table,
    coalesce(target_row_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(target_field, ''),
    coalesce(external_id, '')
  )
  where status = 'open' and deleted_at is null;

-- The badge and the queue.
create index dam_sync_conflicts_open_idx
  on dam_sync_conflicts (integration_id, created_at desc)
  where status = 'open' and deleted_at is null;

create index dam_sync_conflicts_run_idx
  on dam_sync_conflicts (sync_run_id);

-- The "this field is disputed" marker on the record's own page.
create index dam_sync_conflicts_target_idx
  on dam_sync_conflicts (target_table, target_row_id)
  where status = 'open';

-- FK index (added, not in the spec list):
-- dam_sync_conflicts.field_mapping_id → dam_integration_field_mappings.
create index dam_sync_conflicts_field_mapping_id_idx
  on dam_sync_conflicts (field_mapping_id)
  where field_mapping_id is not null;

-- --- 2B.45a  dam_sync_field_state -------------------------------------------

-- One shadow per field, whatever the connector.
create unique index dam_sync_field_state_target_key
  on dam_sync_field_state (target_table, target_row_id, target_field)
  where deleted_at is null;

-- The read-only lookup on a form render.
create index dam_sync_field_state_target_idx
  on dam_sync_field_state (target_table, target_row_id)
  where deleted_at is null;

-- The "fields no longer following the source" report.
create index dam_sync_field_state_detached_idx
  on dam_sync_field_state (integration_id)
  where is_detached and deleted_at is null;

-- FK index (added, not in the spec list):
-- dam_sync_field_state.field_mapping_id → dam_integration_field_mappings.
create index dam_sync_field_state_field_mapping_id_idx
  on dam_sync_field_state (field_mapping_id)
  where field_mapping_id is not null;


-- ===========================================================================
-- SUPPORTING / DOCUMENTS — templates, their versions, generated output
--                                                       (SPEC 2B.46–2B.48)
-- ===========================================================================

-- --- 2B.46  dam_templates ---------------------------------------------------
-- The plain unique (slug) is a table constraint.

create unique index dam_templates_lower_name_key
  on dam_templates (lower(name))
  where deleted_at is null;

-- The template picker.
create index dam_templates_kind_idx
  on dam_templates (kind, sort_order)
  where is_active and deleted_at is null;

-- The "Generate…" menu on a project or an employee.
create index dam_templates_subject_idx
  on dam_templates (subject_type)
  where is_active and deleted_at is null;

create index dam_templates_studio_id_idx
  on dam_templates (studio_id)
  where deleted_at is null;

-- --- 2B.47  dam_template_versions -------------------------------------------
-- The plain unique (template_id, version_no) is a table constraint.

-- The history view, newest first.
create index dam_template_versions_template_idx
  on dam_template_versions (template_id, version_no desc);

-- The template review queue.
create index dam_template_versions_review_idx
  on dam_template_versions (submitted_at)
  where state = 'in_review' and deleted_at is null;

-- An uploaded template file is itself a library asset.
create index dam_template_versions_source_asset_idx
  on dam_template_versions (source_asset_id);

-- FK index (added, not in the spec list):
-- dam_template_versions.preview_asset_id → dam_assets, the rendered preview.
create index dam_template_versions_preview_asset_id_idx
  on dam_template_versions (preview_asset_id)
  where preview_asset_id is not null;

-- --- 2B.48  dam_generated_documents -----------------------------------------

-- "Documents for this project".
create index dam_generated_documents_subject_idx
  on dam_generated_documents (subject_type, subject_id, created_at desc)
  where deleted_at is null;

create index dam_generated_documents_template_idx
  on dam_generated_documents (template_id, created_at desc)
  where deleted_at is null;

-- "My documents".
create index dam_generated_documents_created_by_idx
  on dam_generated_documents (created_by, created_at desc)
  where deleted_at is null;

-- The pruner. A pinned document never expires, so it is out of the predicate.
create index dam_generated_documents_expiry_idx
  on dam_generated_documents (expires_at)
  where expires_at is not null and not is_pinned and deleted_at is null;

-- "Which documents used this text block version?" — the question asked when
-- approved copy turns out to be wrong.
create index dam_generated_documents_inputs_idx
  on dam_generated_documents using gin (inputs jsonb_path_ops);

-- FK indexes (added, not in the spec list). This table grows without bound —
-- one row per generated deck, CV or fact sheet — so every parent that can be
-- deleted or joined from needs its child index here:
-- template_version_id → dam_template_versions (which version produced it),
-- output_asset_id → dam_assets, storage_location_id → dam_storage_locations,
-- job_id → dam_jobs, the self-pointer regenerated_from_id, and
-- share_link_id → dam_share_links.
create index dam_generated_documents_template_version_id_idx
  on dam_generated_documents (template_version_id)
  where template_version_id is not null;

create index dam_generated_documents_output_asset_id_idx
  on dam_generated_documents (output_asset_id)
  where output_asset_id is not null;

create index dam_generated_documents_storage_location_id_idx
  on dam_generated_documents (storage_location_id)
  where storage_location_id is not null;

create index dam_generated_documents_job_id_idx
  on dam_generated_documents (job_id)
  where job_id is not null;

create index dam_generated_documents_regenerated_from_id_idx
  on dam_generated_documents (regenerated_from_id)
  where regenerated_from_id is not null;

create index dam_generated_documents_share_link_id_idx
  on dam_generated_documents (share_link_id)
  where share_link_id is not null;


-- ===========================================================================
-- SUPPORTING / AI — suggestions and the runs that produced them
--                                                       (SPEC 2B.49–2B.50)
-- ===========================================================================

-- --- 2B.49  dam_ai_suggestions ----------------------------------------------

-- Re-running auto-tag updates the confidence of an open suggestion instead of
-- creating a second one. A suggestion is identified either by the keyword it
-- proposes or by its raw label, so both are coalesced into the key.
create unique index dam_ai_suggestions_open_key
  on dam_ai_suggestions (
    target_type,
    target_id,
    kind,
    coalesce(keyword_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(lower(raw_label), '')
  )
  where state = 'suggested' and deleted_at is null;

-- The review panel on an asset.
create index dam_ai_suggestions_queue_idx
  on dam_ai_suggestions (target_type, target_id, kind, rank)
  where state = 'suggested' and deleted_at is null;

-- The firm-wide review queue, highest confidence first.
create index dam_ai_suggestions_review_idx
  on dam_ai_suggestions (kind, confidence desc, created_at)
  where state = 'suggested' and deleted_at is null;

create index dam_ai_suggestions_expiry_idx
  on dam_ai_suggestions (expires_at)
  where state = 'suggested' and deleted_at is null;

create index dam_ai_suggestions_run_idx
  on dam_ai_suggestions (ai_run_id);

-- "Which suggestions would this keyword's deletion orphan?"
create index dam_ai_suggestions_keyword_id_idx
  on dam_ai_suggestions (keyword_id)
  where state = 'suggested' and deleted_at is null;

-- --- 2B.50  dam_ai_runs -----------------------------------------------------

-- Spend per task.
create index dam_ai_runs_task_started_idx
  on dam_ai_runs (task, started_at desc);

-- Spend and latency per model — the input to "is the cheaper tier good
-- enough".
create index dam_ai_runs_model_started_idx
  on dam_ai_runs (provider, model, started_at desc);

-- "What did we spend on this asset".
create index dam_ai_runs_asset_id_idx
  on dam_ai_runs (asset_id, started_at desc)
  where asset_id is not null;

-- The failure board.
create index dam_ai_runs_status_idx
  on dam_ai_runs (status, started_at desc)
  where status <> 'succeeded';

create index dam_ai_runs_batch_idx
  on dam_ai_runs (batch_id)
  where batch_id is not null;

-- Deliberately NOT unique: an identical request may legitimately run again
-- after a model change.
create index dam_ai_runs_request_hash_idx
  on dam_ai_runs (request_hash)
  where request_hash is not null;


-- ===========================================================================
-- SUPPORTING / ADMIN — retention, tiering, settings      (SPEC 2B.51–2B.53)
-- ===========================================================================

-- --- 2B.51  dam_retention_policies ------------------------------------------

-- One policy per (target, category, studio) scope. NULLS NOT DISTINCT so the
-- firm-wide policy for a target — both scope columns null — is itself unique.
create unique index dam_retention_policies_scope_key
  on dam_retention_policies (target, category_id, studio_id)
  nulls not distinct
  where deleted_at is null;

-- The purge job's only read.
create index dam_retention_policies_target_idx
  on dam_retention_policies (target)
  where is_active and deleted_at is null;

-- --- 2B.52  dam_tiering_rules -----------------------------------------------

create unique index dam_tiering_rules_lower_name_key
  on dam_tiering_rules (lower(name))
  where deleted_at is null;

-- The tiering sweep, in priority order.
create index dam_tiering_rules_active_idx
  on dam_tiering_rules (priority, name)
  where is_active and deleted_at is null;

-- --- 2B.53  dam_settings ----------------------------------------------------
-- The plain unique (key) over all rows is a table constraint, and it is the
-- lookup: dam_setting() reads by key. Nothing else — the table is tens of rows
-- and is read through a cached function.

-- The admin settings page, grouped and ordered.
create index dam_settings_group_idx
  on dam_settings (group_name, key)
  where deleted_at is null;


-- ===========================================================================
-- SECTION 4 — Row-level security, triggers and reference data
-- ===========================================================================
-- Implements SPEC part 3 §3.7 (policy classes A–K), §3.7.3 (soft delete and
-- trash) and §3.7.4 (why ENABLE rather than FORCE).
--
-- The rules this file encodes, stated once:
--
--   * Deny by default. Row-level security is enabled on every table. A command
--     with no policy is denied — that is the mechanism, not an oversight, and
--     several tables deliberately have no insert/update/delete policy because
--     only the worker (service_role) or a trigger may write them.
--   * Every select policy for a user filters `deleted_at is null`. Trashed rows
--     are visible only through the matching `_select_trash` policy, which is
--     restricted to the studio administrators of the row's studio and above.
--   * Policies call the STABLE SECURITY DEFINER predicates defined in
--     00-preamble.sql. They never inline a join, so a policy change is one
--     function change rather than eighty policy rewrites.
--   * ENABLE, not FORCE (§3.7.4): the migration role owns these tables and must
--     seed, backfill and repair without a JWT, and Supabase's service_role
--     bypasses row-level security by design for the worker.
--   * The hot search path does NOT rely on per-row policy evaluation; it goes
--     through the set-based RPC in §3.7.6. The policies here are defence in
--     depth for that table.
--
-- Naming: policies are `dam_<table>_<cmd>_<who>`; triggers `trg_<table>_<purpose>`.
-- ===========================================================================


-- ===========================================================================
-- A. Enable row-level security on every table
-- ===========================================================================
-- Listed explicitly rather than generated from the catalogue: a wildcard would
-- silently pick up a table added later that nobody had thought about, which is
-- precisely the table most likely to need a considered policy.

-- Core: projects, assets, taxonomy, fields, storage
alter table dam_studios                    enable row level security;
alter table dam_clients                    enable row level security;
alter table dam_projects                   enable row level security;
alter table dam_project_aliases            enable row level security;
alter table dam_project_studios            enable row level security;
alter table dam_project_assets             enable row level security;
alter table dam_categories                 enable row level security;
alter table dam_keyword_categories         enable row level security;
alter table dam_keywords                   enable row level security;
alter table dam_keyword_aliases            enable row level security;
alter table dam_keyword_links              enable row level security;
alter table dam_category_keyword_categories enable row level security;
alter table dam_field_categories           enable row level security;
alter table dam_fields                     enable row level security;
alter table dam_field_options              enable row level security;
alter table dam_category_fields            enable row level security;
alter table dam_field_values               enable row level security;
alter table dam_storage_locations          enable row level security;
alter table dam_assets                     enable row level security;
alter table dam_asset_versions             enable row level security;
alter table dam_derivatives                enable row level security;
alter table dam_render_cache               enable row level security;
alter table dam_asset_crops                enable row level security;
alter table dam_asset_search               enable row level security;
alter table dam_asset_embeddings           enable row level security;
alter table dam_asset_ocr_text             enable row level security;
alter table dam_asset_duplicates           enable row level security;
alter table dam_ingest_sources             enable row level security;
alter table dam_ingest_batches             enable row level security;
alter table dam_ingest_batch_files         enable row level security;
alter table dam_external_ids               enable row level security;

-- Supporting: people, collections, rights, output, governance, integration
alter table dam_users                      enable row level security;
alter table dam_groups                     enable row level security;
alter table dam_group_members              enable row level security;
alter table dam_user_studios               enable row level security;
alter table dam_access_levels              enable row level security;
alter table dam_access_grants              enable row level security;
alter table dam_api_keys                   enable row level security;
alter table dam_employees                  enable row level security;
alter table dam_employee_bios              enable row level security;
alter table dam_employee_headshots         enable row level security;
alter table dam_employee_education         enable row level security;
alter table dam_employee_registrations     enable row level security;
alter table dam_employee_languages         enable row level security;
alter table dam_project_employees          enable row level security;
alter table dam_albums                     enable row level security;
alter table dam_album_items                enable row level security;
alter table dam_album_collaborators        enable row level security;
alter table dam_text_blocks                enable row level security;
alter table dam_text_block_versions        enable row level security;
alter table dam_photographers              enable row level security;
alter table dam_copyright_holders          enable row level security;
alter table dam_copyright_policies         enable row level security;
alter table dam_asset_rights               enable row level security;
alter table dam_sizes                      enable row level security;
alter table dam_aspect_ratios              enable row level security;
alter table dam_saved_searches             enable row level security;
alter table dam_share_links                enable row level security;
alter table dam_share_link_items           enable row level security;
alter table dam_upload_requests            enable row level security;
alter table dam_upload_request_files       enable row level security;
alter table dam_comments                   enable row level security;
alter table dam_review_decisions           enable row level security;
alter table dam_notifications              enable row level security;
alter table dam_ratings                    enable row level security;
alter table dam_favourites                 enable row level security;
alter table dam_audit_log                  enable row level security;
alter table dam_usage_events               enable row level security;
alter table dam_search_log                 enable row level security;
alter table dam_jobs                       enable row level security;
alter table dam_webhooks                   enable row level security;
alter table dam_webhook_deliveries         enable row level security;
alter table dam_integrations               enable row level security;
alter table dam_integration_field_mappings enable row level security;
alter table dam_sync_runs                  enable row level security;
alter table dam_sync_conflicts             enable row level security;
alter table dam_sync_field_state           enable row level security;
alter table dam_templates                  enable row level security;
alter table dam_template_versions          enable row level security;
alter table dam_generated_documents        enable row level security;
alter table dam_ai_suggestions             enable row level security;
alter table dam_ai_runs                    enable row level security;
alter table dam_retention_policies         enable row level security;
alter table dam_tiering_rules              enable row level security;
alter table dam_settings                   enable row level security;

-- Partition children of the three log tables.
--
-- ROW-LEVEL SECURITY IS NOT INHERITED. `create table ... partition of` does not
-- copy the parent's rowsecurity flag, so without these twelve lines every row
-- of the audit trail, the usage events and the search log is readable by any
-- authenticated user who names the child directly —
-- `select * from dam_audit_log_y2026m09` — while `select * from dam_audit_log`
-- is correctly filtered. The parent's policies would be a fence with a gate
-- beside it.
--
-- The children carry no policies of their own, and must not: Postgres applies
-- the policies of the relation NAMED in the query, so a read through the parent
-- is governed by the parent's policies regardless of which partition supplies
-- the row. Enabling row-level security here with no policy attached is what
-- makes the child unreadable when named directly, which is the whole intent.
--
-- The partition-creation job (SPEC §6.8, the monthly pg_cron task) must repeat
-- this line for each partition it creates. A partition made without it is a
-- hole that opens silently, which is why the job asserts `relrowsecurity` on
-- the child it just made and fails loudly if it is false.
alter table dam_audit_log_default          enable row level security;
alter table dam_audit_log_y2026m09         enable row level security;
alter table dam_audit_log_y2026m10         enable row level security;
alter table dam_audit_log_y2026m11         enable row level security;
alter table dam_usage_events_default       enable row level security;
alter table dam_usage_events_y2026m09      enable row level security;
alter table dam_usage_events_y2026m10      enable row level security;
alter table dam_usage_events_y2026m11      enable row level security;
alter table dam_search_log_default         enable row level security;
alter table dam_search_log_y2026m09        enable row level security;
alter table dam_search_log_y2026m10        enable row level security;
alter table dam_search_log_y2026m11        enable row level security;

-- Anonymous visitors never reach a table directly. Share links and upload
-- requests are served exclusively by SECURITY DEFINER RPCs (SPEC §3.9), so the
-- anonymous role keeps no privileges on anything this schema creates.
--
-- SCOPED TO `dam_` OBJECTS ON PURPOSE. The obvious form of this is
-- `revoke all on all tables in schema public from anon`, and it is wrong here:
-- it would also strip the anonymous role's access to every OTHER application
-- sharing this database. The existing internal DAM keeps `common_dam_assets`,
-- `common_dam_taxonomy`, `common_dam_presets` and `common_dam_drive_sync` in
-- this same schema, reads and writes them with the anon key, and runs with
-- row-level security switched off; a schema-wide revoke would break every one
-- of its reads and writes the moment this file was applied. This file has to be
-- safe to run against a database that is not empty.
--
-- Two consequences worth knowing:
--   * Supabase grants new tables to `anon` by default, so a later migration
--     that adds a `dam_` table must repeat this revoke for that table.
--   * The RPCs that serve share links and upload requests are the deliberate
--     exception (D-376): the migration that creates them grants EXECUTE back to
--     `anon` on those functions alone, which is how an anonymous visitor opens
--     a share without ever touching a table.
do $$
declare
  obj record;
begin
  -- The backslash is LIKE's escape character, so 'dam\_%' matches a literal
  -- underscore and cannot widen to something merely starting with "dam".
  for obj in
    select format('%I.%I', schemaname, tablename) as ident
      from pg_tables
     where schemaname = 'public'
       and tablename like 'dam\_%'
  loop
    execute format('revoke all on table %s from anon', obj.ident);
  end loop;

  for obj in
    select format('%I.%I', sequence_schema, sequence_name) as ident
      from information_schema.sequences
     where sequence_schema = 'public'
       and sequence_name like 'dam\_%'
  loop
    execute format('revoke all on sequence %s from anon', obj.ident);
  end loop;

  for obj in
    select format('%I.%I(%s)', n.nspname, p.proname,
                  pg_get_function_identity_arguments(p.oid)) as ident
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like 'dam\_%'
  loop
    -- REVOKE FROM PUBLIC, NOT JUST FROM anon. Postgres grants EXECUTE on every
    -- new function to PUBLIC automatically, and `anon` is a member of PUBLIC
    -- like every other role, so revoking from `anon` alone removes a grant it
    -- never held and leaves the inherited one untouched — the anonymous role
    -- would still be able to call dam_is_global_admin(), dam_can_read_asset()
    -- and every other helper in this file. Revoking from PUBLIC is what
    -- actually closes it, and it means the two roles that DO need these
    -- functions have to be named explicitly afterwards.
    --
    -- Still scoped to `dam\_%`, for the reason given above the table loop: a
    -- function belonging to another application in this schema is none of this
    -- file's business. Note this loop is strictly wider than the table one in
    -- WHO it affects (PUBLIC, not just anon) while being identically narrow in
    -- WHAT it affects.
    execute format('revoke all on function %s from public, anon', obj.ident);
    execute format('grant execute on function %s to authenticated, service_role', obj.ident);
  end loop;
end;
$$;


-- ===========================================================================
-- B. Class B — project-scoped tables
-- ===========================================================================
-- Read what you may read of the project; write what you may write of it. The
-- predicate is the same one the API uses, so the interface and the database
-- cannot drift apart.

create policy dam_projects_select_user on dam_projects
  for select to authenticated
  using (deleted_at is null and dam_can_read_project(id));

-- Trash: a studio administrator sees their own studio's deleted projects so
-- they can restore them; nobody else sees them at all (§3.7.3).
create policy dam_projects_select_trash on dam_projects
  for select to authenticated
  using (deleted_at is not null and dam_can_manage_studio(studio_id));

create policy dam_projects_insert_user on dam_projects
  for insert to authenticated
  with check (dam_is_at_least('editor'::dam_role) or dam_can_manage_studio(studio_id));

create policy dam_projects_update_user on dam_projects
  for update to authenticated
  using (dam_can_write_project(id))
  with check (dam_can_write_project(id));

-- No delete policy: rows are soft-deleted by an update, and the irreversible
-- purge is the worker's job (§3.7.3). This is true of nearly every table here.

create policy dam_project_aliases_select_user on dam_project_aliases
  for select to authenticated
  using (deleted_at is null and dam_can_read_project(project_id));
create policy dam_project_aliases_write_user on dam_project_aliases
  for all to authenticated
  using (dam_can_write_project(project_id))
  with check (dam_can_write_project(project_id));

create policy dam_project_studios_select_user on dam_project_studios
  for select to authenticated
  using (deleted_at is null and dam_can_read_project(project_id));
create policy dam_project_studios_write_user on dam_project_studios
  for all to authenticated
  using (dam_can_write_project(project_id))
  with check (dam_can_write_project(project_id));

-- Linking an asset to a project is a project act, but the caller must also be
-- allowed to see the asset — otherwise linking becomes a way to discover
-- assets you cannot read.
create policy dam_project_assets_select_user on dam_project_assets
  for select to authenticated
  using (deleted_at is null
         and dam_can_read_project(project_id)
         and dam_can_read_asset(asset_id));
create policy dam_project_assets_write_user on dam_project_assets
  for all to authenticated
  using (dam_can_write_project(project_id))
  with check (dam_can_write_project(project_id) and dam_can_read_asset(asset_id));

create policy dam_project_employees_select_user on dam_project_employees
  for select to authenticated
  using (deleted_at is null and dam_can_read_project(project_id));
create policy dam_project_employees_write_user on dam_project_employees
  for all to authenticated
  using (dam_can_write_project(project_id))
  with check (dam_can_write_project(project_id));


-- ===========================================================================
-- C. Class C — asset-scoped tables
-- ===========================================================================

create policy dam_assets_select_user on dam_assets
  for select to authenticated
  using (deleted_at is null and dam_can_read_asset(id));

create policy dam_assets_select_trash on dam_assets
  for select to authenticated
  using (deleted_at is not null
         and (dam_is_global_admin()
              or exists (select 1
                           from dam_project_assets pa
                           join dam_projects p on p.id = pa.project_id
                          where pa.asset_id = dam_assets.id
                            and dam_can_manage_studio(p.studio_id))));

-- A contributor may create assets; what they may then see is decided by the
-- read predicate, and an upload landing `pending` is the review queue (D-005).
create policy dam_assets_insert_user on dam_assets
  for insert to authenticated
  with check (dam_is_at_least('contributor'::dam_role));

create policy dam_assets_update_user on dam_assets
  for update to authenticated
  using (dam_can_write_asset(id))
  with check (dam_can_write_asset(id));

create policy dam_asset_versions_select_user on dam_asset_versions
  for select to authenticated
  using (deleted_at is null and dam_can_read_asset(asset_id));
create policy dam_asset_versions_insert_user on dam_asset_versions
  for insert to authenticated
  with check (dam_can_write_asset(asset_id));
-- Versions are immutable once written (SPEC 2.20, D-239); only the worker
-- (service_role) may amend extraction results, so there is no update policy.

create policy dam_derivatives_select_user on dam_derivatives
  for select to authenticated
  using (deleted_at is null and dam_can_read_asset(asset_id));
-- Derivatives are written only by the derivative jobs.

create policy dam_render_cache_select_user on dam_render_cache
  for select to authenticated
  using (deleted_at is null and dam_can_read_asset(asset_id));

create policy dam_asset_crops_select_user on dam_asset_crops
  for select to authenticated
  using (deleted_at is null and dam_can_read_asset(asset_id));
create policy dam_asset_crops_write_user on dam_asset_crops
  for all to authenticated
  using (dam_can_write_asset(asset_id))
  with check (dam_can_write_asset(asset_id));

create policy dam_asset_ocr_text_select_user on dam_asset_ocr_text
  for select to authenticated
  using (deleted_at is null and dam_can_read_asset(asset_id));

create policy dam_asset_embeddings_select_user on dam_asset_embeddings
  for select to authenticated
  using (deleted_at is null and dam_can_read_asset(asset_id));

create policy dam_asset_duplicates_select_user on dam_asset_duplicates
  for select to authenticated
  using (deleted_at is null
         and dam_can_read_asset(asset_id)
         and dam_can_read_asset(duplicate_asset_id));
-- Resolving a duplicate edits both assets, so it requires write on both.
create policy dam_asset_duplicates_update_user on dam_asset_duplicates
  for update to authenticated
  using (dam_can_write_asset(asset_id) and dam_can_write_asset(duplicate_asset_id))
  with check (dam_can_write_asset(asset_id) and dam_can_write_asset(duplicate_asset_id));

create policy dam_asset_rights_select_user on dam_asset_rights
  for select to authenticated
  using (deleted_at is null and dam_can_read_asset(asset_id));
-- Managing rights is an editor capability (matrix row 33), not merely asset
-- write: a contributor who uploaded a file may not clear it for publication.
create policy dam_asset_rights_write_user on dam_asset_rights
  for all to authenticated
  using (dam_can_read_asset(asset_id) and dam_is_at_least('editor'::dam_role))
  with check (dam_can_read_asset(asset_id) and dam_is_at_least('editor'::dam_role));


-- ===========================================================================
-- I. Class I — search row and render cache
-- ===========================================================================
-- Defence in depth only. The search path is the set-based RPC of §3.7.6, which
-- applies the same predicate to the whole result set in one pass; this policy
-- exists so that a direct read of the table cannot bypass it.

create policy dam_asset_search_select_user on dam_asset_search
  for select to authenticated
  using (deleted_at is null and dam_can_read_asset(asset_id));
-- Written only by triggers and the reindex job.


-- ===========================================================================
-- Polymorphic tables: keyword links, field values, external ids
-- ===========================================================================
-- The predicate depends on what the row points at, so each policy branches on
-- target_type. Keeping this in one place is why the link tables are polymorphic
-- rather than one table per target.

create policy dam_keyword_links_select_user on dam_keyword_links
  for select to authenticated
  using (deleted_at is null
         and case target_type
               when 'asset'    then dam_can_read_asset(target_id)
               when 'project'  then dam_can_read_project(target_id)
               when 'employee' then dam_can_read_employee(target_id)
               else false
             end);

create policy dam_keyword_links_write_user on dam_keyword_links
  for all to authenticated
  using (case target_type
           when 'asset'    then dam_can_write_asset(target_id)
           when 'project'  then dam_can_write_project(target_id)
           when 'employee' then dam_is_at_least('editor'::dam_role)
           else false
         end)
  with check (case target_type
                when 'asset'    then dam_can_write_asset(target_id)
                when 'project'  then dam_can_write_project(target_id)
                when 'employee' then dam_is_at_least('editor'::dam_role)
                else false
              end);

create policy dam_field_values_select_user on dam_field_values
  for select to authenticated
  using (deleted_at is null
         and case target_type
               when 'asset'    then dam_can_read_asset(target_id)
               when 'project'  then dam_can_read_project(target_id)
               when 'employee' then dam_can_read_employee(target_id)
               else false
             end);

create policy dam_field_values_write_user on dam_field_values
  for all to authenticated
  using (case target_type
           when 'asset'    then dam_can_write_asset(target_id)
           when 'project'  then dam_can_write_project(target_id)
           when 'employee' then dam_is_at_least('editor'::dam_role)
           else false
         end)
  with check (case target_type
                when 'asset'    then dam_can_write_asset(target_id)
                when 'project'  then dam_can_write_project(target_id)
                when 'employee' then dam_is_at_least('editor'::dam_role)
                else false
              end);

-- External ids describe a row's identity in another system. Reading one tells
-- you the row exists, so it follows the target's read predicate; writing one is
-- an integration act and is restricted to global administrators and the worker.
create policy dam_external_ids_select_user on dam_external_ids
  for select to authenticated
  using (deleted_at is null
         and case target_type
               when 'asset'    then dam_can_read_asset(target_id)
               when 'project'  then dam_can_read_project(target_id)
               when 'employee' then dam_can_read_employee(target_id)
               when 'client'   then dam_current_user_id() is not null
               when 'studio'   then dam_current_user_id() is not null
               else dam_is_global_admin()
             end);
create policy dam_external_ids_write_admin on dam_external_ids
  for all to authenticated
  using (dam_is_global_admin())
  with check (dam_is_global_admin());


-- ===========================================================================
-- SECTION 4 (continued) — policy classes D, J, A and K
-- ===========================================================================
-- Continues 40-rls-policies.sql. Split only for authoring; the two files are
-- concatenated in order and there is no ordering dependency between them.


-- ===========================================================================
-- D. Class D — reference data and taxonomy
-- ===========================================================================
-- Everyone signed in reads the vocabulary; only administrators change it. A
-- category is the exception: it carries an access level, so reading it is gated
-- by that level — a category nobody may use should not appear in a picker.

create policy dam_categories_select_user on dam_categories
  for select to authenticated
  using (deleted_at is null and dam_can_read_category(id));
create policy dam_categories_write_admin on dam_categories
  for all to authenticated
  using (dam_is_global_admin()) with check (dam_is_global_admin());

create policy dam_studios_select_user on dam_studios
  for select to authenticated using (deleted_at is null);
create policy dam_studios_write_admin on dam_studios
  for all to authenticated
  using (dam_is_global_admin()) with check (dam_is_global_admin());

create policy dam_clients_select_user on dam_clients
  for select to authenticated using (deleted_at is null);
create policy dam_clients_write_editor on dam_clients
  for all to authenticated
  using (dam_is_at_least('editor'::dam_role))
  with check (dam_is_at_least('editor'::dam_role));

create policy dam_keyword_categories_select_user on dam_keyword_categories
  for select to authenticated using (deleted_at is null);
create policy dam_keyword_categories_write_admin on dam_keyword_categories
  for all to authenticated
  using (dam_is_global_admin()) with check (dam_is_global_admin());

-- Keywords are editable a tier lower than the categories that hold them:
-- marketing curates the vocabulary daily, while adding a whole tree is a
-- structural change to the taxonomy.
create policy dam_keywords_select_user on dam_keywords
  for select to authenticated using (deleted_at is null);
create policy dam_keywords_write_editor on dam_keywords
  for all to authenticated
  using (dam_is_at_least('editor'::dam_role))
  with check (dam_is_at_least('editor'::dam_role));

create policy dam_keyword_aliases_select_user on dam_keyword_aliases
  for select to authenticated using (deleted_at is null);
create policy dam_keyword_aliases_write_editor on dam_keyword_aliases
  for all to authenticated
  using (dam_is_at_least('editor'::dam_role))
  with check (dam_is_at_least('editor'::dam_role));

create policy dam_category_keyword_categories_select_user on dam_category_keyword_categories
  for select to authenticated using (deleted_at is null);
create policy dam_category_keyword_categories_write_admin on dam_category_keyword_categories
  for all to authenticated
  using (dam_is_global_admin()) with check (dam_is_global_admin());

create policy dam_field_categories_select_user on dam_field_categories
  for select to authenticated using (deleted_at is null);
create policy dam_field_categories_write_admin on dam_field_categories
  for all to authenticated
  using (dam_is_global_admin()) with check (dam_is_global_admin());

create policy dam_fields_select_user on dam_fields
  for select to authenticated using (deleted_at is null);
create policy dam_fields_write_admin on dam_fields
  for all to authenticated
  using (dam_is_global_admin()) with check (dam_is_global_admin());

create policy dam_field_options_select_user on dam_field_options
  for select to authenticated using (deleted_at is null);
create policy dam_field_options_write_admin on dam_field_options
  for all to authenticated
  using (dam_is_global_admin()) with check (dam_is_global_admin());

create policy dam_category_fields_select_user on dam_category_fields
  for select to authenticated using (deleted_at is null);
create policy dam_category_fields_write_admin on dam_category_fields
  for all to authenticated
  using (dam_is_global_admin()) with check (dam_is_global_admin());

create policy dam_sizes_select_user on dam_sizes
  for select to authenticated using (deleted_at is null);
create policy dam_sizes_write_admin on dam_sizes
  for all to authenticated
  using (dam_is_global_admin()) with check (dam_is_global_admin());

create policy dam_aspect_ratios_select_user on dam_aspect_ratios
  for select to authenticated using (deleted_at is null);
create policy dam_aspect_ratios_write_admin on dam_aspect_ratios
  for all to authenticated
  using (dam_is_global_admin()) with check (dam_is_global_admin());

create policy dam_photographers_select_user on dam_photographers
  for select to authenticated using (deleted_at is null);
create policy dam_photographers_write_editor on dam_photographers
  for all to authenticated
  using (dam_is_at_least('editor'::dam_role))
  with check (dam_is_at_least('editor'::dam_role));

create policy dam_copyright_holders_select_user on dam_copyright_holders
  for select to authenticated using (deleted_at is null);
create policy dam_copyright_holders_write_editor on dam_copyright_holders
  for all to authenticated
  using (dam_is_at_least('editor'::dam_role))
  with check (dam_is_at_least('editor'::dam_role));

-- A licence policy is reusable terms applied to many assets, so editing one
-- silently re-licenses a corpus. Global administrators only.
create policy dam_copyright_policies_select_user on dam_copyright_policies
  for select to authenticated using (deleted_at is null);
create policy dam_copyright_policies_write_admin on dam_copyright_policies
  for all to authenticated
  using (dam_is_global_admin()) with check (dam_is_global_admin());

create policy dam_templates_select_user on dam_templates
  for select to authenticated using (deleted_at is null);
create policy dam_templates_write_admin on dam_templates
  for all to authenticated
  using (dam_is_at_least('studio_admin'::dam_role))
  with check (dam_is_at_least('studio_admin'::dam_role));

create policy dam_template_versions_select_user on dam_template_versions
  for select to authenticated using (deleted_at is null);
create policy dam_template_versions_write_admin on dam_template_versions
  for all to authenticated
  using (dam_is_at_least('studio_admin'::dam_role))
  with check (dam_is_at_least('studio_admin'::dam_role));


-- ===========================================================================
-- J. Class J — employees
-- ===========================================================================
-- The staff directory is firm-wide by design: a bid team in one studio must be
-- able to find a credential held in another. Editing is an editor capability,
-- and a person may always edit their own profile.

create policy dam_employees_select_user on dam_employees
  for select to authenticated
  using (deleted_at is null and dam_can_read_employee(id));
create policy dam_employees_insert_editor on dam_employees
  for insert to authenticated
  with check (dam_is_at_least('editor'::dam_role));
create policy dam_employees_update_self_or_editor on dam_employees
  for update to authenticated
  using (dam_is_at_least('editor'::dam_role) or user_id = dam_current_user_id())
  with check (dam_is_at_least('editor'::dam_role) or user_id = dam_current_user_id());

create policy dam_employee_bios_select_user on dam_employee_bios
  for select to authenticated
  using (deleted_at is null and dam_can_read_employee(employee_id));
create policy dam_employee_bios_write_editor on dam_employee_bios
  for all to authenticated
  using (dam_is_at_least('editor'::dam_role))
  with check (dam_is_at_least('editor'::dam_role));

create policy dam_employee_headshots_select_user on dam_employee_headshots
  for select to authenticated
  using (deleted_at is null and dam_can_read_employee(employee_id));
create policy dam_employee_headshots_write_editor on dam_employee_headshots
  for all to authenticated
  using (dam_is_at_least('editor'::dam_role))
  with check (dam_is_at_least('editor'::dam_role));

create policy dam_employee_education_select_user on dam_employee_education
  for select to authenticated
  using (deleted_at is null and dam_can_read_employee(employee_id));
create policy dam_employee_education_write_editor on dam_employee_education
  for all to authenticated
  using (dam_is_at_least('editor'::dam_role))
  with check (dam_is_at_least('editor'::dam_role));

create policy dam_employee_registrations_select_user on dam_employee_registrations
  for select to authenticated
  using (deleted_at is null and dam_can_read_employee(employee_id));
create policy dam_employee_registrations_write_editor on dam_employee_registrations
  for all to authenticated
  using (dam_is_at_least('editor'::dam_role))
  with check (dam_is_at_least('editor'::dam_role));

create policy dam_employee_languages_select_user on dam_employee_languages
  for select to authenticated
  using (deleted_at is null and dam_can_read_employee(employee_id));
create policy dam_employee_languages_write_editor on dam_employee_languages
  for all to authenticated
  using (dam_is_at_least('editor'::dam_role))
  with check (dam_is_at_least('editor'::dam_role));


-- ===========================================================================
-- A. Class A — rows owned by one person
-- ===========================================================================
-- Your ratings, your favourites, your notifications. Nobody else reads them,
-- administrators included: an administrator who needs the aggregate reads the
-- analytics views, which do not name the person.

create policy dam_ratings_own on dam_ratings
  for all to authenticated
  using (user_id = dam_current_user_id())
  with check (user_id = dam_current_user_id() and dam_can_read_asset(asset_id));

create policy dam_favourites_own on dam_favourites
  for all to authenticated
  using (user_id = dam_current_user_id())
  with check (user_id = dam_current_user_id());

create policy dam_notifications_select_own on dam_notifications
  for select to authenticated
  using (user_id = dam_current_user_id());
-- Marking one read is the only update a person makes; the row itself is
-- written by the notification job.
create policy dam_notifications_update_own on dam_notifications
  for update to authenticated
  using (user_id = dam_current_user_id())
  with check (user_id = dam_current_user_id());

create policy dam_saved_searches_select_user on dam_saved_searches
  for select to authenticated
  using (deleted_at is null
         and (owner_id = dam_current_user_id()
              or visibility <> 'personal'::dam_album_visibility));
create policy dam_saved_searches_write_own on dam_saved_searches
  for all to authenticated
  using (owner_id = dam_current_user_id() or dam_is_at_least('studio_admin'::dam_role))
  with check (owner_id = dam_current_user_id() or dam_is_at_least('studio_admin'::dam_role));


-- ===========================================================================
-- K. Class K — collaboration
-- ===========================================================================

create policy dam_albums_select_user on dam_albums
  for select to authenticated
  using (deleted_at is null and dam_can_read_album(id));
create policy dam_albums_insert_user on dam_albums
  for insert to authenticated
  with check (dam_current_user_id() is not null and owner_id = dam_current_user_id());
create policy dam_albums_update_user on dam_albums
  for update to authenticated
  using (owner_id = dam_current_user_id()
         or dam_is_at_least('studio_admin'::dam_role)
         or exists (select 1
                      from dam_album_collaborators c
                     where c.album_id = dam_albums.id
                       and c.user_id = dam_current_user_id()
                       and c.permission = 'manage'::dam_album_permission
                       and c.deleted_at is null))
  with check (true);

create policy dam_album_items_select_user on dam_album_items
  for select to authenticated
  using (deleted_at is null and dam_can_read_album(album_id));
-- Adding an asset to an album must not become a way to show someone an asset
-- they may not read, hence the second predicate on insert.
create policy dam_album_items_write_user on dam_album_items
  for all to authenticated
  using (dam_can_read_album(album_id))
  with check (dam_can_read_album(album_id) and dam_can_read_asset(asset_id));

create policy dam_album_collaborators_select_user on dam_album_collaborators
  for select to authenticated
  using (deleted_at is null and dam_can_read_album(album_id));
create policy dam_album_collaborators_write_owner on dam_album_collaborators
  for all to authenticated
  using (exists (select 1
                   from dam_albums a
                  where a.id = dam_album_collaborators.album_id
                    and (a.owner_id = dam_current_user_id()
                         or dam_is_at_least('studio_admin'::dam_role))))
  with check (exists (select 1
                        from dam_albums a
                       where a.id = dam_album_collaborators.album_id
                         and (a.owner_id = dam_current_user_id()
                              or dam_is_at_least('studio_admin'::dam_role))));

create policy dam_comments_select_user on dam_comments
  for select to authenticated
  using (deleted_at is null
         and case target_type
               when 'asset'   then dam_can_read_asset(target_id)
               when 'project' then dam_can_read_project(target_id)
               when 'album'   then dam_can_read_album(target_id)
               else false
             end);
create policy dam_comments_insert_user on dam_comments
  for insert to authenticated
  with check (case target_type
                when 'asset'   then dam_can_read_asset(target_id)
                when 'project' then dam_can_read_project(target_id)
                when 'album'   then dam_can_read_album(target_id)
                else false
              end);
-- You may edit your own comment; an editor may resolve any thread, which is
-- also an update.
create policy dam_comments_update_user on dam_comments
  for update to authenticated
  using (created_by = dam_current_user_id() or dam_is_at_least('editor'::dam_role))
  with check (created_by = dam_current_user_id() or dam_is_at_least('editor'::dam_role));

create policy dam_review_decisions_select_user on dam_review_decisions
  for select to authenticated
  using (deleted_at is null
         and case target_type
               when 'asset'   then dam_can_read_asset(target_id)
               when 'project' then dam_can_read_project(target_id)
               when 'album'   then dam_can_read_album(target_id)
               else false
             end);
-- Approving is an editor capability and decisions are append-only, so there is
-- no update and no delete policy.
create policy dam_review_decisions_insert_editor on dam_review_decisions
  for insert to authenticated
  with check (dam_is_at_least('editor'::dam_role));

create policy dam_text_blocks_select_user on dam_text_blocks
  for select to authenticated
  using (deleted_at is null
         and case target_type
               when 'project'  then dam_can_read_project(target_id)
               when 'employee' then dam_can_read_employee(target_id)
               else dam_current_user_id() is not null
             end);
create policy dam_text_blocks_write_editor on dam_text_blocks
  for all to authenticated
  using (dam_is_at_least('editor'::dam_role))
  with check (dam_is_at_least('editor'::dam_role));

create policy dam_text_block_versions_select_user on dam_text_block_versions
  for select to authenticated
  using (deleted_at is null
         and exists (select 1
                       from dam_text_blocks b
                      where b.id = dam_text_block_versions.text_block_id
                        and b.deleted_at is null));
create policy dam_text_block_versions_write_editor on dam_text_block_versions
  for all to authenticated
  using (dam_is_at_least('editor'::dam_role))
  with check (dam_is_at_least('editor'::dam_role));

create policy dam_generated_documents_select_user on dam_generated_documents
  for select to authenticated
  using (deleted_at is null
         and (created_by = dam_current_user_id() or dam_is_at_least('editor'::dam_role)));
create policy dam_generated_documents_insert_user on dam_generated_documents
  for insert to authenticated
  with check (dam_is_at_least('contributor'::dam_role));


-- ===========================================================================
-- SECTION 4 (continued) — policy classes E, F, G and H
-- ===========================================================================
-- Studio-administered tables, globally administered tables, the append-only
-- logs, and the tables that anonymous visitors reach only through RPCs.


-- ===========================================================================
-- E. Class E — studio-administered
-- ===========================================================================

create policy dam_user_studios_select_user on dam_user_studios
  for select to authenticated
  using (deleted_at is null
         and (user_id = dam_current_user_id()
              or dam_can_manage_studio(studio_id)));
create policy dam_user_studios_write_admin on dam_user_studios
  for all to authenticated
  using (dam_can_manage_studio(studio_id))
  with check (dam_can_manage_studio(studio_id));

create policy dam_groups_select_user on dam_groups
  for select to authenticated using (deleted_at is null);
create policy dam_groups_write_admin on dam_groups
  for all to authenticated
  using (dam_is_global_admin() or dam_can_manage_studio(studio_id))
  with check (dam_is_global_admin() or dam_can_manage_studio(studio_id));

create policy dam_group_members_select_user on dam_group_members
  for select to authenticated
  using (deleted_at is null
         and (user_id = dam_current_user_id()
              or dam_is_at_least('studio_admin'::dam_role)));
create policy dam_group_members_write_admin on dam_group_members
  for all to authenticated
  using (dam_is_at_least('studio_admin'::dam_role))
  with check (dam_is_at_least('studio_admin'::dam_role));

-- A grant extends an access level to a person or a group. Studio
-- administrators may grant within their studios; the level itself is global
-- reference data (class F).
create policy dam_access_grants_select_user on dam_access_grants
  for select to authenticated
  using (deleted_at is null
         and (user_id = dam_current_user_id()
              or dam_is_at_least('studio_admin'::dam_role)));
create policy dam_access_grants_write_admin on dam_access_grants
  for all to authenticated
  using (dam_is_at_least('studio_admin'::dam_role))
  with check (dam_is_at_least('studio_admin'::dam_role));

-- Ingest configuration is operational, not editorial: it points at a storage
-- location and writes assets, so it sits with studio administrators.
create policy dam_ingest_sources_select_user on dam_ingest_sources
  for select to authenticated
  using (deleted_at is null and dam_is_at_least('editor'::dam_role));
create policy dam_ingest_sources_write_admin on dam_ingest_sources
  for all to authenticated
  using (dam_is_at_least('studio_admin'::dam_role))
  with check (dam_is_at_least('studio_admin'::dam_role));

-- A batch belongs to whoever opened it; an editor sees any batch so a stalled
-- upload can be diagnosed without impersonating the uploader.
create policy dam_ingest_batches_select_user on dam_ingest_batches
  for select to authenticated
  using (deleted_at is null
         and (created_by = dam_current_user_id() or dam_is_at_least('editor'::dam_role)));
create policy dam_ingest_batches_insert_user on dam_ingest_batches
  for insert to authenticated
  with check (dam_is_at_least('contributor'::dam_role));
create policy dam_ingest_batches_update_own on dam_ingest_batches
  for update to authenticated
  using (created_by = dam_current_user_id() or dam_is_at_least('editor'::dam_role))
  with check (created_by = dam_current_user_id() or dam_is_at_least('editor'::dam_role));

create policy dam_ingest_batch_files_select_user on dam_ingest_batch_files
  for select to authenticated
  using (deleted_at is null
         and exists (select 1
                       from dam_ingest_batches b
                      where b.id = dam_ingest_batch_files.batch_id
                        and (b.created_by = dam_current_user_id()
                             or dam_is_at_least('editor'::dam_role))));
create policy dam_ingest_batch_files_write_own on dam_ingest_batch_files
  for all to authenticated
  using (exists (select 1
                   from dam_ingest_batches b
                  where b.id = dam_ingest_batch_files.batch_id
                    and b.created_by = dam_current_user_id()))
  with check (exists (select 1
                        from dam_ingest_batches b
                       where b.id = dam_ingest_batch_files.batch_id
                         and b.created_by = dam_current_user_id()));


-- ===========================================================================
-- H. Class H — share links and upload requests
-- ===========================================================================
-- For authenticated users these behave like class E. For anonymous visitors
-- there are NO policies at all: an unauthenticated caller reaches a share only
-- through the SECURITY DEFINER RPCs, which validate the token, the expiry, the
-- password and the revocation before returning anything. That is why the
-- anonymous role was stripped of table privileges at the top of section 4.

create policy dam_share_links_select_user on dam_share_links
  for select to authenticated
  using (deleted_at is null
         and (created_by = dam_current_user_id() or dam_is_at_least('studio_admin'::dam_role)));
-- Sharing externally is an editor capability (matrix row 22).
create policy dam_share_links_insert_editor on dam_share_links
  for insert to authenticated
  with check (dam_is_at_least('editor'::dam_role));
create policy dam_share_links_update_owner on dam_share_links
  for update to authenticated
  using (created_by = dam_current_user_id() or dam_is_at_least('studio_admin'::dam_role))
  with check (created_by = dam_current_user_id() or dam_is_at_least('studio_admin'::dam_role));

create policy dam_share_link_items_select_user on dam_share_link_items
  for select to authenticated
  using (deleted_at is null
         and exists (select 1
                       from dam_share_links s
                      where s.id = dam_share_link_items.share_link_id
                        and (s.created_by = dam_current_user_id()
                             or dam_is_at_least('studio_admin'::dam_role))));
create policy dam_share_link_items_write_owner on dam_share_link_items
  for all to authenticated
  using (exists (select 1
                   from dam_share_links s
                  where s.id = dam_share_link_items.share_link_id
                    and s.created_by = dam_current_user_id()))
  with check (exists (select 1
                        from dam_share_links s
                       where s.id = dam_share_link_items.share_link_id
                         and s.created_by = dam_current_user_id())
              and dam_can_read_asset(asset_id));

create policy dam_upload_requests_select_user on dam_upload_requests
  for select to authenticated
  using (deleted_at is null
         and (created_by = dam_current_user_id()
              or dam_can_manage_studio(studio_id)
              or dam_is_at_least('editor'::dam_role)));
create policy dam_upload_requests_insert_editor on dam_upload_requests
  for insert to authenticated
  with check (dam_is_at_least('editor'::dam_role));
create policy dam_upload_requests_update_owner on dam_upload_requests
  for update to authenticated
  using (created_by = dam_current_user_id() or dam_is_at_least('studio_admin'::dam_role))
  with check (created_by = dam_current_user_id() or dam_is_at_least('studio_admin'::dam_role));

create policy dam_upload_request_files_select_user on dam_upload_request_files
  for select to authenticated
  using (deleted_at is null
         and exists (select 1
                       from dam_upload_requests r
                      where r.id = dam_upload_request_files.upload_request_id
                        and (r.created_by = dam_current_user_id()
                             or dam_is_at_least('editor'::dam_role))));
-- Deposits are written by the anonymous RPC running as definer, never by a
-- signed-in user, so there is no insert policy here.


-- ===========================================================================
-- F. Class F — globally administered
-- ===========================================================================

-- Everyone may see who their colleagues are (the directory needs it); only
-- administrators may change a person, and the role-change guards live in a
-- trigger, not here, because they depend on the old and new values.
create policy dam_users_select_user on dam_users
  for select to authenticated using (deleted_at is null);
create policy dam_users_update_self on dam_users
  for update to authenticated
  using (id = dam_current_user_id())
  with check (id = dam_current_user_id());
create policy dam_users_write_admin on dam_users
  for all to authenticated
  using (dam_is_global_admin()) with check (dam_is_global_admin());

-- --- the trigger those policies depend on -----------------------------------
--
-- WITHOUT THIS, dam_users_update_self IS A PRIVILEGE-ESCALATION HOLE. The
-- policy constrains which ROW a caller may update; it says nothing about which
-- COLUMNS, and it cannot — a WITH CHECK expression sees only the new row, so
-- "this column did not change" is not expressible in it. Supabase grants
-- `authenticated` ALL privileges on every table in this schema by default, and
-- the revoke loop in the policy file deliberately narrows `anon` only. Put
-- those three facts together and any signed-in user can run
--
--     update dam_users set role = 'owner' where id = <their own id>;
--
-- which satisfies both the USING and the WITH CHECK, and hands them the top of
-- the six-tier hierarchy. Everything else in this file is then decoration.
--
-- SPEC §3.7.2 class F already says the self-update is "limited to display_name,
-- picture_url, settings by trigger; role fields by [D-358]", and the threat
-- table in §3.11 lists "assignment rules in a trigger, not only the UI" as the
-- control against exactly this attack. This is that trigger. It is created here
-- rather than deferred to a phase migration like the other table-specific
-- triggers, because a security control that arrives later leaves a window in
-- which the schema is exploitable.
--
-- Column-level `revoke update (role, ...) from authenticated` was the other
-- candidate and is rejected: the API serves administrators over the same
-- `authenticated` role with the administrator's own JWT, so a column revoke
-- would lock out the people who are supposed to make these changes. The
-- distinction being drawn is between callers, not between connections, and
-- only a trigger can see the caller.
create or replace function dam_users_guard_privileged_columns()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  -- WHAT AN ORDINARY PERSON MAY CHANGE ABOUT THEMSELVES. A whitelist, not a
  -- list of forbidden columns: a column added by a later migration is then
  -- denied by default, which is the safe direction to be wrong in. A blacklist
  -- silently admits every column nobody remembered to add to it.
  k_self constant text[] := array[
    'display_name', 'avatar_asset_id', 'sso_picture_url',
    'locale', 'timezone', 'settings'
  ];
  -- Maintained by trg_users_updated_at, which fires after this one (trigger
  -- order is alphabetical and 'g' precedes 'u'), so their incoming values are
  -- whatever the client sent and are about to be overwritten regardless.
  -- Policing them here would reject honest updates over columns that do not
  -- matter.
  k_bookkeeping constant text[] := array[
    'created_at', 'created_by', 'updated_at', 'updated_by'
  ];
  -- Written by the session exchange on each sign-in.
  k_session constant text[] := array['last_login_at', 'login_count'];

  v_actor        uuid;
  v_ignore       text[];
  v_deactivating boolean;
  v_other_owners integer;
begin
  v_actor := dam_current_user_id();

  -- No principal on the connection: the migration itself, the seed harness and
  -- the background workers, all of which connect as service_role without a JWT
  -- and all of which legitimately write these columns (provisioning, the
  -- directory sync, deactivating a leaver). service_role already bypasses
  -- row-level security by design, so refusing it here would break the workers
  -- while stopping nobody — anyone who holds service_role has the database.
  if v_actor is null then
    return new;
  end if;

  v_ignore := k_self || k_bookkeeping;

  -- A system principal (D-375) additionally stamps the sign-in counters. It is
  -- deliberately NOT given a blanket bypass: the whole rationale of D-375 is
  -- that a compromised web container can insert users and log usage rather
  -- than rewrite the library, and a system token that could set `role` would
  -- give back everything that decision was taken to withhold.
  if dam_current_principal_type() = 'system'::dam_principal_type then
    v_ignore := v_ignore || k_session;
  end if;

  if not dam_is_global_admin() then
    if (to_jsonb(new) - v_ignore) is distinct from (to_jsonb(old) - v_ignore) then
      raise exception 'You may only change your own display name, avatar, locale, timezone and settings'
        using errcode = '42501',
              detail  = format('principal %s attempted an administered change to dam_users row %s', v_actor, old.id),
              hint    = 'Role, activation, email and studio visibility are set by an administrator.';
    end if;
    return new;
  end if;

  -- ----- from here the caller is a global administrator or an owner: D-358 --
  --
  -- These rules are the difference between "administrators may manage users"
  -- and "one compromised administrator account ends the tenancy". Each one is a
  -- clause of D-358, enforced here rather than only in the API, because the API
  -- is not the only way to reach this table.

  v_deactivating := (old.is_active and not new.is_active)
                 or (old.deleted_at is null and new.deleted_at is not null);

  -- is_system is set once, by the seed, and never by a person. A human
  -- principal that acquired it would inherit whatever the workers are trusted
  -- with, and the table's own CHECK would then force the row inactive and onto
  -- the reserved domain — a confusing way to lose an account.
  if new.is_system is distinct from old.is_system then
    raise exception 'dam_users.is_system is set by the seed and cannot be changed'
      using errcode = '42501';
  end if;

  -- Only an owner may create an owner or a global admin. A global admin who
  -- could mint another global admin could mint one under their own control,
  -- which makes the tier meaningless.
  if new.role is distinct from old.role
     and new.role in ('global_admin'::dam_role, 'owner'::dam_role)
     and not dam_is_at_least('owner'::dam_role) then
    raise exception 'Only an owner may grant the global_admin or owner role'
      using errcode = '42501';
  end if;

  -- Only an owner may change an owner, in any respect. Otherwise a global
  -- admin demotes the owners first and is then unopposed.
  if old.role = 'owner'::dam_role and not dam_is_at_least('owner'::dam_role) then
    raise exception 'Only an owner may modify an owner'
      using errcode = '42501';
  end if;

  -- Nobody lowers their own role or deactivates themselves. The upward case is
  -- the escalation this trigger exists to stop; the downward case is how an
  -- administrator locks themselves out by accident, and it costs nothing to
  -- require that somebody else make the change.
  if old.id = v_actor then
    if new.role is distinct from old.role then
      raise exception 'You may not change your own role'
        using errcode = '42501',
              hint    = 'Ask another global administrator or an owner to make this change.';
    end if;
    if v_deactivating then
      raise exception 'You may not deactivate or delete your own account'
        using errcode = '42501';
    end if;
  end if;

  -- The last active owner cannot be demoted, deactivated or deleted. Without
  -- this, two owners can demote each other into a firm that has no owner and no
  -- way to appoint one, and the only route back is a database console.
  if old.role = 'owner'::dam_role
     and old.is_active
     and old.deleted_at is null
     and (new.role is distinct from old.role or v_deactivating) then
    select count(*) into v_other_owners
      from dam_users
     where role = 'owner'::dam_role
       and is_active
       and deleted_at is null
       and id <> old.id;
    if v_other_owners = 0 then
      raise exception 'The last active owner cannot be demoted, deactivated or deleted'
        using errcode = '42501',
              hint    = 'Appoint another owner first.';
    end if;
  end if;

  return new;
end;
$$;

comment on function dam_users_guard_privileged_columns() is
  'BEFORE UPDATE guard on dam_users. Confines an ordinary user to their own display name, avatar, locale, timezone and settings, and enforces D-358 for administrators: only an owner grants or modifies owner/global_admin, nobody changes their own role or deactivates themselves, and the last active owner cannot be removed. Completes dam_users_update_self, which cannot restrict columns.';

create trigger trg_users_guard_privileged_columns
  before update on dam_users
  for each row execute function dam_users_guard_privileged_columns();

-- The equivalent rule for per-studio elevation (a Studio Admin may set
-- dam_user_studios.role_override no higher than `editor`) belongs on that table
-- and is attached by the phase migration that builds user management, where the
-- studio-scoped helpers it needs already exist.

create policy dam_access_levels_select_user on dam_access_levels
  for select to authenticated using (deleted_at is null);
create policy dam_access_levels_write_admin on dam_access_levels
  for all to authenticated
  using (dam_is_global_admin()) with check (dam_is_global_admin());

-- A key is a credential. Its owner sees their own (to rotate or revoke it);
-- only a global administrator sees every key. The hash itself is never
-- returned by the API regardless of this policy.
create policy dam_api_keys_select_owner on dam_api_keys
  for select to authenticated
  using (deleted_at is null
         and (owner_user_id = dam_current_user_id() or dam_is_global_admin()));
create policy dam_api_keys_write_admin on dam_api_keys
  for all to authenticated
  using (dam_is_global_admin()) with check (dam_is_global_admin());

create policy dam_storage_locations_select_user on dam_storage_locations
  for select to authenticated
  using (deleted_at is null and dam_is_at_least('editor'::dam_role));
-- Adding or retiring a storage location moves where bytes live: owner only.
create policy dam_storage_locations_write_owner on dam_storage_locations
  for all to authenticated
  using (dam_is_at_least('owner'::dam_role))
  with check (dam_is_at_least('owner'::dam_role));

create policy dam_integrations_select_admin on dam_integrations
  for select to authenticated
  using (deleted_at is null and dam_is_global_admin());
create policy dam_integrations_write_admin on dam_integrations
  for all to authenticated
  using (dam_is_global_admin()) with check (dam_is_global_admin());

create policy dam_integration_field_mappings_select_admin on dam_integration_field_mappings
  for select to authenticated
  using (deleted_at is null and dam_is_global_admin());
create policy dam_integration_field_mappings_write_admin on dam_integration_field_mappings
  for all to authenticated
  using (dam_is_global_admin()) with check (dam_is_global_admin());

create policy dam_sync_runs_select_admin on dam_sync_runs
  for select to authenticated
  using (deleted_at is null and dam_is_at_least('studio_admin'::dam_role));

create policy dam_sync_conflicts_select_admin on dam_sync_conflicts
  for select to authenticated
  using (deleted_at is null and dam_is_at_least('studio_admin'::dam_role));
-- Resolving a conflict is an administrative decision recorded on the row.
create policy dam_sync_conflicts_update_admin on dam_sync_conflicts
  for update to authenticated
  using (dam_is_at_least('studio_admin'::dam_role))
  with check (dam_is_at_least('studio_admin'::dam_role));

create policy dam_sync_field_state_select_admin on dam_sync_field_state
  for select to authenticated
  using (deleted_at is null and dam_is_at_least('studio_admin'::dam_role));

create policy dam_webhooks_select_admin on dam_webhooks
  for select to authenticated
  using (deleted_at is null and dam_is_global_admin());
create policy dam_webhooks_write_admin on dam_webhooks
  for all to authenticated
  using (dam_is_global_admin()) with check (dam_is_global_admin());

create policy dam_retention_policies_select_admin on dam_retention_policies
  for select to authenticated
  using (deleted_at is null and dam_is_at_least('studio_admin'::dam_role));
-- Retention decides what is destroyed and when: owner only.
create policy dam_retention_policies_write_owner on dam_retention_policies
  for all to authenticated
  using (dam_is_at_least('owner'::dam_role))
  with check (dam_is_at_least('owner'::dam_role));

create policy dam_tiering_rules_select_admin on dam_tiering_rules
  for select to authenticated
  using (deleted_at is null and dam_is_at_least('studio_admin'::dam_role));
create policy dam_tiering_rules_write_owner on dam_tiering_rules
  for all to authenticated
  using (dam_is_at_least('owner'::dam_role))
  with check (dam_is_at_least('owner'::dam_role));

-- Settings are firm-wide configuration. Everyone reads them (the interface
-- needs the branding and the thresholds); owners change them, and the
-- security-prefixed keys are guarded further in the API.
create policy dam_settings_select_user on dam_settings
  for select to authenticated using (deleted_at is null);
create policy dam_settings_write_owner on dam_settings
  for all to authenticated
  using (dam_is_at_least('owner'::dam_role))
  with check (dam_is_at_least('owner'::dam_role));


-- ===========================================================================
-- AI suggestions and runs
-- ===========================================================================
-- A suggestion is a proposal about a row, so it follows that row's read
-- predicate. Accepting or rejecting one is done through an RPC (so the
-- acceptance and the resulting real row are one transaction), which is why
-- there is no update policy here.

create policy dam_ai_suggestions_select_user on dam_ai_suggestions
  for select to authenticated
  using (deleted_at is null
         and case target_type
               when 'asset'    then dam_can_read_asset(target_id)
               when 'project'  then dam_can_read_project(target_id)
               when 'employee' then dam_can_read_employee(target_id)
               else false
             end);

create policy dam_ai_runs_select_admin on dam_ai_runs
  for select to authenticated
  using (deleted_at is null and dam_is_at_least('studio_admin'::dam_role));


-- ===========================================================================
-- G. Class G — append-only logs
-- ===========================================================================
-- Read-only to users, written by triggers and the worker. No table here has an
-- insert, update or delete policy: the only writer is service_role, and the
-- only remover is the retention job dropping a whole partition.

-- A studio administrator reads their own studio's audit trail through the
-- denormalised studio_id; every person may read the entries they caused.
create policy dam_audit_log_select_admin on dam_audit_log
  for select to authenticated
  using (dam_is_global_admin()
         or dam_can_manage_studio(studio_id)
         or actor_id = dam_current_user_id());

create policy dam_usage_events_select_admin on dam_usage_events
  for select to authenticated
  using (dam_is_global_admin()
         or dam_can_manage_studio(studio_id)
         or user_id = dam_current_user_id());

create policy dam_search_log_select_admin on dam_search_log
  for select to authenticated
  using (dam_is_global_admin()
         or dam_can_manage_studio(studio_id)
         or user_id = dam_current_user_id());

-- Jobs are operational. An editor may watch the job behind their own export or
-- document; administrators see the whole queue.
create policy dam_jobs_select_user on dam_jobs
  for select to authenticated
  using (dam_is_at_least('studio_admin'::dam_role)
         or created_by = dam_current_user_id());

create policy dam_webhook_deliveries_select_admin on dam_webhook_deliveries
  for select to authenticated
  using (dam_is_global_admin());



-- ===========================================================================
-- SECTION 4 (continued) — shared triggers and reference data
-- ===========================================================================
-- Two shared triggers are attached to every table here. The table-specific
-- trigger FUNCTIONS named throughout SPEC part 2 (rank assignment, the hero
-- pointer, keyword path maintenance and propagation, field-value validation,
-- search-row maintenance, status-transition guards, soft-delete cascades) are
-- implemented in the phase migrations that introduce the behaviour they
-- enforce; their contracts are specified per table in the SPEC. Attaching them
-- here would put a thousand lines of procedural code in a file whose purpose is
-- to be reviewable.


-- ===========================================================================
-- Shared trigger: updated_at
-- ===========================================================================
-- Attached to every table. The list is written out rather than read from the
-- catalogue so that a table added later does not silently acquire behaviour
-- nobody decided on.

do $$
declare
  t text;
  tables text[] := array[
    -- core
    'dam_studios','dam_clients','dam_projects','dam_project_aliases','dam_project_studios',
    'dam_project_assets','dam_categories','dam_keyword_categories','dam_keywords',
    'dam_keyword_aliases','dam_keyword_links','dam_category_keyword_categories',
    'dam_field_categories','dam_fields','dam_field_options','dam_category_fields',
    'dam_field_values','dam_storage_locations','dam_assets','dam_asset_versions',
    'dam_derivatives','dam_render_cache','dam_asset_crops','dam_asset_embeddings',
    'dam_asset_ocr_text','dam_asset_duplicates','dam_ingest_sources','dam_ingest_batches',
    'dam_ingest_batch_files','dam_external_ids',
    -- supporting
    'dam_users','dam_groups','dam_group_members','dam_user_studios','dam_access_levels',
    'dam_access_grants','dam_api_keys','dam_employees','dam_employee_bios',
    'dam_employee_headshots','dam_employee_education','dam_employee_registrations',
    'dam_employee_languages','dam_project_employees','dam_albums','dam_album_items',
    'dam_album_collaborators','dam_text_blocks','dam_text_block_versions','dam_photographers',
    'dam_copyright_holders','dam_copyright_policies','dam_asset_rights','dam_sizes',
    'dam_aspect_ratios','dam_saved_searches','dam_share_links','dam_share_link_items',
    'dam_upload_requests','dam_upload_request_files','dam_comments','dam_review_decisions',
    'dam_notifications','dam_ratings','dam_favourites','dam_webhooks','dam_integrations',
    'dam_integration_field_mappings','dam_sync_runs','dam_sync_conflicts','dam_sync_field_state',
    'dam_templates','dam_template_versions','dam_generated_documents','dam_ai_suggestions',
    'dam_ai_runs','dam_retention_policies','dam_tiering_rules','dam_settings'
  ];
begin
  foreach t in array tables loop
    execute format(
      'create trigger trg_%s_updated_at before update on %I
         for each row execute function dam_set_updated_at()',
      replace(t, 'dam_', ''), t);
  end loop;
end;
$$;

-- dam_asset_search, dam_jobs, dam_audit_log, dam_usage_events, dam_search_log
-- and dam_webhook_deliveries are deliberately absent from that list. The search
-- row is machine-maintained and stamps its own indexed_at; the job row's
-- updated_at is written by the claim statement itself and a trigger would fight
-- it; the four log tables are append-only and never updated at all.


-- ===========================================================================
-- Shared trigger: audit
-- ===========================================================================
-- Every business table is audited (brief §4.8). Excluded, per D-019 and D-201:
-- the search row, the render cache, embeddings and OCR text (machine-written
-- derivatives of a version, not user data), the queue, and the log tables
-- themselves — auditing an audit table is a recursion, not a control.

do $$
declare
  t text;
  tables text[] := array[
    'dam_studios','dam_clients','dam_projects','dam_project_aliases','dam_project_studios',
    'dam_project_assets','dam_categories','dam_keyword_categories','dam_keywords',
    'dam_keyword_aliases','dam_keyword_links','dam_category_keyword_categories',
    'dam_field_categories','dam_fields','dam_field_options','dam_category_fields',
    'dam_field_values','dam_storage_locations','dam_assets','dam_asset_versions',
    'dam_derivatives','dam_asset_crops','dam_asset_duplicates','dam_ingest_sources',
    'dam_ingest_batches','dam_external_ids',
    'dam_users','dam_groups','dam_group_members','dam_user_studios','dam_access_levels',
    'dam_access_grants','dam_api_keys','dam_employees','dam_employee_bios',
    'dam_employee_headshots','dam_employee_education','dam_employee_registrations',
    'dam_employee_languages','dam_project_employees','dam_albums','dam_album_items',
    'dam_album_collaborators','dam_text_blocks','dam_text_block_versions','dam_photographers',
    'dam_copyright_holders','dam_copyright_policies','dam_asset_rights','dam_sizes',
    'dam_aspect_ratios','dam_share_links','dam_upload_requests','dam_review_decisions',
    'dam_webhooks','dam_integrations','dam_integration_field_mappings','dam_sync_conflicts',
    'dam_templates','dam_template_versions','dam_generated_documents','dam_ai_suggestions',
    'dam_retention_policies','dam_tiering_rules','dam_settings'
  ];
begin
  foreach t in array tables loop
    execute format(
      'create trigger trg_%s_audit after insert or update or delete on %I
         for each row execute function dam_audit_row()',
      replace(t, 'dam_', ''), t);
  end loop;
end;
$$;


-- ===========================================================================
-- Reference data
-- ===========================================================================
-- Seeded with fixed uuids so a re-run is idempotent and so the phase
-- migrations, the seed harness and the test fixtures can all refer to the same
-- rows. Everything here is `is_system`, which the protect triggers use to
-- refuse deletion and slug changes.

-- --- access levels (D-013) -------------------------------------------------
-- Four levels, deliberately few: every additional level multiplies the
-- permission matrix a reviewer has to hold in their head.
insert into dam_access_levels (id, name, slug, description, min_role, scope, is_default, watermark_below_role, sort_order, is_system) values
  ('a1000000-0000-4000-8000-000000000001', 'Firm-wide',    'firm-wide',    'Visible to everyone signed in, in any studio. Brand material, templates, marketing collateral.', 'viewer'::dam_role,       'firm'::dam_access_scope,       false, 'contributor'::dam_role, 10, true),
  ('a1000000-0000-4000-8000-000000000002', 'Studio',       'studio',       'Visible to the owning studio and to anyone with cross-studio visibility. The default for a new project.', 'viewer'::dam_role,       'studio'::dam_access_scope,     true,  'contributor'::dam_role, 20, true),
  ('a1000000-0000-4000-8000-000000000003', 'Restricted',   'restricted',   'Editors and above, or an explicit grant. Unpublished work, client-sensitive imagery.', 'editor'::dam_role,       'grant_only'::dam_access_scope, false, 'editor'::dam_role,      30, true),
  ('a1000000-0000-4000-8000-000000000004', 'Confidential', 'confidential', 'Named people only, by grant. Embargoed projects and anything under a non-disclosure agreement.', 'studio_admin'::dam_role, 'grant_only'::dam_access_scope, false, 'owner'::dam_role,       40, true)
on conflict (id) do nothing;

-- --- asset categories (brief §3, D-014) ------------------------------------
-- `requires_review` is true only where a mistake is externally visible: client
-- photography and pictures of people.
insert into dam_categories (id, name, slug, description, access_level_id, requires_review, sort_order, is_system, is_active) values
  ('c1000000-0000-4000-8000-000000000001', 'Project Photography',  'project-photography',  'Commissioned and site photography of completed work.',        'a1000000-0000-4000-8000-000000000002', true,  10, true, true),
  ('c1000000-0000-4000-8000-000000000002', 'Renderings',           'renderings',           'Visualisations and computer-generated imagery.',              'a1000000-0000-4000-8000-000000000002', false, 20, true, true),
  ('c1000000-0000-4000-8000-000000000003', 'Drawings',             'drawings',             'Plans, sections, elevations, diagrams and sketches.',         'a1000000-0000-4000-8000-000000000002', false, 30, true, true),
  ('c1000000-0000-4000-8000-000000000004', 'Staff',                'staff',                'Headshots and people photography.',                           'a1000000-0000-4000-8000-000000000001', true,  40, true, true),
  ('c1000000-0000-4000-8000-000000000005', 'Logos & Brand',        'logos-and-brand',      'Marks, wordmarks and brand assets.',                          'a1000000-0000-4000-8000-000000000001', false, 50, true, true),
  ('c1000000-0000-4000-8000-000000000006', 'Marketing Collateral', 'marketing-collateral', 'Brochures, decks, proposals and published material.',         'a1000000-0000-4000-8000-000000000001', false, 60, true, true),
  ('c1000000-0000-4000-8000-000000000007', 'Awards',               'awards',               'Award submissions, certificates and ceremony photography.',   'a1000000-0000-4000-8000-000000000001', false, 70, true, true),
  ('c1000000-0000-4000-8000-000000000008', 'Site Photos',          'site-photos',          'Progress, survey and site-condition photography.',            'a1000000-0000-4000-8000-000000000002', false, 80, true, true)
on conflict (id) do nothing;

-- --- studios (DQ11) --------------------------------------------------------
-- The fifteen codes of the existing vocabulary, with their Drive folder names
-- carried across so folder-walk ingest and the migration can map a path to a
-- studio. A city name is used only where the firm has exactly one studio in
-- that place; everywhere else the location keeps its own name, because
-- inventing a studio puts a place on screen that does not exist.
insert into dam_studios (id, code, name, city, country_code, region, timezone, is_region_group, legacy_folder_names, sort_order, is_active) values
  ('51000000-0000-4000-8000-000000000001', 'australia',        'Australia',        null,             'AU', 'Australia',    'Australia/Sydney',   true,  array['Australia','AUS_ARCHIVED'], 10, true),
  ('51000000-0000-4000-8000-000000000002', 'bahrain',          'Bahrain',          null,             'BH', 'MENA',         'Asia/Bahrain',       false, array['Bahrain'],                  20, true),
  ('51000000-0000-4000-8000-000000000003', 'bangkok',          'Bangkok',          'Bangkok',        'TH', 'APAC',         'Asia/Bangkok',       false, array['Thailand'],                 30, true),
  ('51000000-0000-4000-8000-000000000004', 'china',            'China',            null,             'CN', 'APAC',         'Asia/Shanghai',      false, array['China'],                    40, true),
  ('51000000-0000-4000-8000-000000000005', 'dubai',            'Dubai',            'Dubai',          'AE', 'MENA',         'Asia/Dubai',         false, array['UAE'],                      50, true),
  ('51000000-0000-4000-8000-000000000006', 'ho-chi-minh-city', 'Ho Chi Minh City', 'Ho Chi Minh City','VN','APAC',         'Asia/Ho_Chi_Minh',   false, array['Vietnam'],                  60, true),
  ('51000000-0000-4000-8000-000000000007', 'hong-kong',        'Hong Kong',        'Hong Kong',      'HK', 'APAC',         'Asia/Hong_Kong',     false, array['Hong Kong'],                70, true),
  ('51000000-0000-4000-8000-000000000008', 'london',           'London',           'London',         'GB', 'UK & Europe',  'Europe/London',      false, array['United Kingdom','UK'],      80, true),
  ('51000000-0000-4000-8000-000000000009', 'malaysia',         'Malaysia',         null,             'MY', 'APAC',         'Asia/Kuala_Lumpur',  false, array['Malaysia'],                 90, true),
  ('51000000-0000-4000-8000-00000000000a', 'myanmar',          'Myanmar',          null,             'MM', 'APAC',         'Asia/Yangon',        false, array['Myanmar'],                 100, true),
  ('51000000-0000-4000-8000-00000000000b', 'new-zealand',      'New Zealand',      null,             'NZ', 'Australia',    'Pacific/Auckland',   false, array['New Zealand'],             110, true),
  ('51000000-0000-4000-8000-00000000000c', 'philippines',      'Philippines',      null,             'PH', 'APAC',         'Asia/Manila',        false, array['Philippines','Manila'],    120, true),
  ('51000000-0000-4000-8000-00000000000d', 'riyadh',           'Riyadh',           'Riyadh',         'SA', 'MENA',         'Asia/Riyadh',        false, array['Saudi Arabia','KSA'],      130, true),
  ('51000000-0000-4000-8000-00000000000e', 'singapore',        'Singapore',        'Singapore',      'SG', 'APAC',         'Asia/Singapore',     false, array['Singapore'],               140, true),
  ('51000000-0000-4000-8000-00000000000f', 'united-states',    'United States',    null,             'US', 'Americas',     'America/New_York',   false, array['USA','United States'],     150, true)
on conflict (id) do nothing;

-- The five Australian offices as children of the region group. They hold no
-- assets until master data says which office delivered which project: the
-- folder path cannot tell them apart, and guessing would attribute work to the
-- wrong studio.
insert into dam_studios (id, code, name, city, country_code, region, timezone, parent_studio_id, sort_order, is_active) values
  ('51000000-0000-4000-8000-000000000011', 'sydney',    'Sydney',    'Sydney',    'AU', 'Australia', 'Australia/Sydney',    '51000000-0000-4000-8000-000000000001', 11, true),
  ('51000000-0000-4000-8000-000000000012', 'melbourne', 'Melbourne', 'Melbourne', 'AU', 'Australia', 'Australia/Melbourne', '51000000-0000-4000-8000-000000000001', 12, true),
  ('51000000-0000-4000-8000-000000000013', 'brisbane',  'Brisbane',  'Brisbane',  'AU', 'Australia', 'Australia/Brisbane',  '51000000-0000-4000-8000-000000000001', 13, true),
  ('51000000-0000-4000-8000-000000000014', 'adelaide',  'Adelaide',  'Adelaide',  'AU', 'Australia', 'Australia/Adelaide',  '51000000-0000-4000-8000-000000000001', 14, true),
  ('51000000-0000-4000-8000-000000000015', 'newcastle', 'Newcastle', 'Newcastle', 'AU', 'Australia', 'Australia/Sydney',    '51000000-0000-4000-8000-000000000001', 15, true)
on conflict (id) do nothing;

-- --- keyword categories (D-015) --------------------------------------------
-- Three namespaces. Asset keywords describe the picture, project keywords
-- describe the work, employee keywords describe the person.
insert into dam_keyword_categories (id, namespace, name, slug, description, max_depth, is_exclusive, sort_order, is_system, is_active) values
  ('41000000-0000-4000-8000-000000000001', 'asset'::dam_keyword_namespace,    'Space Type',          'space-type',          'What the picture shows: lobby, guest room, restaurant, facade.', 3, false, 10, true, true),
  ('41000000-0000-4000-8000-000000000002', 'asset'::dam_keyword_namespace,    'Material',            'material',            'Dominant materials and finishes.',                              3, false, 20, true, true),
  ('41000000-0000-4000-8000-000000000003', 'asset'::dam_keyword_namespace,    'Time of Day',         'time-of-day',         'Dawn, day, dusk, night. One value per asset.',                  1, true,  30, true, true),
  ('41000000-0000-4000-8000-000000000004', 'asset'::dam_keyword_namespace,    'Photography Style',   'photography-style',   'Wide, detail, aerial, lifestyle, styled, documentary.',         2, false, 40, true, true),
  ('41000000-0000-4000-8000-000000000005', 'asset'::dam_keyword_namespace,    'View',                'view',                'Interior, exterior, aerial, plan.',                             1, true,  50, true, true),
  ('41000000-0000-4000-8000-000000000006', 'asset'::dam_keyword_namespace,    'Colour Mood',         'colour-mood',         'Warm, cool, neutral, monochrome, saturated.',                   1, true,  60, true, true),
  ('41000000-0000-4000-8000-000000000011', 'project'::dam_keyword_namespace,  'Sector',              'sector',              'The three-level sector taxonomy: macro portfolio, core sector, sub-sector.', 3, false, 10, true, true),
  ('41000000-0000-4000-8000-000000000012', 'project'::dam_keyword_namespace,  'Services',            'services',            'Scope delivered: architecture, interior design, master planning, branding.', 2, false, 20, true, true),
  ('41000000-0000-4000-8000-000000000013', 'project'::dam_keyword_namespace,  'Certifications',      'certifications',      'LEED, WELL, Green Mark, BREEAM and their levels.',              2, false, 30, true, true),
  ('41000000-0000-4000-8000-000000000014', 'project'::dam_keyword_namespace,  'Awards',              'awards',              'Award programmes the project has been entered in or won.',      2, false, 40, true, true),
  ('41000000-0000-4000-8000-000000000021', 'employee'::dam_keyword_namespace, 'Sector Expertise',    'sector-expertise',    'Sectors this person is credible in for a bid.',                 2, false, 10, true, true),
  ('41000000-0000-4000-8000-000000000022', 'employee'::dam_keyword_namespace, 'Typology Expertise',  'typology-expertise',  'Building and space typologies this person has delivered.',      2, false, 20, true, true),
  ('41000000-0000-4000-8000-000000000023', 'employee'::dam_keyword_namespace, 'Project Role',        'project-role',        'Controlled vocabulary for roles on a project, used by CVs.',    1, false, 30, true, true)
on conflict (id) do nothing;

-- Pair the asset Space Type tree to the project Sector tree so that an asset
-- carrying its own space type suppresses the inherited project sector on that
-- asset (the override half of the inheritance rule).
update dam_keyword_categories
   set overrides_category_id = '41000000-0000-4000-8000-000000000011'
 where id = '41000000-0000-4000-8000-000000000001';

-- --- aspect ratios (D-016) -------------------------------------------------
insert into dam_aspect_ratios (id, name, slug, ratio_w, ratio_h, is_default, is_system, is_active, sort_order) values
  ('61000000-0000-4000-8000-000000000001', 'Square 1:1',      'square',        1,    1,    false, true, true, 10),
  ('61000000-0000-4000-8000-000000000002', 'Classic 4:3',     'classic-4-3',   4,    3,    false, true, true, 20),
  ('61000000-0000-4000-8000-000000000003', 'Photo 3:2',       'photo-3-2',     3,    2,    true,  true, true, 30),
  ('61000000-0000-4000-8000-000000000004', 'Widescreen 16:9', 'widescreen',    16,   9,    false, true, true, 40),
  ('61000000-0000-4000-8000-000000000005', 'Portrait 2:3',    'portrait-2-3',  2,    3,    false, true, true, 50),
  ('61000000-0000-4000-8000-000000000006', 'A-series',        'a-series',      1000, 1414, false, true, true, 60)
on conflict (id) do nothing;

-- --- output size presets (D-016) -------------------------------------------
-- `Original` is the only preset that is not a render; it is listed so that a
-- download dialogue has one vocabulary, and its minimum role is contributor
-- because handing out a 60 MB master is a different act from taking a web JPEG.
insert into dam_sizes (id, name, slug, description, width, height, fit, dpi, format, quality, colour_profile, watermark, min_role, is_original, is_default, is_system, is_active, sort_order) values
  ('71000000-0000-4000-8000-000000000001', 'Web 1200',      'web-1200',      'Web and intranet use.',                     1200, null, 'inside', 72,  'webp', 82, 'srgb',     false, 'viewer'::dam_role,      false, true,  true, true, 10),
  ('71000000-0000-4000-8000-000000000002', 'Social Square', 'social-square', 'Square crop for social posts.',             1080, 1080, 'cover',  72,  'jpeg', 85, 'srgb',     false, 'viewer'::dam_role,      false, false, true, true, 20),
  ('71000000-0000-4000-8000-000000000003', 'Presentation',  'presentation',  'Full-bleed slide image.',                   1920, 1080, 'cover',  96,  'jpeg', 88, 'srgb',     false, 'viewer'::dam_role,      false, false, true, true, 30),
  ('71000000-0000-4000-8000-000000000004', 'Print A4',      'print-a4',      'A4 at 300 dpi for proposals and sheets.',   2480, 3508, 'inside', 300, 'jpeg', 92, 'adobe_rgb',false, 'contributor'::dam_role, false, false, true, true, 40),
  ('71000000-0000-4000-8000-000000000005', 'Print A3',      'print-a3',      'A3 at 300 dpi for boards and submissions.', 3508, 4961, 'inside', 300, 'jpeg', 92, 'adobe_rgb',false, 'contributor'::dam_role, false, false, true, true, 50),
  ('71000000-0000-4000-8000-000000000006', 'Original',      'original',      'The master file exactly as supplied.',      null, null, 'inside', null,'original', null,'srgb', false, 'contributor'::dam_role, true,  false, true, true, 60)
on conflict (id) do nothing;
