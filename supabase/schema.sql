-- Run this in the Supabase SQL editor before using the app.

-- Trigram extension, required by the name-search index (gin_trgm_ops) below.
-- On Supabase this installs into the `extensions` schema.
create extension if not exists pg_trgm;

create table if not exists common_dam_assets (
  id uuid primary key default gen_random_uuid(),
  drive_file_id text not null unique,
  name text not null,
  folder_id text not null,
  folder_path text not null,
  tags text[] not null default '{}',
  -- Taxonomy classification (Macro Portfolio → Core Sector → Sub-Sectors).
  macro_portfolio text,
  core_sector text,
  sub_sectors text[] not null default '{}',
  mime_type text not null,
  size_bytes bigint not null default 0,
  web_view_link text not null,
  thumbnail_link text,
  uploaded_by text,
  publish_permission text not null default 'pending',
  created_at timestamptz not null default now()
);

-- Migration for existing installs that predate the taxonomy or publish_permission columns.
alter table common_dam_assets add column if not exists macro_portfolio text;
alter table common_dam_assets add column if not exists core_sector text;
alter table common_dam_assets add column if not exists sub_sectors text[] not null default '{}';
alter table common_dam_assets add column if not exists publish_permission text default 'pending';

-- Fast tag lookups (contains / overlap queries).
create index if not exists common_dam_assets_tags_gin on common_dam_assets using gin (tags);

-- Fast taxonomy filtering.
create index if not exists common_dam_assets_macro_idx on common_dam_assets (macro_portfolio);
create index if not exists common_dam_assets_core_idx on common_dam_assets (core_sector);
create index if not exists common_dam_assets_sub_gin on common_dam_assets using gin (sub_sectors);
create index if not exists common_dam_assets_publish_permission_idx on common_dam_assets (publish_permission);

-- Fast folder browsing.
create index if not exists common_dam_assets_folder_id_idx on common_dam_assets (folder_id);

