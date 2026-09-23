-- tools/pgtest/fixtures.sql -- a mini-library shaped exactly like the imported v2 data.
--
-- Loads after SCHEMA.sql ALONE and depends on no migration:
--   node apply.mjs --files --fixtures fixtures.sql       (baseline + fixtures)
--   node apply.mjs --fixtures fixtures.sql               (baseline + every migration + fixtures)
-- With the migrations applied, their triggers fire on these inserts (search rows, integrity checks) exactly as
-- they would for a future import. The data must therefore satisfy every rule the migrations enforce too:
-- asset links only to asset-namespace keywords, project links only to project-namespace keywords, at most one
-- keyword per exclusive category per asset, live targets, paths and depths consistent with parents.
--
-- WHERE THE SHAPES COME FROM. Every row replays scripts/import-stage1..4.mjs over a hand-designed corpus, using
-- scripts/lib/derive.mjs itself (derivePath, fileKindFor, categorySlugFor): titles, categories, statuses,
-- studios, flags, legacy.derived, project grouping by code, ranks, sector link weights and the exclusive-category
-- rule are what the import would have written for these v1 rows. It was generated once by a throwaway script;
-- edit it by hand from here on, keeping those rules.
--
-- What matches v2 (as a read-only probe found it on 2026-09-23): one google_drive storage location registered in place; exactly one
-- version per asset (version_no 1, object_key = the Drive file id, object_container 'dwp_Digital_Asset');
-- current_version_id set by a later UPDATE, as Stage 1 did; dwp_dam_v1 + google_drive external ids per asset and
-- openasset ids on projects from '_OpenAsset Projects'; projects all 'unverified' at the Studio level, code_source
-- 'folder', one alias per folder path; at most one project per asset, ranks dense by (created_at, id); the Sector
-- tree as project keywords (depth 1-3, parent_id + path set, descendant_ids empty); flat depth-1 asset keywords;
-- asset links weight 1.000, project links weighted by the share of the project's assets; every link source
-- 'migration'; no dam_project_studios, clients, rights, ratings, heroes or search rows.
-- Deliberate additions v2 does not have today: asset fa000000-0000-4000-8000-000000000010 carries an explicit access_level_id
-- (Restricted), so the effective-level rules have a case to test; and a small set of test principals (last section).
--
-- FIXED IDS (tests reference these)
--   storage location   f5000000-0000-4000-8000-000000000001   drive-dwp-digital-asset
--   projects           f1000000-0000-4000-8000-0000000000NN
--     01  22-0047   Khao Yai Residence           home bangkok
--     02  20-0040   Rawai Beach Resort Phuket    home bangkok
--     03  12-65100  Marina Bay Corporate Tower   home singapore + malaysia folder
--     04  402520    Gold Coast Private Hospital  home australia
--     05  (no code) Sukhumvit Showflat           home bangkok
--     06  23-0126   Hanoi Tech Campus            home (none)
--   assets             fa000000-0000-4000-8000-0000000000NN (01-26); versions fb000000-...NN (same NN)
--   v1 ids             0e1f0000-0000-4000-8000-0000000000NN (dam_external_ids system dwp_dam_v1)
--   Sector keywords    f7000000-0000-4000-8000-0000000000NN; asset keywords f6000000-...NN
--   new asset keyword categories f4000000-...03 design-style, ...04 lighting, ...06 setting
--   test principals    f9000000-0000-4000-8000-0000000000NN (see the last section)
--
-- Cases worth knowing:
--   * fa000000-0000-4000-8000-000000000003 is the one pending asset (v1 'restricted'; flags needs_review).
--   * 11, 12, 13 and 15 share one created_at (a tie group, like the ~100-row groups in v2): keyset paging needs asset_id.
--   * Project 03 is filed under Singapore and MALAYSIA (flags sector_conflict, the import's multi-studio flag);
--     assets 13 and 14 have dam_assets.studio_id = malaysia, which is ignored because they have a project.
--   * Assets 04, 05 and 21 come from '3D Projects' (category renderings, dam_assets.studio_id null).
--   * Project 05 has no code (flags needs_code); project 06 has no studio; project 04's home is the australia
--     region group.
--   * Asset 22's v1 macro_portfolio is 'Brand Activation', a preset group name Stage 3 rejects: no sector link.
--   * Asset 20 has no sector at all, so project 05's sector weights are 0.667.
--   * Assets 23-26 have no project: 23 has a studio (australia), 24-26 do not. 24 is Marketing Collateral and
--     26 Logos and Brand (both Firm-wide by category); 23 and 25 are Project Photography (Studio).
--   * Asset 01 carries v1 tags 'dusk' then 'night' (Time of Day is exclusive: only dusk is linked); asset 02
--     carries 'timber flooring' and 'timber-flooring' (one keyword, one link); 'sydney', 'smart building' and
--     'institutional standard' were classified 'drop' and are never linked.
set search_path = public, extensions, pg_catalog;

-- ---------------------------------------------------------------------------
-- Stage 1: the storage location, assets, versions, the back-pointer, external ids
-- ---------------------------------------------------------------------------
insert into dam_storage_locations (id, name, slug, provider, tier, is_default_originals, allow_register_in_place, notes) values
  ('f5000000-0000-4000-8000-000000000001', 'Drive — dwp_Digital_Asset', 'drive-dwp-digital-asset', 'google_drive', 'hot', true, true,
   'Registered in place by the v1 import. Objects are addressed by Drive fileId.');

insert into dam_assets (id, created_at, filename, title, title_source, category_id, status, access_level_id, studio_id,
                        file_kind, mime_type, size_bytes, ingest_relative_path, legacy, flags) values
  ('fa000000-0000-4000-8000-000000000001', '2024-11-04T03:21:09.412Z', 'KYR_Pool_Dusk_01.jpg', 'KYR Pool Dusk 01', 'filename', 'c1000000-0000-4000-8000-000000000001', 'approved', null::uuid, '51000000-0000-4000-8000-000000000003', 'image', 'image/jpeg', 8421377, 'dwp_Digital_Asset/dwp Projects/THAILAND/Residential/22-0047 Khao Yai Residence/KHAOYAI_HOUSE_HIRES',
   '{"folder_id":"1FxFolder010000000000000000000000","folder_path":"dwp_Digital_Asset/dwp Projects/THAILAND/Residential/22-0047 Khao Yai Residence/KHAOYAI_HOUSE_HIRES","web_view_link":"https://drive.google.com/file/d/1Fx01DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":["swimming pool","dusk","night","exterior facade","warm neutral","contemporary luxury","tropical","natural daylight","infinity edge","sydney"],"macro_portfolio":"Lifestyle","core_sector":"Residential","sub_sectors":["Super-Luxury Villas"],"derived":{"collection":"dwp Projects","studio_folder":"THAILAND","sector":"Residential","code":"22-0047","project":"Khao Yai Residence","outcome":"code + name"}}'::jsonb, '{}'::text[]),
  ('fa000000-0000-4000-8000-000000000002', '2024-11-04T03:21:10.020Z', 'KYR_Living_Day_02.jpg', 'KYR Living Day 02', 'filename', 'c1000000-0000-4000-8000-000000000001', 'approved', null::uuid, '51000000-0000-4000-8000-000000000003', 'image', 'image/jpeg', 6120554, 'dwp_Digital_Asset/dwp Projects/THAILAND/Residential/22-0047 Khao Yai Residence/KHAOYAI_HOUSE_HIRES',
   '{"folder_id":"1FxFolder010000000000000000000000","folder_path":"dwp_Digital_Asset/dwp Projects/THAILAND/Residential/22-0047 Khao Yai Residence/KHAOYAI_HOUSE_HIRES","web_view_link":"https://drive.google.com/file/d/1Fx02DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":["interior","day","timber flooring","timber-flooring","natural daylight","contemporary luxury","warm neutral","institutional standard"],"macro_portfolio":"Lifestyle","core_sector":"Residential","sub_sectors":["Super-Luxury Villas"],"derived":{"collection":"dwp Projects","studio_folder":"THAILAND","sector":"Residential","code":"22-0047","project":"Khao Yai Residence","outcome":"code + name"}}'::jsonb, '{}'::text[]),
  ('fa000000-0000-4000-8000-000000000003', '2024-11-04T03:21:11.735Z', 'KYR_Bedroom_03.tif', 'KYR Bedroom 03', 'filename', 'c1000000-0000-4000-8000-000000000001', 'pending', null::uuid, '51000000-0000-4000-8000-000000000003', 'image', 'image/tiff', 84220311, 'dwp_Digital_Asset/dwp Projects/THAILAND/Residential/22-0047 Khao Yai Residence/KHAOYAI_HOUSE_HIRES',
   '{"folder_id":"1FxFolder010000000000000000000000","folder_path":"dwp_Digital_Asset/dwp Projects/THAILAND/Residential/22-0047 Khao Yai Residence/KHAOYAI_HOUSE_HIRES","web_view_link":"https://drive.google.com/file/d/1Fx03DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"restricted","uploaded_by":null,"tags":["bedroom","interior","marble","pendant lighting","warm neutral","night"],"macro_portfolio":"Lifestyle","core_sector":"Residential","sub_sectors":["Super-Luxury Villas"],"derived":{"collection":"dwp Projects","studio_folder":"THAILAND","sector":"Residential","code":"22-0047","project":"Khao Yai Residence","outcome":"code + name"}}'::jsonb, array['needs_review']::text[]),
  ('fa000000-0000-4000-8000-000000000004', '2025-01-20T08:02:33.000Z', 'KYR_Aerial_Render_A.psd', 'KYR Aerial Render A', 'filename', 'c1000000-0000-4000-8000-000000000002', 'approved', null::uuid, null::uuid, 'design', 'image/x-photoshop', 251338004, 'dwp_Digital_Asset/3D Projects/22-0047 Khao Yai Residence',
   '{"folder_id":"1FxFolder020000000000000000000000","folder_path":"dwp_Digital_Asset/3D Projects/22-0047 Khao Yai Residence","web_view_link":"https://drive.google.com/file/d/1Fx04DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":["aerial view","tropical","contemporary luxury","smart building"],"macro_portfolio":"Lifestyle","core_sector":"Hospitality","sub_sectors":["Boutique & Lifestyle"],"derived":{"collection":"3D Projects","studio_folder":null,"code":"22-0047","project":"Khao Yai Residence","outcome":"code + name"}}'::jsonb, '{}'::text[]),
  ('fa000000-0000-4000-8000-000000000005', '2025-01-20T08:02:34.000Z', 'KYR_Facade_Render_B.png', 'KYR Facade Render B', 'filename', 'c1000000-0000-4000-8000-000000000002', 'approved', null::uuid, null::uuid, 'image', 'image/png', 1320044, 'dwp_Digital_Asset/3D Projects/22-0047 Khao Yai Residence',
   '{"folder_id":"1FxFolder020000000000000000000000","folder_path":"dwp_Digital_Asset/3D Projects/22-0047 Khao Yai Residence","web_view_link":"https://drive.google.com/file/d/1Fx05DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":["exterior facade","dusk","exposed concrete","minimalist","cool tones"],"macro_portfolio":"Lifestyle","core_sector":"Residential","sub_sectors":["Super-Luxury Villas"],"derived":{"collection":"3D Projects","studio_folder":null,"code":"22-0047","project":"Khao Yai Residence","outcome":"code + name"}}'::jsonb, '{}'::text[]),
  ('fa000000-0000-4000-8000-000000000006', '2025-06-02T10:15:00.000Z', 'RBR_Lobby_01.jpg', 'RBR Lobby 01', 'filename', 'c1000000-0000-4000-8000-000000000001', 'approved', null::uuid, '51000000-0000-4000-8000-000000000003', 'image', 'image/jpeg', 9530221, 'dwp_Digital_Asset/dwp Projects/THAILAND/Hospitality/20-0040 Rawai Beach Resort Phuket/Final',
   '{"folder_id":"1FxFolder030000000000000000000000","folder_path":"dwp_Digital_Asset/dwp Projects/THAILAND/Hospitality/20-0040 Rawai Beach Resort Phuket/Final","web_view_link":"https://drive.google.com/file/d/1Fx06DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"granted","uploaded_by":null,"tags":["lobby","interior","marble","pendant lighting","contemporary luxury","coastal","warm neutral"],"macro_portfolio":"Lifestyle","core_sector":"Hospitality","sub_sectors":["Luxury Resort","Serviced Apartments"],"derived":{"collection":"dwp Projects","studio_folder":"THAILAND","sector":"Hospitality","code":"20-0040","project":"Rawai Beach Resort Phuket","outcome":"code + name"}}'::jsonb, '{}'::text[]),
  ('fa000000-0000-4000-8000-000000000007', '2025-06-02T10:15:01.000Z', 'RBR_Pool_Villa_02.jpg', 'RBR Pool Villa 02', 'filename', 'c1000000-0000-4000-8000-000000000001', 'approved', null::uuid, '51000000-0000-4000-8000-000000000003', 'image', 'image/jpeg', 7702112, 'dwp_Digital_Asset/dwp Projects/THAILAND/Hospitality/20-0040 Rawai Beach Resort Phuket/Final',
   '{"folder_id":"1FxFolder030000000000000000000000","folder_path":"dwp_Digital_Asset/dwp Projects/THAILAND/Hospitality/20-0040 Rawai Beach Resort Phuket/Final","web_view_link":"https://drive.google.com/file/d/1Fx07DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":["swimming pool","exterior facade","day","coastal","tropical","wide angle"],"macro_portfolio":"Lifestyle","core_sector":"Hospitality","sub_sectors":["Luxury Resort"],"derived":{"collection":"dwp Projects","studio_folder":"THAILAND","sector":"Hospitality","code":"20-0040","project":"Rawai Beach Resort Phuket","outcome":"code + name"}}'::jsonb, '{}'::text[]),
  ('fa000000-0000-4000-8000-000000000008', '2025-06-02T10:15:02.000Z', 'RBR_Restaurant_03.heic', 'RBR Restaurant 03', 'filename', 'c1000000-0000-4000-8000-000000000001', 'approved', null::uuid, '51000000-0000-4000-8000-000000000003', 'image', 'image/heif', 3044129, 'dwp_Digital_Asset/dwp Projects/THAILAND/Hospitality/20-0040 Rawai Beach Resort Phuket/Final',
   '{"folder_id":"1FxFolder030000000000000000000000","folder_path":"dwp_Digital_Asset/dwp Projects/THAILAND/Hospitality/20-0040 Rawai Beach Resort Phuket/Final","web_view_link":"https://drive.google.com/file/d/1Fx08DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":["interior","timber flooring","pendant lighting","warm neutral","coastal"],"macro_portfolio":"Lifestyle","core_sector":"Food & Beverage","sub_sectors":["All-Day Dining"],"derived":{"collection":"dwp Projects","studio_folder":"THAILAND","sector":"Hospitality","code":"20-0040","project":"Rawai Beach Resort Phuket","outcome":"code + name"}}'::jsonb, '{}'::text[]),
  ('fa000000-0000-4000-8000-000000000009', '2025-06-03T01:00:00.000Z', 'RBR_Walkthrough.mp4', 'RBR Walkthrough', 'filename', 'c1000000-0000-4000-8000-000000000001', 'approved', null::uuid, '51000000-0000-4000-8000-000000000003', 'video', 'video/mp4', 152300118, 'dwp_Digital_Asset/dwp Projects/THAILAND/Hospitality/20-0040 Rawai Beach Resort Phuket/Final',
   '{"folder_id":"1FxFolder030000000000000000000000","folder_path":"dwp_Digital_Asset/dwp Projects/THAILAND/Hospitality/20-0040 Rawai Beach Resort Phuket/Final","web_view_link":"https://drive.google.com/file/d/1Fx09DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":["day","coastal","contemporary luxury"],"macro_portfolio":"Lifestyle","core_sector":"Hospitality","sub_sectors":["Luxury Resort","Serviced Apartments"],"derived":{"collection":"dwp Projects","studio_folder":"THAILAND","sector":"Hospitality","code":"20-0040","project":"Rawai Beach Resort Phuket","outcome":"code + name"}}'::jsonb, '{}'::text[]),
  ('fa000000-0000-4000-8000-000000000010', '2025-06-04T02:30:00.000Z', 'RBR_Guest_Room_04.jpg', 'RBR Guest Room 04', 'filename', 'c1000000-0000-4000-8000-000000000001', 'approved', 'a1000000-0000-4000-8000-000000000003', '51000000-0000-4000-8000-000000000003', 'image', 'image/jpeg', 5501874, 'dwp_Digital_Asset/dwp Projects/THAILAND/Hospitality/20-0040 Rawai Beach Resort Phuket/Final',
   '{"folder_id":"1FxFolder030000000000000000000000","folder_path":"dwp_Digital_Asset/dwp Projects/THAILAND/Hospitality/20-0040 Rawai Beach Resort Phuket/Final","web_view_link":"https://drive.google.com/file/d/1Fx10DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":["guest room","interior","timber flooring","natural daylight","warm neutral","contemporary luxury"],"macro_portfolio":"Lifestyle","core_sector":"Hospitality","sub_sectors":["Luxury Resort"],"derived":{"collection":"dwp Projects","studio_folder":"THAILAND","sector":"Hospitality","code":"20-0040","project":"Rawai Beach Resort Phuket","outcome":"code + name"}}'::jsonb, '{}'::text[]),
  ('fa000000-0000-4000-8000-000000000011', '2025-03-14T09:12:44.123Z', 'MBCT_Reception_01.jpg', 'MBCT Reception 01', 'filename', 'c1000000-0000-4000-8000-000000000001', 'approved', null::uuid, '51000000-0000-4000-8000-00000000000e', 'image', 'image/jpeg', 4211900, 'dwp_Digital_Asset/_OpenAsset Projects/Singapore/12-65100 Marina Bay Corporate Tower/medium',
   '{"folder_id":"1FxFolder040000000000000000000000","folder_path":"dwp_Digital_Asset/_OpenAsset Projects/Singapore/12-65100 Marina Bay Corporate Tower/medium","web_view_link":"https://drive.google.com/file/d/1Fx11DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"granted","uploaded_by":null,"tags":["reception","interior","marble","contemporary workplace","cool tones","urban high-dense"],"macro_portfolio":"Workplace","core_sector":"Corporate","sub_sectors":["Global HQ"],"derived":{"collection":"_OpenAsset Projects","studio_folder":"Singapore","code":"12-65100","project":"Marina Bay Corporate Tower","outcome":"code + name"}}'::jsonb, '{}'::text[]),
  ('fa000000-0000-4000-8000-000000000012', '2025-03-14T09:12:44.123Z', 'MBCT_Open_Plan_02.jpg', 'MBCT Open Plan 02', 'filename', 'c1000000-0000-4000-8000-000000000001', 'approved', null::uuid, '51000000-0000-4000-8000-00000000000e', 'image', 'image/jpeg', 3988120, 'dwp_Digital_Asset/_OpenAsset Projects/Singapore/12-65100 Marina Bay Corporate Tower/medium',
   '{"folder_id":"1FxFolder040000000000000000000000","folder_path":"dwp_Digital_Asset/_OpenAsset Projects/Singapore/12-65100 Marina Bay Corporate Tower/medium","web_view_link":"https://drive.google.com/file/d/1Fx12DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":["open plan office","interior","natural daylight","contemporary workplace","minimalist","urban high-dense"],"macro_portfolio":"Workplace","core_sector":"Corporate","sub_sectors":["Global HQ","Financial Services"],"derived":{"collection":"_OpenAsset Projects","studio_folder":"Singapore","code":"12-65100","project":"Marina Bay Corporate Tower","outcome":"code + name"}}'::jsonb, '{}'::text[]),
  ('fa000000-0000-4000-8000-000000000013', '2025-03-14T09:12:44.123Z', 'MBCT_Boardroom_03.jpg', 'MBCT Boardroom 03', 'filename', 'c1000000-0000-4000-8000-000000000001', 'approved', null::uuid, '51000000-0000-4000-8000-000000000009', 'image', 'image/jpeg', 4410032, 'dwp_Digital_Asset/dwp Projects/MALAYSIA/12-65100 Marina Bay Corporate Tower',
   '{"folder_id":"1FxFolder050000000000000000000000","folder_path":"dwp_Digital_Asset/dwp Projects/MALAYSIA/12-65100 Marina Bay Corporate Tower","web_view_link":"https://drive.google.com/file/d/1Fx13DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":["interior","pendant lighting","contemporary workplace","timber flooring"],"macro_portfolio":"Workplace","core_sector":"Corporate","sub_sectors":["Global HQ"],"derived":{"collection":"dwp Projects","studio_folder":"MALAYSIA","code":"12-65100","project":"Marina Bay Corporate Tower","outcome":"code + name"}}'::jsonb, '{}'::text[]),
  ('fa000000-0000-4000-8000-000000000014', '2025-03-15T01:40:00.000Z', 'MBCT_Cafe_04.webp', 'MBCT Cafe 04', 'filename', 'c1000000-0000-4000-8000-000000000001', 'approved', null::uuid, '51000000-0000-4000-8000-000000000009', 'image', 'image/webp', 402331, 'dwp_Digital_Asset/dwp Projects/MALAYSIA/12-65100 Marina Bay Corporate Tower',
   '{"folder_id":"1FxFolder050000000000000000000000","folder_path":"dwp_Digital_Asset/dwp Projects/MALAYSIA/12-65100 Marina Bay Corporate Tower","web_view_link":"https://drive.google.com/file/d/1Fx14DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":["interior","day","exposed concrete","minimalist"],"macro_portfolio":"Workplace","core_sector":"Co-Working","sub_sectors":["Flexible Workspace"],"derived":{"collection":"dwp Projects","studio_folder":"MALAYSIA","code":"12-65100","project":"Marina Bay Corporate Tower","outcome":"code + name"}}'::jsonb, '{}'::text[]),
  ('fa000000-0000-4000-8000-000000000015', '2025-03-14T09:12:44.123Z', 'GCPH_Atrium_01.jpg', 'GCPH Atrium 01', 'filename', 'c1000000-0000-4000-8000-000000000001', 'approved', null::uuid, '51000000-0000-4000-8000-000000000001', 'image', 'image/jpeg', 6612004, 'dwp_Digital_Asset/_OpenAsset Projects/Australia/402520 - Gold Coast Private Hospital',
   '{"folder_id":"1FxFolder060000000000000000000000","folder_path":"dwp_Digital_Asset/_OpenAsset Projects/Australia/402520 - Gold Coast Private Hospital","web_view_link":"https://drive.google.com/file/d/1Fx15DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":["lobby","interior","natural daylight","minimalist","cool tones"],"macro_portfolio":"Community","core_sector":"Healthcare","sub_sectors":["Medical Center"],"derived":{"collection":"_OpenAsset Projects","studio_folder":"Australia","code":"402520","project":"Gold Coast Private Hospital","outcome":"code + name"}}'::jsonb, '{}'::text[]),
  ('fa000000-0000-4000-8000-000000000016', '2025-04-01T00:00:00.000Z', 'GCPH_Ward_02.jpg', 'GCPH Ward 02', 'filename', 'c1000000-0000-4000-8000-000000000001', 'approved', null::uuid, '51000000-0000-4000-8000-000000000001', 'image', 'image/jpeg', 5120980, 'dwp_Digital_Asset/_OpenAsset Projects/Australia/402520 - Gold Coast Private Hospital',
   '{"folder_id":"1FxFolder060000000000000000000000","folder_path":"dwp_Digital_Asset/_OpenAsset Projects/Australia/402520 - Gold Coast Private Hospital","web_view_link":"https://drive.google.com/file/d/1Fx16DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":["bedroom","interior","natural daylight","institutional standard"],"macro_portfolio":"Community","core_sector":"Healthcare","sub_sectors":["Medical Center","Patient-Centric Facility"],"derived":{"collection":"_OpenAsset Projects","studio_folder":"Australia","code":"402520","project":"Gold Coast Private Hospital","outcome":"code + name"}}'::jsonb, '{}'::text[]),
  ('fa000000-0000-4000-8000-000000000017', '2023-08-09T05:05:05.000Z', 'GCPH_Entry_03.jpg', 'GCPH Entry 03', 'filename', 'c1000000-0000-4000-8000-000000000001', 'approved', null::uuid, '51000000-0000-4000-8000-000000000001', 'image', 'image/jpeg', 7300441, 'dwp_Digital_Asset/dwp Projects/AUS_ARCHIVED/402520 Gold Coast Private Hospital/Photos',
   '{"folder_id":"1FxFolder070000000000000000000000","folder_path":"dwp_Digital_Asset/dwp Projects/AUS_ARCHIVED/402520 Gold Coast Private Hospital/Photos","web_view_link":"https://drive.google.com/file/d/1Fx17DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":["exterior facade","day","exposed concrete","urban high-dense"],"macro_portfolio":"Community","core_sector":"Healthcare","sub_sectors":["Medical Center"],"derived":{"collection":"dwp Projects","studio_folder":"AUS_ARCHIVED","code":"402520","project":"Gold Coast Private Hospital","outcome":"code + name"}}'::jsonb, '{}'::text[]),
  ('fa000000-0000-4000-8000-000000000018', '2026-02-10T04:00:00.000Z', 'Showflat_Kitchen.jpg', 'Showflat Kitchen', 'filename', 'c1000000-0000-4000-8000-000000000001', 'approved', null::uuid, '51000000-0000-4000-8000-000000000003', 'image', 'image/jpeg', 3301200, 'dwp_Digital_Asset/dwp Projects/THAILAND/Residential/Sukhumvit Showflat',
   '{"folder_id":"1FxFolder080000000000000000000000","folder_path":"dwp_Digital_Asset/dwp Projects/THAILAND/Residential/Sukhumvit Showflat","web_view_link":"https://drive.google.com/file/d/1Fx18DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":["interior","marble","pendant lighting","minimalist","urban high-dense"],"macro_portfolio":"Lifestyle","core_sector":"Residential","sub_sectors":["Showflat"],"derived":{"collection":"dwp Projects","studio_folder":"THAILAND","sector":"Residential","code":null,"project":"Sukhumvit Showflat","outcome":"name only (unverified, no code)"}}'::jsonb, '{}'::text[]),
  ('fa000000-0000-4000-8000-000000000019', '2026-02-10T04:00:01.000Z', 'Showflat_Master_Bed.jpg', 'Showflat Master Bed', 'filename', 'c1000000-0000-4000-8000-000000000001', 'approved', null::uuid, '51000000-0000-4000-8000-000000000003', 'image', 'image/jpeg', 3190877, 'dwp_Digital_Asset/dwp Projects/THAILAND/Residential/Sukhumvit Showflat',
   '{"folder_id":"1FxFolder080000000000000000000000","folder_path":"dwp_Digital_Asset/dwp Projects/THAILAND/Residential/Sukhumvit Showflat","web_view_link":"https://drive.google.com/file/d/1Fx19DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":["bedroom","interior","timber flooring","warm neutral"],"macro_portfolio":"Lifestyle","core_sector":"Residential","sub_sectors":["Showflat"],"derived":{"collection":"dwp Projects","studio_folder":"THAILAND","sector":"Residential","code":null,"project":"Sukhumvit Showflat","outcome":"name only (unverified, no code)"}}'::jsonb, '{}'::text[]),
  ('fa000000-0000-4000-8000-000000000020', '2026-02-10T04:00:02.000Z', 'Showflat_Balcony.jpg', 'Showflat Balcony', 'filename', 'c1000000-0000-4000-8000-000000000001', 'approved', null::uuid, '51000000-0000-4000-8000-000000000003', 'image', 'image/jpeg', 2980011, 'dwp_Digital_Asset/dwp Projects/THAILAND/Residential/Sukhumvit Showflat',
   '{"folder_id":"1FxFolder080000000000000000000000","folder_path":"dwp_Digital_Asset/dwp Projects/THAILAND/Residential/Sukhumvit Showflat","web_view_link":"https://drive.google.com/file/d/1Fx20DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":["exterior facade","dusk","urban high-dense"],"macro_portfolio":null,"core_sector":null,"sub_sectors":[],"derived":{"collection":"dwp Projects","studio_folder":"THAILAND","sector":"Residential","code":null,"project":"Sukhumvit Showflat","outcome":"name only (unverified, no code)"}}'::jsonb, '{}'::text[]),
  ('fa000000-0000-4000-8000-000000000021', '2026-05-18T07:30:00.000Z', 'HTC_Campus_Render_01.jpg', 'HTC Campus Render 01', 'filename', 'c1000000-0000-4000-8000-000000000002', 'approved', null::uuid, null::uuid, 'image', 'image/jpeg', 2210456, 'dwp_Digital_Asset/3D Projects/23-0126 Hanoi Tech Campus',
   '{"folder_id":"1FxFolder090000000000000000000000","folder_path":"dwp_Digital_Asset/3D Projects/23-0126 Hanoi Tech Campus","web_view_link":"https://drive.google.com/file/d/1Fx21DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":["aerial view","tropical","minimalist"],"macro_portfolio":"Community","core_sector":"Education","sub_sectors":["Higher Ed Campus"],"derived":{"collection":"3D Projects","studio_folder":null,"code":"23-0126","project":"Hanoi Tech Campus","outcome":"code + name"}}'::jsonb, '{}'::text[]),
  ('fa000000-0000-4000-8000-000000000022', '2026-05-19T07:30:00.000Z', 'HTC_Library_Photo_02.jpg', 'HTC Library Photo 02', 'filename', 'c1000000-0000-4000-8000-000000000001', 'approved', null::uuid, null::uuid, 'image', 'image/jpeg', 4870320, 'dwp_Digital_Asset/dwp Projects/23-0126 Hanoi Tech Campus',
   '{"folder_id":"1FxFolder100000000000000000000000","folder_path":"dwp_Digital_Asset/dwp Projects/23-0126 Hanoi Tech Campus","web_view_link":"https://drive.google.com/file/d/1Fx22DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":["interior","timber flooring","natural daylight"],"macro_portfolio":"Brand Activation","core_sector":null,"sub_sectors":[],"derived":{"collection":"dwp Projects","studio_folder":null,"code":"23-0126","project":"Hanoi Tech Campus","outcome":"code + name"}}'::jsonb, '{}'::text[]),
  ('fa000000-0000-4000-8000-000000000023', '2024-02-29T12:00:00.000Z', 'Sydney_Studio_Opening_01.jpg', 'Sydney Studio Opening 01', 'filename', 'c1000000-0000-4000-8000-000000000001', 'approved', null::uuid, '51000000-0000-4000-8000-000000000001', 'image', 'image/jpeg', 2400310, 'dwp_Digital_Asset/_OpenAsset Projects/Australia',
   '{"folder_id":"1FxFolder110000000000000000000000","folder_path":"dwp_Digital_Asset/_OpenAsset Projects/Australia","web_view_link":"https://drive.google.com/file/d/1Fx23DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":["interior","day","sydney"],"macro_portfolio":null,"core_sector":null,"sub_sectors":[],"derived":{"collection":"_OpenAsset Projects","studio_folder":"Australia","code":null,"project":null,"outcome":"NO PROJECT"}}'::jsonb, array['needs_project']::text[]),
  ('fa000000-0000-4000-8000-000000000024', '2026-08-20T09:00:00.000Z', 'Open House Invitation.pdf', 'Open House Invitation', 'filename', 'c1000000-0000-4000-8000-000000000006', 'approved', null::uuid, null::uuid, 'pdf', 'application/pdf', 4100222, 'dwp_Digital_Asset/Marketing Hub/Marketing Requests/ARC84Q - Open House at dwp Bangkok Studio',
   '{"folder_id":"1FxFolder120000000000000000000000","folder_path":"dwp_Digital_Asset/Marketing Hub/Marketing Requests/ARC84Q - Open House at dwp Bangkok Studio","web_view_link":"https://drive.google.com/file/d/1Fx24DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":"fixture.marketing@dwp.com","tags":[],"macro_portfolio":null,"core_sector":null,"sub_sectors":[],"derived":{"collection":"Marketing Hub","studio_folder":null,"code":null,"project":null,"outcome":"no-project (by design)"}}'::jsonb, array['needs_project']::text[]),
  ('fa000000-0000-4000-8000-000000000025', '2025-02-01T02:00:00.000Z', 'Merit_Making_Ceremony.mp4', 'Merit Making Ceremony', 'filename', 'c1000000-0000-4000-8000-000000000001', 'approved', null::uuid, null::uuid, 'video', 'video/mp4', 98231004, 'dwp_Digital_Asset/dwp Projects/_dwp Videos/dwp Merit Making Ceremony 250131',
   '{"folder_id":"1FxFolder130000000000000000000000","folder_path":"dwp_Digital_Asset/dwp Projects/_dwp Videos/dwp Merit Making Ceremony 250131","web_view_link":"https://drive.google.com/file/d/1Fx25DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":["interior","day"],"macro_portfolio":null,"core_sector":null,"sub_sectors":[],"derived":{"collection":"dwp Projects","studio_folder":null,"code":null,"project":null,"outcome":"no-project (content bucket)"}}'::jsonb, array['needs_project']::text[]),
  ('fa000000-0000-4000-8000-000000000026', '2024-01-15T00:00:00.000Z', 'dwp_Wordmark_Black.png', 'dwp Wordmark Black', 'filename', 'c1000000-0000-4000-8000-000000000005', 'approved', null::uuid, null::uuid, 'image', 'image/png', 88120, 'dwp_Digital_Asset/dwp Projects/_dwp Brand/Logos',
   '{"folder_id":"1FxFolder140000000000000000000000","folder_path":"dwp_Digital_Asset/dwp Projects/_dwp Brand/Logos","web_view_link":"https://drive.google.com/file/d/1Fx26DamFixtureFile00000000000000/view?usp=drivesdk","publish_permission":"pending","uploaded_by":null,"tags":[],"macro_portfolio":null,"core_sector":null,"sub_sectors":[],"derived":{"collection":"dwp Projects","studio_folder":null,"code":null,"project":null,"outcome":"no-project (content bucket)"}}'::jsonb, array['needs_project']::text[]);

insert into dam_asset_versions (id, asset_id, version_no, storage_location_id, object_key, original_filename, mime_type,
                                size_bytes, provider_url, object_container) values
  ('fb000000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000001', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx01DamFixtureFile00000000000000', 'KYR_Pool_Dusk_01.jpg', 'image/jpeg', 8421377, 'https://drive.google.com/file/d/1Fx01DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000002', 'fa000000-0000-4000-8000-000000000002', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx02DamFixtureFile00000000000000', 'KYR_Living_Day_02.jpg', 'image/jpeg', 6120554, 'https://drive.google.com/file/d/1Fx02DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000003', 'fa000000-0000-4000-8000-000000000003', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx03DamFixtureFile00000000000000', 'KYR_Bedroom_03.tif', 'image/tiff', 84220311, 'https://drive.google.com/file/d/1Fx03DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000004', 'fa000000-0000-4000-8000-000000000004', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx04DamFixtureFile00000000000000', 'KYR_Aerial_Render_A.psd', 'image/x-photoshop', 251338004, 'https://drive.google.com/file/d/1Fx04DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000005', 'fa000000-0000-4000-8000-000000000005', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx05DamFixtureFile00000000000000', 'KYR_Facade_Render_B.png', 'image/png', 1320044, 'https://drive.google.com/file/d/1Fx05DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000006', 'fa000000-0000-4000-8000-000000000006', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx06DamFixtureFile00000000000000', 'RBR_Lobby_01.jpg', 'image/jpeg', 9530221, 'https://drive.google.com/file/d/1Fx06DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000007', 'fa000000-0000-4000-8000-000000000007', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx07DamFixtureFile00000000000000', 'RBR_Pool_Villa_02.jpg', 'image/jpeg', 7702112, 'https://drive.google.com/file/d/1Fx07DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000008', 'fa000000-0000-4000-8000-000000000008', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx08DamFixtureFile00000000000000', 'RBR_Restaurant_03.heic', 'image/heif', 3044129, 'https://drive.google.com/file/d/1Fx08DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000009', 'fa000000-0000-4000-8000-000000000009', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx09DamFixtureFile00000000000000', 'RBR_Walkthrough.mp4', 'video/mp4', 152300118, 'https://drive.google.com/file/d/1Fx09DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000010', 'fa000000-0000-4000-8000-000000000010', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx10DamFixtureFile00000000000000', 'RBR_Guest_Room_04.jpg', 'image/jpeg', 5501874, 'https://drive.google.com/file/d/1Fx10DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000011', 'fa000000-0000-4000-8000-000000000011', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx11DamFixtureFile00000000000000', 'MBCT_Reception_01.jpg', 'image/jpeg', 4211900, 'https://drive.google.com/file/d/1Fx11DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000012', 'fa000000-0000-4000-8000-000000000012', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx12DamFixtureFile00000000000000', 'MBCT_Open_Plan_02.jpg', 'image/jpeg', 3988120, 'https://drive.google.com/file/d/1Fx12DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000013', 'fa000000-0000-4000-8000-000000000013', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx13DamFixtureFile00000000000000', 'MBCT_Boardroom_03.jpg', 'image/jpeg', 4410032, 'https://drive.google.com/file/d/1Fx13DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000014', 'fa000000-0000-4000-8000-000000000014', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx14DamFixtureFile00000000000000', 'MBCT_Cafe_04.webp', 'image/webp', 402331, 'https://drive.google.com/file/d/1Fx14DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000015', 'fa000000-0000-4000-8000-000000000015', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx15DamFixtureFile00000000000000', 'GCPH_Atrium_01.jpg', 'image/jpeg', 6612004, 'https://drive.google.com/file/d/1Fx15DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000016', 'fa000000-0000-4000-8000-000000000016', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx16DamFixtureFile00000000000000', 'GCPH_Ward_02.jpg', 'image/jpeg', 5120980, 'https://drive.google.com/file/d/1Fx16DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000017', 'fa000000-0000-4000-8000-000000000017', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx17DamFixtureFile00000000000000', 'GCPH_Entry_03.jpg', 'image/jpeg', 7300441, 'https://drive.google.com/file/d/1Fx17DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000018', 'fa000000-0000-4000-8000-000000000018', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx18DamFixtureFile00000000000000', 'Showflat_Kitchen.jpg', 'image/jpeg', 3301200, 'https://drive.google.com/file/d/1Fx18DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000019', 'fa000000-0000-4000-8000-000000000019', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx19DamFixtureFile00000000000000', 'Showflat_Master_Bed.jpg', 'image/jpeg', 3190877, 'https://drive.google.com/file/d/1Fx19DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000020', 'fa000000-0000-4000-8000-000000000020', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx20DamFixtureFile00000000000000', 'Showflat_Balcony.jpg', 'image/jpeg', 2980011, 'https://drive.google.com/file/d/1Fx20DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000021', 'fa000000-0000-4000-8000-000000000021', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx21DamFixtureFile00000000000000', 'HTC_Campus_Render_01.jpg', 'image/jpeg', 2210456, 'https://drive.google.com/file/d/1Fx21DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000022', 'fa000000-0000-4000-8000-000000000022', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx22DamFixtureFile00000000000000', 'HTC_Library_Photo_02.jpg', 'image/jpeg', 4870320, 'https://drive.google.com/file/d/1Fx22DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000023', 'fa000000-0000-4000-8000-000000000023', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx23DamFixtureFile00000000000000', 'Sydney_Studio_Opening_01.jpg', 'image/jpeg', 2400310, 'https://drive.google.com/file/d/1Fx23DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000024', 'fa000000-0000-4000-8000-000000000024', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx24DamFixtureFile00000000000000', 'Open House Invitation.pdf', 'application/pdf', 4100222, 'https://drive.google.com/file/d/1Fx24DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000025', 'fa000000-0000-4000-8000-000000000025', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx25DamFixtureFile00000000000000', 'Merit_Making_Ceremony.mp4', 'video/mp4', 98231004, 'https://drive.google.com/file/d/1Fx25DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset'),
  ('fb000000-0000-4000-8000-000000000026', 'fa000000-0000-4000-8000-000000000026', 1, 'f5000000-0000-4000-8000-000000000001', '1Fx26DamFixtureFile00000000000000', 'dwp_Wordmark_Black.png', 'image/png', 88120, 'https://drive.google.com/file/d/1Fx26DamFixtureFile00000000000000/view?usp=drivesdk', 'dwp_Digital_Asset');

-- The asset points at its version and the version at its asset, so Stage 1 set the pointer afterwards
-- (which also moved updated_at through trg_assets_updated_at, as in v2).
update dam_assets a
   set current_version_id = v.id, version_count = 1
  from dam_asset_versions v
 where v.asset_id = a.id
   and v.version_no = 1
   and a.id in ('fa000000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000002', 'fa000000-0000-4000-8000-000000000003', 'fa000000-0000-4000-8000-000000000004', 'fa000000-0000-4000-8000-000000000005', 'fa000000-0000-4000-8000-000000000006', 'fa000000-0000-4000-8000-000000000007', 'fa000000-0000-4000-8000-000000000008', 'fa000000-0000-4000-8000-000000000009', 'fa000000-0000-4000-8000-000000000010', 'fa000000-0000-4000-8000-000000000011', 'fa000000-0000-4000-8000-000000000012', 'fa000000-0000-4000-8000-000000000013', 'fa000000-0000-4000-8000-000000000014', 'fa000000-0000-4000-8000-000000000015', 'fa000000-0000-4000-8000-000000000016', 'fa000000-0000-4000-8000-000000000017', 'fa000000-0000-4000-8000-000000000018', 'fa000000-0000-4000-8000-000000000019', 'fa000000-0000-4000-8000-000000000020', 'fa000000-0000-4000-8000-000000000021', 'fa000000-0000-4000-8000-000000000022', 'fa000000-0000-4000-8000-000000000023', 'fa000000-0000-4000-8000-000000000024', 'fa000000-0000-4000-8000-000000000025', 'fa000000-0000-4000-8000-000000000026');

insert into dam_external_ids (id, target_type, target_id, system, external_id, external_url) values
  ('fe000000-0000-4000-8000-000000000001', 'asset', 'fa000000-0000-4000-8000-000000000001', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000001', null),
  ('fe000000-0000-4000-8000-000000000002', 'asset', 'fa000000-0000-4000-8000-000000000001', 'google_drive', '1Fx01DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx01DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000003', 'asset', 'fa000000-0000-4000-8000-000000000002', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000002', null),
  ('fe000000-0000-4000-8000-000000000004', 'asset', 'fa000000-0000-4000-8000-000000000002', 'google_drive', '1Fx02DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx02DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000005', 'asset', 'fa000000-0000-4000-8000-000000000003', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000003', null),
  ('fe000000-0000-4000-8000-000000000006', 'asset', 'fa000000-0000-4000-8000-000000000003', 'google_drive', '1Fx03DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx03DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000007', 'asset', 'fa000000-0000-4000-8000-000000000004', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000004', null),
  ('fe000000-0000-4000-8000-000000000008', 'asset', 'fa000000-0000-4000-8000-000000000004', 'google_drive', '1Fx04DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx04DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000009', 'asset', 'fa000000-0000-4000-8000-000000000005', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000005', null),
  ('fe000000-0000-4000-8000-000000000010', 'asset', 'fa000000-0000-4000-8000-000000000005', 'google_drive', '1Fx05DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx05DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000011', 'asset', 'fa000000-0000-4000-8000-000000000006', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000006', null),
  ('fe000000-0000-4000-8000-000000000012', 'asset', 'fa000000-0000-4000-8000-000000000006', 'google_drive', '1Fx06DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx06DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000013', 'asset', 'fa000000-0000-4000-8000-000000000007', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000007', null),
  ('fe000000-0000-4000-8000-000000000014', 'asset', 'fa000000-0000-4000-8000-000000000007', 'google_drive', '1Fx07DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx07DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000015', 'asset', 'fa000000-0000-4000-8000-000000000008', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000008', null),
  ('fe000000-0000-4000-8000-000000000016', 'asset', 'fa000000-0000-4000-8000-000000000008', 'google_drive', '1Fx08DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx08DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000017', 'asset', 'fa000000-0000-4000-8000-000000000009', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000009', null),
  ('fe000000-0000-4000-8000-000000000018', 'asset', 'fa000000-0000-4000-8000-000000000009', 'google_drive', '1Fx09DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx09DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000019', 'asset', 'fa000000-0000-4000-8000-000000000010', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000010', null),
  ('fe000000-0000-4000-8000-000000000020', 'asset', 'fa000000-0000-4000-8000-000000000010', 'google_drive', '1Fx10DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx10DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000021', 'asset', 'fa000000-0000-4000-8000-000000000011', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000011', null),
  ('fe000000-0000-4000-8000-000000000022', 'asset', 'fa000000-0000-4000-8000-000000000011', 'google_drive', '1Fx11DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx11DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000023', 'asset', 'fa000000-0000-4000-8000-000000000012', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000012', null),
  ('fe000000-0000-4000-8000-000000000024', 'asset', 'fa000000-0000-4000-8000-000000000012', 'google_drive', '1Fx12DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx12DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000025', 'asset', 'fa000000-0000-4000-8000-000000000013', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000013', null),
  ('fe000000-0000-4000-8000-000000000026', 'asset', 'fa000000-0000-4000-8000-000000000013', 'google_drive', '1Fx13DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx13DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000027', 'asset', 'fa000000-0000-4000-8000-000000000014', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000014', null),
  ('fe000000-0000-4000-8000-000000000028', 'asset', 'fa000000-0000-4000-8000-000000000014', 'google_drive', '1Fx14DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx14DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000029', 'asset', 'fa000000-0000-4000-8000-000000000015', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000015', null),
  ('fe000000-0000-4000-8000-000000000030', 'asset', 'fa000000-0000-4000-8000-000000000015', 'google_drive', '1Fx15DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx15DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000031', 'asset', 'fa000000-0000-4000-8000-000000000016', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000016', null),
  ('fe000000-0000-4000-8000-000000000032', 'asset', 'fa000000-0000-4000-8000-000000000016', 'google_drive', '1Fx16DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx16DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000033', 'asset', 'fa000000-0000-4000-8000-000000000017', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000017', null),
  ('fe000000-0000-4000-8000-000000000034', 'asset', 'fa000000-0000-4000-8000-000000000017', 'google_drive', '1Fx17DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx17DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000035', 'asset', 'fa000000-0000-4000-8000-000000000018', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000018', null),
  ('fe000000-0000-4000-8000-000000000036', 'asset', 'fa000000-0000-4000-8000-000000000018', 'google_drive', '1Fx18DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx18DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000037', 'asset', 'fa000000-0000-4000-8000-000000000019', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000019', null),
  ('fe000000-0000-4000-8000-000000000038', 'asset', 'fa000000-0000-4000-8000-000000000019', 'google_drive', '1Fx19DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx19DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000039', 'asset', 'fa000000-0000-4000-8000-000000000020', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000020', null),
  ('fe000000-0000-4000-8000-000000000040', 'asset', 'fa000000-0000-4000-8000-000000000020', 'google_drive', '1Fx20DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx20DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000041', 'asset', 'fa000000-0000-4000-8000-000000000021', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000021', null),
  ('fe000000-0000-4000-8000-000000000042', 'asset', 'fa000000-0000-4000-8000-000000000021', 'google_drive', '1Fx21DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx21DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000043', 'asset', 'fa000000-0000-4000-8000-000000000022', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000022', null),
  ('fe000000-0000-4000-8000-000000000044', 'asset', 'fa000000-0000-4000-8000-000000000022', 'google_drive', '1Fx22DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx22DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000045', 'asset', 'fa000000-0000-4000-8000-000000000023', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000023', null),
  ('fe000000-0000-4000-8000-000000000046', 'asset', 'fa000000-0000-4000-8000-000000000023', 'google_drive', '1Fx23DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx23DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000047', 'asset', 'fa000000-0000-4000-8000-000000000024', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000024', null),
  ('fe000000-0000-4000-8000-000000000048', 'asset', 'fa000000-0000-4000-8000-000000000024', 'google_drive', '1Fx24DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx24DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000049', 'asset', 'fa000000-0000-4000-8000-000000000025', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000025', null),
  ('fe000000-0000-4000-8000-000000000050', 'asset', 'fa000000-0000-4000-8000-000000000025', 'google_drive', '1Fx25DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx25DamFixtureFile00000000000000/view?usp=drivesdk'),
  ('fe000000-0000-4000-8000-000000000051', 'asset', 'fa000000-0000-4000-8000-000000000026', 'dwp_dam_v1', '0e1f0000-0000-4000-8000-000000000026', null),
  ('fe000000-0000-4000-8000-000000000052', 'asset', 'fa000000-0000-4000-8000-000000000026', 'google_drive', '1Fx26DamFixtureFile00000000000000', 'https://drive.google.com/file/d/1Fx26DamFixtureFile00000000000000/view?usp=drivesdk');

-- ---------------------------------------------------------------------------
-- Stage 2: projects, folder-path aliases, OpenAsset codes, project-asset links
-- ---------------------------------------------------------------------------
insert into dam_projects (id, code, code_source, name, studio_id, access_level_id, status, legacy_code, legacy_folder_path, flags) values
  ('f1000000-0000-4000-8000-000000000001', '22-0047', 'folder', 'Khao Yai Residence', '51000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000002', 'unverified', '22-0047', 'dwp_Digital_Asset/dwp Projects/THAILAND/Residential/22-0047 Khao Yai Residence/KHAOYAI_HOUSE_HIRES', '{}'::text[]),
  ('f1000000-0000-4000-8000-000000000002', '20-0040', 'folder', 'Rawai Beach Resort Phuket', '51000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000002', 'unverified', '20-0040', 'dwp_Digital_Asset/dwp Projects/THAILAND/Hospitality/20-0040 Rawai Beach Resort Phuket/Final', '{}'::text[]),
  ('f1000000-0000-4000-8000-000000000003', '12-65100', 'folder', 'Marina Bay Corporate Tower', '51000000-0000-4000-8000-00000000000e', 'a1000000-0000-4000-8000-000000000002', 'unverified', '12-65100', 'dwp_Digital_Asset/_OpenAsset Projects/Singapore/12-65100 Marina Bay Corporate Tower/medium', array['sector_conflict']::text[]),
  ('f1000000-0000-4000-8000-000000000004', '402520', 'folder', 'Gold Coast Private Hospital', '51000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', 'unverified', '402520', 'dwp_Digital_Asset/_OpenAsset Projects/Australia/402520 - Gold Coast Private Hospital', '{}'::text[]),
  ('f1000000-0000-4000-8000-000000000005', null, null, 'Sukhumvit Showflat', '51000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000002', 'unverified', null, 'dwp_Digital_Asset/dwp Projects/THAILAND/Residential/Sukhumvit Showflat', array['needs_code']::text[]),
  ('f1000000-0000-4000-8000-000000000006', '23-0126', 'folder', 'Hanoi Tech Campus', null::uuid, 'a1000000-0000-4000-8000-000000000002', 'unverified', '23-0126', 'dwp_Digital_Asset/3D Projects/23-0126 Hanoi Tech Campus', '{}'::text[]);

insert into dam_project_aliases (id, project_id, alias, kind, source, is_verified) values
  ('f1a00000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'dwp_Digital_Asset/dwp Projects/THAILAND/Residential/22-0047 Khao Yai Residence/KHAOYAI_HOUSE_HIRES', 'folder_path', 'migration', false),
  ('f1a00000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000001', 'dwp_Digital_Asset/3D Projects/22-0047 Khao Yai Residence', 'folder_path', 'migration', false),
  ('f1a00000-0000-4000-8000-000000000003', 'f1000000-0000-4000-8000-000000000002', 'dwp_Digital_Asset/dwp Projects/THAILAND/Hospitality/20-0040 Rawai Beach Resort Phuket/Final', 'folder_path', 'migration', false),
  ('f1a00000-0000-4000-8000-000000000004', 'f1000000-0000-4000-8000-000000000003', 'dwp_Digital_Asset/_OpenAsset Projects/Singapore/12-65100 Marina Bay Corporate Tower/medium', 'folder_path', 'migration', false),
  ('f1a00000-0000-4000-8000-000000000005', 'f1000000-0000-4000-8000-000000000003', 'dwp_Digital_Asset/dwp Projects/MALAYSIA/12-65100 Marina Bay Corporate Tower', 'folder_path', 'migration', false),
  ('f1a00000-0000-4000-8000-000000000006', 'f1000000-0000-4000-8000-000000000004', 'dwp_Digital_Asset/_OpenAsset Projects/Australia/402520 - Gold Coast Private Hospital', 'folder_path', 'migration', false),
  ('f1a00000-0000-4000-8000-000000000007', 'f1000000-0000-4000-8000-000000000004', 'dwp_Digital_Asset/dwp Projects/AUS_ARCHIVED/402520 Gold Coast Private Hospital/Photos', 'folder_path', 'migration', false),
  ('f1a00000-0000-4000-8000-000000000008', 'f1000000-0000-4000-8000-000000000005', 'dwp_Digital_Asset/dwp Projects/THAILAND/Residential/Sukhumvit Showflat', 'folder_path', 'migration', false),
  ('f1a00000-0000-4000-8000-000000000009', 'f1000000-0000-4000-8000-000000000006', 'dwp_Digital_Asset/3D Projects/23-0126 Hanoi Tech Campus', 'folder_path', 'migration', false),
  ('f1a00000-0000-4000-8000-000000000010', 'f1000000-0000-4000-8000-000000000006', 'dwp_Digital_Asset/dwp Projects/23-0126 Hanoi Tech Campus', 'folder_path', 'migration', false);

insert into dam_external_ids (id, target_type, target_id, system, external_id) values
  ('fe000000-0000-4000-8000-000000000053', 'project', 'f1000000-0000-4000-8000-000000000003', 'openasset', '12-65100'),
  ('fe000000-0000-4000-8000-000000000054', 'project', 'f1000000-0000-4000-8000-000000000004', 'openasset', '402520');

insert into dam_project_assets (id, project_id, asset_id, rank, source) values
  ('fc000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000001', 1, 'migration'),
  ('fc000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000002', 2, 'migration'),
  ('fc000000-0000-4000-8000-000000000003', 'f1000000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000003', 3, 'migration'),
  ('fc000000-0000-4000-8000-000000000004', 'f1000000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000004', 4, 'migration'),
  ('fc000000-0000-4000-8000-000000000005', 'f1000000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000005', 5, 'migration'),
  ('fc000000-0000-4000-8000-000000000006', 'f1000000-0000-4000-8000-000000000002', 'fa000000-0000-4000-8000-000000000006', 1, 'migration'),
  ('fc000000-0000-4000-8000-000000000007', 'f1000000-0000-4000-8000-000000000002', 'fa000000-0000-4000-8000-000000000007', 2, 'migration'),
  ('fc000000-0000-4000-8000-000000000008', 'f1000000-0000-4000-8000-000000000002', 'fa000000-0000-4000-8000-000000000008', 3, 'migration'),
  ('fc000000-0000-4000-8000-000000000009', 'f1000000-0000-4000-8000-000000000002', 'fa000000-0000-4000-8000-000000000009', 4, 'migration'),
  ('fc000000-0000-4000-8000-000000000010', 'f1000000-0000-4000-8000-000000000002', 'fa000000-0000-4000-8000-000000000010', 5, 'migration'),
  ('fc000000-0000-4000-8000-000000000011', 'f1000000-0000-4000-8000-000000000003', 'fa000000-0000-4000-8000-000000000011', 1, 'migration'),
  ('fc000000-0000-4000-8000-000000000012', 'f1000000-0000-4000-8000-000000000003', 'fa000000-0000-4000-8000-000000000012', 2, 'migration'),
  ('fc000000-0000-4000-8000-000000000013', 'f1000000-0000-4000-8000-000000000003', 'fa000000-0000-4000-8000-000000000013', 3, 'migration'),
  ('fc000000-0000-4000-8000-000000000014', 'f1000000-0000-4000-8000-000000000003', 'fa000000-0000-4000-8000-000000000014', 4, 'migration'),
  ('fc000000-0000-4000-8000-000000000015', 'f1000000-0000-4000-8000-000000000004', 'fa000000-0000-4000-8000-000000000017', 1, 'migration'),
  ('fc000000-0000-4000-8000-000000000016', 'f1000000-0000-4000-8000-000000000004', 'fa000000-0000-4000-8000-000000000015', 2, 'migration'),
  ('fc000000-0000-4000-8000-000000000017', 'f1000000-0000-4000-8000-000000000004', 'fa000000-0000-4000-8000-000000000016', 3, 'migration'),
  ('fc000000-0000-4000-8000-000000000018', 'f1000000-0000-4000-8000-000000000005', 'fa000000-0000-4000-8000-000000000018', 1, 'migration'),
  ('fc000000-0000-4000-8000-000000000019', 'f1000000-0000-4000-8000-000000000005', 'fa000000-0000-4000-8000-000000000019', 2, 'migration'),
  ('fc000000-0000-4000-8000-000000000020', 'f1000000-0000-4000-8000-000000000005', 'fa000000-0000-4000-8000-000000000020', 3, 'migration'),
  ('fc000000-0000-4000-8000-000000000021', 'f1000000-0000-4000-8000-000000000006', 'fa000000-0000-4000-8000-000000000021', 1, 'migration'),
  ('fc000000-0000-4000-8000-000000000022', 'f1000000-0000-4000-8000-000000000006', 'fa000000-0000-4000-8000-000000000022', 2, 'migration');

-- ---------------------------------------------------------------------------
-- Stage 3: the Sector tree (project namespace, 3 levels) and project-to-sector links
-- ---------------------------------------------------------------------------
-- A subset of the v1 taxonomy (supabase/schema.sql), names in v1 spelling including '&'. All four of
-- namespace/path/depth/parent_id are set explicitly, as Stage 3 did (no path trigger in the baseline).
insert into dam_keywords (id, namespace, category_id, parent_id, name, slug, path, depth, source) values
  ('f7000000-0000-4000-8000-000000000001', 'project', '41000000-0000-4000-8000-000000000011', null, 'Lifestyle', 'lifestyle', 'lifestyle', 1, 'migration'),
  ('f7000000-0000-4000-8000-000000000002', 'project', '41000000-0000-4000-8000-000000000011', null, 'Workplace', 'workplace', 'workplace', 1, 'migration'),
  ('f7000000-0000-4000-8000-000000000003', 'project', '41000000-0000-4000-8000-000000000011', null, 'Community', 'community', 'community', 1, 'migration');

insert into dam_keywords (id, namespace, category_id, parent_id, name, slug, path, depth, source) values
  ('f7000000-0000-4000-8000-000000000004', 'project', '41000000-0000-4000-8000-000000000011', 'f7000000-0000-4000-8000-000000000001', 'Hospitality', 'hospitality', 'lifestyle/hospitality', 2, 'migration'),
  ('f7000000-0000-4000-8000-000000000005', 'project', '41000000-0000-4000-8000-000000000011', 'f7000000-0000-4000-8000-000000000001', 'Food & Beverage', 'food-beverage', 'lifestyle/food-beverage', 2, 'migration'),
  ('f7000000-0000-4000-8000-000000000006', 'project', '41000000-0000-4000-8000-000000000011', 'f7000000-0000-4000-8000-000000000001', 'Residential', 'residential', 'lifestyle/residential', 2, 'migration'),
  ('f7000000-0000-4000-8000-000000000007', 'project', '41000000-0000-4000-8000-000000000011', 'f7000000-0000-4000-8000-000000000002', 'Corporate', 'corporate', 'workplace/corporate', 2, 'migration'),
  ('f7000000-0000-4000-8000-000000000008', 'project', '41000000-0000-4000-8000-000000000011', 'f7000000-0000-4000-8000-000000000002', 'Co-Working', 'co-working', 'workplace/co-working', 2, 'migration'),
  ('f7000000-0000-4000-8000-000000000009', 'project', '41000000-0000-4000-8000-000000000011', 'f7000000-0000-4000-8000-000000000003', 'Healthcare', 'healthcare', 'community/healthcare', 2, 'migration'),
  ('f7000000-0000-4000-8000-000000000010', 'project', '41000000-0000-4000-8000-000000000011', 'f7000000-0000-4000-8000-000000000003', 'Education', 'education', 'community/education', 2, 'migration');

insert into dam_keywords (id, namespace, category_id, parent_id, name, slug, path, depth, source) values
  ('f7000000-0000-4000-8000-000000000011', 'project', '41000000-0000-4000-8000-000000000011', 'f7000000-0000-4000-8000-000000000004', 'Luxury Resort', 'luxury-resort', 'lifestyle/hospitality/luxury-resort', 3, 'migration'),
  ('f7000000-0000-4000-8000-000000000012', 'project', '41000000-0000-4000-8000-000000000011', 'f7000000-0000-4000-8000-000000000004', 'Boutique & Lifestyle', 'boutique-lifestyle', 'lifestyle/hospitality/boutique-lifestyle', 3, 'migration'),
  ('f7000000-0000-4000-8000-000000000013', 'project', '41000000-0000-4000-8000-000000000011', 'f7000000-0000-4000-8000-000000000004', 'Serviced Apartments', 'serviced-apartments', 'lifestyle/hospitality/serviced-apartments', 3, 'migration'),
  ('f7000000-0000-4000-8000-000000000014', 'project', '41000000-0000-4000-8000-000000000011', 'f7000000-0000-4000-8000-000000000005', 'All-Day Dining', 'all-day-dining', 'lifestyle/food-beverage/all-day-dining', 3, 'migration'),
  ('f7000000-0000-4000-8000-000000000015', 'project', '41000000-0000-4000-8000-000000000011', 'f7000000-0000-4000-8000-000000000006', 'Super-Luxury Villas', 'super-luxury-villas', 'lifestyle/residential/super-luxury-villas', 3, 'migration'),
  ('f7000000-0000-4000-8000-000000000016', 'project', '41000000-0000-4000-8000-000000000011', 'f7000000-0000-4000-8000-000000000006', 'Showflat', 'showflat', 'lifestyle/residential/showflat', 3, 'migration'),
  ('f7000000-0000-4000-8000-000000000017', 'project', '41000000-0000-4000-8000-000000000011', 'f7000000-0000-4000-8000-000000000007', 'Global HQ', 'global-hq', 'workplace/corporate/global-hq', 3, 'migration'),
  ('f7000000-0000-4000-8000-000000000018', 'project', '41000000-0000-4000-8000-000000000011', 'f7000000-0000-4000-8000-000000000007', 'Financial Services', 'financial-services', 'workplace/corporate/financial-services', 3, 'migration'),
  ('f7000000-0000-4000-8000-000000000019', 'project', '41000000-0000-4000-8000-000000000011', 'f7000000-0000-4000-8000-000000000008', 'Flexible Workspace', 'flexible-workspace', 'workplace/co-working/flexible-workspace', 3, 'migration'),
  ('f7000000-0000-4000-8000-000000000020', 'project', '41000000-0000-4000-8000-000000000011', 'f7000000-0000-4000-8000-000000000009', 'Medical Center', 'medical-center', 'community/healthcare/medical-center', 3, 'migration'),
  ('f7000000-0000-4000-8000-000000000021', 'project', '41000000-0000-4000-8000-000000000011', 'f7000000-0000-4000-8000-000000000009', 'Patient-Centric Facility', 'patient-centric-facility', 'community/healthcare/patient-centric-facility', 3, 'migration'),
  ('f7000000-0000-4000-8000-000000000022', 'project', '41000000-0000-4000-8000-000000000011', 'f7000000-0000-4000-8000-000000000010', 'Higher Ed Campus', 'higher-ed-campus', 'community/education/higher-ed-campus', 3, 'migration');

-- weight = the share of the project's assets carrying the sector (3 decimals, clamped to 0.001-1)
insert into dam_keyword_links (id, keyword_id, target_type, target_id, source, weight) values
  ('fd000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001', 'project', 'f1000000-0000-4000-8000-000000000001', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000006', 'project', 'f1000000-0000-4000-8000-000000000001', 'migration', 0.800),
  ('fd000000-0000-4000-8000-000000000003', 'f7000000-0000-4000-8000-000000000015', 'project', 'f1000000-0000-4000-8000-000000000001', 'migration', 0.800),
  ('fd000000-0000-4000-8000-000000000004', 'f7000000-0000-4000-8000-000000000004', 'project', 'f1000000-0000-4000-8000-000000000001', 'migration', 0.200),
  ('fd000000-0000-4000-8000-000000000005', 'f7000000-0000-4000-8000-000000000012', 'project', 'f1000000-0000-4000-8000-000000000001', 'migration', 0.200),
  ('fd000000-0000-4000-8000-000000000006', 'f7000000-0000-4000-8000-000000000001', 'project', 'f1000000-0000-4000-8000-000000000002', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000007', 'f7000000-0000-4000-8000-000000000004', 'project', 'f1000000-0000-4000-8000-000000000002', 'migration', 0.800),
  ('fd000000-0000-4000-8000-000000000008', 'f7000000-0000-4000-8000-000000000011', 'project', 'f1000000-0000-4000-8000-000000000002', 'migration', 0.800),
  ('fd000000-0000-4000-8000-000000000009', 'f7000000-0000-4000-8000-000000000013', 'project', 'f1000000-0000-4000-8000-000000000002', 'migration', 0.400),
  ('fd000000-0000-4000-8000-000000000010', 'f7000000-0000-4000-8000-000000000005', 'project', 'f1000000-0000-4000-8000-000000000002', 'migration', 0.200),
  ('fd000000-0000-4000-8000-000000000011', 'f7000000-0000-4000-8000-000000000014', 'project', 'f1000000-0000-4000-8000-000000000002', 'migration', 0.200),
  ('fd000000-0000-4000-8000-000000000012', 'f7000000-0000-4000-8000-000000000002', 'project', 'f1000000-0000-4000-8000-000000000003', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000013', 'f7000000-0000-4000-8000-000000000007', 'project', 'f1000000-0000-4000-8000-000000000003', 'migration', 0.750),
  ('fd000000-0000-4000-8000-000000000014', 'f7000000-0000-4000-8000-000000000017', 'project', 'f1000000-0000-4000-8000-000000000003', 'migration', 0.750),
  ('fd000000-0000-4000-8000-000000000015', 'f7000000-0000-4000-8000-000000000018', 'project', 'f1000000-0000-4000-8000-000000000003', 'migration', 0.250),
  ('fd000000-0000-4000-8000-000000000016', 'f7000000-0000-4000-8000-000000000008', 'project', 'f1000000-0000-4000-8000-000000000003', 'migration', 0.250),
  ('fd000000-0000-4000-8000-000000000017', 'f7000000-0000-4000-8000-000000000019', 'project', 'f1000000-0000-4000-8000-000000000003', 'migration', 0.250),
  ('fd000000-0000-4000-8000-000000000018', 'f7000000-0000-4000-8000-000000000003', 'project', 'f1000000-0000-4000-8000-000000000004', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000019', 'f7000000-0000-4000-8000-000000000009', 'project', 'f1000000-0000-4000-8000-000000000004', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000020', 'f7000000-0000-4000-8000-000000000020', 'project', 'f1000000-0000-4000-8000-000000000004', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000021', 'f7000000-0000-4000-8000-000000000021', 'project', 'f1000000-0000-4000-8000-000000000004', 'migration', 0.333),
  ('fd000000-0000-4000-8000-000000000022', 'f7000000-0000-4000-8000-000000000001', 'project', 'f1000000-0000-4000-8000-000000000005', 'migration', 0.667),
  ('fd000000-0000-4000-8000-000000000023', 'f7000000-0000-4000-8000-000000000006', 'project', 'f1000000-0000-4000-8000-000000000005', 'migration', 0.667),
  ('fd000000-0000-4000-8000-000000000024', 'f7000000-0000-4000-8000-000000000016', 'project', 'f1000000-0000-4000-8000-000000000005', 'migration', 0.667),
  ('fd000000-0000-4000-8000-000000000025', 'f7000000-0000-4000-8000-000000000003', 'project', 'f1000000-0000-4000-8000-000000000006', 'migration', 0.500),
  ('fd000000-0000-4000-8000-000000000026', 'f7000000-0000-4000-8000-000000000010', 'project', 'f1000000-0000-4000-8000-000000000006', 'migration', 0.500),
  ('fd000000-0000-4000-8000-000000000027', 'f7000000-0000-4000-8000-000000000022', 'project', 'f1000000-0000-4000-8000-000000000006', 'migration', 0.500);

-- ---------------------------------------------------------------------------
-- Stage 4: asset keyword categories, flat asset keywords, asset-to-keyword links
-- ---------------------------------------------------------------------------
-- Three of the seven categories Stage 4 created (ids are fixture ids; their sort_order is what the script gave them).
insert into dam_keyword_categories (id, namespace, name, slug, description, max_depth, is_exclusive, sort_order, is_system, is_active) values
  ('f4000000-0000-4000-8000-000000000003', 'asset', 'Design Style', 'design-style', 'The design language the work is in.', 3, false, 63, false, true),
  ('f4000000-0000-4000-8000-000000000004', 'asset', 'Lighting', 'lighting', 'Luminaires and the quality of illumination.', 3, false, 64, false, true),
  ('f4000000-0000-4000-8000-000000000006', 'asset', 'Setting', 'setting', 'Where the subject sits: urban, coastal, waterfront.', 3, false, 66, false, true);

-- depth 1, parent_id null, path = slug, name = the first v1 spelling of the tag.
insert into dam_keywords (id, namespace, category_id, parent_id, name, slug, path, depth, source, is_active) values
  ('f6000000-0000-4000-8000-000000000001', 'asset', '41000000-0000-4000-8000-000000000001', null, 'swimming pool', 'swimming-pool', 'swimming-pool', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000002', 'asset', '41000000-0000-4000-8000-000000000001', null, 'lobby', 'lobby', 'lobby', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000003', 'asset', '41000000-0000-4000-8000-000000000001', null, 'guest room', 'guest-room', 'guest-room', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000004', 'asset', '41000000-0000-4000-8000-000000000001', null, 'open plan office', 'open-plan-office', 'open-plan-office', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000005', 'asset', '41000000-0000-4000-8000-000000000001', null, 'reception', 'reception', 'reception', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000006', 'asset', '41000000-0000-4000-8000-000000000001', null, 'bedroom', 'bedroom', 'bedroom', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000007', 'asset', '41000000-0000-4000-8000-000000000002', null, 'timber flooring', 'timber-flooring', 'timber-flooring', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000008', 'asset', '41000000-0000-4000-8000-000000000002', null, 'marble', 'marble', 'marble', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000009', 'asset', '41000000-0000-4000-8000-000000000002', null, 'exposed concrete', 'exposed-concrete', 'exposed-concrete', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000010', 'asset', '41000000-0000-4000-8000-000000000003', null, 'dusk', 'dusk', 'dusk', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000011', 'asset', '41000000-0000-4000-8000-000000000003', null, 'day', 'day', 'day', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000012', 'asset', '41000000-0000-4000-8000-000000000003', null, 'night', 'night', 'night', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000013', 'asset', '41000000-0000-4000-8000-000000000005', null, 'interior', 'interior', 'interior', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000014', 'asset', '41000000-0000-4000-8000-000000000005', null, 'exterior facade', 'exterior-facade', 'exterior-facade', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000015', 'asset', '41000000-0000-4000-8000-000000000005', null, 'aerial view', 'aerial-view', 'aerial-view', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000016', 'asset', '41000000-0000-4000-8000-000000000006', null, 'warm neutral', 'warm-neutral', 'warm-neutral', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000017', 'asset', '41000000-0000-4000-8000-000000000006', null, 'cool tones', 'cool-tones', 'cool-tones', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000018', 'asset', '41000000-0000-4000-8000-000000000004', null, 'wide angle', 'wide-angle', 'wide-angle', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000019', 'asset', 'f4000000-0000-4000-8000-000000000003', null, 'contemporary luxury', 'contemporary-luxury', 'contemporary-luxury', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000020', 'asset', 'f4000000-0000-4000-8000-000000000003', null, 'minimalist', 'minimalist', 'minimalist', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000021', 'asset', 'f4000000-0000-4000-8000-000000000003', null, 'contemporary workplace', 'contemporary-workplace', 'contemporary-workplace', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000022', 'asset', 'f4000000-0000-4000-8000-000000000004', null, 'natural daylight', 'natural-daylight', 'natural-daylight', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000023', 'asset', 'f4000000-0000-4000-8000-000000000004', null, 'pendant lighting', 'pendant-lighting', 'pendant-lighting', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000024', 'asset', 'f4000000-0000-4000-8000-000000000006', null, 'coastal', 'coastal', 'coastal', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000025', 'asset', 'f4000000-0000-4000-8000-000000000006', null, 'urban high-dense', 'urban-high-dense', 'urban-high-dense', 1, 'migration', true),
  ('f6000000-0000-4000-8000-000000000026', 'asset', 'f4000000-0000-4000-8000-000000000006', null, 'tropical', 'tropical', 'tropical', 1, 'migration', true);

insert into dam_keyword_links (id, keyword_id, target_type, target_id, source, weight) values
  ('fd000000-0000-4000-8000-000000000028', 'f6000000-0000-4000-8000-000000000001', 'asset', 'fa000000-0000-4000-8000-000000000001', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000029', 'f6000000-0000-4000-8000-000000000010', 'asset', 'fa000000-0000-4000-8000-000000000001', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000030', 'f6000000-0000-4000-8000-000000000014', 'asset', 'fa000000-0000-4000-8000-000000000001', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000031', 'f6000000-0000-4000-8000-000000000016', 'asset', 'fa000000-0000-4000-8000-000000000001', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000032', 'f6000000-0000-4000-8000-000000000019', 'asset', 'fa000000-0000-4000-8000-000000000001', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000033', 'f6000000-0000-4000-8000-000000000026', 'asset', 'fa000000-0000-4000-8000-000000000001', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000034', 'f6000000-0000-4000-8000-000000000022', 'asset', 'fa000000-0000-4000-8000-000000000001', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000035', 'f6000000-0000-4000-8000-000000000013', 'asset', 'fa000000-0000-4000-8000-000000000002', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000036', 'f6000000-0000-4000-8000-000000000011', 'asset', 'fa000000-0000-4000-8000-000000000002', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000037', 'f6000000-0000-4000-8000-000000000007', 'asset', 'fa000000-0000-4000-8000-000000000002', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000038', 'f6000000-0000-4000-8000-000000000022', 'asset', 'fa000000-0000-4000-8000-000000000002', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000039', 'f6000000-0000-4000-8000-000000000019', 'asset', 'fa000000-0000-4000-8000-000000000002', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000040', 'f6000000-0000-4000-8000-000000000016', 'asset', 'fa000000-0000-4000-8000-000000000002', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000041', 'f6000000-0000-4000-8000-000000000006', 'asset', 'fa000000-0000-4000-8000-000000000003', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000042', 'f6000000-0000-4000-8000-000000000013', 'asset', 'fa000000-0000-4000-8000-000000000003', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000043', 'f6000000-0000-4000-8000-000000000008', 'asset', 'fa000000-0000-4000-8000-000000000003', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000044', 'f6000000-0000-4000-8000-000000000023', 'asset', 'fa000000-0000-4000-8000-000000000003', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000045', 'f6000000-0000-4000-8000-000000000016', 'asset', 'fa000000-0000-4000-8000-000000000003', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000046', 'f6000000-0000-4000-8000-000000000012', 'asset', 'fa000000-0000-4000-8000-000000000003', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000047', 'f6000000-0000-4000-8000-000000000015', 'asset', 'fa000000-0000-4000-8000-000000000004', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000048', 'f6000000-0000-4000-8000-000000000026', 'asset', 'fa000000-0000-4000-8000-000000000004', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000049', 'f6000000-0000-4000-8000-000000000019', 'asset', 'fa000000-0000-4000-8000-000000000004', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000050', 'f6000000-0000-4000-8000-000000000014', 'asset', 'fa000000-0000-4000-8000-000000000005', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000051', 'f6000000-0000-4000-8000-000000000010', 'asset', 'fa000000-0000-4000-8000-000000000005', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000052', 'f6000000-0000-4000-8000-000000000009', 'asset', 'fa000000-0000-4000-8000-000000000005', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000053', 'f6000000-0000-4000-8000-000000000020', 'asset', 'fa000000-0000-4000-8000-000000000005', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000054', 'f6000000-0000-4000-8000-000000000017', 'asset', 'fa000000-0000-4000-8000-000000000005', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000055', 'f6000000-0000-4000-8000-000000000002', 'asset', 'fa000000-0000-4000-8000-000000000006', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000056', 'f6000000-0000-4000-8000-000000000013', 'asset', 'fa000000-0000-4000-8000-000000000006', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000057', 'f6000000-0000-4000-8000-000000000008', 'asset', 'fa000000-0000-4000-8000-000000000006', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000058', 'f6000000-0000-4000-8000-000000000023', 'asset', 'fa000000-0000-4000-8000-000000000006', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000059', 'f6000000-0000-4000-8000-000000000019', 'asset', 'fa000000-0000-4000-8000-000000000006', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000060', 'f6000000-0000-4000-8000-000000000024', 'asset', 'fa000000-0000-4000-8000-000000000006', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000061', 'f6000000-0000-4000-8000-000000000016', 'asset', 'fa000000-0000-4000-8000-000000000006', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000062', 'f6000000-0000-4000-8000-000000000001', 'asset', 'fa000000-0000-4000-8000-000000000007', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000063', 'f6000000-0000-4000-8000-000000000014', 'asset', 'fa000000-0000-4000-8000-000000000007', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000064', 'f6000000-0000-4000-8000-000000000011', 'asset', 'fa000000-0000-4000-8000-000000000007', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000065', 'f6000000-0000-4000-8000-000000000024', 'asset', 'fa000000-0000-4000-8000-000000000007', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000066', 'f6000000-0000-4000-8000-000000000026', 'asset', 'fa000000-0000-4000-8000-000000000007', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000067', 'f6000000-0000-4000-8000-000000000018', 'asset', 'fa000000-0000-4000-8000-000000000007', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000068', 'f6000000-0000-4000-8000-000000000013', 'asset', 'fa000000-0000-4000-8000-000000000008', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000069', 'f6000000-0000-4000-8000-000000000007', 'asset', 'fa000000-0000-4000-8000-000000000008', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000070', 'f6000000-0000-4000-8000-000000000023', 'asset', 'fa000000-0000-4000-8000-000000000008', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000071', 'f6000000-0000-4000-8000-000000000016', 'asset', 'fa000000-0000-4000-8000-000000000008', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000072', 'f6000000-0000-4000-8000-000000000024', 'asset', 'fa000000-0000-4000-8000-000000000008', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000073', 'f6000000-0000-4000-8000-000000000011', 'asset', 'fa000000-0000-4000-8000-000000000009', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000074', 'f6000000-0000-4000-8000-000000000024', 'asset', 'fa000000-0000-4000-8000-000000000009', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000075', 'f6000000-0000-4000-8000-000000000019', 'asset', 'fa000000-0000-4000-8000-000000000009', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000076', 'f6000000-0000-4000-8000-000000000003', 'asset', 'fa000000-0000-4000-8000-000000000010', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000077', 'f6000000-0000-4000-8000-000000000013', 'asset', 'fa000000-0000-4000-8000-000000000010', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000078', 'f6000000-0000-4000-8000-000000000007', 'asset', 'fa000000-0000-4000-8000-000000000010', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000079', 'f6000000-0000-4000-8000-000000000022', 'asset', 'fa000000-0000-4000-8000-000000000010', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000080', 'f6000000-0000-4000-8000-000000000016', 'asset', 'fa000000-0000-4000-8000-000000000010', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000081', 'f6000000-0000-4000-8000-000000000019', 'asset', 'fa000000-0000-4000-8000-000000000010', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000082', 'f6000000-0000-4000-8000-000000000005', 'asset', 'fa000000-0000-4000-8000-000000000011', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000083', 'f6000000-0000-4000-8000-000000000013', 'asset', 'fa000000-0000-4000-8000-000000000011', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000084', 'f6000000-0000-4000-8000-000000000008', 'asset', 'fa000000-0000-4000-8000-000000000011', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000085', 'f6000000-0000-4000-8000-000000000021', 'asset', 'fa000000-0000-4000-8000-000000000011', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000086', 'f6000000-0000-4000-8000-000000000017', 'asset', 'fa000000-0000-4000-8000-000000000011', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000087', 'f6000000-0000-4000-8000-000000000025', 'asset', 'fa000000-0000-4000-8000-000000000011', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000088', 'f6000000-0000-4000-8000-000000000004', 'asset', 'fa000000-0000-4000-8000-000000000012', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000089', 'f6000000-0000-4000-8000-000000000013', 'asset', 'fa000000-0000-4000-8000-000000000012', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000090', 'f6000000-0000-4000-8000-000000000022', 'asset', 'fa000000-0000-4000-8000-000000000012', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000091', 'f6000000-0000-4000-8000-000000000021', 'asset', 'fa000000-0000-4000-8000-000000000012', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000092', 'f6000000-0000-4000-8000-000000000020', 'asset', 'fa000000-0000-4000-8000-000000000012', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000093', 'f6000000-0000-4000-8000-000000000025', 'asset', 'fa000000-0000-4000-8000-000000000012', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000094', 'f6000000-0000-4000-8000-000000000013', 'asset', 'fa000000-0000-4000-8000-000000000013', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000095', 'f6000000-0000-4000-8000-000000000023', 'asset', 'fa000000-0000-4000-8000-000000000013', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000096', 'f6000000-0000-4000-8000-000000000021', 'asset', 'fa000000-0000-4000-8000-000000000013', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000097', 'f6000000-0000-4000-8000-000000000007', 'asset', 'fa000000-0000-4000-8000-000000000013', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000098', 'f6000000-0000-4000-8000-000000000013', 'asset', 'fa000000-0000-4000-8000-000000000014', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000099', 'f6000000-0000-4000-8000-000000000011', 'asset', 'fa000000-0000-4000-8000-000000000014', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000100', 'f6000000-0000-4000-8000-000000000009', 'asset', 'fa000000-0000-4000-8000-000000000014', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000101', 'f6000000-0000-4000-8000-000000000020', 'asset', 'fa000000-0000-4000-8000-000000000014', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000102', 'f6000000-0000-4000-8000-000000000002', 'asset', 'fa000000-0000-4000-8000-000000000015', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000103', 'f6000000-0000-4000-8000-000000000013', 'asset', 'fa000000-0000-4000-8000-000000000015', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000104', 'f6000000-0000-4000-8000-000000000022', 'asset', 'fa000000-0000-4000-8000-000000000015', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000105', 'f6000000-0000-4000-8000-000000000020', 'asset', 'fa000000-0000-4000-8000-000000000015', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000106', 'f6000000-0000-4000-8000-000000000017', 'asset', 'fa000000-0000-4000-8000-000000000015', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000107', 'f6000000-0000-4000-8000-000000000006', 'asset', 'fa000000-0000-4000-8000-000000000016', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000108', 'f6000000-0000-4000-8000-000000000013', 'asset', 'fa000000-0000-4000-8000-000000000016', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000109', 'f6000000-0000-4000-8000-000000000022', 'asset', 'fa000000-0000-4000-8000-000000000016', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000110', 'f6000000-0000-4000-8000-000000000014', 'asset', 'fa000000-0000-4000-8000-000000000017', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000111', 'f6000000-0000-4000-8000-000000000011', 'asset', 'fa000000-0000-4000-8000-000000000017', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000112', 'f6000000-0000-4000-8000-000000000009', 'asset', 'fa000000-0000-4000-8000-000000000017', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000113', 'f6000000-0000-4000-8000-000000000025', 'asset', 'fa000000-0000-4000-8000-000000000017', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000114', 'f6000000-0000-4000-8000-000000000013', 'asset', 'fa000000-0000-4000-8000-000000000018', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000115', 'f6000000-0000-4000-8000-000000000008', 'asset', 'fa000000-0000-4000-8000-000000000018', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000116', 'f6000000-0000-4000-8000-000000000023', 'asset', 'fa000000-0000-4000-8000-000000000018', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000117', 'f6000000-0000-4000-8000-000000000020', 'asset', 'fa000000-0000-4000-8000-000000000018', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000118', 'f6000000-0000-4000-8000-000000000025', 'asset', 'fa000000-0000-4000-8000-000000000018', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000119', 'f6000000-0000-4000-8000-000000000006', 'asset', 'fa000000-0000-4000-8000-000000000019', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000120', 'f6000000-0000-4000-8000-000000000013', 'asset', 'fa000000-0000-4000-8000-000000000019', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000121', 'f6000000-0000-4000-8000-000000000007', 'asset', 'fa000000-0000-4000-8000-000000000019', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000122', 'f6000000-0000-4000-8000-000000000016', 'asset', 'fa000000-0000-4000-8000-000000000019', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000123', 'f6000000-0000-4000-8000-000000000014', 'asset', 'fa000000-0000-4000-8000-000000000020', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000124', 'f6000000-0000-4000-8000-000000000010', 'asset', 'fa000000-0000-4000-8000-000000000020', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000125', 'f6000000-0000-4000-8000-000000000025', 'asset', 'fa000000-0000-4000-8000-000000000020', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000126', 'f6000000-0000-4000-8000-000000000015', 'asset', 'fa000000-0000-4000-8000-000000000021', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000127', 'f6000000-0000-4000-8000-000000000026', 'asset', 'fa000000-0000-4000-8000-000000000021', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000128', 'f6000000-0000-4000-8000-000000000020', 'asset', 'fa000000-0000-4000-8000-000000000021', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000129', 'f6000000-0000-4000-8000-000000000013', 'asset', 'fa000000-0000-4000-8000-000000000022', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000130', 'f6000000-0000-4000-8000-000000000007', 'asset', 'fa000000-0000-4000-8000-000000000022', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000131', 'f6000000-0000-4000-8000-000000000022', 'asset', 'fa000000-0000-4000-8000-000000000022', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000132', 'f6000000-0000-4000-8000-000000000013', 'asset', 'fa000000-0000-4000-8000-000000000023', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000133', 'f6000000-0000-4000-8000-000000000011', 'asset', 'fa000000-0000-4000-8000-000000000023', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000134', 'f6000000-0000-4000-8000-000000000013', 'asset', 'fa000000-0000-4000-8000-000000000025', 'migration', 1.000),
  ('fd000000-0000-4000-8000-000000000135', 'f6000000-0000-4000-8000-000000000011', 'asset', 'fa000000-0000-4000-8000-000000000025', 'migration', 1.000);

-- ---------------------------------------------------------------------------
-- Test principals (NOT in v2 today: real users arrive through dam_provision_user)
-- ---------------------------------------------------------------------------
-- Human users only; the system principals 00000000-...-000000000001..5 belong to the grants/settings migration.
-- Roles and studios are read from these tables, never from the JWT (harness userClaims(id, email)).
--   01 viewer, Bangkok member                      05 global_admin, no studios
--   02 viewer, Singapore member with editor override 06 viewer, INACTIVE, Bangkok member
--   03 viewer, member of the australia region group 07 viewer, no studios, no cross-studio visibility
--   04 viewer, Bangkok member, cross-studio visibility
insert into dam_users (id, email, display_name, role, is_active, cross_studio_visibility) values
  ('f9000000-0000-4000-8000-000000000001', 'fixture.bangkok.viewer@dwp.com',   'Fixture Bangkok Viewer',   'viewer',       true,  false),
  ('f9000000-0000-4000-8000-000000000002', 'fixture.singapore.editor@dwp.com', 'Fixture Singapore Editor', 'viewer',       true,  false),
  ('f9000000-0000-4000-8000-000000000003', 'fixture.australia.viewer@dwp.com', 'Fixture Australia Viewer', 'viewer',       true,  false),
  ('f9000000-0000-4000-8000-000000000004', 'fixture.cross.viewer@dwp.com',     'Fixture Cross Viewer',     'viewer',       true,  true),
  ('f9000000-0000-4000-8000-000000000005', 'fixture.global.admin@dwp.com',     'Fixture Global Admin',     'global_admin', true,  false),
  ('f9000000-0000-4000-8000-000000000006', 'fixture.inactive@dwp.com',         'Fixture Inactive',         'viewer',       false, false),
  ('f9000000-0000-4000-8000-000000000007', 'fixture.nostudio.viewer@dwp.com',  'Fixture No Studio Viewer', 'viewer',       true,  false);

insert into dam_user_studios (id, user_id, studio_id, role_override, is_primary) values
  ('f9100000-0000-4000-8000-000000000001', 'f9000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000003', null,     true),
  ('f9100000-0000-4000-8000-000000000002', 'f9000000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-00000000000e', 'editor', true),
  ('f9100000-0000-4000-8000-000000000003', 'f9000000-0000-4000-8000-000000000003', '51000000-0000-4000-8000-000000000001', null,     true),
  ('f9100000-0000-4000-8000-000000000004', 'f9000000-0000-4000-8000-000000000004', '51000000-0000-4000-8000-000000000003', null,     true),
  ('f9100000-0000-4000-8000-000000000006', 'f9000000-0000-4000-8000-000000000006', '51000000-0000-4000-8000-000000000003', null,     true);
