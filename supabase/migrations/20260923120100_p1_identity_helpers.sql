-- =============================================================================
-- 20260923120100_p1_identity_helpers.sql
-- Phase 1, migration 2 of 5 — v2 (project-based DAM) behaviour layer.
--
-- PURPOSE
--   1. The row-level-security helpers SPEC 3.7.1 names that the baseline does
--      not define: dam_current_claims, dam_is_active_user, dam_is_system,
--      dam_current_role_in_studio(s), dam_is_at_least_in_studios,
--      dam_has_scope, dam_has_grant, dam_project_studio_ids,
--      dam_asset_studio_ids, dam_asset_effective_level and dam_level_satisfied.
--   2. The null-role fix in dam_access_level_allows: an inactive or trashed
--      user with a valid `sub` has dam_current_role() = null, `null <
--      min_role` is null, the grant branch was skipped and the caller fell
--      through to the scope checks, passing firm scope and studio scope with no
--      owning studio. The function is re-created verbatim with one added line.
--   3. First-sign-in provisioning, dam_provision_user (SPEC 3.2.2, D-271,
--      D-353, D-375): the web tier calls it with its system token, so it never
--      needs the service-role key.
--
-- CONVENTIONS (the applied schema's, FACTS identity-rls (b))
--   Every helper reads identity from the TABLES by the token's `sub`, exactly
--   like the baseline helpers: role, studio membership, cross-studio flag and
--   activity are never taken from claims, so a demotion or a deactivation
--   takes effect on the next statement rather than at the next token mint. The
--   one claim-level input besides `sub` is the principal type, read from
--   `principal` or `principal_type` (the web tier mints both).
--   Every helper denies (false, null or '{}') when there is no `sub`.
--   All are plpgsql, SECURITY DEFINER with a pinned search_path (they read
--   rows the caller may not), and STABLE, except dam_provision_user, which
--   writes and is VOLATILE.
--
-- DEPENDS ON
--   20260915000000_baseline.sql (SCHEMA.sql as applied 2026-09-15): the
--   baseline identity helpers, dam_users and its guard trigger.
--   20260923120000_p1_grants_settings_principals.sql: dam_setting(),
--   dam_setting_bool(), the seeded keys users.auto_activate_domains and
--   users.default_cross_studio_visibility, and the system principals
--   (...0005 is the web tier's, the `sub` of its system token).
--   Later phase 1 files rely on this one: p1_search_row must store in
--   dam_asset_search.studio_ids and .access_level_id exactly what
--   dam_asset_studio_ids() and dam_asset_effective_level() compute here.
--
-- HOW IT IS APPLIED
--   Forward-only. The user applies it with `supabase db push`; it is never
--   edited once applied (write a new migration instead). The CLI runs each file
--   as one implicit transaction, so there is no begin/commit here. Re-running
--   it is harmless: every function is `create or replace` with an unchanged
--   signature, and grants and revokes are idempotent.
--
-- DELIBERATE CHOICES (recorded in supabase/migrations/README.md)
--   * Helpers read tables, not claims (contract deviation 4).
--   * dam_level_satisfied also passes a global admin (SPEC 3.5.5 step 2, and
--     what dam_access_level_allows already does), besides step 7 and the
--     creator pass.
--   * dam_is_at_least_in_studios returns false, never null, for a caller with
--     no role, so `not dam_is_at_least_in_studios(...)` cannot open a door.
--   * dam_has_scope is false with no `sub`, true for every non-api_key
--     principal, and for an api_key token applies the stored vocabulary's
--     implications (read, write, admin, share, upload; SPEC 2B.7).
--   * Studio sets are sorted and distinct, so an array comparison with the
--     search row is meaningful.
-- =============================================================================

set search_path = public, extensions, pg_catalog;


-- =============================================================================
-- 1. Claims and principal
-- =============================================================================

-- SPEC 3.7.1's name for the baseline's dam_jwt_claims(): the verified token's
-- claims, '{}' when there are none (a migration, psql) or they are malformed.
create or replace function dam_current_claims()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return dam_jwt_claims();
end;
$$;

comment on function dam_current_claims() is
  'SPEC 3.7.1 name for dam_jwt_claims(): the request''s JWT claims, or ''{}'' when there are none or they are malformed.';

-- SPEC 3.5.5 step 3. dam_current_role() is already null for an inactive user;
-- this says so by name, for policies and RPCs that need no role.
create or replace function dam_is_active_user()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  v_id := dam_current_user_id();
  if v_id is null then
    return false;
  end if;
  return exists (
    select 1
      from dam_users u
     where u.id = v_id
       and u.is_active
       and u.deleted_at is null);
end;
$$;

comment on function dam_is_active_user() is
  'True when the token''s sub is a live, active dam_users row (SPEC 3.5.5 step 3). False with no sub.';

-- D-375: the web tier's system token. NOT dam_current_principal_type() =
-- 'system', which is also true for any token that lacks the claim (the service
-- key, a mis-minted user token). The claim must say system AND the `sub` must
-- be a live system principal; dam_users_system_principal_check keeps those
-- inert (never active), and only a holder of the JWT secret can name one.
create or replace function dam_is_system()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_claims jsonb;
  v_id     uuid;
begin
  v_claims := dam_jwt_claims();
  if coalesce(v_claims ->> 'principal', '') <> 'system'
     and coalesce(v_claims ->> 'principal_type', '') <> 'system' then
    return false;
  end if;
  v_id := dam_current_user_id();
  if v_id is null then
    return false;
  end if;
  return exists (
    select 1
      from dam_users u
     where u.id = v_id
       and u.is_system
       and u.deleted_at is null);
end;
$$;

comment on function dam_is_system() is
  'D-375: true only when the claims say principal (or principal_type) = system AND sub is a live is_system dam_users row. Never inferred from a missing claim.';


-- =============================================================================
-- 2. Effective role in a studio context (D-357)
-- =============================================================================
-- Effective role in the context of a set of studios = greatest(global role,
-- the live role_override of every membership that covers one of them). A
-- membership of a region group covers its children, exactly as in
-- dam_current_studio_ids(); a membership of a child does not cover the group.
-- Null when the caller has no role (no sub, unknown, inactive or trashed): an
-- override never resurrects an inactive user. With no studios, the global role.

create or replace function dam_current_role_in_studios(p_studio_ids uuid[])
returns dam_role
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role     dam_role;
  v_override dam_role;
begin
  v_role := dam_current_role();
  if v_role is null then
    return null;
  end if;
  if p_studio_ids is null or cardinality(array_remove(p_studio_ids, null)) = 0 then
    return v_role;
  end if;

  select max(us.role_override)
    into v_override
    from dam_user_studios us
    join dam_studios s
      on s.id = us.studio_id
      or s.parent_studio_id = us.studio_id
   where us.user_id = dam_current_user_id()
     and us.deleted_at is null
     and s.deleted_at is null
     and s.id = any (p_studio_ids);

  -- greatest() ignores a null override.
  return greatest(v_role, v_override);
end;
$$;

comment on function dam_current_role_in_studios(uuid[]) is
  'D-357 effective role over a studio set: greatest(dam_current_role(), live role_override of memberships covering any of the studios, region groups expanding to their children). Null when the caller has no role; the global role for an empty set.';

create or replace function dam_current_role_in_studio(p_studio_id uuid)
returns dam_role
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_studio_id is null then
    return dam_current_role();
  end if;
  return dam_current_role_in_studios(array[p_studio_id]);
end;
$$;

comment on function dam_current_role_in_studio(uuid) is
  'D-357 effective role in one studio: dam_current_role_in_studios(array[p_studio_id]). The global role for a null studio; null when the caller has no role.';

create or replace function dam_is_at_least_in_studios(p_role dam_role, p_studio_ids uuid[])
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_role is null then
    return false;
  end if;
  return coalesce(dam_current_role_in_studios(p_studio_ids) >= p_role, false);
end;
$$;

comment on function dam_is_at_least_in_studios(dam_role, uuid[]) is
  'True when the caller''s effective role over the studio set (dam_current_role_in_studios) is at least p_role. False, never null, when the caller has no role.';


-- =============================================================================
-- 3. API-key scopes
-- =============================================================================
-- Scopes narrow, never widen (SPEC 3.8.2). A person or a system principal is
-- not narrowed. An api_key token (principal or principal_type = api_key) holds
-- a `scopes` array from the stored vocabulary, which
-- dam_api_keys_scopes_check fixes at read, write, admin, share, upload, with
-- the SPEC 2B.7 implications: write implies read and upload; upload and share
-- each imply read; admin implies all five. A scope outside the vocabulary is
-- never held.
create or replace function dam_has_scope(p_scope text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_claims jsonb;
  v_scopes text[];
begin
  if dam_current_user_id() is null then
    return false;
  end if;

  v_claims := dam_jwt_claims();
  if coalesce(v_claims ->> 'principal', '') <> 'api_key'
     and coalesce(v_claims ->> 'principal_type', '') <> 'api_key' then
    return true;
  end if;

  if p_scope is null
     or not (p_scope = any (array['read', 'write', 'admin', 'share', 'upload'])) then
    return false;
  end if;
  if jsonb_typeof(v_claims -> 'scopes') is distinct from 'array' then
    return false;
  end if;

  select coalesce(array_agg(e.scope), array[]::text[])
    into v_scopes
    from jsonb_array_elements_text(v_claims -> 'scopes') as e(scope)
   where e.scope is not null;

  return coalesce(
            p_scope = any (v_scopes)
         or 'admin' = any (v_scopes)
         or (p_scope = 'read' and v_scopes && array['write', 'upload', 'share'])
         or (p_scope = 'upload' and 'write' = any (v_scopes)),
         false);
end;
$$;

comment on function dam_has_scope(text) is
  'False with no sub; true for any principal that is not an api_key; for an api_key token, whether its scopes claim holds p_scope, with the SPEC 2B.7 implications (write => read, upload; upload => read; share => read; admin => all).';


-- =============================================================================
-- 4. Grants (SPEC 2B.6)
-- =============================================================================
-- A live, unexpired grant of the level to the user directly, or to a group the
-- user is a live member of, provided that group is live and ACTIVE (the
-- dam_groups.is_active comment: "An inactive group confers nothing"). The
-- baseline dam_access_level_allows does not check the group's state; this does.
create or replace function dam_has_grant(p_level uuid, p_user uuid default dam_current_user_id())
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_level is null or p_user is null then
    return false;
  end if;
  return exists (
    select 1
      from dam_access_grants g
     where g.access_level_id = p_level
       and g.deleted_at is null
       and (g.expires_at is null or g.expires_at > now())
       and (g.user_id = p_user
            or g.group_id in (
                 select gm.group_id
                   from dam_group_members gm
                   join dam_groups gr on gr.id = gm.group_id
                  where gm.user_id = p_user
                    and gm.deleted_at is null
                    and gr.deleted_at is null
                    and gr.is_active)));
end;
$$;

comment on function dam_has_grant(uuid, uuid) is
  'SPEC 2B.6: a live, unexpired grant of p_level to p_user (default the caller) directly or via a live membership of a live, active group. False when either argument is null.';


-- =============================================================================
-- 5. Studio sets and the effective level (live, from base tables)
-- =============================================================================
-- These are what p1_search_row materialises into dam_asset_search.studio_ids
-- and .access_level_id; the rebuild must compute the same values.

-- A project's studio set S: its home studio plus its live contributing
-- studios, distinct, sorted ascending, no nulls; '{}' for a project with
-- neither (about 8 % of migrated projects have no home studio) or for an
-- unknown id. The project's own trash state does not change its studios.
create or replace function dam_project_studio_ids(p_project_id uuid)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
begin
  if p_project_id is null then
    return array[]::uuid[];
  end if;

  select coalesce(array_agg(distinct x.studio_id order by x.studio_id), array[]::uuid[])
    into v_ids
    from (
      select p.studio_id
        from dam_projects p
       where p.id = p_project_id
         and p.studio_id is not null
      union all
      select ps.studio_id
        from dam_project_studios ps
       where ps.project_id = p_project_id
         and ps.deleted_at is null
    ) x;

  return v_ids;
end;
$$;

comment on function dam_project_studio_ids(uuid) is
  'Studio set of a project: home studio_id plus live dam_project_studios rows, distinct, sorted ascending, no nulls; ''{}'' when it has none.';

-- An asset's studio set S, computed live:
--   1. the union of dam_project_studio_ids() over the asset's live links to
--      live projects, distinct and sorted ascending, when that union is not
--      empty;
--   2. otherwise (no live link to a live project, or linked projects with no
--      studio at all) the asset's own dam_assets.studio_id, as a one-element
--      array;
--   3. otherwise '{}'.
-- Step 2 also covers linked projects that have no studio: an empty S reads as
-- "visible firm-wide within the role test" (SPEC 3.5.5 step 7), so a set is
-- only left empty when nothing at all names a studio. The asset's trash state
-- does not change its studios. An unknown id gives '{}'.
create or replace function dam_asset_studio_ids(p_asset_id uuid)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_own uuid;
begin
  if p_asset_id is null then
    return array[]::uuid[];
  end if;

  -- array_agg over no rows is null, which is how "empty union" is detected.
  select array_agg(distinct x.studio_id order by x.studio_id)
    into v_ids
    from (
      select p.studio_id
        from dam_project_assets pa
        join dam_projects p
          on p.id = pa.project_id
         and p.deleted_at is null
       where pa.asset_id = p_asset_id
         and pa.deleted_at is null
         and p.studio_id is not null
      union all
      select ps.studio_id
        from dam_project_assets pa
        join dam_projects p
          on p.id = pa.project_id
         and p.deleted_at is null
        join dam_project_studios ps
          on ps.project_id = p.id
         and ps.deleted_at is null
       where pa.asset_id = p_asset_id
         and pa.deleted_at is null
    ) x;

  if v_ids is not null then
    return v_ids;
  end if;

  select a.studio_id
    into v_own
    from dam_assets a
   where a.id = p_asset_id;

  if v_own is not null then
    return array[v_own];
  end if;
  return array[]::uuid[];
end;
$$;

comment on function dam_asset_studio_ids(uuid) is
  'Studio set of an asset, live: the distinct, ascending union of dam_project_studio_ids() over live links to live projects when non-empty; else array[dam_assets.studio_id] when set; else ''{}''. dam_asset_search.studio_ids must hold the same value.';

-- D-362 effective level, computed live: the asset's explicit level; else the
-- most restrictive level among its live links to live projects, ordered
-- scope desc (dam_access_scope is declared firm < studio < grant_only), then
-- min_role desc, then the level id so the choice is deterministic; else its
-- category's level. Never null for an existing asset (the category level is
-- NOT NULL); null for an unknown id.
create or replace function dam_asset_effective_level(p_asset_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_explicit uuid;
  v_category uuid;
  v_level    uuid;
begin
  if p_asset_id is null then
    return null;
  end if;

  select a.access_level_id, a.category_id
    into v_explicit, v_category
    from dam_assets a
   where a.id = p_asset_id;

  if not found then
    return null;
  end if;
  if v_explicit is not null then
    return v_explicit;
  end if;

  select p.access_level_id
    into v_level
    from dam_project_assets pa
    join dam_projects p
      on p.id = pa.project_id
     and p.deleted_at is null
    join dam_access_levels al
      on al.id = p.access_level_id
   where pa.asset_id = p_asset_id
     and pa.deleted_at is null
   order by al.scope desc, al.min_role desc, al.id
   limit 1;

  if v_level is not null then
    return v_level;
  end if;

  select c.access_level_id
    into v_level
    from dam_categories c
   where c.id = v_category;

  return v_level;
end;
$$;

comment on function dam_asset_effective_level(uuid) is
  'D-362 effective level, live: explicit dam_assets.access_level_id; else the most restrictive live linked live project''s level (scope desc, min_role desc, level id); else the category''s level. dam_asset_search.access_level_id must hold the same value.';


-- =============================================================================
-- 6. Level test (SPEC 3.5.5 step 7, with the 3.5.2 creator pass)
-- =============================================================================
-- In order, first rule that decides wins:
--   no sub, or no role (unknown, inactive, trashed)   -> false
--   global admin or owner                             -> true   (step 2)
--   p_created_by is the caller                        -> true   (creator pass)
--   unknown or trashed level                          -> false  (closed)
--   grant_only: a grant AND effective role >= min_role, else false
--   a grant                                           -> true
--   effective role < min_role                         -> false
--   firm                                              -> true
--   studio: S empty, or S meets the caller's studios, or the caller has
--           cross-studio visibility or a global role >= editor
-- Effective role = dam_current_role_in_studios(p_studio_ids) (D-357).
create or replace function dam_level_satisfied(p_level_id uuid, p_studio_ids uuid[], p_created_by uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me      uuid;
  v_role    dam_role;
  v_eff     dam_role;
  v_level   record;
  v_granted boolean;
  v_studios uuid[];
begin
  v_me := dam_current_user_id();
  if v_me is null then
    return false;
  end if;
  v_role := dam_current_role();
  if v_role is null then
    return false;
  end if;
  if v_role >= 'global_admin'::dam_role then
    return true;
  end if;
  if p_created_by is not null and p_created_by = v_me then
    return true;
  end if;
  if p_level_id is null then
    return false;
  end if;

  select al.min_role, al.scope
    into v_level
    from dam_access_levels al
   where al.id = p_level_id
     and al.deleted_at is null;

  if not found then
    return false;   -- an unknown level is a closed level
  end if;

  v_eff := dam_current_role_in_studios(p_studio_ids);
  v_granted := dam_has_grant(p_level_id, v_me);

  if v_level.scope = 'grant_only'::dam_access_scope then
    return v_granted and v_eff >= v_level.min_role;
  end if;
  if v_granted then
    return true;
  end if;
  if v_eff < v_level.min_role then
    return false;
  end if;
  if v_level.scope = 'firm'::dam_access_scope then
    return true;
  end if;

  -- scope = 'studio'
  v_studios := array_remove(coalesce(p_studio_ids, array[]::uuid[]), null);
  if cardinality(v_studios) = 0 then
    return true;
  end if;
  if v_studios && dam_current_studio_ids() then
    return true;
  end if;
  return dam_has_cross_studio() or v_role >= 'editor'::dam_role;
end;
$$;

comment on function dam_level_satisfied(uuid, uuid[], uuid) is
  'SPEC 3.5.5 step 7 for level p_level_id over studio set p_studio_ids, plus the creator pass (p_created_by = caller) and the global-admin pass. False with no sub or for an inactive, trashed or unknown user; an unknown level is closed.';


-- =============================================================================
-- 7. dam_access_level_allows: the null-role fix
-- =============================================================================
-- Body copied verbatim from SCHEMA.sql:473-550 with exactly one change: after
-- the global-admin short-circuit and the null-user check, a caller whose role
-- is null (inactive, trashed or never provisioned) is refused. Before it,
-- `dam_current_role() < v_level.min_role` evaluated to null for such a caller,
-- the grant branch was skipped and a firm level, or a studio level with no
-- owning studio, returned true. Same signature, volatility, definer and
-- search_path, so every policy that calls it keeps working; create or replace
-- keeps its ACL and its comment.
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
  if dam_current_role() is null then return false; end if;

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


-- =============================================================================
-- 8. First-sign-in provisioning (SPEC 3.2.2, D-271, D-353, D-375)
-- =============================================================================
-- Called by the web tier with its system token (sub ...0005) after it has
-- verified the broker session, and usable from service_role and from a direct
-- connection (migrations, psql), whose claims are empty. Any other caller,
-- including a signed-in person, is refused with 42501.
--
-- Returns the caller's dam_users row (the columns the web tier needs) and
-- whether this call created it. The web tier mints a user token only for a
-- returned row that is active and not trashed (D-355).
--
--   * The email is normalised to lower(btrim()) (no trigger does this) and must
--     pass the dam_users_email_check pattern; the reserved system domain is
--     refused. Both raise 22023.
--   * Lookup covers ALL rows, trashed included: an email identifies one
--     principal for ever, so a trashed row blocks re-provisioning by design.
--   * A new row is a viewer, active when the domain is in
--     users.auto_activate_domains (case-insensitive), with cross-studio
--     visibility when active and users.default_cross_studio_visibility is on.
--   * An existing live, active row gets sign-in bookkeeping (last_login_at,
--     login_count, and the picture when one is given), at most once per 15
--     minutes so that a burst of requests does not become a burst of audit
--     rows. Role, activation, cross-studio visibility and display name of an
--     existing row are never touched: they belong to administrators and to the
--     person. A trashed or inactive row is returned unchanged.
--   * trg_users_guard_privileged_columns admits the bookkeeping update: under
--     the system token it ignores the session counters and the self-editable
--     columns; under service_role or empty claims it has no actor at all.
--
-- The RETURNS TABLE column names are also plpgsql variables, so every column
-- reference below is qualified and the conflict target is named by constraint
-- rather than by column (an `on conflict (email)` would be ambiguous).
create or replace function dam_provision_user(p_email text, p_display_name text default null, p_picture_url text default null)
returns table (id uuid, email text, display_name text, role dam_role, is_active boolean, cross_studio_visibility boolean, deleted_at timestamptz, created boolean)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_claims  jsonb;
  -- fninsert:ok v_email — assigned from p_email before any use, and a null
  -- result raises 22023 before the insert can be reached.
  v_email   text;
  v_domains jsonb;
  v_active  boolean := false;
  v_cross   boolean := false;
  v_id      uuid;
  v_created boolean := false;
begin
  -- Gate first: nothing about the email is examined for a refused caller.
  v_claims := dam_jwt_claims();
  if not (dam_is_system()
          or coalesce(v_claims ->> 'role', '') = 'service_role'
          or v_claims = '{}'::jsonb) then
    raise exception 'dam_provision_user: system principal required'
      using errcode = '42501',
            hint    = 'Provisioning runs under the web tier''s system token, never a person''s.';
  end if;

  v_email := lower(btrim(p_email));
  if v_email is null
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     or v_email like '%@system.dam.invalid' then
    raise exception 'dam_provision_user: not a valid email address for a person'
      using errcode = '22023';
  end if;

  select u.id
    into v_id
    from dam_users u
   where u.email = v_email;

  if v_id is null then
    v_domains := dam_setting('users.auto_activate_domains');
    if jsonb_typeof(v_domains) = 'array' then
      v_active := exists (
        select 1
          from jsonb_array_elements_text(v_domains) as d(domain_name)
         where lower(btrim(d.domain_name)) = split_part(v_email, '@', 2));
    end if;
    if v_active then
      v_cross := dam_setting_bool('users.default_cross_studio_visibility');
    end if;

    insert into dam_users (email, display_name, sso_picture_url, role, is_active,
                           cross_studio_visibility, last_login_at, login_count, created_by)
    values
      (v_email,
       coalesce(nullif(btrim(left(p_display_name, 120)), ''),
                left(split_part(v_email, '@', 1), 120)),
       nullif(p_picture_url, ''),
       'viewer'::dam_role,
       v_active,
       coalesce(v_cross, false),
       now(),
       1,
       dam_current_user_id())
    on conflict on constraint dam_users_email_key do nothing
    returning dam_users.id into v_id;

    if v_id is not null then
      v_created := true;
    else
      -- Lost a race with a concurrent first sign-in: that row now exists.
      select u.id
        into v_id
        from dam_users u
       where u.email = v_email;
      if v_id is null then
        raise exception 'dam_provision_user: the user row could not be created or found'
          using errcode = '40001';
      end if;
    end if;
  end if;

  if not v_created then
    -- Bookkeeping only, throttled. The conditions are in the WHERE clause so
    -- that they are re-checked against the latest row version if a concurrent
    -- administrator change holds the row lock.
    update dam_users as u
       set last_login_at   = now(),
           login_count     = u.login_count + 1,
           sso_picture_url = coalesce(nullif(p_picture_url, ''), u.sso_picture_url)
     where u.id = v_id
       and u.deleted_at is null
       and u.is_active
       and (u.last_login_at is null
            or u.last_login_at < now() - interval '15 minutes');
  end if;

  return query
    select u.id, u.email, u.display_name, u.role, u.is_active,
           u.cross_studio_visibility, u.deleted_at, v_created
      from dam_users u
     where u.id = v_id;
end;
$$;

comment on function dam_provision_user(text, text, text) is
  'First-sign-in provisioning (SPEC 3.2.2, D-271, D-375). System token, service_role or empty claims only (else 42501). Normalises and validates the email (22023), creates a viewer (active when the domain is in users.auto_activate_domains, cross-studio per users.default_cross_studio_visibility) or does throttled sign-in bookkeeping on a live active row. Never changes role, activation, cross-studio visibility or display name of an existing row.';


-- =============================================================================
-- 9. Function privileges (explicit, per function; never the baseline's
--    all-functions loop, which would re-grant authenticated on functions that
--    later migrations reserve for service_role)
-- =============================================================================
-- Every helper: any signed-in principal and the service role, never anon.
-- dam_provision_user too: its gate is inside, and the web tier reaches it with
-- an authenticated-role system token.

revoke all on function public.dam_current_claims() from public, anon;
grant execute on function public.dam_current_claims() to authenticated, service_role;

revoke all on function public.dam_is_active_user() from public, anon;
grant execute on function public.dam_is_active_user() to authenticated, service_role;

revoke all on function public.dam_is_system() from public, anon;
grant execute on function public.dam_is_system() to authenticated, service_role;

revoke all on function public.dam_current_role_in_studios(uuid[]) from public, anon;
grant execute on function public.dam_current_role_in_studios(uuid[]) to authenticated, service_role;

revoke all on function public.dam_current_role_in_studio(uuid) from public, anon;
grant execute on function public.dam_current_role_in_studio(uuid) to authenticated, service_role;

revoke all on function public.dam_is_at_least_in_studios(dam_role, uuid[]) from public, anon;
grant execute on function public.dam_is_at_least_in_studios(dam_role, uuid[]) to authenticated, service_role;

revoke all on function public.dam_has_scope(text) from public, anon;
grant execute on function public.dam_has_scope(text) to authenticated, service_role;

revoke all on function public.dam_has_grant(uuid, uuid) from public, anon;
grant execute on function public.dam_has_grant(uuid, uuid) to authenticated, service_role;

revoke all on function public.dam_project_studio_ids(uuid) from public, anon;
grant execute on function public.dam_project_studio_ids(uuid) to authenticated, service_role;

revoke all on function public.dam_asset_studio_ids(uuid) from public, anon;
grant execute on function public.dam_asset_studio_ids(uuid) to authenticated, service_role;

revoke all on function public.dam_asset_effective_level(uuid) from public, anon;
grant execute on function public.dam_asset_effective_level(uuid) to authenticated, service_role;

revoke all on function public.dam_level_satisfied(uuid, uuid[], uuid) from public, anon;
grant execute on function public.dam_level_satisfied(uuid, uuid[], uuid) to authenticated, service_role;

revoke all on function public.dam_access_level_allows(uuid, uuid[]) from public, anon;
grant execute on function public.dam_access_level_allows(uuid, uuid[]) to authenticated, service_role;

revoke all on function public.dam_provision_user(text, text, text) from public, anon;
grant execute on function public.dam_provision_user(text, text, text) to authenticated, service_role;
