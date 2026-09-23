-- =============================================================================
-- 20260923120300_p1_taxonomy_integrity.sql
-- Phase 1, migration 4 of 5 — v2 (project-based DAM) behaviour layer.
--
-- PURPOSE
--   The integrity triggers the applied schema documents but never attached
--   (SCHEMA.sql:12139-12148 defers them to "the phase migrations"), for the
--   three tables every v2 keyword and v1-id lookup goes through:
--     1. dam_keyword_links and dam_external_ids address their target by
--        (target_type, target_id) and so cannot carry a foreign key. The
--        baseline's dam_assert_target_exists() and
--        dam_assert_keyword_namespace() are attached here, unchanged, with
--        column lists that keep a soft-delete cascade (which SETs only
--        deleted_at and deleted_by) from tripping them (SPEC 2.11, 2.29).
--     2. trg_dam_keyword_links_exclusive: at most one live keyword from an
--        exclusive category (Time of Day, View, Colour Mood) per target
--        (D-222), serialised by an advisory lock because no unique index can
--        express a rule whose category lives on another table.
--     3. trg_dam_external_ids_immutable: system and external_id never change;
--        a re-pointed id is a delete plus an insert, so the audit log shows it.
--     4. Keyword path maintenance (SPEC 2.9): trg_dam_keywords_path derives
--        slug, namespace, path and depth and refuses what would break the
--        tree; trg_dam_keywords_propagate rewrites a moved or renamed node's
--        subtree and keeps descendant_ids on root rows (D-223).
--     5. The descendant_ids backfill: the importers never set the column, so
--        the three Sector roots that have children hold '{}' today.
--     6. Assertions that the imported data satisfies every rule above, so a
--        violation aborts this file instead of surfacing on a later write.
--
-- DEPENDS ON
--   20260915000000_baseline.sql (the tables, the two assert functions,
--   dam_unaccent, dam_set_updated_at, dam_audit_row). Applied after 20260923120000
--   (table grants), 20260923120100 (identity helpers) and 20260923120200 (search
--   row). It calls nothing from those files. It relies on one property of
--   120200: trg_dam_keywords_search_update fires only when name, parent_id,
--   deleted_at or merged_into_keyword_id changes, so neither the subtree
--   rewrite here (path and depth) nor the descendant_ids backfill marks any
--   search row stale; the stale marking for a rename or move comes from
--   120200's trigger on the node itself, which walks the subtree by parent_id.
--
-- HOW IT IS APPLIED
--   Forward-only. The user applies it with `supabase db push`; it is never
--   edited once applied (write a new migration instead). The CLI runs each file
--   as one implicit transaction, so there is no begin/commit here. Re-running
--   it is harmless: functions are `create or replace`, triggers are dropped
--   before they are created, the backfill only touches rows whose cached
--   value differs, and the assertions only read. On v2 the backfill updates 3
--   rows (workplace, lifestyle, community) and so writes 3 audit rows, tagged
--   with request_id 'migration:20260923120300_p1_taxonomy_integrity'.
--
-- DECISIONS (where SPEC is silent, contradicts itself, or cannot be built)
--   * SPEC's single dam_assert_keyword_target(keyword_id, target_type,
--     target_id) raising P0002 does not exist; the baseline's two zero-argument
--     functions do the same checks and raise 23503 (missing or trashed target,
--     missing keyword) and 23514 (namespace mismatch). They are attached as
--     they are, as two triggers. Neither is SECURITY DEFINER, so for an
--     authenticated writer they see the target through its read policy: a
--     target the writer cannot read is reported as missing.
--   * The exclusive guard raises 23505 (unique_violation): the rule is a
--     uniqueness rule per (target, category). A second link to the SAME keyword
--     is left to dam_keyword_links_keyword_target_key, so an idempotent
--     `insert ... on conflict do nothing` of an existing link still succeeds.
--   * SPEC's `AFTER UPDATE OF path` cannot work: a column list ignores changes
--     made by BEFORE triggers, and path is always changed by
--     trg_dam_keywords_path, never by the caller. trg_dam_keywords_propagate
--     therefore fires on the columns the CALLER sets to move, rename or trash a
--     node (parent_id, slug, name, path, depth, deleted_at) and compares old
--     and new itself.
--   * The subtree is found by walking parent_id, not by `path LIKE`: paths are
--     unique among live rows only, so a trashed subtree can share a prefix
--     with a live one. The rewrite recomputes every descendant's path from the
--     tree (trashed descendants included, so a restore finds a correct path).
--   * A rename re-derives slug (and so the subtree's paths) when name changed
--     and slug did not, as SPEC 5.2.2 "Rename-with-propagation" describes.
--   * Moving a node that has children to another category is refused until the
--     "Move to category" operation (which must move the whole subtree) exists.
--   * pg_trigger_depth() > 1 alone would also skip a legitimate keyword update
--     issued from inside some other trigger, so the nested-firing guard also
--     requires the transaction-local marker dam.keyword_propagation = 'on',
--     which only the subtree rewrite sets, around its own UPDATE.
-- =============================================================================

set search_path = public, extensions, pg_catalog;


-- =============================================================================
-- 1. Polymorphic target guards: the baseline's functions, attached
-- =============================================================================
-- `update of <cols>` fires whenever a listed column is in the SET list, even
-- unchanged, and never for a column the statement does not name. So the
-- future soft-delete cascade, which must SET only deleted_at and deleted_by,
-- passes these guards after its target has been trashed (FACTS integrity 5.2),
-- while an insert or any re-pointing of a link or an id is checked.
--
-- BEFORE triggers on dam_keyword_links fire in name order: assert_namespace,
-- assert_target, exclusive, then the baseline's trg_keyword_links_updated_at.
-- The exclusive guard runs last, so a link that is wrong for a simpler reason
-- reports that reason.

drop trigger if exists trg_dam_keyword_links_assert_namespace on dam_keyword_links;
create trigger trg_dam_keyword_links_assert_namespace
  before insert or update of keyword_id, target_type on dam_keyword_links
  for each row execute function dam_assert_keyword_namespace();

drop trigger if exists trg_dam_keyword_links_assert_target on dam_keyword_links;
create trigger trg_dam_keyword_links_assert_target
  before insert or update of target_type, target_id on dam_keyword_links
  for each row execute function dam_assert_target_exists();

drop trigger if exists trg_dam_external_ids_assert_target on dam_external_ids;
create trigger trg_dam_external_ids_assert_target
  before insert or update of target_type, target_id on dam_external_ids
  for each row execute function dam_assert_target_exists();


-- =============================================================================
-- 2. Exclusive keyword categories (D-222)
-- =============================================================================
-- A trashed link is never a violation, and an update that leaves a live link's
-- keyword and target as they were cannot create one, so both return at once:
-- a row that predates a category becoming exclusive can still be edited. A
-- restore (deleted_at back to null) is checked, which is why deleted_at is in
-- the trigger's column list.
--
-- SECURITY DEFINER: the check must see every live link of the target, not only
-- those the writer's read policy shows. The advisory lock is per (target,
-- category), so two transactions adding different Time of Day values to one
-- asset queue instead of both passing. Rows inserted earlier by the same
-- statement are visible here (a BEFORE ROW trigger's queries see them), so a
-- multi-row insert carrying two values is caught on the second row.
create or replace function dam_keyword_links_exclusive()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_category uuid;
  v_exclusive boolean;
  v_other uuid;
begin
  if new.deleted_at is not null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.deleted_at is null
     and new.keyword_id = old.keyword_id
     and new.target_type = old.target_type
     and new.target_id = old.target_id then
    return new;
  end if;

  select k.category_id, c.is_exclusive
    into v_category, v_exclusive
    from dam_keywords k
    join dam_keyword_categories c
      on c.id = k.category_id
   where k.id = new.keyword_id;
  -- A missing keyword is reported by trg_dam_keyword_links_assert_namespace.
  if not found or not v_exclusive then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'dam_keyword_links_exclusive:' || new.target_type::text || ':'
      || new.target_id::text || ':' || v_category::text, 0));

  select l.keyword_id
    into v_other
    from dam_keyword_links l
    join dam_keywords k
      on k.id = l.keyword_id
   where l.target_type = new.target_type
     and l.target_id = new.target_id
     and l.deleted_at is null
     and l.id is distinct from new.id
     and l.keyword_id <> new.keyword_id
     and k.category_id = v_category
   limit 1;
  if found then
    raise exception 'dam: % % already has keyword % from exclusive keyword category %; remove it before adding keyword %',
      new.target_type, new.target_id, v_other, v_category, new.keyword_id
      using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;

