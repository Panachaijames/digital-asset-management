# dwp.dam — Drive-backed asset manager

Files live in Google Drive. Tags, search, and browsing live in Supabase.
Two pages: `/` to upload, `/browse` to search and filter by tag.

## Structure

```
app/
  page.tsx                Upload page
  browse/page.tsx          Search/filter page (tag chips + name search)
  layout.tsx                Fonts + metadata
  api/
    upload/route.ts         POST — uploads to Drive, inserts a row into Supabase
    folders/route.ts        GET  — lists Drive folders (supports drill-down via parentId)
    assets/route.ts         GET  — search/filter common_dam_assets by tag(s) and/or name
    tags/route.ts             GET  — distinct tags with counts, for the filter chips
components/
  ImageUploader.tsx          Dropzone, queue, progress, results
  TagInput.tsx                Chip-style multi-tag entry
  FolderPicker.tsx             Drive folder browser with breadcrumb drill-down
lib/
  googleDrive.ts               Service-account Drive client + upload/list helpers
  supabase.ts                  Server-side Supabase client
  types.ts                     Shared TypeScript types
supabase/
  schema.sql                   Run this in the Supabase SQL editor first
```

## Setup

### 1. Google Cloud / Drive
1. Create (or reuse) a Google Cloud project, enable the **Google Drive API**.
2. Create a **service account**, download its JSON key.
3. In Google Drive, open the **Shared Drive** you want assets stored in and
   add the service account's email as a member with **Content Manager**
   access (or higher). Service accounts cannot access personal "My Drive"
   folders, so this must be a Shared Drive.

### 2. Supabase
1. Run `supabase/schema.sql` in your Supabase project's SQL editor.
2. It uses `pg_trgm` for name search — if that extension isn't already
   enabled, run `create extension if not exists pg_trgm;` first.

### 3. Env vars
Copy `.env.local.example` → `.env.local` and fill in:
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` from
  the downloaded JSON key
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` from your Supabase project settings
  (Project Settings → API). The anon key works because `common_dam_assets` has RLS
  disabled; if you enable RLS, add policies or use the service_role key instead.
- `GEMINI_API_KEY` (optional) — enables AI auto-classification of uploaded
  images into the dwp sector taxonomy via Google Gemini. Leave blank to disable
  (the manual taxonomy picker still works). Override the model with
  `GEMINI_MODEL` (defaults to `gemini-3.5-flash`).

### 4. Run
```
npm install
npm run dev
```

## How it works

- **Upload** (`/`): drag/drop single images or **entire folders** (or use
  "Select a whole folder…"). Dropped folder structures are recreated inside the
  chosen Drive destination, and every image lands in its matching subfolder.
  Each image is auto-assessed by Gemini vision against the dwp sector taxonomy
  (Macro Portfolio → Core Sector → Sub-Sectors, see `lib/taxonomy.ts`; also
  queryable in SQL via the `common_dam_taxonomy` table), editable per image
  before upload. Optionally add batch tags, pick a Drive destination via
  breadcrumbs, then upload — the client chunks large batches automatically to
  stay under Cloud Run's request cap. Each file is streamed to Drive via the
  service account, and a matching row (taxonomy, tags, folder, Drive file ID,
  thumbnail link) is written to the `common_dam_assets` Supabase table. Re-run
  `supabase/schema.sql` to create/upgrade tables.
- **Browse** (`/browse`): tag chips are built from every distinct tag in
  Supabase, sorted by frequency. Clicking a chip filters to assets that have
  *all* selected tags (`tags @> ARRAY[...]`). The search box filters by file
  name. Everything queries Supabase, not Drive — Drive is only opened when
  you click through to an actual asset.

## Notes for further development (Antigravity)

- **No auth**: same as the Cloudinary version — wire this into your
  dwp.com Google SSO / 6-tier RBAC before this goes anywhere beyond local
  use. Right now anyone who can reach the app can upload and browse.
- **Sequential uploads**: `app/api/upload/route.ts` uploads one file at a
  time (Drive call + Supabase insert per file). Fine for typical batch
  sizes; parallelize with `Promise.all` if you're routinely uploading
  dozens of files at once and want it faster.
- **Tag editing after upload**: there's currently no UI to edit tags on an
  already-uploaded asset — `/browse` is read-only. A quick add would be a
  `PATCH /api/assets/[id]` route plus an edit affordance on the asset card.
- **Distinct-tags query**: `/api/tags` currently pulls every asset's tag
  array into Node and counts client-side, which is simple but won't scale
  indefinitely. If your asset count gets into the tens of thousands,
  replace it with a Postgres function that does `unnest` + `count` in SQL.
- **Drive thumbnails**: `thumbnailLink` from the Drive API is session-scoped
  and can expire/require the viewer to be signed into a Google account with
  access — this is why the DAM's thumbnails are plain `<img>` tags rather
  than `next/image`. If broken thumbnails become an issue, consider
  generating and storing your own preview images (e.g. in a Supabase Storage
  bucket) instead of relying on Drive's.
- **Folder picker performance**: `listDriveFolders` queries live on every
  drill-down. If your Drive structure is deep, consider caching the folder
  tree in Supabase (a `drive_folders` table synced periodically) the same
  way you already sync `common_google_data`.