-- Fast name search (uses the pg_trgm extension enabled at the top of this file).
create index if not exists common_dam_assets_name_trgm on common_dam_assets using gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Taxonomy reference table — the dwp Sector & Sub-Sector taxonomy in joinable
-- form (one row per Sub-Sector). Join it to assets on core_sector, or per
-- sub-sector via unnest:
--   select a.*, t.macro_portfolio
--   from common_dam_assets a
--   cross join lateral unnest(a.sub_sectors) as s(name)
--   join common_dam_taxonomy t on t.sub_sector = s.name;
-- Must be kept in sync with lib/taxonomy.ts (the app's source of truth).
-- ---------------------------------------------------------------------------
create table if not exists common_dam_taxonomy (
  id bigint generated always as identity primary key,
  macro_portfolio text not null,
  core_sector text not null,
  sub_sector text not null,
  unique (macro_portfolio, core_sector, sub_sector)
);

insert into common_dam_taxonomy (macro_portfolio, core_sector, sub_sector) values
  ('Lifestyle','Hospitality','Luxury Resort'),
  ('Lifestyle','Hospitality','Urban Business Hotel'),
  ('Lifestyle','Hospitality','Boutique & Lifestyle'),
  ('Lifestyle','Hospitality','Serviced Apartments'),
  ('Lifestyle','Hospitality','Eco-Lodge'),
  ('Lifestyle','Food & Beverage','Fine Dining'),
  ('Lifestyle','Food & Beverage','Destination Bar'),
  ('Lifestyle','Food & Beverage','All-Day Dining'),
  ('Lifestyle','Food & Beverage','Cafe & Lounge'),
  ('Lifestyle','Food & Beverage','Speakeasy'),
  ('Lifestyle','Residential','High-Rise Residential'),
  ('Lifestyle','Residential','Super-Luxury Villas'),
  ('Lifestyle','Residential','Showflat'),
  ('Lifestyle','Residential','Co-Living'),
  ('Lifestyle','Residential','Branded Residences'),
  ('Lifestyle','Retail & Leisure','Experiential Retail'),
  ('Lifestyle','Retail & Leisure','Wellness Spa'),
  ('Lifestyle','Retail & Leisure','Fitness & Sports Club'),
  ('Lifestyle','Retail & Leisure','Flagship Store'),
  ('Lifestyle','Retail & Leisure','Entertainment Hub'),
  ('Workplace','Corporate','Global HQ'),
  ('Workplace','Corporate','Tech & Innovation Hub'),
  ('Workplace','Corporate','Financial Services'),
  ('Workplace','Corporate','Creative Studio'),
  ('Workplace','Corporate','Regional Office'),
  ('Workplace','Co-Working','Flexible Workspace'),
  ('Workplace','Co-Working','Executive Club'),
  ('Workplace','Co-Working','Incubator Space'),
  ('Community','Healthcare','Medical Center'),
  ('Community','Healthcare','Wellness Retreat'),
  ('Community','Healthcare','Patient-Centric Facility'),
  ('Community','Healthcare','Specialized Clinic'),
  ('Community','Education','Higher Ed Campus'),
  ('Community','Education','K-12 School'),
  ('Community','Education','Learning Commons'),
  ('Community','Education','Research Lab'),
  ('Community','Education','Student Hub'),
  ('Community','Civic & Cultural','Public Realm'),
  ('Community','Civic & Cultural','Exhibition Space'),
  ('Community','Civic & Cultural','Mixed-Use Precinct'),
  ('Community','Civic & Cultural','Museum'),
  ('Community','Civic & Cultural','Community Center')
on conflict (macro_portfolio, core_sector, sub_sector) do nothing;

-- ---------------------------------------------------------------------------
-- Preset tag library (drives the Presets panel on the upload page AND the
-- vocabulary the AI may auto-tag from). Edit rows here to change the presets —
-- the app picks changes up automatically (server caches for ~5 minutes).
-- ---------------------------------------------------------------------------
create table if not exists common_dam_presets (
  id bigint generated always as identity primary key,
  group_name text not null,
  tag text not null,
  sort_order int not null default 0,
  unique (group_name, tag)
);

insert into common_dam_presets (group_name, tag, sort_order) values
  ('Macro Portfolio','Lifestyle',1),
  ('Macro Portfolio','Workplace',2),
  ('Macro Portfolio','Community',3),
  ('Staff & Culture','Role Seniority',4),
  ('Staff & Culture','Function / Group',5),
  ('Staff & Culture','Portrait Style Variant',6),
  ('Brand Activation','Event Typology',7),
  ('Brand Activation','Social Content Format',8),
  ('Location Matrix','Global Region',9),
  ('Location Matrix','Studio Hub (Jurisdiction)',10),
  ('Location Matrix','Climate / Setting Context',11),
  ('Project Excellence','Global Flagship',12),
  ('Project Excellence','Award Winner',13),
  ('Project Excellence','Press Featured',14),
  ('Sustainability & Wellness','Biophilic Design',15),
  ('Sustainability & Wellness','Net-Zero Carbon',16),
  ('Sustainability & Wellness','Institutional Standard',17),
  ('Digital Innovation','AI-Accelerated Workflow',18),
  ('Digital Innovation','Advanced 3D Visualisation',19),
  ('Digital Innovation','Smart Building',20),
  ('Marketing Performance','Top Social Performer',21),
  ('Marketing Performance','Executive Approved',22),
  ('Project Reference','Project Status',23),
  ('Project Reference','Lead Studio',24),
  ('Project Reference','Scope of Work',25),
  ('Video & Motion','Motion Format',26),
  ('Video & Motion','Master / Derivative',27),
  ('Video & Motion','Audio & Language',28),
  ('Video & Motion','Drone Compliance',29),
  ('Rights & Licensing','Licence Type',30),
  ('Rights & Licensing','Confidentiality Status',31),
  ('Rights & Licensing','Consent / Releases',32),
  ('Rights & Licensing','Territory Restrictions',33),
  ('Asset Lifecycle','Draft',34),
  ('Asset Lifecycle','In Review',35),
  ('Asset Lifecycle','Approved',36),
  ('Asset Lifecycle','Published',37),
  ('Asset Lifecycle','Superseded',38),
  ('Asset Lifecycle','Expired',39),
  ('Asset Lifecycle','Archived',40),
  ('Asset Lifecycle','Version Numbering',41),
  ('Asset Lifecycle','Review Cadence',42),
  ('AI Provenance','Digital Source Type',43),
  ('AI Provenance','AI System Used',44),
  ('AI Provenance','Prompt on File',45),
  ('AI Provenance','Content Credentials',46),
  ('AI Provenance','Disclosure Clearance',47)
on conflict (group_name, tag) do nothing;

-- Join assets to the taxonomy table, e.g. per-sub-sector counts:
--   select t.macro_portfolio, t.core_sector, t.sub_sector, count(a.id) as assets
--   from common_dam_taxonomy t
--   left join common_dam_assets a
--     on a.core_sector = t.core_sector and t.sub_sector = any(a.sub_sectors)
--   group by 1, 2, 3
--   order by 1, 2, 3;

-- ---------------------------------------------------------------------------
-- Folder-tree sync state (lib/folderIndex.ts).
--
-- Google Drive's whole-drive folder listing is eventually consistent on a scale
-- of hours, so the app keeps its own folder index fresh with the Drive Changes
-- API. This table stores, per Shared Drive, the change-feed token to replay
-- from after a restart / on a new Cloud Run instance, so folders created (or
-- trashed) in the hours before that restart are still reflected. `page_token`
-- is the replay-from token; `candidate_token` is a younger token that the app
-- promotes into `page_token` once it is ~2 days old (old enough that Drive's
-- listing can be trusted for everything before it). One row per drive; the app
-- creates and advances the rows itself. Without this table the app still works
-- but logs a warning and loses that cross-restart guarantee.
create table if not exists common_dam_drive_sync (
  drive_id        text primary key,
  page_token      text not null,
  candidate_token text,
  candidate_at    timestamptz,
  updated_at      timestamptz not null default now()
);
-- Like the other tables: the app writes with the anon key, so RLS must stay
-- off (the dashboard's Table Editor turns it on for tables it creates).
alter table common_dam_drive_sync disable row level security;