comment on function dam_keyword_links_exclusive() is
  'Trigger on dam_keyword_links (D-222): refuses a second live link from an is_exclusive keyword category to the same target (23505). Serialised per (target, category) by an advisory lock.';

drop trigger if exists trg_dam_keyword_links_exclusive on dam_keyword_links;
create trigger trg_dam_keyword_links_exclusive
  before insert or update of keyword_id, target_type, target_id, deleted_at on dam_keyword_links
  for each row execute function dam_keyword_links_exclusive();


-- =============================================================================
-- 3. External ids are immutable (SPEC 2.29)
-- =============================================================================
-- Reads only the row, so it needs no privilege the writer lacks: not SECURITY
-- DEFINER. Rewriting a column with its own value is allowed (a full-row upsert
-- names every column).
create or replace function dam_external_ids_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.system is distinct from old.system
     or new.external_id is distinct from old.external_id then
    raise exception 'dam: external id % (% %) cannot be changed; soft-delete it and insert a new one',
      old.id, old.system, old.external_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function dam_external_ids_immutable() is
  'Trigger on dam_external_ids (SPEC 2.29): system and external_id never change (23514); a re-pointed id is a delete plus an insert, so the audit log shows the move.';

drop trigger if exists trg_dam_external_ids_immutable on dam_external_ids;
create trigger trg_dam_external_ids_immutable
  before update of system, external_id on dam_external_ids
  for each row execute function dam_external_ids_immutable();


