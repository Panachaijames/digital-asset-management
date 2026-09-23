-- =============================================================================
-- 20260923120400_p1_search_rpcs.sql
-- Phase 1, migration 5 of 5 — v2 (project-based DAM) behaviour layer.
--
-- PURPOSE
--   The read path of the v2 library (SPEC 3.7.6): three SECURITY DEFINER RPCs
--   that run the SPEC 3.5.5 read algorithm ONCE per call, as a set predicate
--   over dam_asset_search, instead of calling dam_can_read_asset() per row.
--     1. dam_search_assets(p jsonb)        one page of rows, keyset or offset
--                                          paged, hydrated after the LIMIT
--                                          with the fields the v1 grid needs
--                                          (v1 id, Drive file id, keyword and
--                                          project names, a legacy subset).
--     2. dam_search_assets_count(p jsonb)  the total for the same predicate,
--                                          exact up to 50,000.
--     3. dam_search_facets(p jsonb)        top-50 counts per requested facet.
--   All three share ONE private builder, dam_search_sql_where(p jsonb), which
--   validates `p`, reads the caller once and returns the WHERE clause as SQL
--   text with every value embedded as a quoted literal (format %L). The RPCs
--   EXECUTE that text, so every call is planned for its own values and the
--   GIN and btree indexes stay usable (TRAP T16: a static
--   `($1 is null or col = any($1))` gets a generic plan after five calls).
--
-- THE PREDICATE (SPEC 3.5.5, FACTS search.md 7.2), over dam_asset_search only
--   No sub, or no role (unknown, inactive or trashed user; system principals
--   are never active)                                      -> nothing at all.
--   Global admin or owner                   -> every row not in the trash.
--   Otherwise a row not in the trash is visible when
--     the caller created it, or
--     (status approved/published, or the caller is an editor there)
--     and (no embargo in force, or the caller is an editor there)
--     and level_ok,
--   where "an editor there" is a global role >= editor, or a live studio
--   membership with role_override >= editor covering one of the row's studios
--   (region groups cover their children, as dam_current_studio_ids() does),
--   and level_ok, with the level's min_role compared with the GLOBAL role
--   (SPEC 3.7.6; FACTS C10), is
--     a live grant of the level (user, or live membership of a live active
--       group, exactly dam_has_grant()) and, for grant_only, role >= min_role;
--     or a firm level with role >= min_role;
--     or a studio level with role >= min_role and (the row has no studio, or
--       shares one with the caller's memberships, or the caller has
--       cross-studio visibility: the flag, or a global role >= editor).
--   A trashed or unknown level is closed. The creator pass comes first, as in
--   SPEC 3.5.5 step 4.
--
-- THE `p` KEYS (all optional; JSON null reads as absent; unknown keys are
-- ignored; a wrong type raises 22023 naming the key)
--   q                     text; websearch_to_tsquery('simple', dam_unaccent(q))
--                         on search_tsv; ignored when it yields no lexeme
--   filename_like         text; filename ILIKE '%x%' with \ % _ escaped
--   project_ids           uuid[]; + project_mode any (default) | all
--   category_ids          uuid[]
--   studio_ids            uuid[]; a region group also matches its children
--   studio_codes          text[]; dam_studios.code, case-insensitive, region
--                         groups expanded; codes that resolve to nothing
--                         contribute nothing, so all-unknown matches nothing
--   file_kinds            text[] of dam_file_kind labels
--   keyword_ids           uuid[]; + keyword_mode any (default) | all
--   keyword_names         text[]; each lower(name) among live asset-namespace
--                         keywords; ALL names must match; an unresolvable
--                         name matches nothing
--   project_keyword_ids   uuid[]; + project_keyword_mode any (default) | all
--   project_keyword_names text[]; as keyword_names, project namespace
--   path                  text; ingest_relative_path equality
--   path_prefix           text; equality, or LIKE escaped || '/%'
--   statuses              text[] of dam_asset_status labels; narrows only
--   sort                  '-created_at' (default) | 'created_at'
--   limit                 whole number; default search.default_limit,
--                         clamped to 1 .. search.max_limit
--   cursor                {created_at, asset_id}; strictly after, in the sort
--   offset                whole number 0 .. 10000; ignored with a cursor
--   facets                (dam_search_facets only) text[] of facet names
--   An empty array is the same as an absent key. The builder validates the
--   paging keys too, so the three RPCs accept and refuse exactly the same `p`.
--
-- DEPENDS ON
--   20260915000000_baseline.sql: dam_asset_search and its indexes, the
--   baseline identity helpers (dam_current_user_id, dam_current_role,
--   dam_current_studio_ids, dam_has_cross_studio), dam_unaccent.
--   20260923120000_p1_grants_settings_principals.sql: dam_setting_int() and
--   the seeded search.default_limit and search.max_limit.
--   20260923120100_p1_identity_helpers.sql: dam_has_grant().
--   20260923120200_p1_search_row.sql: the search rows themselves (written by
--   dam_rebuild_asset_search_batch, backfilled by dam_reindex_stale), the
--   ingest_relative_path column and the (created_at desc, asset_id desc)
--   keyset index this file orders by.
--   Nothing in 20260923120300_p1_taxonomy_integrity.sql is read here.
--
-- HOW IT IS APPLIED
--   Forward-only. The user applies it with `supabase db push`; it is never
--   edited once applied (write a new migration instead). The CLI runs each file
--   as one implicit transaction, so there is no begin/commit here. Re-running
--   it is harmless: every function is `create or replace` with an unchanged
--   signature, and grants and revokes are idempotent. It writes no rows.
--   Until the search rows are backfilled (scripts/v2-backfill-search.mjs) the
--   RPCs return nothing, because they read only dam_asset_search.
--
-- DELIBERATE CHOICES (recorded in supabase/migrations/README.md)
--   * dam_can_read_asset() and the base-table policies are unchanged (contract
--     deviation 9); these RPCs are the read path the app uses.
--   * min_role is compared with the global role (SPEC 3.7.6's text, FACTS
--     C10), whereas dam_level_satisfied() uses the per-studio effective role.
--     They differ only for a user whose studio role_override lifts them over a
--     grant_only floor; none exists today.
--   * The embargo test is written null-safe (no embargo, or one ending on or
--     before today, or an editor there). The one-line form in FACTS 7.2,
--     `not (embargo_until > current_date and not elevated)`, is null for a row
--     with no embargo and would hide it.
--   * keyword_names in the result are the distinct names of the direct live
--     asset-namespace links, ordered by their highest weight, then name.
--   * project_names and project_codes are aligned: element i of each is the
--     same linked project, ordered by link created_at then link id, so
--     project_codes holds null for a project with no code.
--   * updated_at in the result is the asset's own (dam_assets.updated_at): the
--     search row's copy is capped at now() and moved by stale marks.
--   * offset outside 0 .. 10000 raises 22023 rather than being clamped: a
--     clamped offset would silently repeat a page. Deep pages use the cursor
--     (TRAP T19).
--   * Under service_role or empty claims the RPCs return nothing (no `sub`).
-- =============================================================================

