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
| `GET` | `/api/v1/folders` | Folder paths — find a folder / check one exists |

### Write endpoints (need a `write` key)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/folders` | Create a folder (missing levels created as needed) |
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
| `studio` | dwp studio / project location — ids listed below | `studio=bangkok` |
| `sort` | `newest` (default) or `oldest` | `sort=oldest` |
| `limit` | Page size, default 60, max 100 | `limit=24` |
| `offset` | Skip N results (pagination) | `offset=24` |

### Studio ids for `studio=`

A project’s studio comes from the location folder in its Drive path
(`dwp_Digital_Asset/<collection>/<LOCATION>/<project>/…`) — there is no studio
field on an asset. The match is on a whole path segment, so `studio=bangkok`
finds everything under a `Thailand` folder without matching a project merely
*named* "Thailand Creative & Design Center".

Roughly 8% of the library sits outside any location folder (`Marketing
Requests`, `ARCHIVED`, `_dwp Videos`, `Staff Photo 2026`, and projects filed
straight under `3D Projects`). Those assets match no `studio` and are never
returned by a `studio=` query.

A city name is used only where dwp has one studio for that location. Where it
has several or none, the id is the location itself — `australia` covers the
Sydney, Melbourne, Brisbane, Adelaide and Newcastle studios, which the folder
path cannot tell apart.

| `studio=` | Shown as | Drive location folder(s) |
|---|---|---|
| `australia` | Australia | `Australia`, `AUS_ARCHIVED` |
| `bahrain` | Bahrain | `Bahrain` |
| `bangkok` | Bangkok · Thailand | `Thailand` |
| `china` | China | `China` |
| `dubai` | Dubai · UAE | `UAE` |
| `ho-chi-minh-city` | Ho Chi Minh City · Vietnam | `Vietnam` |
| `hong-kong` | Hong Kong | `Hong Kong` |
| `london` | London · United Kingdom | `United Kingdom`, `UK` — *no such folder yet, so this id matches nothing and the picker hides it* |
| `malaysia` | Malaysia | `Malaysia` |
| `myanmar` | Myanmar | `Myanmar` |
| `new-zealand` | New Zealand | `New Zealand` |
| `philippines` | Philippines | `Philippines`, `Manila` |
| `riyadh` | Riyadh · Saudi Arabia | `Saudi Arabia`, `KSA` — *no such folder yet, so this id matches nothing and the picker hides it* |
| `singapore` | Singapore | `Singapore` |
| `united-states` | United States | `USA`, `United States` |

An unrecognised value is a `400 bad_request` listing the valid ids.

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
{ "name": "Interiors", "location": "dwp_Digital_Asset/ProjectX" }
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | The folder to create. Slashes mean nesting — `"ProjectY/Interiors"` creates both levels. |
| `location` | see below | Where to create it. A key with a **site root** (see `DAM_SITE_ROOTS` below) can omit it — the folder lands in that root — or give a path relative to it; a key without a root must send the full path starting with the Shared Drive name. `parentPath` is the old name for this field and still works. |
| `createParents` | no | Default `true`: missing levels in `location` are created too, so a whole branch appears in one call. `false` restores the strict behaviour — the call fails naming the first missing folder. |

- Safe to call twice: an existing folder is reused, and the response says so
  via `created`.
- `createdParents` lists any parents the call had to create — a non-empty list
  the caller didn't expect usually means a typo in `location`.
- A key with a site root can only create inside it; anything outside → `403`.

```json
{
  "data": {
    "path": "dwp_Digital_Asset/ProjectX/Interiors",
    "name": "Interiors",
    "location": "dwp_Digital_Asset/ProjectX",
    "created": true,
    "createdParents": []
  }
}
```

### `GET /api/v1/folders` — list folders (read key is enough)

For finding a folder or checking one exists before uploading into it.

| Param | Meaning | Example |
|---|---|---|
| `location` (or `prefix`) | Limit to this folder and its subfolders | `location=dwp_Digital_Asset/ProjectX` |
| `depth` | Levels below it; `1` = immediate children | `depth=1` |
| `q` | Case-insensitive substring match on the path | `q=interiors` |
| `limit` | Max paths, default 500, max 2000 | `limit=100` |

