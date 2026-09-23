-- =============================================================================
-- 20260923120200_p1_search_row.sql
-- Phase 1, migration 3 of 5 — v2 (project-based DAM) behaviour layer.
--
-- PURPOSE
--   The writer side of dam_asset_search (SPEC 2.23). The applied schema has
--   the table and its indexes but nothing that writes a row, so every search
--   row is missing today. This file adds:
--     1. dam_asset_search.ingest_relative_path (a copy of the asset's ingest
--        path; the v1 folder navigation filters on it) with a prefix index,
--        and the (created_at desc, asset_id desc) keyset index the search RPC
--        orders by (the baseline's index is asset_id ASC, TRAP T3).
--     2. dam_rebuild_asset_search_batch(uuid[]): ONE set-based
--        INSERT ... SELECT ... ON CONFLICT (asset_id) DO UPDATE that projects
--        every column of the row from the base tables, and the SPEC-named
--        single-asset wrapper dam_rebuild_asset_search(uuid).
--     3. dam_mark_search_stale(uuid[]) and dam_reindex_stale(integer): a stale
--        mark plus a drain. The drain also creates rows that do not exist yet,
--        so it is the backfill mechanism for the 34,949 imported assets
--        (scripts/v2-backfill-search.mjs loops it until it returns 0).
--     4. Reindex triggers. Asset- and project-scoped changes rebuild the
--        affected rows synchronously, in the writing transaction; category and
--        keyword changes, which can touch most of the library, only mark rows
--        stale and leave the rebuild to the drain.
--     5. A pg_cron schedule that runs the drain every minute.
--
-- DEPENDS ON
--   20260915000000_baseline.sql (tables, indexes, dam_unaccent,
--   dam_rights_status). Applied after 20260923120000 (table grants) and
--   20260923120100 (identity helpers). Nothing here calls either of them, but
--   dam_asset_studio_ids() and dam_asset_effective_level() in 120100 compute,
--   live, exactly what this file stores in studio_ids and access_level_id; a
--   change to one side must be made to the other. The search RPCs in 120400
--   read only the columns written here.
--
-- HOW IT IS APPLIED
--   Forward-only. The user applies it with `supabase db push`; it is never
--   edited once applied (write a new migration instead). The CLI runs each file
--   as one implicit transaction, so there is no begin/commit here. Re-running
--   it is harmless: functions are `create or replace`, triggers are dropped
--   before they are created, the column and indexes use `if not exists`, and
--   cron.schedule() replaces a job of the same name. It writes no search rows:
--   run the backfill script afterwards.
--
-- SESSION SWITCH
--   Every reindex trigger returns at once when the session sets
--   `dam.skip_search_row = 'on'`. Only service-role bulk scripts use it, and
--   they then call dam_rebuild_asset_search_batch() themselves (or let the
--   drain pick the rows up), so an import costs one rebuild pass instead of one
--   per trigger firing (D-588, TRAP T8).
--
-- DELIBERATE DEVIATIONS FROM SPEC (recorded in supabase/migrations/README.md)
--   * Reindexing is synchronous for asset- and project-scoped changes and
--     stale-plus-cron for category and keyword changes. There is no worker, so
--     SPEC's reindex_asset / reindex_project jobs would never run (TRAP T7);
--     pg_cron runs dam_reindex_stale(), not dam_enqueue_job(), and the
--     baseline's dam_queue_reindex_asset() stays defined but unattached (T6).
--   * project_keyword_ids ignores the D-483 override. The seeded Space Type ->
--     Sector pairing would drop the inherited sectors of about half the
--     project-linked library (TRAP T9); until the user decides, project
--     keywords are additive.
--   * dam_asset_search.ingest_relative_path is added.
--   * completeness_score is computed here per D-012, never read from (or
--     written back to) dam_assets.completeness_score, which nothing maintains.
--   * The row's updated_at is the asset's updated_at capped at now(), so a
--     rebuild always leaves the row fresh (indexed_at >= updated_at) and the
--     drain always converges, even for an asset whose updated_at was written
--     in the future.
--   * dam_mark_search_stale() stamps clock_timestamp(), not now(), so a mark
--     made later in the same transaction as a rebuild still makes the row
--     stale (with now() the two stamps would be equal and the mark lost).
-- =============================================================================

set search_path = public, extensions, pg_catalog;


-- =============================================================================
-- 1. Column and indexes
-- =============================================================================

alter table dam_asset_search add column if not exists ingest_relative_path text;

comment on column dam_asset_search.ingest_relative_path is
  'Copy of dam_assets.ingest_relative_path (the v1 folder path) so the v1 folder navigation can filter the search row without joining the asset. Ingest metadata only, never an organising unit.';

-- Exact folder and `folder/%` prefix filters.
create index if not exists dam_asset_search_ingest_relative_path_idx
  on dam_asset_search (ingest_relative_path text_pattern_ops);

-- The search RPC orders by (created_at desc, asset_id desc); the baseline's
-- dam_asset_search_created_at_idx is (created_at desc, asset_id ASC), which
-- cannot serve that order as one range scan.
create index if not exists dam_asset_search_created_at_asset_id_desc_idx
  on dam_asset_search (created_at desc, asset_id desc);


-- =============================================================================
-- 2. The rebuild
-- =============================================================================
-- Column sources (FACTS search.md section 2 and 5.3). L = live links
-- (dam_project_assets.deleted_at is null) to live projects
-- (dam_projects.deleted_at is null). P1 = the primary project: the earliest
-- link, then the lowest code, then the link id.
--   studio_ids       union of L's home studios and live contributing studios,
--                    distinct ascending; when that is empty the asset's own
--                    studio_id; else '{}'. Same as dam_asset_studio_ids().
--   access_level_id  explicit level; else the most restrictive level among L
--                    (scope desc, min_role desc, id); else the category's.
--                    Same as dam_asset_effective_level(). Never null.
--   asset_keyword_ids   live asset links to live asset-namespace keywords,
--                    expanded with every live ancestor (walked on parent_id,
--                    never descendant_ids, which is empty on every row).
--   project_keyword_ids live links of L's projects to live project-namespace
--                    keywords, ancestors included, no D-483 override.
--   search_tsv       A: filename (also with . _ - read as spaces, T20), title,
--                    L's codes. B: caption, names of both expanded keyword
--                    sets, L's names, L's client names, category name.
--                    C: L's text blocks (title and approved body), L's
--                    employees, the photographer. D: OCR text of the current
--                    version, first 200,000 characters. Every part is
--                    coalesced before dam_unaccent(), which is STRICT (T10).
--   completeness_score  D-012: project link 25, category 10, >= 3 direct
--                    asset keywords 20, caption >= 20 chars 15, a rights row
--                    stating a restriction 20, a photographer 10.
--   facet_fields     D-245 reserved keys: city (P1's, omitted when null),
--                    project_status and project_codes (arrays over L), missing.
-- The rows are written in asset_id order, and dam_mark_search_stale() locks in
-- the same order, so two concurrent writers of overlapping row sets queue
-- instead of deadlocking.
create or replace function dam_rebuild_asset_search_batch(p_asset_ids uuid[])
returns integer
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
set timezone = 'UTC'
as $$
declare
  v_count integer := 0;
begin
  if p_asset_ids is null or cardinality(p_asset_ids) = 0 then
    return 0;
  end if;

  insert into dam_asset_search (
    asset_id, created_at, updated_at, created_by, deleted_at, indexed_at,
    search_tsv, trigram_text, filename, title,
    asset_keyword_ids, project_ids, project_keyword_ids, studio_ids, client_ids,
    hero_of_project_ids, is_hero_anywhere,
    category_id, photographer_id, country_code, captured_on,
    orientation, long_edge_px, megapixels,
    size_bytes, file_kind, mime_type,
    rights_status, embargo_until, colour_buckets,
    rating_avg, rating_count, completeness_score,
    status, access_level_id, sha256, phash,
    has_embedding, has_ocr, has_rights, has_gps,
    ingest_batch_id, facet_fields, ingest_relative_path)
  select
    a.id,
    a.created_at,
    least(a.updated_at, now()),
    a.created_by,
    a.deleted_at,
    now(),
    setweight(to_tsvector('simple', dam_unaccent(coalesce(concat_ws(' ',
        a.filename,
        regexp_replace(a.filename, '[._-]+', ' ', 'g'),
        a.title,
        nullif(array_to_string(pl.codes, ' '), '')), ''))), 'A')
      || setweight(to_tsvector('simple', dam_unaccent(coalesce(concat_ws(' ',
        a.caption,
        ak.names,
        pk.names,
        pl.names,
        cl.names,
        c.name), ''))), 'B')
      || setweight(to_tsvector('simple', dam_unaccent(coalesce(concat_ws(' ',
        tb.texts,
        emp.names,
        ph.name), ''))), 'C')
      || setweight(to_tsvector('simple', dam_unaccent(coalesce(oc.body, ''))), 'D'),
    lower(dam_unaccent(coalesce(concat_ws(' ',
        a.filename,
        a.title,
        nullif(array_to_string(pl.codes, ' '), ''),
        pl.names), ''))),
    a.filename,
    a.title,
    ak.ids,
    pl.project_ids,
    pk.ids,
    case
      when cardinality(st.ids) > 0 then st.ids
      when a.studio_id is not null then array[a.studio_id]
      else array[]::uuid[]
    end,
    pl.client_ids,
    pl.hero_ids,
    cardinality(pl.hero_ids) > 0,
    a.category_id,
    coalesce(r.photographer_id, a.photographer_id),
    pl.country_code,
    (a.captured_at at time zone 'UTC')::date,
    a.orientation,
    a.long_edge_px,
    a.megapixels,
    a.size_bytes,
    a.file_kind,
    a.mime_type,
    dam_rights_status(a.id),
    greatest(r.embargo_until, pl.confidential_until),
    a.colour_buckets,
    rt.avg_rating,
    rt.n_ratings,
    ((case when cardinality(pl.project_ids) > 0 then 25 else 0 end)
     + (case when a.category_id is not null then 10 else 0 end)
     + (case when akd.n >= 3 then 20 else 0 end)
     + (case when coalesce(length(a.caption), 0) >= 20 then 15 else 0 end)
     + (case when r.restriction is not null then 20 else 0 end)
     + (case when coalesce(r.photographer_id, a.photographer_id) is not null then 10 else 0 end)
    )::smallint,
    a.status,
    coalesce(a.access_level_id, lv.id, c.access_level_id),
    v.sha256,
    v.phash,
    exists (
      select 1
        from dam_asset_embeddings e
       where e.asset_id = a.id
         and e.deleted_at is null
         and (e.image_embedding is not null or e.text_embedding is not null)),
    oc.n_pages > 0,
    r.id is not null,
    a.gps_latitude is not null,
    a.ingest_batch_id,
    jsonb_strip_nulls(jsonb_build_object(
      'city', pl.city,
      'project_status', to_jsonb(pl.statuses),
      'project_codes', to_jsonb(pl.codes),
      'missing', to_jsonb(array_remove(array[
        case when cardinality(pl.project_ids) = 0 then 'project' end,
        case when akd.n < 3 then 'keywords' end,
        case when coalesce(length(a.caption), 0) < 20 then 'caption' end,
        case when r.restriction is null then 'rights' end,
        case when coalesce(r.photographer_id, a.photographer_id) is null then 'photographer' end,
        case when a.category_id is null then 'category' end
      ]::text[], null)))),
    a.ingest_relative_path
  from dam_assets a
  left join dam_asset_versions v
    on v.id = a.current_version_id
  left join dam_categories c
    on c.id = a.category_id
  -- L, aggregated once per asset.
  left join lateral (
    select
      coalesce(array_agg(distinct x.project_id order by x.project_id), array[]::uuid[]) as project_ids,
      coalesce(array_agg(distinct x.client_id order by x.client_id)
                 filter (where x.client_id is not null), array[]::uuid[]) as client_ids,
      coalesce(array_agg(distinct x.project_id order by x.project_id)
                 filter (where x.is_hero), array[]::uuid[]) as hero_ids,
      coalesce(array_agg(distinct x.studio_id order by x.studio_id)
                 filter (where x.studio_id is not null), array[]::uuid[]) as home_studio_ids,
      coalesce(array_agg(distinct x.access_level_id order by x.access_level_id), array[]::uuid[]) as level_ids,
      coalesce(array_agg(distinct x.code order by x.code)
                 filter (where x.code is not null), array[]::text[]) as codes,
      coalesce(array_agg(distinct x.status::text order by x.status::text), array[]::text[]) as statuses,
      string_agg(x.name, ' ' order by x.linked_at, x.link_id) as names,
      max(x.confidential_until) as confidential_until,
      (array_agg(x.country_code order by x.linked_at, x.code nulls last, x.link_id))[1] as country_code,
      (array_agg(x.city order by x.linked_at, x.code nulls last, x.link_id))[1] as city
    from (
      select pa.project_id, pa.is_hero, pa.created_at as linked_at, pa.id as link_id,
             p.code, p.name, p.client_id, p.studio_id, p.access_level_id, p.status,
             p.country_code, p.city, p.confidential_until
        from dam_project_assets pa
        join dam_projects p
          on p.id = pa.project_id
         and p.deleted_at is null
       where pa.asset_id = a.id
         and pa.deleted_at is null
    ) x
  ) pl on true
  -- Home plus live contributing studios of L.
  left join lateral (
    select coalesce(array_agg(distinct u.studio_id order by u.studio_id), array[]::uuid[]) as ids
      from (
        select h.studio_id
          from unnest(pl.home_studio_ids) as h (studio_id)
        union all
        select ps.studio_id
          from dam_project_studios ps
         where ps.project_id = any(pl.project_ids)
           and ps.deleted_at is null
      ) u
     where u.studio_id is not null
  ) st on true
  -- The most restrictive of L's levels (D-362).
  left join lateral (
    select l.id
      from dam_access_levels l
     where l.id = any(pl.level_ids)
     order by l.scope desc, l.min_role desc, l.id
     limit 1
  ) lv on true
  -- Asset keywords, ancestor-expanded (D-244).
  left join lateral (
    with recursive kw (id, parent_id, name) as (
      select k.id, k.parent_id, k.name
        from dam_keyword_links kl
        join dam_keywords k
          on k.id = kl.keyword_id
       where kl.target_type = 'asset'
         and kl.target_id = a.id
         and kl.deleted_at is null
         and k.deleted_at is null
         and k.namespace = 'asset'
      union
      select k.id, k.parent_id, k.name
        from kw
        join dam_keywords k
          on k.id = kw.parent_id
       where k.deleted_at is null
         and k.namespace = 'asset'
    )
    select coalesce(array_agg(distinct kw.id order by kw.id), array[]::uuid[]) as ids,
           string_agg(kw.name, ' ' order by kw.name, kw.id) as names
      from kw
  ) ak on true
  -- Direct asset keywords only, for the completeness checklist.
  left join lateral (
    select count(*) as n
      from dam_keyword_links kl
      join dam_keywords k
        on k.id = kl.keyword_id
     where kl.target_type = 'asset'
       and kl.target_id = a.id
       and kl.deleted_at is null
       and k.deleted_at is null
       and k.namespace = 'asset'
  ) akd on true
  -- Project keywords of L, ancestor-expanded, additive (no D-483 override).
  left join lateral (
    with recursive kw (id, parent_id, name) as (
      select k.id, k.parent_id, k.name
        from dam_keyword_links kl
        join dam_keywords k
          on k.id = kl.keyword_id
       where kl.target_type = 'project'
         and kl.target_id = any(pl.project_ids)
         and kl.deleted_at is null
         and k.deleted_at is null
         and k.namespace = 'project'
      union
      select k.id, k.parent_id, k.name
        from kw
        join dam_keywords k
          on k.id = kw.parent_id
       where k.deleted_at is null
         and k.namespace = 'project'
    )
    select coalesce(array_agg(distinct kw.id order by kw.id), array[]::uuid[]) as ids,
           string_agg(kw.name, ' ' order by kw.name, kw.id) as names
      from kw
  ) pk on true
  -- Client names of L.
  left join lateral (
    select string_agg(cc.name, ' ' order by cc.name, cc.id) as names
      from dam_clients cc
     where cc.id = any(pl.client_ids)
       and cc.deleted_at is null
  ) cl on true
  -- The live rights row (one per asset by partial unique index).
  left join lateral (
    select ar.id, ar.photographer_id, ar.embargo_until, ar.restriction
      from dam_asset_rights ar
     where ar.asset_id = a.id
       and ar.deleted_at is null
     order by ar.created_at desc, ar.id
     limit 1
  ) r on true
  left join dam_photographers ph
    on ph.id = coalesce(r.photographer_id, a.photographer_id)
  -- Ratings aggregate (D-326).
  left join lateral (
    select coalesce(round(avg(rr.rating), 2), 0)::numeric(3,2) as avg_rating,
           count(*)::integer as n_ratings
      from dam_ratings rr
     where rr.asset_id = a.id
       and rr.deleted_at is null
  ) rt on true
  -- Text blocks on L's projects: title plus the approved current version.
  left join lateral (
    select left(string_agg(concat_ws(' ', t.title, tv.body), ' ' order by t.id), 200000) as texts
      from dam_text_blocks t
      left join dam_text_block_versions tv
        on tv.id = t.current_version_id
       and tv.deleted_at is null
     where t.target_type = 'project'
       and t.target_id = any(pl.project_ids)
       and t.deleted_at is null
  ) tb on true
  -- People on L's projects.
  left join lateral (
    select string_agg(distinct e.display_name, ' ' order by e.display_name) as names
      from dam_project_employees pe
      join dam_employees e
        on e.id = pe.employee_id
       and e.deleted_at is null
     where pe.project_id = any(pl.project_ids)
       and pe.deleted_at is null
  ) emp on true
  -- OCR of the current version, first 200,000 characters (D-243).
  left join lateral (
    select left(string_agg(o.text, ' ' order by o.page, o.id), 200000) as body,
           count(*) as n_pages
      from dam_asset_ocr_text o
     where o.version_id = a.current_version_id
       and o.deleted_at is null
  ) oc on true
  where a.id = any(p_asset_ids)
  order by a.id
  on conflict (asset_id) do update set
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    created_by = excluded.created_by,
    deleted_at = excluded.deleted_at,
    indexed_at = now(),
    search_tsv = excluded.search_tsv,
    trigram_text = excluded.trigram_text,
    filename = excluded.filename,
    title = excluded.title,
    asset_keyword_ids = excluded.asset_keyword_ids,
    project_ids = excluded.project_ids,
    project_keyword_ids = excluded.project_keyword_ids,
    studio_ids = excluded.studio_ids,
    client_ids = excluded.client_ids,
    hero_of_project_ids = excluded.hero_of_project_ids,
    is_hero_anywhere = excluded.is_hero_anywhere,
    category_id = excluded.category_id,
    photographer_id = excluded.photographer_id,
    country_code = excluded.country_code,
    captured_on = excluded.captured_on,
    orientation = excluded.orientation,
    long_edge_px = excluded.long_edge_px,
    megapixels = excluded.megapixels,
    size_bytes = excluded.size_bytes,
    file_kind = excluded.file_kind,
    mime_type = excluded.mime_type,
    rights_status = excluded.rights_status,
    embargo_until = excluded.embargo_until,
    colour_buckets = excluded.colour_buckets,
    rating_avg = excluded.rating_avg,
    rating_count = excluded.rating_count,
    completeness_score = excluded.completeness_score,
    status = excluded.status,
    access_level_id = excluded.access_level_id,
    sha256 = excluded.sha256,
    phash = excluded.phash,
    has_embedding = excluded.has_embedding,
    has_ocr = excluded.has_ocr,
    has_rights = excluded.has_rights,
    has_gps = excluded.has_gps,
    ingest_batch_id = excluded.ingest_batch_id,
    facet_fields = excluded.facet_fields,
    ingest_relative_path = excluded.ingest_relative_path;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function dam_rebuild_asset_search_batch(uuid[]) is
  'Writes the dam_asset_search rows of the given assets in one INSERT ... SELECT ... ON CONFLICT (asset_id) DO UPDATE and returns the number written. Ids of assets that no longer exist are skipped (their row went with the asset, on delete cascade). service_role only.';

-- The SPEC name (2.23): one asset.
create or replace function dam_rebuild_asset_search(p_asset_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform dam_rebuild_asset_search_batch(array[p_asset_id]);
end;
$$;

comment on function dam_rebuild_asset_search(uuid) is
  'SPEC 2.23 writer for one asset; calls dam_rebuild_asset_search_batch(). service_role only.';


-- =============================================================================
-- 3. Stale mark and drain
-- =============================================================================

-- Marks existing rows stale (indexed_at < updated_at) so the drain rebuilds
-- them. Rows already stale keep their mark, so the drain's oldest-first order
-- is preserved. Rows that do not exist yet are found by the drain anyway.
-- Locks are taken in asset_id order, as the rebuild takes them.
create or replace function dam_mark_search_stale(p_asset_ids uuid[])
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  if p_asset_ids is null or cardinality(p_asset_ids) = 0 then
    return 0;
  end if;

  with target as (
    select s.asset_id
      from dam_asset_search s
     where s.asset_id = any(p_asset_ids)
       and s.updated_at <= s.indexed_at
     order by s.asset_id
       for update
  )
  update dam_asset_search s
     set updated_at = clock_timestamp()
    from target t
   where s.asset_id = t.asset_id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function dam_mark_search_stale(uuid[]) is
  'Marks the search rows of the given assets stale for dam_reindex_stale(). Stamps clock_timestamp() so a mark made after a rebuild in the same transaction still counts. Returns the rows marked. service_role only.';

-- Rebuilds up to p_limit assets: first those with no search row at all
-- (oldest asset first), then stale rows (oldest rebuild first, through the
-- baseline's partial index dam_asset_search_indexed_at_idx). Returns the
-- number rebuilt, 0 when nothing is left, so a caller can loop it to finish a
-- backfill. A rebuild always leaves its row fresh, so the loop terminates.
-- Concurrent drains (cron plus the backfill script) queue on one advisory
-- lock rather than rebuilding the same rows twice.
create or replace function dam_reindex_stale(p_limit integer default 1000)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(coalesce(p_limit, 1000), 0);
  v_ids uuid[] := array[]::uuid[];
begin
  if v_limit = 0 then
    return 0;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('dam_reindex_stale', 0));

  v_ids := array(
    select a.id
      from dam_assets a
     where not exists (
             select 1
               from dam_asset_search s
              where s.asset_id = a.id)
     order by a.created_at, a.id
     limit v_limit);

  if cardinality(v_ids) < v_limit then
    v_ids := v_ids || array(
      select s.asset_id
        from dam_asset_search s
       where s.indexed_at < s.updated_at
       order by s.indexed_at, s.asset_id
       limit v_limit - cardinality(v_ids));
  end if;

  if cardinality(v_ids) = 0 then
    return 0;
  end if;
  return dam_rebuild_asset_search_batch(v_ids);
end;
$$;

comment on function dam_reindex_stale(integer) is
  'Drain and backfill: rebuilds up to p_limit assets with no search row or a stale one (indexed_at < updated_at), missing rows first, and returns the number rebuilt. Scheduled every minute by pg_cron as dam-reindex-stale. service_role only.';


-- =============================================================================
-- 4. Reindex triggers
-- =============================================================================
-- All AFTER ... FOR EACH STATEMENT with transition tables (one rebuild call
-- per statement, however many rows it touched), except the keyword trigger,
-- which is FOR EACH ROW with a WHEN clause so that a change to descendant_ids
-- alone never fires it. One trigger per event: transition tables cannot be
-- combined with a column list, so the functions compare old and new rows
-- themselves where only some columns matter. Every function honours the
-- dam.skip_search_row session switch.

-- dam_assets INSERT, UPDATE: rebuild the rows' own ids. A DELETE takes the
-- search row with it (on delete cascade), so there is nothing to do.
create or replace function dam_search_reindex_assets()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if current_setting('dam.skip_search_row', true) = 'on' then
    return null;
  end if;
  perform dam_rebuild_asset_search_batch(array(select distinct n.id from new_rows n));
  return null;
end;
$$;

comment on function dam_search_reindex_assets() is
  'Statement trigger on dam_assets (insert, update): rebuilds the changed assets'' search rows.';

-- dam_asset_versions, dam_project_assets, dam_asset_rights, dam_ratings: every
-- one carries asset_id, so one function serves all four; old and new ids are
-- both rebuilt (a link moved between assets changes both).
create or replace function dam_search_reindex_by_asset_id()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_ids uuid[] := array[]::uuid[];
begin
  if current_setting('dam.skip_search_row', true) = 'on' then
    return null;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_ids := v_ids || array(select n.asset_id from new_rows n);
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    v_ids := v_ids || array(select o.asset_id from old_rows o);
  end if;
  perform dam_rebuild_asset_search_batch(array(select distinct x.id from unnest(v_ids) as x (id)));
  return null;
end;
$$;

comment on function dam_search_reindex_by_asset_id() is
  'Statement trigger on dam_asset_versions, dam_project_assets, dam_asset_rights and dam_ratings: rebuilds the search rows of every asset_id in the old and new rows.';

-- dam_keyword_links: asset targets rebuild the asset; project targets rebuild
-- the project's live linked assets; employee targets have no search row.
create or replace function dam_search_reindex_keyword_links()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_ids uuid[] := array[]::uuid[];
begin
  if current_setting('dam.skip_search_row', true) = 'on' then
    return null;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_ids := v_ids || array(
      select n.target_id
        from new_rows n
       where n.target_type = 'asset'
      union
      select pa.asset_id
        from new_rows n
        join dam_project_assets pa
          on pa.project_id = n.target_id
         and pa.deleted_at is null
       where n.target_type = 'project');
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    v_ids := v_ids || array(
      select o.target_id
        from old_rows o
       where o.target_type = 'asset'
      union
      select pa.asset_id
        from old_rows o
        join dam_project_assets pa
          on pa.project_id = o.target_id
         and pa.deleted_at is null
       where o.target_type = 'project');
  end if;
  perform dam_rebuild_asset_search_batch(array(select distinct x.id from unnest(v_ids) as x (id)));
  return null;
end;
$$;

comment on function dam_search_reindex_keyword_links() is
  'Statement trigger on dam_keyword_links: rebuilds asset targets, and the live linked assets of project targets.';

-- dam_projects UPDATE, DELETE: rebuild the live linked assets of every project
-- whose searchable columns changed (or that was deleted). A hard delete also
-- cascades to dam_project_assets, whose own trigger rebuilds the assets.
create or replace function dam_search_reindex_projects()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_projects uuid[] := array[]::uuid[];
begin
  if current_setting('dam.skip_search_row', true) = 'on' then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    v_projects := array(
      select n.id
        from new_rows n
        join old_rows o
          on o.id = n.id
       where (o.name, o.code, o.client_id, o.studio_id, o.access_level_id, o.status,
              o.country_code, o.city, o.confidential_until, o.deleted_at)
             is distinct from
             (n.name, n.code, n.client_id, n.studio_id, n.access_level_id, n.status,
              n.country_code, n.city, n.confidential_until, n.deleted_at));
  elsif tg_op = 'DELETE' then
    v_projects := array(select o.id from old_rows o);
  end if;
  if cardinality(v_projects) = 0 then
    return null;
  end if;
  perform dam_rebuild_asset_search_batch(array(
    select distinct pa.asset_id
      from dam_project_assets pa
     where pa.project_id = any(v_projects)
       and pa.deleted_at is null));
  return null;
end;
$$;

comment on function dam_search_reindex_projects() is
  'Statement trigger on dam_projects (update, delete): rebuilds the live linked assets of projects whose searchable columns changed.';

-- dam_project_studios INSERT, UPDATE, DELETE: rebuild the live linked assets
-- of the projects in the old and new rows (their studio_ids change).
create or replace function dam_search_reindex_project_studios()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_projects uuid[] := array[]::uuid[];
begin
  if current_setting('dam.skip_search_row', true) = 'on' then
    return null;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_projects := v_projects || array(select n.project_id from new_rows n);
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    v_projects := v_projects || array(select o.project_id from old_rows o);
  end if;
  if cardinality(v_projects) = 0 then
    return null;
  end if;
  perform dam_rebuild_asset_search_batch(array(
    select distinct pa.asset_id
      from dam_project_assets pa
     where pa.project_id = any(v_projects)
       and pa.deleted_at is null));
  return null;
end;
$$;

comment on function dam_search_reindex_project_studios() is
  'Statement trigger on dam_project_studios: rebuilds the live linked assets of the affected projects.';

-- dam_categories UPDATE: a category can hold most of the library, so its
-- assets are only marked stale; the drain rebuilds them.
create or replace function dam_search_stale_categories()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_categories uuid[] := array[]::uuid[];
begin
  if current_setting('dam.skip_search_row', true) = 'on' then
    return null;
  end if;
  v_categories := array(
    select n.id
      from new_rows n
      join old_rows o
        on o.id = n.id
     where (o.name, o.access_level_id, o.deleted_at)
           is distinct from
           (n.name, n.access_level_id, n.deleted_at));
  if cardinality(v_categories) = 0 then
    return null;
  end if;
  perform dam_mark_search_stale(array(
    select a.id
      from dam_assets a
     where a.category_id = any(v_categories)));
  return null;
end;
$$;

comment on function dam_search_stale_categories() is
  'Statement trigger on dam_categories (update): marks stale the search rows of categories whose name, level or trash state changed.';

-- dam_keywords UPDATE of name, parent_id, deleted_at or merged_into_keyword_id
-- (the trigger's WHEN clause): the keyword's name or ancestry reaches every
-- asset linked to it or to any descendant, directly or through a project, so
-- those rows are marked stale for the drain.
create or replace function dam_search_stale_keywords()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if current_setting('dam.skip_search_row', true) = 'on' then
    return null;
  end if;
  perform dam_mark_search_stale(array(
    with recursive sub (id) as (
      select new.id
      union
      select k.id
        from dam_keywords k
        join sub
          on k.parent_id = sub.id
    )
    select kl.target_id
      from dam_keyword_links kl
     where kl.keyword_id in (select sub.id from sub)
       and kl.target_type = 'asset'
       and kl.deleted_at is null
    union
    select pa.asset_id
      from dam_keyword_links kl
      join dam_project_assets pa
        on pa.project_id = kl.target_id
       and pa.deleted_at is null
     where kl.keyword_id in (select sub.id from sub)
       and kl.target_type = 'project'
       and kl.deleted_at is null));
  return null;
end;
$$;

comment on function dam_search_stale_keywords() is
  'Row trigger on dam_keywords (update of name, parent_id, deleted_at, merged_into_keyword_id): marks stale the search rows of assets linked to the keyword or a descendant, directly or through a project.';

-- dam_assets
drop trigger if exists trg_dam_assets_search_insert on dam_assets;
create trigger trg_dam_assets_search_insert
  after insert on dam_assets
  referencing new table as new_rows
  for each statement execute function dam_search_reindex_assets();

drop trigger if exists trg_dam_assets_search_update on dam_assets;
create trigger trg_dam_assets_search_update
  after update on dam_assets
  referencing old table as old_rows new table as new_rows
  for each statement execute function dam_search_reindex_assets();

-- dam_asset_versions
drop trigger if exists trg_dam_asset_versions_search_insert on dam_asset_versions;
create trigger trg_dam_asset_versions_search_insert
  after insert on dam_asset_versions
  referencing new table as new_rows
  for each statement execute function dam_search_reindex_by_asset_id();

drop trigger if exists trg_dam_asset_versions_search_update on dam_asset_versions;
create trigger trg_dam_asset_versions_search_update
  after update on dam_asset_versions
  referencing old table as old_rows new table as new_rows
  for each statement execute function dam_search_reindex_by_asset_id();

drop trigger if exists trg_dam_asset_versions_search_delete on dam_asset_versions;
create trigger trg_dam_asset_versions_search_delete
  after delete on dam_asset_versions
  referencing old table as old_rows
  for each statement execute function dam_search_reindex_by_asset_id();

-- dam_project_assets
drop trigger if exists trg_dam_project_assets_search_insert on dam_project_assets;
create trigger trg_dam_project_assets_search_insert
  after insert on dam_project_assets
  referencing new table as new_rows
  for each statement execute function dam_search_reindex_by_asset_id();

drop trigger if exists trg_dam_project_assets_search_update on dam_project_assets;
create trigger trg_dam_project_assets_search_update
  after update on dam_project_assets
  referencing old table as old_rows new table as new_rows
  for each statement execute function dam_search_reindex_by_asset_id();

drop trigger if exists trg_dam_project_assets_search_delete on dam_project_assets;
create trigger trg_dam_project_assets_search_delete
  after delete on dam_project_assets
  referencing old table as old_rows
  for each statement execute function dam_search_reindex_by_asset_id();

-- dam_keyword_links
drop trigger if exists trg_dam_keyword_links_search_insert on dam_keyword_links;
create trigger trg_dam_keyword_links_search_insert
  after insert on dam_keyword_links
  referencing new table as new_rows
  for each statement execute function dam_search_reindex_keyword_links();

drop trigger if exists trg_dam_keyword_links_search_update on dam_keyword_links;
create trigger trg_dam_keyword_links_search_update
  after update on dam_keyword_links
  referencing old table as old_rows new table as new_rows
  for each statement execute function dam_search_reindex_keyword_links();

drop trigger if exists trg_dam_keyword_links_search_delete on dam_keyword_links;
create trigger trg_dam_keyword_links_search_delete
  after delete on dam_keyword_links
  referencing old table as old_rows
  for each statement execute function dam_search_reindex_keyword_links();

-- dam_projects
drop trigger if exists trg_dam_projects_search_update on dam_projects;
create trigger trg_dam_projects_search_update
  after update on dam_projects
  referencing old table as old_rows new table as new_rows
  for each statement execute function dam_search_reindex_projects();

drop trigger if exists trg_dam_projects_search_delete on dam_projects;
create trigger trg_dam_projects_search_delete
  after delete on dam_projects
  referencing old table as old_rows
  for each statement execute function dam_search_reindex_projects();

-- dam_project_studios
drop trigger if exists trg_dam_project_studios_search_insert on dam_project_studios;
create trigger trg_dam_project_studios_search_insert
  after insert on dam_project_studios
  referencing new table as new_rows
  for each statement execute function dam_search_reindex_project_studios();

drop trigger if exists trg_dam_project_studios_search_update on dam_project_studios;
create trigger trg_dam_project_studios_search_update
  after update on dam_project_studios
  referencing old table as old_rows new table as new_rows
  for each statement execute function dam_search_reindex_project_studios();

drop trigger if exists trg_dam_project_studios_search_delete on dam_project_studios;
create trigger trg_dam_project_studios_search_delete
  after delete on dam_project_studios
  referencing old table as old_rows
  for each statement execute function dam_search_reindex_project_studios();

-- dam_asset_rights
drop trigger if exists trg_dam_asset_rights_search_insert on dam_asset_rights;
create trigger trg_dam_asset_rights_search_insert
  after insert on dam_asset_rights
  referencing new table as new_rows
  for each statement execute function dam_search_reindex_by_asset_id();

drop trigger if exists trg_dam_asset_rights_search_update on dam_asset_rights;
create trigger trg_dam_asset_rights_search_update
  after update on dam_asset_rights
  referencing old table as old_rows new table as new_rows
  for each statement execute function dam_search_reindex_by_asset_id();

drop trigger if exists trg_dam_asset_rights_search_delete on dam_asset_rights;
create trigger trg_dam_asset_rights_search_delete
  after delete on dam_asset_rights
  referencing old table as old_rows
  for each statement execute function dam_search_reindex_by_asset_id();

-- dam_ratings
drop trigger if exists trg_dam_ratings_search_insert on dam_ratings;
create trigger trg_dam_ratings_search_insert
  after insert on dam_ratings
  referencing new table as new_rows
  for each statement execute function dam_search_reindex_by_asset_id();

drop trigger if exists trg_dam_ratings_search_update on dam_ratings;
create trigger trg_dam_ratings_search_update
  after update on dam_ratings
  referencing old table as old_rows new table as new_rows
  for each statement execute function dam_search_reindex_by_asset_id();

drop trigger if exists trg_dam_ratings_search_delete on dam_ratings;
create trigger trg_dam_ratings_search_delete
  after delete on dam_ratings
  referencing old table as old_rows
  for each statement execute function dam_search_reindex_by_asset_id();

-- dam_categories
drop trigger if exists trg_dam_categories_search_update on dam_categories;
create trigger trg_dam_categories_search_update
  after update on dam_categories
  referencing old table as old_rows new table as new_rows
  for each statement execute function dam_search_stale_categories();

-- dam_keywords (row level, so the WHEN clause can ignore descendant_ids)
drop trigger if exists trg_dam_keywords_search_update on dam_keywords;
create trigger trg_dam_keywords_search_update
  after update on dam_keywords
  for each row
  when (old.name is distinct from new.name
        or old.parent_id is distinct from new.parent_id
        or old.deleted_at is distinct from new.deleted_at
        or old.merged_into_keyword_id is distinct from new.merged_into_keyword_id)
  execute function dam_search_stale_keywords();


-- =============================================================================
-- 5. pg_cron: drain every minute
-- =============================================================================
-- pg_cron is created by the baseline on Supabase. The second test is for a
-- database without the extension but with a stand-in cron.schedule() (the
-- local test harness); where neither exists the schedule is skipped and the
-- drain must be run by hand or by the backfill script.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     or to_regprocedure('cron.schedule(text, text, text)') is not null then
    perform cron.schedule('dam-reindex-stale', '* * * * *', 'select public.dam_reindex_stale(2000)');
  end if;
end;
$$;


-- =============================================================================
-- 6. Function privileges (explicit, per function)
-- =============================================================================

-- Writers: service_role only. SECURITY DEFINER writers left callable by anon
-- or authenticated would be a write hole (TRAP T4).
revoke all on function public.dam_rebuild_asset_search_batch(uuid[]) from public, anon, authenticated;
grant execute on function public.dam_rebuild_asset_search_batch(uuid[]) to service_role;

revoke all on function public.dam_rebuild_asset_search(uuid) from public, anon, authenticated;
grant execute on function public.dam_rebuild_asset_search(uuid) to service_role;

revoke all on function public.dam_mark_search_stale(uuid[]) from public, anon, authenticated;
grant execute on function public.dam_mark_search_stale(uuid[]) to service_role;

revoke all on function public.dam_reindex_stale(integer) from public, anon, authenticated;
grant execute on function public.dam_reindex_stale(integer) to service_role;

-- Trigger functions: nobody.
revoke all on function public.dam_search_reindex_assets() from public, anon, authenticated;
revoke all on function public.dam_search_reindex_by_asset_id() from public, anon, authenticated;
revoke all on function public.dam_search_reindex_keyword_links() from public, anon, authenticated;
revoke all on function public.dam_search_reindex_projects() from public, anon, authenticated;
revoke all on function public.dam_search_reindex_project_studios() from public, anon, authenticated;
revoke all on function public.dam_search_stale_categories() from public, anon, authenticated;
revoke all on function public.dam_search_stale_keywords() from public, anon, authenticated;

notify pgrst, 'reload schema';
