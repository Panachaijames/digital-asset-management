-- =============================================================================
-- 20260923120000_p1_grants_settings_principals.sql
-- Phase 1, migration 1 of 5 — v2 (project-based DAM) behaviour layer.
--
-- PURPOSE
--   1. Explicit table privileges on every `dam_` table, partition children
--      included: nothing for PUBLIC or anon, the four DML privileges for
--      authenticated (row-level security stays the gate), everything for
--      service_role. The baseline relied on Supabase's legacy default
--      privileges; new projects (and a local `supabase start`) use revoked
--      defaults, under which the baseline leaves authenticated and service_role
--      with no table access at all. After this file both regimes agree.
--   2. The system principals (SPEC 2B.1, D-272) with fixed ids, plus the web
--      tier's principal `...0005` (D-375), which the web service's system JWT
--      names as `sub`.
--   3. Settings as data (SPEC 2B.53, D-348): the dam_setting() accessor and its
--      typed wrappers, the three guard triggers the SPEC names, and the seed.
--      dam_settings is empty in the applied schema, so until this file runs
--      every dam_setting() call would raise.
--
-- DEPENDS ON
--   20260915000000_baseline.sql only (a byte copy of SCHEMA.sql, applied to v2
--   on 2026-09-15). Nothing earlier in phase 1. Later phase 1 migrations read
--   what this one creates: provisioning (p1_identity_helpers) reads
--   users.auto_activate_domains and users.default_cross_studio_visibility and
--   is gated on the system principals; the search RPCs (p1_search_rpcs) read
--   search.default_limit and search.max_limit.
--
-- HOW IT IS APPLIED
--   Forward-only. The user applies it with `supabase db push`; it is never
--   edited once applied (write a new migration instead). The CLI runs each file
--   as one implicit transaction, so there is no begin/commit here. Re-running
--   it is harmless: functions are `create or replace`, triggers are dropped
--   before they are created, the seeds are `on conflict do nothing`, and
--   grants and revokes are idempotent.
--
-- DELIBERATE DEVIATIONS FROM SPEC (recorded in supabase/migrations/README.md)
--   * dam_setting_int returns bigint, not int: the seeded
--     uploads.max_file_bytes (10737418240) overflows int4.
--   * ai.autoaccept_confidence is not seeded: as specified (value_type 'null')
--     it could never be given a number, because the type-match CHECK and the
--     protect trigger together pin it to null for ever. The AI phase adds it.
--   * users.default_cross_studio_visibility is added (true, for parity with
--     the current library, where everyone sees everything).
--   * System principal ...0005 "Web service" is added (D-375).
-- =============================================================================

set search_path = public, extensions, pg_catalog;


-- =============================================================================
-- 1. Table privileges
-- =============================================================================
-- Same scope as the baseline's loop (SCHEMA.sql, "Anonymous visitors never
-- reach a table directly"): `dam_` tables only, never the whole schema, so
-- another application sharing `public` is untouched. pg_tables lists
-- partitioned parents and their partition children alike, so the monthly log
-- partitions are covered too; their row-level security has no policies, so a
-- grant on a child exposes nothing that the parent's policies do not.
--
-- authenticated gets SELECT/INSERT/UPDATE/DELETE and nothing else: those are
-- the privileges row-level security governs. TRUNCATE is not governed by it
-- and PostgREST never needs REFERENCES or TRIGGER. On the v2 project, which
-- was created under the legacy defaults, authenticated already holds ALL and
-- this grant changes nothing; narrowing that is left to a later migration.
do $$
declare
  obj record;
begin
  for obj in
    select format('%I.%I', schemaname, tablename) as ident
      from pg_tables
     where schemaname = 'public'
       and tablename like 'dam\_%'
  loop
    execute format('revoke all on table %s from public, anon', obj.ident);
    execute format('grant select, insert, update, delete on table %s to authenticated', obj.ident);
    execute format('grant all on table %s to service_role', obj.ident);
  end loop;
end;
$$;


-- =============================================================================
-- 2. Settings guards (SPEC 2B.53 "Invariants and triggers")
-- =============================================================================
-- Three BEFORE triggers with the SPEC's names. They fire in name order:
-- no_secrets, protect_system, validate, and then the baseline's
-- trg_settings_updated_at. None of them depends on another having run.
--
-- None is SECURITY DEFINER: they read nothing but the row itself (and the
-- immutable dam_config_has_no_secrets(), which authenticated and service_role
-- may already execute), so they need no privilege the writer lacks.