set search_path = public, extensions, pg_catalog;


-- =============================================================================
-- 1. The shared builder
-- =============================================================================
-- Validates p, reads the caller once and returns the WHERE clause for alias
-- `s` (dam_asset_search) as SQL text: the visibility predicate AND every
-- filter, each parenthesised. It returns 'false' when there is no caller with
-- a role, so the RPCs return nothing without a special case. Every value is
-- embedded with %L and cast; nothing supplied by the caller reaches the text
-- through %s. Paging keys (sort, limit, cursor, offset) are validated here but
-- applied by dam_search_assets(). service_role only: the RPCs call it as
-- their owner.
create or replace function dam_search_sql_where(p jsonb)
returns text
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_p               jsonb := coalesce(p, '{}'::jsonb);
  -- LIKE's default escape character. chr(92) keeps a literal backslash out of
  -- the source, so the body does not depend on standard_conforming_strings.
  v_bs              constant text := chr(92);
  v_key             text;
  v_val             jsonb;
  v_text            text;
  v_mode            text;
  v_ids             uuid[];
  v_names           text[];
  v_name            text;
  v_tsq             tsquery;
  v_parts           text[] := array[]::text[];
  -- caller context, read once
  v_me              uuid;
  v_role            dam_role;
  v_studios         uuid[];
  v_cross           boolean;
  v_editor_studios  uuid[];
  v_granted         uuid[];
  v_open_levels     uuid[];
  v_studio_levels   uuid[];
  v_elevated        text;
  v_level_ok        text;
