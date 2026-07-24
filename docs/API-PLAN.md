# DWP DAM — External Image API Plan

Plan for letting other DWP web pages fetch images from the DAM — and, for sites
that need it, upload images, edit them, and create folders — through a small,
versioned API. Two audiences:

- **Part 1** — for the consumer sites (your colleagues): what to call.
- **Part 2** — for the DAM (this repo): what to build to receive those calls.

Only `GET` and `POST` are used: reads are `GET`, every change is a `POST`.
There is no `PATCH` / `PUT` / `DELETE` verb anywhere — even deleting (if you
enable it) is a `POST`, so consumers only ever need two verbs.

---

## How it fits together

```
Colleague site A ──┐
                   │   GET  /api/v1/assets?tags=...      (search, JSON)
Colleague site B ──┼──▶  DAM (Cloud Run, Next.js)
                   │        │ metadata ──▶ Supabase (common_dam_assets)
                   │        │ image bytes ─▶ Google Drive (service account)
                   │   GET  /api/v1/assets/{id}/image    (the actual picture)
                   └── POST /api/v1/assets, /folders ... (writes, if key allows)
```

Key idea: consumer sites never talk to Drive or Supabase directly. They only
know the DAM's base URL and an API key. The DAM streams image bytes from Drive
itself, because Drive's `webViewLink` / `thumbnailLink` don't work for outside
visitors (they require Drive permissions and the thumbnail links expire).
Writes go through the DAM too, so Drive and the Supabase metadata always change
together and stay in sync.

---

## Part 1 — For the consumer sites (colleagues)

### What you need from the DAM team

| Item | Example |
|---|---|
| Base URL | `https://dwp-dam-xxxxx.a.run.app` (or the final domain) |
| API key (one per site) | `dam_live_a1b2c3...` — keep it in your server env, not in git |

Each key carries **permissions**: `read` only, or `read+write` (write covers
upload, update, replace **and delete**). If your site only displays images,
ask for a read key. Calling a write endpoint with a read-only key returns `403`.

### Authentication

Send the key on **every** request, either way works:

