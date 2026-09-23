# DWP DAM Image API — Integration Guide (studioai)

How to search, display, upload and manage images in the dwp Digital Asset
Management system (DAM) from StudioAI. Everything is plain HTTPS + JSON —
no SDK needed, only `GET` and `POST`.

| | |
|---|---|
| Base URL | `https://dwp-dam-s2r2rmdlzq-eu.a.run.app` |
| Your API key | You receive it separately from Panachai (panachai.t@dwp.com) — it is not in this document |
| Your permissions | `read+write` — search, display, upload, edit, delete |
| Your folder space | `dwp_Digital_Asset/StudioAI` — every folder you create and every image you upload goes inside this folder. You never have to type it: send short paths and the DAM fills in the rest (for a new folder you can leave the location out entirely). |
| Your key's name | `studioai` — this is what lands in each uploaded image's `uploaded_by`, so anything StudioAI puts in the DAM is attributable to it |

---

## 1. Store your key

The key is **one plain string** that looks like `dam_live_xxxxxxxx...`.
Put it in StudioAI's server environment (a `.env` file or your Cloud Run
service's env vars):

```
DAM_API_KEY=dam_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

No quotation marks needed. (Quotes also work in most `.env` parsers — they
get stripped — but the value you *send* must be the bare key: no quotes, no
spaces, no `Bearer` prefix.)

Rules:

- **Never commit the key to git** and never put it in pages that outside
  visitors can view-source (internal pages are fine — see §4).
- If the key ever leaks, tell Panachai — it can be swapped in about a minute,
  and only StudioAI's key changes.

## 2. Two-minute test

```bash
curl -H "x-api-key: YOUR_KEY" \
  "https://dwp-dam-s2r2rmdlzq-eu.a.run.app/api/v1/assets?limit=2"
```

You should get JSON with a `data` array of image records. If you get `401`,
the key didn't arrive or is wrong; `403` means your key lacks that permission.

Then confirm your folder space is wired up:

```bash
curl -H "x-api-key: YOUR_KEY" \
  "https://dwp-dam-s2r2rmdlzq-eu.a.run.app/api/v1/folders"