-- =============================================================================
-- 4. Keyword trees: the subtree cache
-- =============================================================================
-- The ONE definition of a root's descendant_ids (D-223), used by the
-- propagation trigger and by the backfill below: every live row below the node,
-- found by walking parent_id, ordered by path. The node itself is excluded;
-- consumers add it. The walk goes through trashed intermediate rows, which is
-- what `path LIKE root.path || '/%' and deleted_at is null` means on a
-- consistent tree. It stops after five levels, the deepest a tree can be
-- (D-484), so even a corrupted parent chain cannot make it loop.
create or replace function dam_keyword_descendant_ids(p_keyword_id uuid)
returns uuid[]
language sql
stable
set search_path = public, pg_temp
as $$
  with recursive sub (id, lvl) as (
    select k.id, 1
      from dam_keywords k
     where k.parent_id = p_keyword_id
    union all
    select k.id, sub.lvl + 1
      from dam_keywords k
      join sub
        on k.parent_id = sub.id
     where sub.lvl < 5
  )
  select coalesce(array_agg(k.id order by k.path, k.id), array[]::uuid[])
    from sub
    join dam_keywords k
      on k.id = sub.id
   where k.deleted_at is null;
$$;

comment on function dam_keyword_descendant_ids(uuid) is
  'Live descendants of a keyword (walked on parent_id, ordered by path), excluding the keyword itself: the value dam_keywords.descendant_ids caches on root rows (D-223).';