- Header (preferred): `x-api-key: <your key>`
- Query string (for `<img>` tags, which can't send headers): `?key=<your key>`

Missing/wrong key → `401`. Key lacks permission → `403`. Error body is always
`{ "error": { "code": "...", "message": "..." } }`.

### Read endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/assets` | Search / list images (JSON metadata) |
| `POST` | `/api/v1/assets/search` | Same search, filters in a JSON body (optional, for long filter lists) |
| `GET` | `/api/v1/assets/{id}` | One image's metadata |
| `GET` | `/api/v1/assets/{id}/image` | The full-resolution image file (bytes) |
| `GET` | `/api/v1/assets/{id}/thumbnail` | Fast preview image (default 640px) |
| `GET` | `/api/v1/tags` | All known tags (to build filter dropdowns) |
| `GET` | `/api/v1/presets` | The preset tag library, grouped (the DAM's tag menu) |

### Write endpoints (need a `write` key)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/folders` | Create a folder |
| `POST` | `/api/v1/assets` | Upload a new image |
| `POST` | `/api/v1/assets/{id}/update` | Change an image's name / tags |
| `POST` | `/api/v1/assets/{id}/replace` | Swap the image file itself (same id, same URLs) |
| `POST` | `/api/v1/assets/{id}/delete` | Move the image to Drive trash |
| `POST` | `/api/v1/presets` | Add preset tags to a group (creates the group if new) |
| `POST` | `/api/v1/presets/update` | Rename a preset tag (`{group, tag, newTag}`) or group (`{group, newGroup}`) |
| `POST` | `/api/v1/presets/delete` | Delete a preset tag (`{group, tag}`) or whole group (`{group}`) |

Preset edits change the DAM's tag *menu* only — tags already applied to
images are never modified. The same library is editable in the DAM's own
Settings page (gear icon in the menu bar); the first-ever write seeds the
`common_dam_presets` table with the built-in defaults so nothing disappears.
Changes can take up to 5 minutes to show everywhere (server-side cache).

### `GET /api/v1/assets` — search parameters

All parameters are optional; combine freely.

| Param | Meaning | Example |
|---|---|---|
| `q` | Text match on file name (partial, case-insensitive) | `q=lobby` |
| `tags` | Comma-separated; asset must have **all** of them | `tags=exterior,bangkok` |
| `macro` | Exact Macro Portfolio | `macro=Lifestyle` |
| `core` | Exact Core Sector | `core=Hospitality` |
| `sub` | Comma-separated Sub-Sectors; must have all | `sub=Luxury+Resort` |
| `path` | Exact Drive folder path | `path=dwp_Digital_Asset/ProjectX` |
| `pathPrefix` | Folder path prefix (folder + subfolders) | `pathPrefix=dwp_Digital_Asset/ProjectX` |
| `sort` | `newest` (default) or `oldest` | `sort=oldest` |
| `limit` | Page size, default 60, max 100 | `limit=24` |
| `offset` | Skip N results (pagination) | `offset=24` |

### Response shape (used by search, upload, update, replace)

```json
{
  "data": [
    {
      "id": "0b9f2c4e-...",
      "name": "lobby-01.jpg",
      "mime_type": "image/jpeg",
      "size_bytes": 2456123,
      "tags": ["exterior", "bangkok"],
      "macro_portfolio": "Lifestyle",
      "core_sector": "Hospitality",
      "sub_sectors": ["Luxury Resort"],
      "folder_path": "dwp_Digital_Asset/ProjectX/Interiors",
      "created_at": "2026-07-01T09:30:00Z",
      "thumbnail_url": "https://<dam>/api/v1/assets/0b9f2c4e-.../thumbnail",
      "image_url": "https://<dam>/api/v1/assets/0b9f2c4e-.../image"
    }
  ],
  "meta": { "limit": 60, "offset": 0, "count": 1 }
}
```

Single-asset endpoints (upload, update, replace, `GET /assets/{id}`) return one
object under `"data"` instead of a list. Errors always look like:

```json
{ "error": { "code": "bad_request", "message": "limit must be <= 100" } }
```

(`400` bad input, `401` bad key, `403` key lacks permission, `404` unknown
asset, `500` server problem.)

### `POST /api/v1/assets/search` — body version of the same search

Use this if your filter lists get long or you prefer sending JSON:

```json
{
  "q": "lobby",
  "tags": ["exterior", "bangkok"],
  "macro": "Lifestyle",
  "sub": ["Luxury Resort"],
  "sort": "newest",
  "limit": 24,
  "offset": 0
}
```

Same response shape as the GET version.

### `POST /api/v1/folders` — create a folder

```json
{ "parentPath": "dwp_Digital_Asset/ProjectX", "name": "Interiors" }
```

- `parentPath` starts with the Shared Drive name and must already exist.
- Safe to call twice: if the folder already exists it is reused, and the
  response tells you via `created`.

```json
{ "data": { "path": "dwp_Digital_Asset/ProjectX/Interiors", "created": true } }
```

### `POST /api/v1/assets` — upload an image

`multipart/form-data`, **one image per request**:

| Field | Required | Meaning |
|---|---|---|
| `file` | yes | The image file (`image/*` only, max 30 MB) |
| `folderPath` | yes | Destination folder, e.g. `dwp_Digital_Asset/ProjectX/Interiors` — must already exist (create it first via `/folders`) |
| `tags` | no | Comma-separated tags; sector fields are derived from them automatically |

```js
const form = new FormData();
form.append("file", fileInput.files[0]);
form.append("folderPath", "dwp_Digital_Asset/ProjectX/Interiors");
form.append("tags", "interior,bangkok");

const res = await fetch("https://<dam>/api/v1/assets", {
  method: "POST",
  headers: { "x-api-key": DAM_API_KEY },
  body: form, // don't set Content-Type yourself — fetch does it for multipart
});
const { data } = await res.json(); // the new asset, incl. image_url
```

Uploading several images = several requests (running them in parallel is fine).
**Don't blind-retry a timed-out upload** — it may have succeeded, and retrying
creates a duplicate file. Search for the file name first.

### `POST /api/v1/assets/{id}/update` — change name / tags

```json
{ "name": "lobby-01-final.jpg", "tags": ["interior", "bangkok", "renovated"] }
```

- Both fields optional; send only what you're changing.
- `tags` **replaces** the whole tag list (it is not merged) — send the full
  final list. The sector fields are re-derived from the new tags.
- A `name` change also renames the file in Drive.
- Returns the updated asset.

### `POST /api/v1/assets/{id}/replace` — swap the image file

`multipart/form-data` with a single `file` field. The asset keeps the same
`id`, `image_url` and `thumbnail_url`, so anything already embedding this image
just starts showing the new picture (thumbnails may take a minute to refresh,
and viewers may see the old image until caches expire — up to 24 h).

### `POST /api/v1/assets/{id}/delete` — remove an image

No body. The file is moved to the Drive **trash** (recoverable there for ~30
days by the DAM team) and disappears from search immediately. Recovery is
manual, and the image's tags/metadata are **not** restored with it — so treat
delete as final from your side and confirm with your users before calling it.

### Typical read usage in a page

```js
// 1) Search (works from your server or straight from the browser)
const res = await fetch(
  "https://<dam>/api/v1/assets?tags=exterior&limit=24",
  { headers: { "x-api-key": process.env.DAM_API_KEY } }
);
const { data } = await res.json();

// 2) Render — image endpoints accept the key as a query param for <img>
for (const asset of data) {
  img.src = `${asset.thumbnail_url}?key=${DAM_API_KEY}`;       // grid tile
  link.href = `${asset.image_url}?key=${DAM_API_KEY}`;          // full-res
}
```

Notes:

- `thumbnail_url` supports `&size=320|640|1024` (longest edge, default 640).
- If your page is public on the internet (not internal), don't put the key in
  HTML — fetch the image through your own backend instead, or ask the DAM team
  for the signed-URL option (see "Later" below). Write calls especially should
  happen from your **server**, never from public browser code.
- Cache freely: thumbnails are cacheable for 30 min, full images for 24 h.

---

## Part 2 — For the DAM (this repo): what to build

Keep the existing internal routes (`/api/assets`, `/api/upload`, ...) as they
are for the app's own UI. Add a separate **public, versioned** surface so the
internal ones stay free to change:

```
app/api/v1/
  assets/
    route.ts               GET  search  (reuse the query logic from app/api/assets/route.ts)
                           POST upload  (one file; reuse the Drive-upload + Supabase-insert
                                         flow from app/api/upload/route.ts)
    search/route.ts        POST search  (parse JSON body → same shared query function)
    [id]/
      route.ts             GET  one row by id from common_dam_assets
      image/route.ts       GET  stream bytes from Drive:
                                drive.files.get({ fileId, alt: "media",
                                  supportsAllDrives: true }, { responseType: "stream" })
                                → return as Response with Content-Type = mime_type,
                                  Cache-Control: public, max-age=86400
      thumbnail/route.ts   GET  same fresh-link + 302 trick as app/api/thumbnail/route.ts,
                                with ?size= mapped to Drive's =sNNN suffix
      update/route.ts      POST rename in Drive if name changed + update Supabase row;
                                tags → deriveSelectionFromTags() like upload does
      replace/route.ts     POST drive.files.update with new media (same fileId),
                                then update mime_type / size_bytes in Supabase
      delete/route.ts      POST drive trash (files.update { trashed: true }),
                                then delete the Supabase row
  folders/route.ts         POST wrap createFolderAtPath(); return only { path, created }
  tags/route.ts            GET  distinct tags (reuse app/api/tags logic)
  presets/route.ts         GET  the preset library  |  POST add tags to a group
  presets/update/route.ts  POST rename a preset tag or group
  presets/delete/route.ts  POST delete a preset tag or group
                           (all four call lib/presets.ts helpers, shared with
                            the app's own Settings page and /api/presets*;
                            REQUIRES row-level security to be disabled on
                            common_dam_presets, like common_dam_assets)

lib/api/
  auth.ts        requireApiKey(request, scope): checks x-api-key header OR ?key=
                 against DAM_API_KEYS, then checks the key has the needed scope
                 ("read" | "write" — write covers delete); returns the site
                 name or an error Response (401 unknown key / 403 missing scope)
  cors.ts        open CORS for the JSON routes (Access-Control-Allow-Origin: *,
                 x-api-key header allowed) + the shared OPTIONS preflight
                 handler — the API key is the access control, not the origin
  serialize.ts   toPublicAsset(row): picks the public fields (see response shape
                 above — do NOT expose drive_file_id, web_view_link, uploaded_by)
                 and builds absolute thumbnail_url / image_url from
                 DAM_PUBLIC_BASE_URL (falling back to the request's own origin)
  search.ts      the one shared search function both GET and POST routes call

lib/googleDrive.ts — add three small functions next to uploadFileToDrive():
  resolveFolderPathToId(path)   path → { driveId, folderId }, find-only
                                (reuse the resolveFolderPath walk that
                                createFolderAtPath already uses — never create
                                on upload, so a typo fails loudly instead of
                                growing a stray folder tree)
  replaceDriveFile(fileId, buffer, mimeType)   files.update with media
  trashDriveFile(fileId)                       files.update { trashed: true }
  renameDriveFile(fileId, name)                files.update { name }
```

### Decisions baked into this design

1. **Auth = per-site API keys with scopes.** Two consumers → two keys, so one
   can be rotated without breaking the other, and a display-only site never
   holds a key that can write. Long random strings, e.g. `openssl rand -hex 24`.
2. **Key via `?key=` is allowed only because `<img>` can't send headers.**
   Fine for internal pages; the upgrade path for public pages is signed URLs
   (below), not more key-sharing.
3. **Image bytes are streamed, not buffered** — pass Drive's stream straight
   through to the Response so big files don't blow memory / Cloud Run response
   limits.
4. **Lookup by `id` (Supabase UUID), never by `drive_file_id`.** The row gives
   you `drive_file_id` + `mime_type` server-side; Drive IDs stay internal.
5. **CORS is open (`*`) on the JSON routes** — every consumer is internal and
   the API key is the real gate. Pinning origins would add a redeploy per new
   site and wouldn't stop a leaked key anyway (non-browser callers ignore
   CORS; the fix for a leak is rotating the key). `<img>` loading doesn't
   involve CORS at all.
6. **Cap `limit` at 100** and validate `sort`/`offset` so a consumer bug can't
   turn into a giant Supabase scan.
7. **Every write goes through the same shared helpers as the internal UI, and
   always touches Drive + Supabase together** in one code path — never one
   without the other, or search results and reality drift apart.
8. **Every write is attributed**: uploads stamp `uploaded_by` with the calling
   key's site name, and every update/replace/delete/folder call is logged with
   the site name (visible in Cloud Logging), so you can always answer "which
   site did this?".
9. **Uploads address folders by human path, and the folder must already
   exist.** Consumers create folders explicitly via `POST /folders` (which is
   find-or-create, so it's retry-safe). This keeps typos from silently
   spawning new folder trees.
10. **Upload rules: one image per request, `image/*` MIME types only,
    ≤ 30 MB** (Cloud Run caps requests at 32 MB). Batch = parallel requests.
11. **`update` replaces the whole tags array** and re-derives the taxonomy
    columns server-side with `deriveSelectionFromTags()` — identical semantics
    to upload, one tagging code path.
12. **`replace` keeps the same asset id and Drive file id**, so URLs already
    embedded in consumer pages keep working and simply show the new image.
13. **Delete means Drive trash, not permanent deletion** (recoverable ~30 days
    in Drive), plus removing the Supabase row. Restoring a trashed file is a
    manual Drive operation and does NOT bring the metadata row back — accepted
    trade-off to keep v1 simple.
14. **No idempotency in v1** — a retried upload makes a duplicate. Documented
    for consumers; an `Idempotency-Key` header is the "Later" fix if it bites.

### New environment variables

Already set in `.env.local` (real values) and passed through to Cloud Run by
`deploy.ps1` / `set-env.ps1`:

```
# comma-separated entries of  name:key:scopes  — scopes joined with "+"
# (name shows up in logs and in uploaded_by for tracing)
DAM_API_KEYS=site-a:dam_live_xxxxxxxx:read+write,site-b:dam_live_yyyyyyyy:read+write

# base for image/thumbnail URLs in responses (optional — the code falls back
# to the request's own origin when unset)
DAM_PUBLIC_BASE_URL=https://dwp-dam-4w57ydlk6q-eu.a.run.app
```

There is deliberately **no CORS origin list**: all consumers are internal, so
the JSON routes answer CORS with `*` and the API key does the gatekeeping.

### Rollout checklist

1. Build `lib/api/*` helpers + the Drive helper additions, then the read
   routes, then the write routes.
2. Keys are already generated in `.env.local` (`DAM_API_KEYS`) — rename
   `site-a` / `site-b` to the real site names (the name is what shows up in
   `uploaded_by`), and drop `+write` from any site that should be
   display-only.
3. In the Drive UI, confirm the service account's membership on the Shared
   Drive is **Content manager** or **Manager** — lower roles can upload but
   cannot trash files, so delete would 403 at the Drive layer.
4. Test locally with `curl`:
   `curl -H "x-api-key: ..." "http://localhost:3000/api/v1/assets?limit=2"`
   and an upload:
   `curl -H "x-api-key: ..." -F "file=@test.jpg" -F "folderPath=dwp_Digital_Asset/ApiTest" http://localhost:3000/api/v1/assets`
5. Deploy with `deploy.ps1` (new code needs an image build — `set-env.ps1`
   alone only updates env vars on the existing image).
6. Send each colleague: the base URL, their key + its scopes, and Part 1 of
   this document.
7. They wire up one test page; confirm a browser fetch works from their page,
   and (for a write site) that a test upload appears in the DAM's browse page.

### Known limitations (v1)

Accepted trade-offs — each has an upgrade path in "Later" if it starts to hurt.

- **Uploads**: one image per request, `image/*` only, max 30 MB (Cloud Run
  request cap). No idempotency — a blind retry after a timeout can create a
  duplicate file.
- **Delete is one-way in practice**: the file can be rescued from Drive trash
  for ~30 days, but its tags/metadata row is gone and must be re-entered.
- **Keys are static, long-lived secrets**: rotating one means updating
  `DAM_API_KEYS` on Cloud Run and redeploying. A key used in `<img>` URLs is
  visible to anyone who can view the page source — acceptable for internal
  pages only.
- **Any site with a write key can modify/delete ANY asset**, including images
  uploaded through the DAM UI or by the other site. `uploaded_by` tells you
  who did it, but nothing prevents it (see ownership check in "Later").
- **Adding or rotating a key means an env update**: edit `DAM_API_KEYS` in
  `.env.local` and run `set-env.ps1` (~15 s, no rebuild needed).
- **Search is simple**: tag filters are AND-only (no OR), text search is a
  name substring match, pagination is offset-based. No full-text or
  visual/semantic search.
- **No push**: consumers poll for new images; there are no webhooks.
- **Replaced images can look stale for up to 24 h** (browser/proxy caches on
  `image_url`; thumbnails up to 30 min + Drive regeneration time).
- **Folders are addressed by name-path** (inherited from the app): renaming or
  moving a folder directly in Drive leaves stored `folder_path` values stale,
  and duplicate-named siblings resolve to the first match.
- **Every image byte flows through Cloud Run** (no CDN in v1) and Drive API
  quotas are the ceiling — fine for two internal sites, revisit if traffic
  grows.
- **No rate limiting**: a buggy consumer loop hits Supabase/Drive directly at
  full speed.
- **Attribution is per-site, not per-person**: `uploaded_by` records which
  site wrote, not which of their end users clicked the button.

### Later / optional (not needed for v1)

- **Signed URLs** — search response returns short-lived HMAC-signed
  `image_url`s so no key ever appears in HTML. Do this if any consumer page
  becomes public-facing.
- **Ownership check on update/replace/delete** — one-line guard restricting a
  site to assets whose `uploaded_by` matches its own name, if sites shouldn't
  touch each other's (or the DAM UI's) images.
- **Idempotency-Key header on uploads** — retry-safe uploads if duplicate
  files from network timeouts become a real problem.
- **Auto-classification on upload** — accept `classify=true` on
  `POST /assets` and run the same Gemini assessment the internal uploader
  uses, for consumers that can't supply good tags.
- **Rate limiting** — per-key request counter if usage grows beyond two
  internal sites.
- **`fields` param** — let consumers request fewer JSON fields.
- **Webhook / `since` param** — let consumers poll `?since=<timestamp>` to
  sync new uploads instead of re-querying everything.