-- --- protect_system ----------------------------------------------------------
-- A system key can be re-valued or reset, never deleted, and its key and type
-- may not change (SCHEMA.sql comments on dam_settings.deleted_at and
-- .is_system). The column list goes beyond the SPEC's "key, value_type":
-- without deleted_at a system key could be soft-deleted, and without is_system
-- it could first be demoted to a tenant key and then deleted. Either would
-- make every dam_setting() caller of that key raise.
--
-- `update of <col>` fires whenever the column is in the SET list, changed or
-- not, so the function compares values: an upsert that rewrites an unchanged
-- key alongside a new value is allowed. Restoring a trashed system key
-- (deleted_at back to null) is allowed too; it is the safe direction.
create or replace function dam_settings_protect_system()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_system then
      raise exception 'dam_setting_protected: system setting % cannot be deleted', old.key
        using errcode = '42501',
              hint    = 'Change its value, or reset it to its default_value, instead.';
    end if;
    return old;
  end if;

  if not old.is_system then
    return new;
  end if;

  if new.key is distinct from old.key then
    raise exception 'dam_setting_protected: the key of system setting % cannot change', old.key
      using errcode = '42501';
  end if;

  if new.value_type is distinct from old.value_type then
    raise exception 'dam_setting_protected: the value type of system setting % cannot change', old.key
      using errcode = '42501';
  end if;

  if new.is_system is distinct from old.is_system then
    raise exception 'dam_setting_protected: system setting % cannot stop being a system setting', old.key
      using errcode = '42501';
  end if;

  if new.deleted_at is distinct from old.deleted_at and new.deleted_at is not null then
    raise exception 'dam_setting_protected: system setting % cannot be deleted', old.key
      using errcode = '42501',
            hint    = 'Change its value, or reset it to its default_value, instead.';
  end if;

  return new;
end;
$$;

comment on function dam_settings_protect_system() is
  'BEFORE DELETE OR UPDATE OF key, value_type, deleted_at, is_system on dam_settings (trg_dam_settings_protect_system, SPEC 2B.53): a system key cannot be deleted or soft-deleted, renamed, retyped or demoted to a tenant key. Raises 42501 dam_setting_protected. Compares values, so naming an unchanged column is allowed.';

-- --- validate ----------------------------------------------------------------
-- Applies dam_settings.validation, whose shape is { min, max, enum, pattern }
-- (SPEC 2B.53). Any other rule name is refused, so a typo such as "minimum"
-- fails loudly instead of validating nothing. A rule set to JSON null counts
-- as absent.
--   min / max  a number: bounds the value. A string: bounds its length in
--              characters. An array: bounds its number of items. Refused on
--              any other type.
--   enum       an array of allowed JSON values; the value must equal one.
--   pattern    a regular expression (Postgres ARE). A string value must match
--              it; for an array, every item must be a string that matches.
--              Refused on any other type.
-- Also, because the type-match CHECK accepts any JSON number for an
-- 'integer' setting: an integer setting must hold a whole number that fits in
-- bigint, which is what dam_setting_int() returns. That is why value_type is
-- in the column list as well as value and validation.
-- Error messages never echo the value, only the key and the rule.
create or replace function dam_settings_validate()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_rules   jsonb;
  v_type    text;
  v_rule    text;
  v_bound   jsonb;
  v_measure numeric;
  v_what    text;
  v_pattern text;
  v_item    jsonb;