-- =============================================================================
-- 5. Keyword trees: trg_dam_keywords_path (SPEC 2.9)
-- =============================================================================
-- BEFORE INSERT, and BEFORE UPDATE of any column the tree is derived from. On
-- every firing it:
--   * derives slug from name when slug is absent, and again on a rename that
--     leaves slug as it was (name changed, slug not);
--   * copies namespace from the category and refuses any change of namespace
--     (directly, or by moving to a category of another namespace);
--   * refuses a missing, trashed, other-category or other-namespace parent,
--     and a parent inside the node's own subtree (a cycle);
--   * refuses a category change for a node that has children;
--   * sets path (the parent's path + '/' + slug; a root's path is its slug)
--     and depth (root = 1), overwriting whatever the caller wrote, so path
--     and depth really are trigger-maintained;
--   * refuses depth > category.max_depth, for the node and, when its depth or
--     category changes, for its deepest descendant too (the subtree rewrite
--     sets only path and depth and would not re-check them).
-- Checks that depend on an unchanged value (the parent's liveness, max_depth)
-- run only when that value changes, so an unrelated edit of an old row still
-- works. Error codes: 23503 missing category, missing or trashed parent;
-- 23502 missing category_id; 23514 everything else. (A trashed category is
-- not checked here: SPEC blocks a category's soft delete while it holds live
-- keywords, in trg_dam_keyword_categories_block_delete, which is not built
-- yet.)
--
-- The subtree rewrite in section 6 updates path and depth of descendants,
-- which fires this trigger again one level down; with the rewrite's marker set
-- and only path and depth changing, the values it computed are kept.
--
-- SECURITY DEFINER so the parent, category and subtree reads see every row,
-- trashed ones included, whatever the writer's read policy hides. The search
-- path includes extensions because the slug is folded with dam_unaccent().
create or replace function dam_keywords_path()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_slug text;
  v_cat_namespace dam_keyword_namespace;
  v_max_depth smallint;
  v_parent_path text;
  v_parent_depth smallint;
  v_parent_category uuid;
  v_parent_namespace dam_keyword_namespace;
  v_parent_deleted timestamptz;
  v_cycle boolean := false;
  v_height integer := 0;
begin
  -- A descendant being rewritten by trg_dam_keywords_propagate.
  if tg_op = 'UPDATE'
     and pg_trigger_depth() > 1
     and current_setting('dam.keyword_propagation', true) = 'on'
     and (new.parent_id, new.slug, new.name, new.category_id, new.namespace)
         is not distinct from
         (old.parent_id, old.slug, old.name, old.category_id, old.namespace) then
    return new;
  end if;

  -- Slug.
  if new.name is not null
     and (new.slug is null
          or btrim(new.slug) = ''
          or (tg_op = 'UPDATE'
              and new.name is distinct from old.name
              and new.slug is not distinct from old.slug)) then
    v_slug := btrim(regexp_replace(lower(dam_unaccent(coalesce(new.name, ''))), '[^a-z0-9]+', '-', 'g'), '-');
    if v_slug = '' then
      raise exception 'dam: cannot derive a slug from keyword name "%"; supply one', new.name
        using errcode = 'check_violation';
    end if;
    new.slug := v_slug;
  end if;

  -- Category and namespace.
  if new.category_id is null then
    raise exception 'dam: keyword category_id is required'
      using errcode = 'not_null_violation';
  end if;
  select c.namespace, c.max_depth
    into v_cat_namespace, v_max_depth
    from dam_keyword_categories c
   where c.id = new.category_id;
  if not found then
    raise exception 'dam: keyword category % does not exist', new.category_id
      using errcode = 'foreign_key_violation';
  end if;

  if tg_op = 'INSERT' then
    if new.namespace is not null and new.namespace <> v_cat_namespace then
      raise exception 'dam: keyword namespace % does not match its category''s namespace %',
        new.namespace, v_cat_namespace
        using errcode = 'check_violation';
    end if;
  else
    if new.namespace is distinct from old.namespace or v_cat_namespace <> old.namespace then
      raise exception 'dam: keyword % cannot leave namespace % (a keyword never changes namespace)',
        old.id, old.namespace
        using errcode = 'check_violation';
    end if;
    if new.category_id is distinct from old.category_id
       and exists (select 1 from dam_keywords c where c.parent_id = new.id) then
      raise exception 'dam: keyword % has children; moving a subtree to another category is not supported yet',
        new.id
        using errcode = 'check_violation';
    end if;
  end if;
  new.namespace := v_cat_namespace;

  -- Parent, path and depth.
  if new.parent_id is null then
    new.path := new.slug;
    new.depth := 1;
  else
    select p.path, p.depth, p.category_id, p.namespace, p.deleted_at
      into v_parent_path, v_parent_depth, v_parent_category, v_parent_namespace, v_parent_deleted
      from dam_keywords p
     where p.id = new.parent_id;
    if not found then
      raise exception 'dam: parent keyword % does not exist', new.parent_id
        using errcode = 'foreign_key_violation';
    end if;
    if v_parent_category <> new.category_id or v_parent_namespace <> v_cat_namespace then
      raise exception 'dam: parent keyword % is in another category or namespace; a keyword''s parent must share its category',
        new.parent_id
        using errcode = 'check_violation';
    end if;
    if tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id then
      if v_parent_deleted is not null and new.deleted_at is null then
        raise exception 'dam: parent keyword % is deleted', new.parent_id
          using errcode = 'foreign_key_violation';
      end if;
      if tg_op = 'UPDATE' then
        with recursive up (id, parent_id, lvl) as (
          select k.id, k.parent_id, 1
            from dam_keywords k
           where k.id = new.parent_id
          union all
          select k.id, k.parent_id, up.lvl + 1
            from dam_keywords k
            join up
              on k.id = up.parent_id
           where up.lvl < 8
        )
        select exists (select 1 from up where up.id = new.id)
          into v_cycle;
        if v_cycle then
          raise exception 'dam: keyword % cannot move under % (a keyword cannot be inside its own subtree)',
            new.id, new.parent_id
            using errcode = 'check_violation';
        end if;
      end if;
    end if;
    new.path := v_parent_path || '/' || new.slug;
    new.depth := v_parent_depth + 1;
  end if;

  -- Depth limits.
  if tg_op = 'INSERT'
     or new.depth is distinct from old.depth
     or new.category_id is distinct from old.category_id then
    if tg_op = 'UPDATE' then
      with recursive down (id, lvl) as (
        select k.id, 1
          from dam_keywords k
         where k.parent_id = new.id
        union all
        select k.id, down.lvl + 1
          from dam_keywords k
          join down
            on k.parent_id = down.id
         where down.lvl < 5
      )
      select coalesce(max(down.lvl), 0)
        into v_height
        from down;
    end if;
    if new.depth + v_height > v_max_depth then
      raise exception 'dam: keyword tree too deep: % would reach depth %, and its category allows %',
        new.slug, new.depth + v_height, v_max_depth
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function dam_keywords_path() is
  'Trigger on dam_keywords (SPEC 2.9): derives slug, namespace, path and depth; refuses a cycle, a cross-category or trashed parent, a namespace change, a subtree category move and depth > category.max_depth.';

drop trigger if exists trg_dam_keywords_path on dam_keywords;
create trigger trg_dam_keywords_path
  before insert or update of parent_id, slug, name, category_id, namespace, path, depth on dam_keywords
  for each row execute function dam_keywords_path();


-- =============================================================================
-- 6. Keyword trees: trg_dam_keywords_propagate (SPEC 2.9, D-223)
-- =============================================================================
-- AFTER a row's place in a tree changes. Two jobs:
--   1. When the node's path or depth changed (move, rename, new slug), rewrite
--      every descendant's path and depth in one statement, computed from the
--      tree as it now stands. The node's CURRENT row is read rather than NEW,
--      so when one statement moves a node and one of its ancestors, whichever
--      firing runs last leaves the right paths.
--   2. Refresh descendant_ids on each root whose subtree changed: the root
--      above the node's new position and above its old one (for a child
--      insert, a move, a trash or restore, a hard delete), and clear the cache
--      of a root that became a child. Only rows whose value differs are
--      written, so a statement inserting 40 children updates each root once.
-- The rewrite's own UPDATE fires this trigger again for every descendant. The
-- marker dam.keyword_propagation, set only around that UPDATE, makes those
-- nested firings return at once; the outer firing has already done their work.
--
-- Neither statement changes name, parent_id, deleted_at or
-- merged_into_keyword_id, so 120200's trg_dam_keywords_search_update never
-- fires for them. SECURITY DEFINER: the rewrite must reach every descendant,
-- trashed ones included, whatever the writer may read.
create or replace function dam_keywords_propagate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_path text;
  v_depth smallint;
  v_start uuid[] := array[]::uuid[];