```json
{
  "data": {
    "root": "dwp_Digital_Asset/ProjectX",
    "paths": ["dwp_Digital_Asset/ProjectX", "dwp_Digital_Asset/ProjectX/Interiors"]
  },
  "meta": { "count": 2, "total": 2, "limit": 500 }
}
```

`root` echoes the effective scope (the site root, or the `location` you sent,
or `null` for the whole tree). `total` above `count` means more folders matched
than `limit` returned. Folder creation invalidates the cache, so a folder you
just created is listed immediately; folder changes made directly in Drive can
take up to a minute to appear.

### `POST /api/v1/assets` — upload an image or PDF

`multipart/form-data`, **one file per request**:

| Field | Required | Meaning |
|---|---|---|
| `file` | yes | The file (`image/*` or `application/pdf`, max 30 MB) |
| `folderPath` | yes | Destination folder, e.g. `dwp_Digital_Asset/ProjectX/Interiors` — must already exist (create it first via `/folders`). Same location rules as `/folders`: relative to the key's site root when it has one, and never outside it. **Always required**, even for a key with a root — an upload has to name its destination, so a caller bug can't quietly pile images into the root. |
| `tags` | no | Comma-separated tags; preserved, cleaned of `#`, and merged with AI-generated tags |
| `autoTag` | no | `true` (default) or `false` — runs Gemini Vision AI to generate ~14+ rich architectural & interior tags and set macro/core sector taxonomy |

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
const { data } = await res.json(); // the new asset, incl. image_url and AI tags
```

By default, every uploaded image is automatically analyzed with Gemini Vision AI to generate ~14+ rich architectural & interior tags (materials, lighting, typologies, space type, styles) and populate `macro_portfolio`, `core_sector`, and `sub_sectors`. Any caller-supplied `tags` are preserved and merged. Pass `autoTag: "false"` to opt out of AI classification.

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
  folders/route.ts         GET  list folder paths (cached tree from lib/drivePaths.ts),
                                scoped to the key's site root, with location/depth/q/limit
                           POST wrap createFolderAtPath() with createParents; return only
                                { path, name, location, created, createdParents }
  tags/route.ts            GET  distinct tags (reuse app/api/tags logic)
  presets/route.ts         GET  the preset library  |  POST add tags to a group
  presets/update/route.ts  POST rename a preset tag or group
  presets/delete/route.ts  POST delete a preset tag or group
                           (all four call lib/presets.ts helpers, shared with
                            the app's own Settings page and /api/presets*;
                            REQUIRES row-level security to be disabled on
                            common_dam_presets, like common_dam_assets)

lib/api/
  folderScope.ts resolveSiteLocation(site, location): applies DAM_SITE_ROOTS —
                 turns an omitted/relative location into an absolute path under
                 the key's root and rejects anything outside it (403). Used by
                 /folders (GET + POST) and the upload's folderPath, so one key
                 has one folder space for every write it can do
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
   spawning new folder trees. **Folder creation itself is `mkdir -p`** —
   missing levels in `location` are created (opt out with
   `createParents: false`) and listed back in `createdParents`. The asymmetry
   is deliberate: on the endpoint whose whole job is making folders, building
   "Projects/Marketing Hub/Q3" shouldn't take three calls; on upload a typo
   would orphan an image in a stray folder, so upload still fails loudly.
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
15. **`DAM_SITE_ROOTS` gives a key one folder space.** A site with a root
    creates folders and uploads relative to it, and is fenced to it (`403`
    outside) — which is what a per-project consumer app wants: it sends a
    project name, not a Drive path. Reads (search, `GET /assets/{id}`, image,
    thumbnail) and edits by asset id are deliberately NOT fenced: every
    consumer is internal and cross-team reuse is the point (the per-asset
    version of this is the ownership check under "Later"). A site with no root
    behaves exactly as it did before roots existed — absolute paths, no fence.

### New environment variables

Already set in `.env.local` (real values) and passed through to Cloud Run by
`deploy.ps1` / `set-env.ps1`:

```
# comma-separated entries of  name:key:scopes  — scopes joined with "+"
# (name shows up in logs and in uploaded_by for tracing)
DAM_API_KEYS=site-a:dam_live_xxxxxxxx:read+write,site-b:dam_live_yyyyyyyy:read+write