begin
  if jsonb_typeof(v_p) = 'null' then
    v_p := '{}'::jsonb;
  end if;
  if jsonb_typeof(v_p) <> 'object' then
    raise exception 'dam_search: p must be a JSON object'
      using errcode = '22023';
  end if;

  -- ---------------------------------------------------------------------------
  -- 1a. Validation. JSON null reads as absent. Nested IFs, not AND/OR chains,
  --     so an element test never runs on a value of the wrong type.
  -- ---------------------------------------------------------------------------
  foreach v_key in array array['q', 'filename_like', 'path', 'path_prefix'] loop
    v_val := v_p -> v_key;
    continue when v_val is null or jsonb_typeof(v_val) = 'null';
    if jsonb_typeof(v_val) <> 'string' then
      raise exception 'dam_search: p.% must be a string', v_key
        using errcode = '22023';
    end if;
  end loop;

  foreach v_key in array array['project_mode', 'keyword_mode', 'project_keyword_mode'] loop
    v_val := v_p -> v_key;
    continue when v_val is null or jsonb_typeof(v_val) = 'null';
    if jsonb_typeof(v_val) <> 'string' then
      raise exception 'dam_search: p.% must be "any" or "all"', v_key
        using errcode = '22023';
    end if;
    if (v_val #>> '{}') not in ('any', 'all') then
      raise exception 'dam_search: p.% must be "any" or "all"', v_key
        using errcode = '22023';
    end if;
  end loop;

  foreach v_key in array array['project_ids', 'category_ids', 'studio_ids', 'keyword_ids', 'project_keyword_ids'] loop
    v_val := v_p -> v_key;
    continue when v_val is null or jsonb_typeof(v_val) = 'null';
    if jsonb_typeof(v_val) <> 'array' then
      raise exception 'dam_search: p.% must be an array of uuid strings', v_key
        using errcode = '22023';
    end if;
    if exists (select 1
                 from jsonb_array_elements(v_val) as e (x)
                where jsonb_typeof(e.x) <> 'string') then
      raise exception 'dam_search: p.% must be an array of uuid strings', v_key
        using errcode = '22023';
    end if;
    if exists (select 1
                 from jsonb_array_elements_text(v_val) as e (x)
                where not pg_input_is_valid(e.x, 'uuid')) then
      raise exception 'dam_search: p.% must be an array of uuid strings', v_key
        using errcode = '22023';
    end if;
  end loop;

  foreach v_key in array array['studio_codes', 'keyword_names', 'project_keyword_names', 'file_kinds', 'statuses'] loop
    v_val := v_p -> v_key;
    continue when v_val is null or jsonb_typeof(v_val) = 'null';
    if jsonb_typeof(v_val) <> 'array' then
      raise exception 'dam_search: p.% must be an array of strings', v_key
        using errcode = '22023';
    end if;
    if exists (select 1
                 from jsonb_array_elements(v_val) as e (x)
                where jsonb_typeof(e.x) <> 'string') then
      raise exception 'dam_search: p.% must be an array of strings', v_key
        using errcode = '22023';
    end if;
    if v_key = 'file_kinds'
       and exists (select 1
                     from jsonb_array_elements_text(v_val) as e (x)
                    where not pg_input_is_valid(e.x, 'public.dam_file_kind')) then
      raise exception 'dam_search: p.file_kinds must be an array of dam_file_kind labels'
        using errcode = '22023';
    end if;
    if v_key = 'statuses'
       and exists (select 1
                     from jsonb_array_elements_text(v_val) as e (x)
                    where not pg_input_is_valid(e.x, 'public.dam_asset_status')) then
      raise exception 'dam_search: p.statuses must be an array of dam_asset_status labels'
        using errcode = '22023';
    end if;
  end loop;

  v_val := v_p -> 'sort';
  if v_val is not null and jsonb_typeof(v_val) <> 'null' then
    if jsonb_typeof(v_val) <> 'string' then
      raise exception 'dam_search: p.sort must be "-created_at" or "created_at"'
        using errcode = '22023';
    end if;
    if (v_val #>> '{}') not in ('-created_at', 'created_at') then
      raise exception 'dam_search: p.sort must be "-created_at" or "created_at"'
        using errcode = '22023';
    end if;
  end if;

  v_val := v_p -> 'limit';
  if v_val is not null and jsonb_typeof(v_val) <> 'null' then
    if jsonb_typeof(v_val) <> 'number' then
      raise exception 'dam_search: p.limit must be a whole number'
        using errcode = '22023';
    end if;
    if (v_val #>> '{}')::numeric <> trunc((v_val #>> '{}')::numeric) then
      raise exception 'dam_search: p.limit must be a whole number'
        using errcode = '22023';
    end if;
  end if;

  v_val := v_p -> 'offset';
  if v_val is not null and jsonb_typeof(v_val) <> 'null' then
    if jsonb_typeof(v_val) <> 'number' then
      raise exception 'dam_search: p.offset must be a whole number from 0 to 10000'
        using errcode = '22023';
    end if;
    if (v_val #>> '{}')::numeric <> trunc((v_val #>> '{}')::numeric)
       or (v_val #>> '{}')::numeric < 0
       or (v_val #>> '{}')::numeric > 10000 then
      raise exception 'dam_search: p.offset must be a whole number from 0 to 10000'
        using errcode = '22023';
    end if;
  end if;

  v_val := v_p -> 'cursor';
  if v_val is not null and jsonb_typeof(v_val) <> 'null' then
    if jsonb_typeof(v_val) <> 'object' then
      raise exception 'dam_search: p.cursor must be an object {created_at, asset_id}'
        using errcode = '22023';
    end if;
    if jsonb_typeof(v_val -> 'created_at') is distinct from 'string'
       or jsonb_typeof(v_val -> 'asset_id') is distinct from 'string' then
      raise exception 'dam_search: p.cursor must be an object {created_at, asset_id}'
        using errcode = '22023';
    end if;
    if not pg_input_is_valid(v_val ->> 'created_at', 'timestamptz')
       or not pg_input_is_valid(v_val ->> 'asset_id', 'uuid') then
      raise exception 'dam_search: p.cursor must be an object {created_at, asset_id}'
        using errcode = '22023';
    end if;
  end if;

  -- ---------------------------------------------------------------------------
  -- 1b. The caller, read once (FACTS search.md 7.2). No sub or no role:
  --     nothing is visible (SPEC 3.5.5 step 3).
  -- ---------------------------------------------------------------------------
  v_me := dam_current_user_id();
  if v_me is null then
    return 'false';
  end if;
  v_role := dam_current_role();
  if v_role is null then
    return 'false';
  end if;

  if v_role >= 'global_admin'::dam_role then
    v_parts := v_parts || 's.deleted_at is null'::text;
  else
    v_studios := coalesce(dam_current_studio_ids(), array[]::uuid[]);
    v_cross := coalesce(dam_has_cross_studio(), false) or v_role >= 'editor'::dam_role;

    -- Studios where a live membership lifts the caller to editor or above; a
    -- region-group membership covers the group and its children.
    v_editor_studios := array(
      select distinct st.id
        from dam_user_studios us
        join dam_studios st
          on st.id = us.studio_id
          or st.parent_studio_id = us.studio_id
       where us.user_id = v_me
         and us.deleted_at is null
         and st.deleted_at is null
         and us.role_override >= 'editor'::dam_role
       order by st.id);

    -- Live levels the caller holds a live grant of (dam_has_grant: direct, or
    -- a live membership of a live, active group; unexpired).
    v_granted := array(
      select al.id
        from dam_access_levels al
       where al.deleted_at is null
         and dam_has_grant(al.id, v_me)
       order by al.id);

    -- Levels open without any studio test, and studio levels that still need
    -- one. A level in neither list (trashed, grant_only without grant or
    -- below its floor, role below min_role) is closed.
    v_open_levels := array(
      select al.id
        from dam_access_levels al
       where al.deleted_at is null
         and ((al.scope <> 'grant_only'::dam_access_scope and al.id = any (v_granted))
              or (al.scope = 'firm'::dam_access_scope and v_role >= al.min_role)
              or (al.scope = 'grant_only'::dam_access_scope
                  and al.id = any (v_granted)
                  and v_role >= al.min_role))
       order by al.id);
    v_studio_levels := array(
      select al.id
        from dam_access_levels al
       where al.deleted_at is null
         and al.scope = 'studio'::dam_access_scope
         and v_role >= al.min_role
         and not (al.id = any (v_granted))
       order by al.id);

    if v_role >= 'editor'::dam_role then
      v_elevated := 'true';
    elsif cardinality(v_editor_studios) > 0 then
      v_elevated := format('s.studio_ids && %L::uuid[]', v_editor_studios);
    else
      v_elevated := 'false';
    end if;

    if v_cross then
      v_level_ok := format('s.access_level_id = any (%L::uuid[])',
                           v_open_levels || v_studio_levels);
    else
      v_level_ok := format(
        '(s.access_level_id = any (%L::uuid[]) or (s.access_level_id = any (%L::uuid[]) and (s.studio_ids = ''{}''::uuid[] or s.studio_ids && %L::uuid[])))',
        v_open_levels, v_studio_levels, v_studios);
    end if;

    v_parts := v_parts || format(
      's.deleted_at is null and (s.created_by = %L::uuid or ((s.status in (''approved'', ''published'') or %s) and (s.embargo_until is null or s.embargo_until <= current_date or %s) and %s))',
      v_me, v_elevated, v_elevated, v_level_ok);
  end if;

  -- ---------------------------------------------------------------------------
  -- 1c. Filters. Validated above, so the casts below cannot fail.
  -- ---------------------------------------------------------------------------

  -- q: full text. Punctuation-only input yields no lexeme and is ignored
  -- (TRAP T18); the query side folds accents like the index side (C17).
  v_text := v_p ->> 'q';
  if v_text is not null then
    v_tsq := websearch_to_tsquery('simple', dam_unaccent(v_text));
    if numnode(v_tsq) > 0 then
      v_parts := v_parts || format('s.search_tsv @@ %L::tsquery', v_tsq::text);
    end if;
  end if;

  -- filename_like: v1 parity (ILIKE '%q%' on the name), wildcards escaped.
  v_text := v_p ->> 'filename_like';
  if v_text is not null then
    v_parts := v_parts || format('s.filename ilike %L',
      '%' || replace(replace(replace(v_text, v_bs, v_bs || v_bs), '%', v_bs || '%'), '_', v_bs || '_') || '%');
  end if;

  -- project_ids + project_mode
  if jsonb_typeof(v_p -> 'project_ids') = 'array' then
    v_ids := array(select e.x::uuid from jsonb_array_elements_text(v_p -> 'project_ids') as e (x));
    v_mode := coalesce(v_p ->> 'project_mode', 'any');
    if cardinality(v_ids) > 0 then
      v_parts := v_parts || format(
        case when v_mode = 'all' then 's.project_ids @> %L::uuid[]' else 's.project_ids && %L::uuid[]' end,
        v_ids);
    end if;
  end if;

  -- category_ids
  if jsonb_typeof(v_p -> 'category_ids') = 'array' then
    v_ids := array(select e.x::uuid from jsonb_array_elements_text(v_p -> 'category_ids') as e (x));
    if cardinality(v_ids) > 0 then
      v_parts := v_parts || format('s.category_id = any (%L::uuid[])', v_ids);
    end if;
  end if;

  -- studio_ids: a region group also matches its live children (D-443).
  if jsonb_typeof(v_p -> 'studio_ids') = 'array' then
    v_ids := array(select e.x::uuid from jsonb_array_elements_text(v_p -> 'studio_ids') as e (x));
    if cardinality(v_ids) > 0 then
      v_ids := array(
        select x.id
          from unnest(v_ids) as x (id)
        union
        select ch.id
          from dam_studios ch
         where ch.parent_studio_id = any (v_ids)
           and ch.deleted_at is null
        order by 1);
      v_parts := v_parts || format('s.studio_ids && %L::uuid[]', v_ids);
    end if;
  end if;

  -- studio_codes: live studios by code (case-insensitive), region groups
  -- expanded to their live children. Nothing resolved matches nothing.
  if jsonb_typeof(v_p -> 'studio_codes') = 'array' then
    v_names := array(select lower(btrim(e.x)) from jsonb_array_elements_text(v_p -> 'studio_codes') as e (x));
    if cardinality(v_names) > 0 then
      v_ids := array(
        select st.id
          from dam_studios st
         where st.deleted_at is null
           and lower(st.code) = any (v_names)
        union
        select ch.id
          from dam_studios ch
          join dam_studios st
            on st.id = ch.parent_studio_id
         where ch.deleted_at is null
           and st.deleted_at is null
           and lower(st.code) = any (v_names)
        order by 1);
      if cardinality(v_ids) = 0 then
        v_parts := v_parts || 'false'::text;
      else
        v_parts := v_parts || format('s.studio_ids && %L::uuid[]', v_ids);
      end if;
    end if;
  end if;

  -- file_kinds
  if jsonb_typeof(v_p -> 'file_kinds') = 'array' then
    v_names := array(select e.x from jsonb_array_elements_text(v_p -> 'file_kinds') as e (x));
    if cardinality(v_names) > 0 then
      v_parts := v_parts || format('s.file_kind = any (%L::dam_file_kind[])', v_names);
    end if;
  end if;

  -- keyword_ids + keyword_mode (ancestor-expanded column, so a parent id
  -- matches its subtree).
  if jsonb_typeof(v_p -> 'keyword_ids') = 'array' then
    v_ids := array(select e.x::uuid from jsonb_array_elements_text(v_p -> 'keyword_ids') as e (x));
    v_mode := coalesce(v_p ->> 'keyword_mode', 'any');
    if cardinality(v_ids) > 0 then
      v_parts := v_parts || format(
        case when v_mode = 'all' then 's.asset_keyword_ids @> %L::uuid[]' else 's.asset_keyword_ids && %L::uuid[]' end,
        v_ids);
    end if;
  end if;

  -- keyword_names: every name must match; a name may resolve to several
  -- keywords (the same name in two trees), any of which will do.
  if jsonb_typeof(v_p -> 'keyword_names') = 'array' then
    for v_name in
      select distinct lower(btrim(e.x))
        from jsonb_array_elements_text(v_p -> 'keyword_names') as e (x)
    loop
      v_ids := array(
        select k.id
          from dam_keywords k
         where k.deleted_at is null
           and k.namespace = 'asset'::dam_keyword_namespace
           and lower(btrim(k.name)) = v_name
         order by k.id);
      if cardinality(v_ids) = 0 then
        v_parts := v_parts || 'false'::text;
      else
        v_parts := v_parts || format('s.asset_keyword_ids && %L::uuid[]', v_ids);
      end if;
    end loop;
  end if;

  -- project_keyword_ids + project_keyword_mode
  if jsonb_typeof(v_p -> 'project_keyword_ids') = 'array' then
    v_ids := array(select e.x::uuid from jsonb_array_elements_text(v_p -> 'project_keyword_ids') as e (x));
    v_mode := coalesce(v_p ->> 'project_keyword_mode', 'any');
    if cardinality(v_ids) > 0 then
      v_parts := v_parts || format(
        case when v_mode = 'all' then 's.project_keyword_ids @> %L::uuid[]' else 's.project_keyword_ids && %L::uuid[]' end,
        v_ids);
    end if;
  end if;

  -- project_keyword_names: as keyword_names, project namespace.
  if jsonb_typeof(v_p -> 'project_keyword_names') = 'array' then
    for v_name in
      select distinct lower(btrim(e.x))
        from jsonb_array_elements_text(v_p -> 'project_keyword_names') as e (x)
    loop
      v_ids := array(
        select k.id
          from dam_keywords k
         where k.deleted_at is null
           and k.namespace = 'project'::dam_keyword_namespace
           and lower(btrim(k.name)) = v_name
         order by k.id);
      if cardinality(v_ids) = 0 then
        v_parts := v_parts || 'false'::text;
      else
        v_parts := v_parts || format('s.project_keyword_ids && %L::uuid[]', v_ids);
      end if;
    end loop;
  end if;

  -- path: the folder itself.
  v_text := v_p ->> 'path';
  if v_text is not null then
    v_parts := v_parts || format('s.ingest_relative_path = %L', v_text);
  end if;

  -- path_prefix: the folder or anything under it on a '/' boundary, with the
  -- caller's % and _ taken literally.
  v_text := v_p ->> 'path_prefix';
  if v_text is not null then
    v_parts := v_parts || format('(s.ingest_relative_path = %L or s.ingest_relative_path like %L)',
      v_text,
      replace(replace(replace(v_text, v_bs, v_bs || v_bs), '%', v_bs || '%'), '_', v_bs || '_') || '/%');
  end if;

  -- statuses: narrows the visible set, never widens it.
  if jsonb_typeof(v_p -> 'statuses') = 'array' then
    v_names := array(select e.x from jsonb_array_elements_text(v_p -> 'statuses') as e (x));
    if cardinality(v_names) > 0 then
      v_parts := v_parts || format('s.status = any (%L::dam_asset_status[])', v_names);
    end if;
  end if;

  return '(' || array_to_string(v_parts, ') and (') || ')';
end;
$$;

comment on function dam_search_sql_where(jsonb) is
  'Private builder for the search RPCs: validates p (22023 naming the key), reads the caller once and returns the SPEC 3.5.5 visibility predicate AND the p filters as SQL text over alias s (dam_asset_search), values embedded with %L. ''false'' when there is no caller with a role. service_role only.';


-- =============================================================================
-- 2. dam_search_assets: one page
-- =============================================================================
-- The filter, sort and LIMIT touch dam_asset_search only; the fields the v1
-- grid needs that the search row does not carry are joined AFTER the limit
-- (FACTS search.md 9.4), inside this SECURITY DEFINER function, so no second
-- read runs the base-table policies (which would drop rows this predicate
-- returns).
create or replace function dam_search_assets(p jsonb)
returns table (
  asset_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  filename text,
  title text,
  category_id uuid,
  status dam_asset_status,
  access_level_id uuid,
  file_kind dam_file_kind,
  mime_type text,
  size_bytes bigint,
  project_ids uuid[],
  studio_ids uuid[],
  asset_keyword_ids uuid[],
  project_keyword_ids uuid[],
  rights_status dam_rights_status,
  completeness_score smallint,
  ingest_relative_path text,
  v1_id text,
  object_key text,
  storage_provider dam_storage_provider,
  provider_url text,
  keyword_names text[],
  project_names text[],
  project_codes text[],
  legacy jsonb)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_p       jsonb := coalesce(p, '{}'::jsonb);
  v_where   text;
  v_desc    boolean;
  v_dir     text;
  v_max     numeric;
  v_limit   numeric;
  v_offset  integer := 0;
begin
  -- Validates every key (including the paging keys used below) and reads the
  -- caller; 'false' when there is none.
  v_where := dam_search_sql_where(v_p);
  if jsonb_typeof(v_p) = 'null' then
    v_p := '{}'::jsonb;
  end if;

  v_desc := coalesce(v_p ->> 'sort', '-created_at') = '-created_at';
  v_dir := case when v_desc then 'desc' else 'asc' end;

  v_max := greatest(dam_setting_int('search.max_limit'), 1);
  v_limit := coalesce((v_p ->> 'limit')::numeric, dam_setting_int('search.default_limit'));
  v_limit := least(greatest(v_limit, 1), v_max);

  -- Keyset strictly after the cursor in the sort order; the offset is ignored
  -- when a cursor is given.
  if jsonb_typeof(v_p -> 'cursor') = 'object' then
    v_where := v_where || format(' and ((s.created_at, s.asset_id) %s (%L::timestamptz, %L::uuid))',
                                 case when v_desc then '<' else '>' end,
                                 v_p -> 'cursor' ->> 'created_at',
                                 v_p -> 'cursor' ->> 'asset_id');
  else
    v_offset := coalesce(((v_p ->> 'offset')::numeric)::integer, 0);
  end if;

  return query execute format(
    'select pg.asset_id,
            pg.created_at,
            coalesce(a.updated_at, pg.updated_at),
            pg.filename,
            pg.title,
            pg.category_id,
            pg.status,
            pg.access_level_id,
            pg.file_kind,
            pg.mime_type,
            pg.size_bytes,
            pg.project_ids,
            pg.studio_ids,
            pg.asset_keyword_ids,
            pg.project_keyword_ids,
            pg.rights_status,
            pg.completeness_score,
            pg.ingest_relative_path,
            x1.external_id,
            v.object_key,
            sl.provider,
            v.provider_url,
            coalesce(kn.names, array[]::text[]),
            coalesce(pn.names, array[]::text[]),
            coalesce(pn.codes, array[]::text[]),
            jsonb_build_object(
              ''folder_id'', a.legacy -> ''folder_id'',
              ''publish_permission'', a.legacy -> ''publish_permission'',
              ''uploaded_by'', a.legacy -> ''uploaded_by'',
              ''macro_portfolio'', a.legacy -> ''macro_portfolio'',
              ''core_sector'', a.legacy -> ''core_sector'',
              ''sub_sectors'', a.legacy -> ''sub_sectors'')
       from (select s.asset_id, s.created_at, s.updated_at, s.filename, s.title,
                    s.category_id, s.status, s.access_level_id, s.file_kind,
                    s.mime_type, s.size_bytes, s.project_ids, s.studio_ids,
                    s.asset_keyword_ids, s.project_keyword_ids, s.rights_status,
                    s.completeness_score, s.ingest_relative_path
               from dam_asset_search s
              where %s
              order by s.created_at %s, s.asset_id %s
              limit %s offset %s) pg
       left join dam_assets a
         on a.id = pg.asset_id
       left join dam_asset_versions v
         on v.id = a.current_version_id
       left join dam_storage_locations sl
         on sl.id = v.storage_location_id
       left join lateral (
         select e.external_id
           from dam_external_ids e
          where e.target_type = ''asset''
            and e.target_id = pg.asset_id
            and e.system = ''dwp_dam_v1''
            and e.deleted_at is null
          order by e.created_at desc, e.id
          limit 1) x1 on true
       left join lateral (
         select array_agg(kw.name order by kw.weight desc, kw.name) as names
           from (select k.name, max(kl.weight) as weight
                   from dam_keyword_links kl
                   join dam_keywords k
                     on k.id = kl.keyword_id
                    and k.deleted_at is null
                    and k.namespace = ''asset''
                  where kl.target_type = ''asset''
                    and kl.target_id = pg.asset_id
                    and kl.deleted_at is null
                  group by k.name) kw) kn on true
       left join lateral (
         select array_agg(pr.name order by pa.created_at, pa.id) as names,
                array_agg(pr.code order by pa.created_at, pa.id) as codes
           from dam_project_assets pa
           join dam_projects pr
             on pr.id = pa.project_id
            and pr.deleted_at is null
          where pa.asset_id = pg.asset_id
            and pa.deleted_at is null) pn on true
      order by pg.created_at %s, pg.asset_id %s',
    v_where, v_dir, v_dir, v_limit::integer, v_offset, v_dir, v_dir);
end;
$$;

comment on function dam_search_assets(jsonb) is
  'SPEC 3.7.6 search RPC: one page of the caller''s visible assets (SPEC 3.5.5 as a set predicate over dam_asset_search) matching p, ordered created_at then asset_id (desc by default), keyset (p.cursor) or offset paged, hydrated after the limit with v1_id, the current version''s object_key, provider and URL, keyword and project names and a legacy subset. Nothing without a caller with a role.';


-- =============================================================================
-- 3. dam_search_assets_count: the total
-- =============================================================================
-- Same predicate and filters; the paging keys are validated and ignored.
-- Exact up to 50,000 rows, else 50,001 with is_estimate (SPEC 5.3.12).
create or replace function dam_search_assets_count(p jsonb)
returns table (total bigint, is_estimate boolean)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_where text;
  v_n     bigint;
begin
  v_where := dam_search_sql_where(p);
  execute format('select count(*) from (select 1 from dam_asset_search s where %s limit 50001) c', v_where)
     into v_n;
  if v_n > 50000 then
    return query select 50001::bigint, true;
  else
    return query select v_n, false;
  end if;
end;
$$;

comment on function dam_search_assets_count(jsonb) is
  'Total for dam_search_assets(p) without paging: exact up to 50,000 (is_estimate false), else 50,001 with is_estimate true. Nothing (0) without a caller with a role.';


-- =============================================================================
-- 4. dam_search_facets: top 50 per facet
-- =============================================================================
-- p.facets names the groups to count (SPEC 5.3.2: only open groups), from
-- category_id, studio_ids, file_kind, asset_keyword_ids, project_keyword_ids,
-- project_ids, rights_status and status. status is returned only to a caller
-- whose role is editor or above, and is silently left out otherwise. Values
-- are text (uuid or enum label); the API resolves labels. An array facet
-- counts an asset once per element, so a parent keyword's count is its
-- subtree's asset count (the arrays are ancestor-expanded). Rows come back in
-- the order the facets were asked for, then count desc, then value.
create or replace function dam_search_facets(p jsonb)
returns table (facet text, value text, count bigint)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_p         jsonb := coalesce(p, '{}'::jsonb);
  v_where     text;
  v_val       jsonb;
  v_facet     text;
  v_ord       integer := 0;
  v_editor    boolean;
  v_branches  text[] := array[]::text[];
  v_allowed   constant text[] := array['category_id', 'studio_ids', 'file_kind', 'asset_keyword_ids',
                                       'project_keyword_ids', 'project_ids', 'rights_status', 'status'];
  v_arrays    constant text[] := array['studio_ids', 'asset_keyword_ids', 'project_keyword_ids', 'project_ids'];
begin
  v_where := dam_search_sql_where(v_p);
  if jsonb_typeof(v_p) = 'null' then
    v_p := '{}'::jsonb;
  end if;

  v_val := v_p -> 'facets';
  if v_val is null or jsonb_typeof(v_val) = 'null' then
    return;
  end if;
  if jsonb_typeof(v_val) <> 'array' then
    raise exception 'dam_search: p.facets must be an array of facet names'
      using errcode = '22023';
  end if;
  if exists (select 1
               from jsonb_array_elements(v_val) as e (x)
              where jsonb_typeof(e.x) <> 'string') then
    raise exception 'dam_search: p.facets must be an array of facet names'
      using errcode = '22023';
  end if;
  if exists (select 1
               from jsonb_array_elements_text(v_val) as e (x)
              where not (e.x = any (v_allowed))) then
    raise exception 'dam_search: p.facets may name only %', array_to_string(v_allowed, ', ')
      using errcode = '22023';
  end if;

  v_editor := coalesce(dam_current_role() >= 'editor'::dam_role, false);

  -- Each facet once, in the order first asked for.
  for v_facet in
    select e.x
      from jsonb_array_elements_text(v_val) with ordinality as e (x, n)
     group by e.x
     order by min(e.n)
  loop
    continue when v_facet = 'status' and not v_editor;
    v_ord := v_ord + 1;
    if v_facet = any (v_arrays) then
      v_branches := v_branches || format(
        '(select %L::text as facet, u.v::text as value, count(*)::bigint as n, %s as ord
            from m
            cross join lateral unnest(m.%I) as u (v)
           where u.v is not null
           group by u.v
           order by count(*) desc, u.v::text collate "C"
           limit 50)',
        v_facet, v_ord, v_facet);
    else
      v_branches := v_branches || format(
        '(select %L::text as facet, m.%I::text as value, count(*)::bigint as n, %s as ord
            from m
           where m.%I is not null
           group by m.%I
           order by count(*) desc, m.%I::text collate "C"
           limit 50)',
        v_facet, v_facet, v_ord, v_facet, v_facet, v_facet);
    end if;
  end loop;

  if cardinality(v_branches) = 0 then
    return;
  end if;

  return query execute format(
    'with m as materialized (
       select s.category_id, s.studio_ids, s.file_kind, s.asset_keyword_ids,
              s.project_keyword_ids, s.project_ids, s.rights_status, s.status
         from dam_asset_search s
        where %s)
     select u.facet, u.value, u.n
       from (%s) u
      order by u.ord, u.n desc, u.value collate "C"',
    v_where, array_to_string(v_branches, ' union all '));
end;
$$;

comment on function dam_search_facets(jsonb) is
  'Facet counts for dam_search_assets(p): top 50 values per facet named in p.facets (category_id, studio_ids, file_kind, asset_keyword_ids, project_keyword_ids, project_ids, rights_status, status), count desc then value; status only for editor and above. Same predicate and filters; paging keys ignored.';


-- =============================================================================
-- 5. Function privileges (explicit, per function; never the baseline's
--    all-functions loop)
-- =============================================================================

-- The builder: service_role only. The RPCs call it as its owner.
revoke all on function public.dam_search_sql_where(jsonb) from public, anon, authenticated;
grant execute on function public.dam_search_sql_where(jsonb) to service_role;

-- The RPCs: any signed-in principal and the service role, never anon. The
-- predicate inside decides what a caller sees.
revoke all on function public.dam_search_assets(jsonb) from public, anon;
grant execute on function public.dam_search_assets(jsonb) to authenticated, service_role;

revoke all on function public.dam_search_assets_count(jsonb) from public, anon;
grant execute on function public.dam_search_assets_count(jsonb) to authenticated, service_role;

revoke all on function public.dam_search_facets(jsonb) from public, anon;
grant execute on function public.dam_search_facets(jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';