begin
  if pg_trigger_depth() > 1
     and current_setting('dam.keyword_propagation', true) = 'on' then
    return null;
  end if;

  if tg_op = 'INSERT' then
    -- A new root has no descendants yet.
    if new.parent_id is null then
      return null;
    end if;
    v_start := array[new.parent_id];
  elsif tg_op = 'DELETE' then
    if old.parent_id is null then
      return null;
    end if;
    v_start := array[old.parent_id];
  else
    if (new.parent_id, new.path, new.depth, new.deleted_at)
       is not distinct from
       (old.parent_id, old.path, old.depth, old.deleted_at) then
      return null;
    end if;

    if new.path is distinct from old.path or new.depth is distinct from old.depth then
      select k.id, k.path, k.depth
        into v_id, v_path, v_depth
        from dam_keywords k
       where k.id = new.id;
      if found then
        perform set_config('dam.keyword_propagation', 'on', true);
        with recursive sub (id, path, depth, lvl) as (
          select k.id, v_path || '/' || k.slug, v_depth + 1, 1
            from dam_keywords k
           where k.parent_id = v_id
          union all
          select k.id, sub.path || '/' || k.slug, sub.depth + 1, sub.lvl + 1
            from dam_keywords k
            join sub
              on k.parent_id = sub.id
           where sub.lvl < 5
        )
        update dam_keywords d
           set path = sub.path,
               depth = sub.depth
          from sub
         where d.id = sub.id
           and (d.path, d.depth) is distinct from (sub.path, sub.depth);
        perform set_config('dam.keyword_propagation', 'off', true);
      end if;
    end if;

    -- A root that became a child keeps no cache.
    update dam_keywords k
       set descendant_ids = array[]::uuid[]
     where k.id = new.id
       and k.parent_id is not null
       and cardinality(k.descendant_ids) > 0;

    v_start := array[new.id];
    if old.parent_id is not null then
      v_start := v_start || old.parent_id;
    end if;
  end if;

  with recursive up (id, parent_id, lvl) as (
    select k.id, k.parent_id, 1
      from dam_keywords k
     where k.id = any(v_start)
    union all
    select k.id, k.parent_id, up.lvl + 1
      from dam_keywords k
      join up
        on k.id = up.parent_id
     where up.lvl < 8
  ),
  roots as (
    select distinct up.id
      from up
     where up.parent_id is null
  ),
  fresh as (
    select roots.id, dam_keyword_descendant_ids(roots.id) as ids
      from roots
  )
  update dam_keywords r
     set descendant_ids = fresh.ids
    from fresh
   where r.id = fresh.id
     and r.descendant_ids is distinct from fresh.ids;

  return null;