# base for image/thumbnail URLs in responses (optional — the code falls back
# to the request's own origin when unset). MUST match the live service: on the
# dwp2026 project that is
DAM_PUBLIC_BASE_URL=https://dwp-dam-s2r2rmdlzq-eu.a.run.app

# optional per-site folder roots:  site:path  entries, comma-separated, path
# starting with the Shared Drive name. A site listed here creates folders and
# uploads relative to its root and cannot write outside it; a site not listed
# keeps sending absolute paths with no fence. Site names match DAM_API_KEYS.
DAM_SITE_ROOTS=dwp-marketing-hub:dwp_Digital_Asset/Marketing Hub
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

### Onboarding another consumer site (e.g. `dwp-marketing-hub`, `studioai`)

Every consumer issued so far — all Cloud Run services in the *same* project and
region as the DAM (`dwp2026` / `asia-southeast3`):

| Key name | Consumer service | Folder space | Guide |
|---|---|---|---|
| `dwp_website2026` | the dwp.com site | *(unfenced — absolute paths)* | `docs/DAM-API-GUIDE-dwp_website2026.md` |
| `proposal-maker` | proposal tooling | *(unfenced — absolute paths)* | `docs/DAM-API-GUIDE-proposal-maker.md` |
| `dwp-marketing-hub` | https://dwp-marketing-hub-s2r2rmdlzq-eu.a.run.app | `dwp_Digital_Asset/Marketing Hub` | `docs/DAM-API-GUIDE-dwp-marketing-hub.md` |
| `studioai` | https://studioai-v2-s2r2rmdlzq-eu.a.run.app | `dwp_Digital_Asset/StudioAI` | `docs/DAM-API-GUIDE-studioai.md` |

Same-project doesn't change anything: a consumer still authenticates with an API
key over HTTPS like any other, and no origin allow-listing is needed (CORS is
`*`). Note `studioai` is deliberately *not* named `studioai-v2` after its Cloud
Run service — the key name is written into every `uploaded_by` row, so it should
outlive a version bump.

No code change — three env/doc steps:

1. **Key** — append to `DAM_API_KEYS` in `.env.local`:
   `,studioai:dam_live_<openssl rand -hex 24>:read+write`
   (the site name lands in `uploaded_by` and every write log line).
2. **Folder space (optional but recommended)** — append to `DAM_SITE_ROOTS`:
   `studioai:dwp_Digital_Asset/StudioAI`. The site then sends folder
   names/short paths instead of Drive paths, and can't write outside that
   folder. The folder doesn't need to exist first — the site's first
   `POST /folders` creates it.
3. **Guide** — copy `docs/DAM-API-GUIDE-studioai.md` or
   `docs/DAM-API-GUIDE-dwp-marketing-hub.md` (both written for the rooted flow;
   retitle and fix the root path) and send it with the base URL + key. The
   guides deliberately contain no key — send that separately.

Then `set-env.ps1` (env-only change, ~15 s — no rebuild needed). Both scripts
already pass `DAM_SITE_ROOTS` through; a var missing from those lists never
reaches Cloud Run.

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
  who did it, but nothing prevents it (see ownership check in "Later"). A
  `DAM_SITE_ROOTS` root narrows only *where new folders and uploads land* — it
  does not stop that key editing or deleting an asset elsewhere by id.
- **A site root is name-path based, like everything else here.** It doesn't
  have to exist when you set it — the first `POST /folders` creates it (handy:
  no manual Drive step to onboard a site). The flip side: rename or move the
  root folder in Drive and the next call **recreates it empty** instead of
  failing, so the site's new folders land in the recreated one while its old
  images stay under the old name. Renaming a root folder = update
  `DAM_SITE_ROOTS` in the same change.
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