begin
  -- Let the NOT NULL constraints report a missing value or rule set.
  if new.value is null or new.validation is null then
    return new;
  end if;

  v_rules := new.validation;
  v_type  := jsonb_typeof(new.value);

  if jsonb_typeof(v_rules) <> 'object' then
    raise exception 'dam_setting_invalid: the validation of % must be a JSON object', new.key
      using errcode = '23514';
  end if;

  for v_rule in select jsonb_object_keys(v_rules) loop
    if v_rule not in ('min', 'max', 'enum', 'pattern') then
      raise exception 'dam_setting_invalid: the validation of % has an unknown rule "%"', new.key, v_rule
        using errcode = '23514',
              hint    = 'The rules are min, max, enum and pattern.';
    end if;
  end loop;

  -- An integer setting holds a whole number within bigint.
  if new.value_type = 'integer' and v_type = 'number' then
    v_measure := (new.value)::numeric;
    if v_measure <> trunc(v_measure)
       or v_measure < -9223372036854775808
       or v_measure > 9223372036854775807 then
      raise exception 'dam_setting_invalid: % is an integer setting and must hold a whole number', new.key
        using errcode = '23514';
    end if;
  end if;

  -- min and max
  if nullif(v_rules -> 'min', 'null'::jsonb) is not null
     or nullif(v_rules -> 'max', 'null'::jsonb) is not null then
    if v_type = 'number' then
      v_measure := (new.value)::numeric;
      v_what    := 'value';
    elsif v_type = 'string' then
      v_measure := char_length(new.value #>> '{}');
      v_what    := 'length';
    elsif v_type = 'array' then
      v_measure := jsonb_array_length(new.value);
      v_what    := 'number of items';
    else
      raise exception 'dam_setting_invalid: min and max do not apply to the % value of %', v_type, new.key
        using errcode = '23514';
    end if;

    foreach v_rule in array array['min', 'max'] loop
      v_bound := nullif(v_rules -> v_rule, 'null'::jsonb);
      continue when v_bound is null;
      if jsonb_typeof(v_bound) <> 'number' then
        raise exception 'dam_setting_invalid: the % rule of % must be a number', v_rule, new.key
          using errcode = '23514';
      end if;
      if (v_rule = 'min' and v_measure < v_bound::numeric)
         or (v_rule = 'max' and v_measure > v_bound::numeric) then
        raise exception 'dam_setting_invalid: the % of % is %, outside its % of %',
                        v_what, new.key, v_measure, v_rule, v_bound
          using errcode = '23514';
      end if;
    end loop;
  end if;

  -- enum
  v_bound := nullif(v_rules -> 'enum', 'null'::jsonb);
  if v_bound is not null then
    if jsonb_typeof(v_bound) <> 'array' then
      raise exception 'dam_setting_invalid: the enum rule of % must be an array', new.key
        using errcode = '23514';
    end if;
    if not exists (select 1 from jsonb_array_elements(v_bound) as e(allowed) where e.allowed = new.value) then
      raise exception 'dam_setting_invalid: the value of % is not one of its allowed values', new.key
        using errcode = '23514';
    end if;
  end if;

  -- pattern
  v_bound := nullif(v_rules -> 'pattern', 'null'::jsonb);
  if v_bound is not null then
    if jsonb_typeof(v_bound) <> 'string' then
      raise exception 'dam_setting_invalid: the pattern rule of % must be a string', new.key
        using errcode = '23514';
    end if;
    v_pattern := v_bound #>> '{}';
    if v_type = 'string' then
      if (new.value #>> '{}') !~ v_pattern then
        raise exception 'dam_setting_invalid: the value of % does not match its pattern', new.key
          using errcode = '23514';
      end if;
    elsif v_type = 'array' then
      for v_item in select e.item from jsonb_array_elements(new.value) as e(item) loop
        if jsonb_typeof(v_item) <> 'string' or (v_item #>> '{}') !~ v_pattern then
          raise exception 'dam_setting_invalid: every item of % must be a string matching its pattern', new.key
            using errcode = '23514';
        end if;
      end loop;
    else
      raise exception 'dam_setting_invalid: the pattern rule does not apply to the % value of %', v_type, new.key
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

comment on function dam_settings_validate() is
  'BEFORE INSERT OR UPDATE OF value, value_type, validation on dam_settings (trg_dam_settings_validate, SPEC 2B.53): applies validation { min, max, enum, pattern } (min/max bound a number, a string''s length or an array''s item count; pattern applies to a string or to every item of an array) and requires an integer setting to hold a whole bigint. Raises 23514 dam_setting_invalid.';

-- --- no_secrets --------------------------------------------------------------
-- "The settings table is exactly where a hurried admin would paste an API
-- key" (SPEC 2B.53). The SPEC checks (key, value); default_value is checked
-- the same way, because it is what a reset writes back into value.
-- coalesce() on the key only keeps jsonb_build_object() from failing before
-- the NOT NULL constraint can report the missing key.
create or replace function dam_settings_no_secrets()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not dam_config_has_no_secrets(jsonb_build_object(coalesce(new.key, ''), new.value))
     or not dam_config_has_no_secrets(jsonb_build_object(coalesce(new.key, ''), new.default_value)) then
    raise exception 'dam_setting_secret: setting % looks like it holds a secret', new.key
      using errcode = '23514',
            hint    = 'Keep the secret in Secret Manager and store its name, under a key ending in _name.';
  end if;
  return new;
end;
$$;

comment on function dam_settings_no_secrets() is
  'BEFORE INSERT OR UPDATE OF key, value, default_value on dam_settings (trg_dam_settings_no_secrets, SPEC 2B.53): raises 23514 dam_setting_secret when dam_config_has_no_secrets() rejects {key: value} or {key: default_value}.';

drop trigger if exists trg_dam_settings_protect_system on dam_settings;
create trigger trg_dam_settings_protect_system
  before delete or update of key, value_type, deleted_at, is_system on dam_settings
  for each row execute function dam_settings_protect_system();

drop trigger if exists trg_dam_settings_validate on dam_settings;
create trigger trg_dam_settings_validate
  before insert or update of value, value_type, validation on dam_settings
  for each row execute function dam_settings_validate();

drop trigger if exists trg_dam_settings_no_secrets on dam_settings;
create trigger trg_dam_settings_no_secrets
  before insert or update of key, value, default_value on dam_settings
  for each row execute function dam_settings_no_secrets();


-- =============================================================================
-- 3. The accessor (SPEC 2B.53, D-348)
-- =============================================================================
-- dam_setting() returns the live row's value and raises when there is no live
-- row: a typo in a trigger must fail loudly, not behave as null.
-- `dam_unknown_setting` is not a Postgres condition name, so the error carries
-- SQLSTATE P0002 (no_data_found) with the name at the start of the message.
--
-- The SPEC's "falling back to default_value" cannot choose default_value:
-- value is NOT NULL, and a missing row has no default_value to fall back to.
-- The coalesce() states the intent and costs nothing.
--
-- SECURITY DEFINER so a trigger running as any role can read settings
-- regardless of the dam_settings policies. It is therefore NOT granted to
-- anon (section 5): an anonymous caller could otherwise read every key.
create or replace function dam_setting(p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_value jsonb;
begin
  select coalesce(s.value, s.default_value)
    into v_value
    from dam_settings s
   where s.key = p_key
     and s.deleted_at is null;

  if not found then
    raise exception 'dam_unknown_setting: %', p_key
      using errcode = 'P0002',
            hint    = 'Settings are seeded by migration; check the key for a typo.';
  end if;

  return v_value;
end;
$$;

comment on function dam_setting(text) is
  'Settings accessor (SPEC 2B.53, D-348): the live dam_settings value for p_key; raises P0002 "dam_unknown_setting: <key>" when there is no live row. SECURITY DEFINER, so readable from triggers under any role.';

-- #>> '{}' unwraps a JSON string without the quotes ::text would keep. A JSON
-- null gives SQL null; an array or object gives its JSON text.
create or replace function dam_setting_text(p_key text)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  return dam_setting(p_key) #>> '{}';
end;
$$;

comment on function dam_setting_text(text) is
  'dam_setting(p_key) unwrapped to text (#>> ''{}''): a JSON string without its quotes; SQL null for a JSON null.';

-- bigint, not the SPEC's int: uploads.max_file_bytes is 10737418240.
create or replace function dam_setting_int(p_key text)
returns bigint
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_value jsonb;
  v_num   numeric;
begin
  v_value := dam_setting(p_key);

  if jsonb_typeof(v_value) is distinct from 'number' then
    raise exception 'dam_setting_int: setting % holds a %, not a whole number', p_key, jsonb_typeof(v_value)
      using errcode = '22023';
  end if;

  v_num := v_value::numeric;
  if v_num <> trunc(v_num) then
    raise exception 'dam_setting_int: setting % holds a fraction, not a whole number', p_key
      using errcode = '22023';
  end if;

  return v_num::bigint;
end;
$$;

comment on function dam_setting_int(text) is
  'dam_setting(p_key) as bigint (SPEC says int; bigint because uploads.max_file_bytes overflows int4). Raises 22023 unless the value is a whole JSON number.';

create or replace function dam_setting_bool(p_key text)
returns boolean
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_value jsonb;
begin
  v_value := dam_setting(p_key);

  if jsonb_typeof(v_value) is distinct from 'boolean' then
    raise exception 'dam_setting_bool: setting % holds a %, not a boolean', p_key, jsonb_typeof(v_value)
      using errcode = '22023';
  end if;

  return (v_value #>> '{}')::boolean;
end;
$$;

comment on function dam_setting_bool(text) is
  'dam_setting(p_key) as boolean. Raises 22023 unless the value is a JSON boolean.';


-- =============================================================================
-- 4. Seeds
-- =============================================================================

-- --- 4.1 Settings --------------------------------------------------------------
-- The SPEC 2B.53 seed table, less ai.autoaccept_confidence (see the header),
-- plus users.default_cross_studio_visibility. value = default_value on every
-- row; every row is a system key. Inserted AFTER the guard triggers exist, so
-- the seed itself passes no_secrets and validate. The one key whose name
-- contains "secret" ends in _name, which dam_config_has_no_secrets() exempts:
-- it holds the NAME of a Secret Manager entry, never the salt.
--
-- Groups follow the settings page sections: users.* sits under privacy
-- because group_name has no users or access section. The validation bounds
-- are deliberately generous; they exist to stop a nonsense value (a zero page
-- size, a digest at hour 25), not to encode policy.
--
-- Fixed ids (5e000000-...-0000000000NN), like every baseline seed, so a row is
-- the same row in every environment. The conflict target is still the key:
-- `on conflict (key) do nothing`, so an administrator's later change to a
-- value survives a re-run.
insert into dam_settings
  (id, key, value_type, value, default_value, group_name, validation, is_system, requires_restart, description)
values
  ('5e000000-0000-4000-8000-000000000001', 'firm.legal_name', 'string',
   '"dwp"'::jsonb, '"dwp"'::jsonb,
   'general', '{"min": 1, "max": 200}'::jsonb, true, false,
   'The firm''s legal name, used in credit lines, rights notices and exported documents.'),

  ('5e000000-0000-4000-8000-000000000002', 'firm.timezone', 'string',
   '"Asia/Bangkok"'::jsonb, '"Asia/Bangkok"'::jsonb,
   'general', '{"pattern": "^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$"}'::jsonb, true, false,
   'IANA time zone for firm-wide schedules and dates, and for any user who has not chosen their own.'),

  ('5e000000-0000-4000-8000-000000000003', 'users.auto_activate_domains', 'array',
   '["dwp.com"]'::jsonb, '["dwp.com"]'::jsonb,
   'privacy', '{"pattern": "^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?([.][A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$"}'::jsonb, true, false,
   'Email domains whose people are active from their first sign-in. Anyone else is created inactive and waits for an administrator.'),

  ('5e000000-0000-4000-8000-000000000004', 'users.default_cross_studio_visibility', 'boolean',
   'true'::jsonb, 'true'::jsonb,
   'privacy', '{}'::jsonb, true, false,
   'New users see other studios'' studio-level assets. On by default so the preview matches today''s library, where everyone sees everything.'),

  ('5e000000-0000-4000-8000-000000000005', 'albums.max_depth', 'integer',
   '5'::jsonb, '5'::jsonb,
   'general', '{"min": 1, "max": 10}'::jsonb, true, false,
   'How many levels deep albums may be nested.'),

  ('5e000000-0000-4000-8000-000000000006', 'text_blocks.allow_self_approval', 'boolean',
   'false'::jsonb, 'false'::jsonb,
   'general', '{}'::jsonb, true, false,
   'Whether the author of a text block may approve their own version.'),

  ('5e000000-0000-4000-8000-000000000007', 'templates.allow_self_approval', 'boolean',
   'false'::jsonb, 'false'::jsonb,
   'general', '{}'::jsonb, true, false,
   'Whether the author of a template may approve their own version.'),

  ('5e000000-0000-4000-8000-000000000008', 'review.allow_self_approval', 'boolean',
   'false'::jsonb, 'false'::jsonb,
   'general', '{}'::jsonb, true, false,
   'Whether the person who asked for a review may also sign it off.'),

  ('5e000000-0000-4000-8000-000000000009', 'rights.expiring_days', 'integer',
   '30'::jsonb, '30'::jsonb,
   'rights', '{"min": 1, "max": 365}'::jsonb, true, false,
   'Days before a licence ends at which an asset''s rights status becomes expiring.'),

  ('5e000000-0000-4000-8000-000000000010', 'watermark.default_text', 'string',
   '"dwp — for review"'::jsonb, '"dwp — for review"'::jsonb,
   'sharing', '{"max": 200}'::jsonb, true, false,
   'Text stamped on watermarked previews when an output preset does not set its own.'),

  ('5e000000-0000-4000-8000-000000000011', 'shares.default_ttl_days', 'integer',
   '30'::jsonb, '30'::jsonb,
   'sharing', '{"min": 1, "max": 3650}'::jsonb, true, false,
   'Days a new share link stays open when its creator does not choose an expiry.'),

  ('5e000000-0000-4000-8000-000000000012', 'upload_requests.default_ttl_days', 'integer',
   '14'::jsonb, '14'::jsonb,
   'sharing', '{"min": 1, "max": 3650}'::jsonb, true, false,
   'Days a new upload request stays open when its creator does not choose an expiry.'),

  ('5e000000-0000-4000-8000-000000000013', 'uploads.max_file_bytes', 'integer',
   '10737418240'::jsonb, '10737418240'::jsonb,
   'uploads', '{"min": 1}'::jsonb, true, false,
   'Largest single file, in bytes, that an upload or an upload request accepts. 10 GiB by default.'),

  ('5e000000-0000-4000-8000-000000000014', 'jobs.visibility_timeout_seconds', 'integer',
   '900'::jsonb, '900'::jsonb,
   'jobs', '{"min": 30, "max": 86400}'::jsonb, true, true,
   'Seconds a claimed background job may go without a heartbeat before another worker may take it over.'),

  ('5e000000-0000-4000-8000-000000000015', 'integrations.max_consecutive_failures', 'integer',
   '5'::jsonb, '5'::jsonb,
   'integrations', '{"min": 1, "max": 1000}'::jsonb, true, false,
   'Failed runs in a row after which an integration is paused and its owner is told.'),

  ('5e000000-0000-4000-8000-000000000016', 'webhooks.rotation_overlap_hours', 'integer',
   '24'::jsonb, '24'::jsonb,
   'integrations', '{"min": 0, "max": 720}'::jsonb, true, false,
   'Hours a webhook''s previous signing secret stays valid after it is rotated.'),

  ('5e000000-0000-4000-8000-000000000017', 'audit.redacted_columns', 'array',
   '["key_hash", "token_hash", "password_hash", "secret_hash", "api_secret", "private_key"]'::jsonb,
   '["key_hash", "token_hash", "password_hash", "secret_hash", "api_secret", "private_key"]'::jsonb,
   'privacy', '{"pattern": "^[a-z_][a-z0-9_]*$"}'::jsonb, true, false,
   'Column names whose values the audit log replaces with a placeholder in its before and after images.'),

  ('5e000000-0000-4000-8000-000000000018', 'privacy.ip_hash_salt_secret_name', 'string',
   '"DAM_IP_HASH_SALT"'::jsonb, '"DAM_IP_HASH_SALT"'::jsonb,
   'privacy', '{"pattern": "^[A-Za-z0-9_-]{1,255}$"}'::jsonb, true, false,
   'Name of the Secret Manager entry that holds the salt for hashing IP addresses. The salt itself never reaches the database.'),

  ('5e000000-0000-4000-8000-000000000019', 'notifications.digest_hour', 'integer',
   '8'::jsonb, '8'::jsonb,
   'notifications', '{"min": 0, "max": 23}'::jsonb, true, false,
   'Hour of the day, in the firm time zone, at which daily notification digests are sent.'),

  ('5e000000-0000-4000-8000-000000000020', 'ai.runs_retention_months', 'integer',
   '24'::jsonb, '24'::jsonb,
   'ai', '{"min": 1, "max": 120}'::jsonb, true, false,
   'Months an AI run record is kept before the retention job removes it.'),

  ('5e000000-0000-4000-8000-000000000021', 'search.default_limit', 'integer',
   '50'::jsonb, '50'::jsonb,
   'search', '{"min": 1, "max": 1000}'::jsonb, true, false,
   'Results per page when a search does not ask for a page size.'),

  ('5e000000-0000-4000-8000-000000000022', 'search.max_limit', 'integer',
   '200'::jsonb, '200'::jsonb,
   'search', '{"min": 1, "max": 1000}'::jsonb, true, false,
   'Largest page size a search may ask for.')
on conflict (key) do nothing;

-- --- 4.2 System principals (SPEC 2B.1, D-272; ...0005 is D-375) ------------------
-- Fixed ids so importers, workers and the web tier have a stable created_by
-- and JWT `sub` before any person exists. Inert by construction:
-- dam_users_system_principal_check requires is_active = false and the
-- reserved @system.dam.invalid domain, and dam_current_role() ignores an
-- inactive row, so the global_admin role grants nothing through the helpers.
-- is_system cannot be changed afterwards (trg_users_guard_privileged_columns).
insert into dam_users (id, email, display_name, role, is_active, is_system)
values
  ('00000000-0000-0000-0000-000000000001', 'migration@system.dam.invalid', 'Migration',      'global_admin'::dam_role, false, true),
  ('00000000-0000-0000-0000-000000000002', 'worker@system.dam.invalid',    'Worker',         'global_admin'::dam_role, false, true),
  ('00000000-0000-0000-0000-000000000003', 'sync@system.dam.invalid',      'Directory sync', 'global_admin'::dam_role, false, true),
  ('00000000-0000-0000-0000-000000000004', 'ai@system.dam.invalid',        'AI',             'global_admin'::dam_role, false, true),
  ('00000000-0000-0000-0000-000000000005', 'web@system.dam.invalid',       'Web service',    'global_admin'::dam_role, false, true)
on conflict (id) do nothing;

-- --- 4.3 Assert the seeds took ---------------------------------------------------
-- `on conflict do nothing` would silently keep a pre-existing row that is not
-- what later migrations rely on (a trashed setting, a live row at a system id
-- that is not a system principal). Fail the migration instead: it is one
-- transaction, so nothing is left half-applied.
do $$
declare
  v_key     text;
  v_missing integer;
begin
  foreach v_key in array array[
    'firm.legal_name', 'firm.timezone', 'users.auto_activate_domains',
    'users.default_cross_studio_visibility', 'albums.max_depth',
    'text_blocks.allow_self_approval', 'templates.allow_self_approval',
    'review.allow_self_approval', 'rights.expiring_days', 'watermark.default_text',
    'shares.default_ttl_days', 'upload_requests.default_ttl_days',
    'uploads.max_file_bytes', 'jobs.visibility_timeout_seconds',
    'integrations.max_consecutive_failures', 'webhooks.rotation_overlap_hours',
    'audit.redacted_columns', 'privacy.ip_hash_salt_secret_name',
    'notifications.digest_hour', 'ai.runs_retention_months',
    'search.default_limit', 'search.max_limit'
  ] loop
    perform dam_setting(v_key);   -- raises P0002 when there is no live row
  end loop;

  select 5 - count(*)
    into v_missing
    from dam_users u
   where u.id in ('00000000-0000-0000-0000-000000000001',
                  '00000000-0000-0000-0000-000000000002',
                  '00000000-0000-0000-0000-000000000003',
                  '00000000-0000-0000-0000-000000000004',
                  '00000000-0000-0000-0000-000000000005')
     and u.is_system
     and not u.is_active
     and u.deleted_at is null;

  if v_missing <> 0 then
    raise exception 'p1_grants_settings_principals: % of the 5 system principals are missing, trashed or not system rows', v_missing
      using errcode = '23514';
  end if;
end;
$$;


-- =============================================================================
-- 5. Function privileges (explicit, per function; never the baseline's
--    all-functions loop, which would re-grant authenticated on functions that
--    later migrations reserve for service_role)
-- =============================================================================

-- Settings accessors: every signed-in principal and the service role; never anon.
revoke all on function public.dam_setting(text) from public, anon;
grant execute on function public.dam_setting(text) to authenticated, service_role;

revoke all on function public.dam_setting_text(text) from public, anon;
grant execute on function public.dam_setting_text(text) to authenticated, service_role;

revoke all on function public.dam_setting_int(text) from public, anon;
grant execute on function public.dam_setting_int(text) to authenticated, service_role;

revoke all on function public.dam_setting_bool(text) from public, anon;
grant execute on function public.dam_setting_bool(text) to authenticated, service_role;

-- Trigger functions: callable only as triggers anyway; no PUBLIC or anon grant.
revoke all on function public.dam_settings_protect_system() from public, anon;
revoke all on function public.dam_settings_validate() from public, anon;
revoke all on function public.dam_settings_no_secrets() from public, anon;

-- The baseline created this one after its revoke loop, so it kept PUBLIC EXECUTE.
revoke all on function public.dam_users_guard_privileged_columns() from public, anon;