end;
$$;

comment on function dam_keywords_propagate() is
  'Trigger on dam_keywords (SPEC 2.9, D-223): rewrites a moved or renamed node''s subtree paths and depths and keeps descendant_ids on the affected roots.';

drop trigger if exists trg_dam_keywords_propagate on dam_keywords;
create trigger trg_dam_keywords_propagate
  after insert or update of parent_id, slug, name, path, depth, deleted_at or delete on dam_keywords
  for each row execute function dam_keywords_propagate();


-- =============================================================================
-- 7. Backfill: descendant_ids on root rows (D-223)
-- =============================================================================
-- Every root gets its live subtree and every non-root an empty cache; only rows
-- whose value differs are written. On v2 that is the three Sector roots with
-- children (workplace 10, lifestyle 24, community 17 descendants): 3 audited
-- updates, no search-row work (descendant_ids is not a column 120200 watches),
-- and none of this file's triggers fire (none lists descendant_ids).
do $$
begin
  perform set_config('dam.request_id', 'migration:20260923120300_p1_taxonomy_integrity', true);

  update dam_keywords k
     set descendant_ids = case
                            when k.parent_id is null then dam_keyword_descendant_ids(k.id)
                            else array[]::uuid[]
                          end
   where k.descendant_ids is distinct from (case
                                              when k.parent_id is null then dam_keyword_descendant_ids(k.id)
                                              else array[]::uuid[]
                                            end);

  perform set_config('dam.request_id', '', true);
end;
$$;


-- =============================================================================
-- 8. The imported data satisfies every rule attached above
-- =============================================================================
-- Attaching a trigger validates nothing that already exists. These counts were
-- all 0 on v2 when last read (2026-09-23); if one is not, the file aborts and
-- rolls back rather than leaving a rule the data already breaks.
do $$
declare
  v_n bigint;