# → { "data": { "root": "dwp_Digital_Asset/StudioAI", "paths": [...] }, ... }
```

`root` should read `dwp_Digital_Asset/StudioAI`. An empty `paths` just means
nothing has been created in your space yet — your first folder call fixes that.

## 3. Authentication — every request

Two ways to send the key; both are equivalent:

- **Header (preferred):** `x-api-key: dam_live_...`
- **Query string (for `<img>` tags and direct links, which can't send
  headers):** append `?key=dam_live_...` (or `&key=` if the URL already has
  parameters).

## 4. Showing images (read)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/assets` | Search / list images |
| `POST` | `/api/v1/assets/search` | Same search, filters as a JSON body |
| `GET` | `/api/v1/assets/{id}` | One image's metadata |
| `GET` | `/api/v1/assets/{id}/image` | Full-resolution image file |
| `GET` | `/api/v1/assets/{id}/thumbnail` | Preview image (`?size=320`, `640` (default) or `1024`) |
| `GET` | `/api/v1/tags` | All tags in use, with counts — good for filter dropdowns |
| `GET` | `/api/v1/presets` | The preset tag library (the DAM's tag menu), grouped |
| `GET` | `/api/v1/folders` | Folder paths — to find a folder or check one exists |

### Search parameters (`GET /api/v1/assets`)

All optional; combine freely.

| Param | Meaning | Example |
|---|---|---|
| `q` | Text match on file name (partial, case-insensitive) | `q=lobby` |
| `tags` | Comma-separated; image must have **all** of them | `tags=exterior,bangkok` |
| `macro` | Exact Macro Portfolio | `macro=Lifestyle` |
| `core` | Exact Core Sector | `core=Hospitality` |
| `sub` | Comma-separated Sub-Sectors; must have all | `sub=Luxury+Resort` |
| `path` | Exact folder path | `path=dwp_Digital_Asset/ProjectX` |
| `pathPrefix` | Folder + all its subfolders | `pathPrefix=dwp_Digital_Asset/ProjectX` |
| `studio` | dwp studio / project location | `studio=bangkok` |
| `sort` | `newest` (default) or `oldest` | `sort=oldest` |
| `limit` | Page size, default 60, max 100 | `limit=24` |
| `offset` | Skip N results (for paging) | `offset=24` |

**Valid `studio=` values** — a project’s studio comes from the location folder
in its Drive path, matched on a whole path segment. The full list:

`australia` · `bahrain` · `bangkok` · `china` · `dubai` · `ho-chi-minh-city` · `hong-kong` · `malaysia` · `myanmar` · `new-zealand` · `philippines` · `singapore` · `united-states`

Anything else is a `400 bad_request` that lists these back to you. A city name
is used only where dwp has a single studio for that location; `australia`
covers several studios the folder path cannot tell apart. Roughly 8% of the
library sits outside any location folder and so matches no `studio` at all.



### What an image record looks like

```json
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
  "thumbnail_url": "https://.../api/v1/assets/0b9f2c4e-.../thumbnail",
  "image_url": "https://.../api/v1/assets/0b9f2c4e-.../image"
}
```

`thumbnail_url` and `image_url` are ready to use — just add your key.

Note: **searching and viewing cover the whole DAM library**, not only your
folder space — that's deliberate, so StudioAI can draw on photography every
other team has uploaded. Add `pathPrefix=dwp_Digital_Asset/StudioAI` when you
want only StudioAI's own images. Writing (new folders, uploads) is what stays
inside your space.

### Recipe: an image grid

```js
const DAM = "https://dwp-dam-s2r2rmdlzq-eu.a.run.app";
const KEY = process.env.DAM_API_KEY; // or however StudioAI loads config

const res = await fetch(`${DAM}/api/v1/assets?tags=exterior&limit=24`, {
  headers: { "x-api-key": KEY },
});
const { data } = await res.json();

for (const asset of data) {
  // <img> can't send headers, so the key rides along as ?key=
  img.src  = `${asset.thumbnail_url}?size=640&key=${KEY}`; // grid tile
  link.href = `${asset.image_url}?key=${KEY}`;             // full resolution
}
```

Caching: thumbnails may be cached ~30 minutes, full images up to 24 hours —
cache freely on your side too.

### Recipe: source images to feed a generation

Full-resolution bytes come back straight from `/{id}/image`, so a server-side
pipeline can pull a reference image without going near Google Drive:

```js
const asset = (await (await fetch(`${DAM}/api/v1/assets?q=lobby&limit=1`, {
  headers: { "x-api-key": KEY },
})).json()).data[0];

const bytes = Buffer.from(
  await (await fetch(asset.image_url, { headers: { "x-api-key": KEY } })).arrayBuffer()
);
// → hand `bytes` to your model
```

## 5. Uploading & managing images (write)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/folders` | Create a folder (nested locations created as needed) |
| `POST` | `/api/v1/assets` | Upload a new image |
| `POST` | `/api/v1/assets/{id}/update` | Rename / re-tag an image |
| `POST` | `/api/v1/assets/{id}/replace` | Swap the image file (same id + URLs) |
| `POST` | `/api/v1/assets/{id}/delete` | Remove an image |
| `POST` | `/api/v1/presets` | Add preset tags to a group |
| `POST` | `/api/v1/presets/update` | Rename a preset tag or group |
| `POST` | `/api/v1/presets/delete` | Delete a preset tag or group |

Do write calls from StudioAI's **server** (`https://studioai-v2-s2r2rmdlzq-eu.a.run.app`),
not from browser code, so the key stays out of user-visible network requests.
Nothing has to be allow-listed on the DAM side — the API key is the gate, and
CORS is open — so a browser `fetch()` from your pages works too for the read
endpoints.

### Create a folder

Send the folder **name** — that's the only required field. It is created inside
your folder space (`dwp_Digital_Asset/StudioAI`). So when someone in StudioAI
starts a session called *Riverside Tower*, one call gives it a home in the DAM:

```js
await fetch(`${DAM}/api/v1/folders`, {
  method: "POST",
  headers: { "x-api-key": KEY, "content-type": "application/json" },
  body: JSON.stringify({ name: "Riverside Tower" }),
});
// → { "data": { "path": "dwp_Digital_Asset/StudioAI/Riverside Tower",
//               "name": "Riverside Tower",
//               "location": "dwp_Digital_Asset/StudioAI",
//               "created": true, "createdParents": [] } }
```

Add `location` when you want it deeper — it is **relative to your folder
space**, and any missing levels are created for you:

```js
body: JSON.stringify({
  name: "Renders",
  location: "Riverside Tower/2026",   // → dwp_Digital_Asset/StudioAI/Riverside Tower/2026/Renders
});
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | The folder to create. Slashes mean nesting: `"Riverside Tower/Renders"` creates both levels. |
| `location` | no | Where to put it, relative to your folder space. Omit it and the folder lands at the top of your space. A full path works too (`dwp_Digital_Asset/StudioAI/...`) as long as it's inside your space — anything outside returns `403`. |
| `createParents` | no | Missing levels in `location` are created too (default `true`). Pass `false` to make the call fail unless `location` already exists — safer against typos. |

Response fields: `path` (the new folder's full path — store this, it's what
upload and search use), `created` (`false` = it already existed, which is fine:
the call is safe to repeat), and `createdParents` — any parent folders the call
had to create on the way. If `createdParents` is non-empty when you didn't
expect it, you probably have a typo in `location`.

Recipe — one folder per StudioAI session/project:

```js
// Call this ONCE when a session is created and store data.path on the session.
async function ensureSessionFolder(sessionName) {
  const res = await fetch(`${DAM}/api/v1/folders`, {
    method: "POST",
    headers: { "x-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({ name: sessionName }),
  });
  if (!res.ok) throw new Error((await res.json()).error.message);
  const { data } = await res.json();
  return data.path; // save on the session record; use it as folderPath on upload
}
```

Calling it again later for the same name is harmless (`created: false`), but
**don't call it concurrently** — for example from several parallel uploads that
each "ensure" the folder first. Two simultaneous creates of the same name can
both reach Google Drive before either can see the other, leaving two folders
with one name. Create the folder first, store `path`, then upload in parallel.
Also use the returned `path` rather than re-typing the name: Drive matches
folder names case-insensitively, so `path` carries the spelling Drive actually
has (creating `"riverside tower"` next to an existing `"Riverside Tower"`
returns the existing one, `created: false`, with its real name).

### Find a folder

`GET /api/v1/folders` lists folder paths, so you can check what exists instead
of guessing. With no parameters it returns everything inside your folder space:

| Param | Meaning | Example |
|---|---|---|
| `location` | Limit to this folder and its subfolders (relative to your space) | `location=Riverside Tower` |
| `depth` | How many levels below it (`1` = immediate children only) | `depth=1` |
| `q` | Case-insensitive substring match on the path | `q=renders` |
| `limit` | Max paths returned, default 500, max 2000 | `limit=100` |

```js
const { data, meta } = await (await fetch(`${DAM}/api/v1/folders?depth=1`, {
  headers: { "x-api-key": KEY },
})).json();
// data.root  = "dwp_Digital_Asset/StudioAI"
// data.paths = ["dwp_Digital_Asset/StudioAI", "dwp_Digital_Asset/StudioAI/Riverside Tower", ...]
// meta = { count: 2, total: 2, limit: 500 }   ← total > count means more matched than `limit` returned
```

New folders show up here right away; other DAM-side folder changes can take up
to a minute (server cache).

### Upload an image

`multipart/form-data`, **one image per request**:

```js
const form = new FormData();
form.append("file", file);                     // image/* only, max 30 MB
form.append("folderPath", "Riverside Tower");   // relative to your space; must already exist
form.append("tags", "render,ai-generated");     // optional, comma-separated

const res = await fetch(`${DAM}/api/v1/assets`, {
  method: "POST",
  headers: { "x-api-key": KEY }, // do NOT set Content-Type yourself for multipart
  body: form,
});
const { data } = await res.json(); // the new image record, incl. its URLs
```

`folderPath` follows the same rules as `location` above: relative to your folder
space, or the full path (`data.path` from the folder call) — both work. Two
differences from folder creation: it is **always required** (there's no
"default to my space" for uploads), and it never creates the folder for you — a
path that doesn't exist returns `400` naming the missing folder, so a typo
can't scatter images into a stray folder.

By default, the DAM automatically analyzes every uploaded image with Gemini
Vision AI to generate ~14+ rich architectural & interior tags (materials,
lighting, space type, architectural typologies, design style) and populates
`macro_portfolio`, `core_sector`, and `sub_sectors`. Any `tags` you send are
preserved, cleaned of `#`, and merged with the AI tags. If you ever want to
skip AI auto-tagging, pass `autoTag: "false"` in the form.

Several images = several requests (parallel is fine).

If StudioAI uploads model output, tag it as such (e.g. `ai-generated`) so the
rest of the business can tell generated imagery from photography at a glance.

⚠️ **Don't blind-retry a timed-out upload** — it may have succeeded, and
retrying creates a duplicate. Search for the file name first.

### Rename / re-tag

```js
await fetch(`${DAM}/api/v1/assets/${id}/update`, {
  method: "POST",
  headers: { "x-api-key": KEY, "content-type": "application/json" },
  body: JSON.stringify({
    name: "riverside-tower-render-01.jpg",          // optional
    tags: ["render", "ai-generated", "approved"],   // optional — REPLACES the whole list
  }),
});
```

`tags` is a full replacement, not a merge — send the complete final list.

### Replace the image file

```js
const form = new FormData();
form.append("file", newFile); // image/*, max 30 MB
await fetch(`${DAM}/api/v1/assets/${id}/replace`, {
  method: "POST",
  headers: { "x-api-key": KEY },
  body: form,
});
```

The id and URLs stay the same, so pages already embedding this image simply
start showing the new picture — handy for re-running a generation over the same
record. Viewers may see the old one until caches expire (thumbnails ~30 min,
full image up to 24 h).

### Delete an image

```js
await fetch(`${DAM}/api/v1/assets/${id}/delete`, {
  method: "POST",
  headers: { "x-api-key": KEY },
});
// → { "data": { "id": "...", "deleted": true } }
```

The file goes to the DAM's Drive trash (the DAM team can rescue it for ~30
days), but its tags/metadata are **not** restored with it — treat delete as
final and confirm with your users before calling it.

(Testing with curl? Send an empty body — `curl -X POST -d '' ...` — Cloud
Run rejects a completely body-less POST with a 411. Browser `fetch()` is
fine as-is.)

### Tag presets (the DAM's tag menu)

Presets are the suggested-tag chips shown in the DAM's upload page, grouped by
theme (e.g. "Asset Lifecycle" → Draft / Approved / Published). You can read
and edit that menu:

```js
// Read the library — great for building your own tag picker
const { data } = await (await fetch(`${DAM}/api/v1/presets`, {
  headers: { "x-api-key": KEY },
})).json();
// data = [{ group: "Asset Lifecycle", tags: ["Draft", "Approved", ...] }, ...]

// Add tags to a group (the group is created if it doesn't exist;
// duplicates are skipped)
await fetch(`${DAM}/api/v1/presets`, {
  method: "POST",
  headers: { "x-api-key": KEY, "content-type": "application/json" },
  body: JSON.stringify({ group: "StudioAI", tags: ["render", "ai-generated"] }),
});

// Rename a tag…                                   …or a whole group
// { group, tag, newTag }                          { group, newGroup }
await fetch(`${DAM}/api/v1/presets/update`, { method: "POST", headers: {...},
  body: JSON.stringify({ group: "StudioAI", tag: "render", newTag: "final render" }) });

// Delete one tag ({ group, tag }) or a whole group ({ group })
await fetch(`${DAM}/api/v1/presets/delete`, { method: "POST", headers: {...},
  body: JSON.stringify({ group: "StudioAI", tag: "ai-generated" }) });
```

Notes:

- Preset edits change the **menu only** — images already tagged keep their
  tags. (Deleting the "Draft" preset doesn't untag draft images.)
- Every write returns the full updated library, same shape as the GET.
- Changes can take up to ~5 minutes to appear everywhere (server cache).
- The preset library is **shared across the whole DAM**, unlike your folder
  space — the DAM team and other sites edit the same list, so coordinate before
  deleting groups you didn't create.

## 6. Errors

Every error has the same shape:

```json
{ "error": { "code": "bad_request", "message": "limit must be an integer between 1 and 100" } }
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `bad_request` | Bad input — the message says exactly what to fix |
| 401 | `unauthorized` | Missing or unknown API key |
| 403 | `forbidden` | Your key doesn't have that permission, or you aimed a write outside `dwp_Digital_Asset/StudioAI` |
| 404 | `not_found` | No image with that id (or no thumbnail yet) |
| 500 | `server_error` | Problem on the DAM side — retry reads later; **don't** auto-retry uploads |

## 7. Limits, in one place

- Uploads: **one image per request**, `image/*` types only, **max 30 MB**.
- Upload destination folder must already exist (create it via `/folders`) —
  only folder creation auto-creates missing levels, never upload.
- Folder listing: `limit` max 2000 paths per call.
- New folders and uploads must stay inside `dwp_Digital_Asset/StudioAI`
  (anything outside → `403`). Searching and viewing are library-wide.
- `limit` max 100 per search page; use `offset` to page.
- Tag search is AND — `tags=a,b` means images having *both*.
- No webhooks — poll (e.g. `sort=newest` + your own bookmark) if you need to
  detect new images.

Questions or a leaked/lost key → Panachai, panachai.t@dwp.com.