begin
  -- Paths and depths equal the chain of slugs from the root; every row is
  -- reachable from a root within five levels (so there is no cycle).
  with recursive t (id, path, depth, lvl) as (
    select k.id, k.slug, 1, 1
      from dam_keywords k
     where k.parent_id is null
    union all
    select k.id, t.path || '/' || k.slug, t.depth + 1, t.lvl + 1
      from dam_keywords k
      join t
        on k.parent_id = t.id
     where t.lvl < 5
  )
  select count(*)
    into v_n
    from dam_keywords k
    left join t
      on t.id = k.id
   where t.id is null
      or t.path <> k.path
      or t.depth <> k.depth;
  if v_n <> 0 then
    raise exception 'p1_taxonomy_integrity: % keywords have a path or depth that does not follow their parent chain', v_n
      using errcode = 'check_violation';
  end if;

  -- Namespace, category, parent and depth agreement.
  select count(*)
    into v_n
    from dam_keywords k
    join dam_keyword_categories c
      on c.id = k.category_id
    left join dam_keywords p
      on p.id = k.parent_id
   where k.namespace <> c.namespace
      or k.depth > c.max_depth
      or (k.parent_id is not null and p.category_id <> k.category_id);
  if v_n <> 0 then
    raise exception 'p1_taxonomy_integrity: % keywords disagree with their category (namespace, max_depth) or parent (category)', v_n
      using errcode = 'check_violation';
  end if;

  -- Root caches, after the backfill.
  select count(*)
    into v_n
    from dam_keywords k
   where k.descendant_ids is distinct from (case
                                              when k.parent_id is null then dam_keyword_descendant_ids(k.id)
                                              else array[]::uuid[]
                                            end);
  if v_n <> 0 then
    raise exception 'p1_taxonomy_integrity: % keywords hold a stale descendant_ids after the backfill', v_n
      using errcode = 'check_violation';
  end if;

  -- Live links: keyword namespace matches the target type.
  select count(*)
    into v_n
    from dam_keyword_links l
    join dam_keywords k
      on k.id = l.keyword_id
   where l.deleted_at is null
     and k.namespace::text <> l.target_type::text;
  if v_n <> 0 then
    raise exception 'p1_taxonomy_integrity: % live keyword links tag a target of another namespace', v_n
      using errcode = 'check_violation';
  end if;

  -- Live links: the target exists and is live.
  select count(*)
    into v_n
    from dam_keyword_links l
   where l.deleted_at is null
     and not case l.target_type
               when 'asset' then exists (select 1 from dam_assets a
                                          where a.id = l.target_id and a.deleted_at is null)
               when 'project' then exists (select 1 from dam_projects p
                                            where p.id = l.target_id and p.deleted_at is null)
               when 'employee' then exists (select 1 from dam_employees e
                                             where e.id = l.target_id and e.deleted_at is null)
               else false
             end;
  if v_n <> 0 then
    raise exception 'p1_taxonomy_integrity: % live keyword links point at a missing or deleted target', v_n
      using errcode = 'foreign_key_violation';
  end if;

  -- Live links: at most one per (target, exclusive category).
  select count(*)
    into v_n
    from (select 1
            from dam_keyword_links l
            join dam_keywords k
              on k.id = l.keyword_id
            join dam_keyword_categories c
              on c.id = k.category_id
           where l.deleted_at is null
             and c.is_exclusive
           group by l.target_type, l.target_id, k.category_id
          having count(*) > 1) x;
  if v_n <> 0 then
    raise exception 'p1_taxonomy_integrity: % targets hold more than one live keyword from an exclusive category', v_n
      using errcode = 'unique_violation';
  end if;

  -- Live external ids: the target exists and is live.
  select count(*)
    into v_n
    from dam_external_ids e
   where e.deleted_at is null
     and not case e.target_type
               when 'asset' then exists (select 1 from dam_assets t
                                          where t.id = e.target_id and t.deleted_at is null)
               when 'project' then exists (select 1 from dam_projects t
                                            where t.id = e.target_id and t.deleted_at is null)
               when 'employee' then exists (select 1 from dam_employees t
                                             where t.id = e.target_id and t.deleted_at is null)
               when 'album' then exists (select 1 from dam_albums t
                                          where t.id = e.target_id and t.deleted_at is null)
               when 'text_block' then exists (select 1 from dam_text_blocks t
                                               where t.id = e.target_id and t.deleted_at is null)
               when 'client' then exists (select 1 from dam_clients t
                                           where t.id = e.target_id and t.deleted_at is null)
               when 'studio' then exists (select 1 from dam_studios t
                                           where t.id = e.target_id and t.deleted_at is null)
               else false
             end;
  if v_n <> 0 then
    raise exception 'p1_taxonomy_integrity: % live external ids point at a missing or deleted target', v_n
      using errcode = 'foreign_key_violation';
  end if;
end;
$$;


-- =============================================================================
-- 9. Function privileges (explicit, per function)
-- =============================================================================

-- The subtree helper: the triggers run it as the owner; the service role may
-- call it; nobody else needs it.
revoke all on function public.dam_keyword_descendant_ids(uuid) from public, anon, authenticated;
grant execute on function public.dam_keyword_descendant_ids(uuid) to service_role;

-- Trigger functions: nobody. A trigger fires without its function's EXECUTE
-- privilege being checked, so this closes only direct calls.
revoke all on function public.dam_keyword_links_exclusive() from public, anon, authenticated;
revoke all on function public.dam_external_ids_immutable() from public, anon, authenticated;
revoke all on function public.dam_keywords_path() from public, anon, authenticated;
revoke all on function public.dam_keywords_propagate() from public, anon, authenticated;

notify pgrst, 'reload schema';
