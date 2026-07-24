# DWP DAM Image API — Integration Guide (dwp_website2026)

How to search, display, upload and manage images in the dwp Digital Asset
Management system (DAM) from your website. Everything is plain HTTPS + JSON —
no SDK needed, only `GET` and `POST`.

| | |
|---|---|
| Base URL | `https://dwp-dam-4w57ydlk6q-eu.a.run.app` |
| Your API key | You receive it separately from Panachai (panachai.t@dwp.com) — it is not in this document |
| Your permissions | `read+write` — search, display, upload, edit, delete |

---

## 1. Store your key

The key is **one plain string** that looks like `dam_live_xxxxxxxx...`.
Put it in your server's environment (a `.env` file or your host's settings):

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
  and only your site's key changes.

## 2. Two-minute test

```bash
curl -H "x-api-key: YOUR_KEY" \
  "https://dwp-dam-4w57ydlk6q-eu.a.run.app/api/v1/assets?limit=2"
```

You should get JSON with a `data` array of image records. If you get `401`,
the key didn't arrive or is wrong; `403` means your key lacks that permission.

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
| `sort` | `newest` (default) or `oldest` | `sort=oldest` |
| `limit` | Page size, default 60, max 100 | `limit=24` |
| `offset` | Skip N results (for paging) | `offset=24` |

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

### Recipe: an image grid

```js
const DAM = "https://dwp-dam-4w57ydlk6q-eu.a.run.app";
const KEY = process.env.DAM_API_KEY; // or however your app loads config

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

## 5. Uploading & managing images (write)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/folders` | Create a folder |
| `POST` | `/api/v1/assets` | Upload a new image |
| `POST` | `/api/v1/assets/{id}/update` | Rename / re-tag an image |
| `POST` | `/api/v1/assets/{id}/replace` | Swap the image file (same id + URLs) |
| `POST` | `/api/v1/assets/{id}/delete` | Remove an image |
| `POST` | `/api/v1/presets` | Add preset tags to a group |
| `POST` | `/api/v1/presets/update` | Rename a preset tag or group |
| `POST` | `/api/v1/presets/delete` | Delete a preset tag or group |

Do write calls from your **server**, not from browser code, so the key stays
out of user-visible network requests where practical.

### Create a folder

The destination folder must exist before you upload into it, so create it
first if needed. Safe to call twice — an existing folder is reused
(`created: false`).

```js
await fetch(`${DAM}/api/v1/folders`, {
  method: "POST",
  headers: { "x-api-key": KEY, "content-type": "application/json" },
  body: JSON.stringify({
    parentPath: "dwp_Digital_Asset/ProjectX", // must already exist; starts with the Shared Drive name
    name: "Interiors",
  }),
});
// → { "data": { "path": "dwp_Digital_Asset/ProjectX/Interiors", "created": true } }
```

### Upload an image

`multipart/form-data`, **one image per request**:

```js
const form = new FormData();
form.append("file", file);                                    // image/* only, max 30 MB
form.append("folderPath", "dwp_Digital_Asset/ProjectX/Interiors"); // must exist
form.append("tags", "interior,bangkok");                      // optional, comma-separated

const res = await fetch(`${DAM}/api/v1/assets`, {
  method: "POST",
  headers: { "x-api-key": KEY }, // do NOT set Content-Type yourself for multipart
  body: form,
});
const { data } = await res.json(); // the new image record, incl. its URLs
```

The DAM's sector fields (`macro_portfolio` etc.) are derived automatically
from your tags. Several images = several requests (parallel is fine).

⚠️ **Don't blind-retry a timed-out upload** — it may have succeeded, and
retrying creates a duplicate. Search for the file name first.

### Rename / re-tag

```js
await fetch(`${DAM}/api/v1/assets/${id}/update`, {
  method: "POST",
  headers: { "x-api-key": KEY, "content-type": "application/json" },
  body: JSON.stringify({
    name: "lobby-01-final.jpg",                    // optional
    tags: ["interior", "bangkok", "renovated"],    // optional — REPLACES the whole list
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
start showing the new picture. Viewers may see the old one until caches
expire (thumbnails ~30 min, full image up to 24 h).

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
  body: JSON.stringify({ group: "Campaign 2026", tags: ["hero shot", "social crop"] }),
});

// Rename a tag…                                   …or a whole group
// { group, tag, newTag }                          { group, newGroup }
await fetch(`${DAM}/api/v1/presets/update`, { method: "POST", headers: {...},
  body: JSON.stringify({ group: "Campaign 2026", tag: "hero shot", newTag: "hero image" }) });

// Delete one tag ({ group, tag }) or a whole group ({ group })
await fetch(`${DAM}/api/v1/presets/delete`, { method: "POST", headers: {...},
  body: JSON.stringify({ group: "Campaign 2026", tag: "social crop" }) });
```

Notes:

- Preset edits change the **menu only** — images already tagged keep their
  tags. (Deleting the "Draft" preset doesn't untag draft images.)
- Every write returns the full updated library, same shape as the GET.
- Changes can take up to ~5 minutes to appear everywhere (server cache).
- The DAM team can edit the same library in the DAM's Settings page, so
  coordinate before deleting groups you didn't create.

## 6. Errors

Every error has the same shape:

```json
{ "error": { "code": "bad_request", "message": "limit must be an integer between 1 and 100" } }
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `bad_request` | Bad input — the message says exactly what to fix |
| 401 | `unauthorized` | Missing or unknown API key |
| 403 | `forbidden` | Your key doesn't have that permission |
| 404 | `not_found` | No image with that id (or no thumbnail yet) |
| 500 | `server_error` | Problem on the DAM side — retry reads later; **don't** auto-retry uploads |

## 7. Limits, in one place

- Uploads: **one image per request**, `image/*` types only, **max 30 MB**.
- Upload destination folder must already exist (create it via `/folders`).
- `limit` max 100 per search page; use `offset` to page.
- Tag search is AND — `tags=a,b` means images having *both*.
- No webhooks — poll (e.g. `sort=newest` + your own bookmark) if you need to
  detect new images.

Questions or a leaked/lost key → Panachai, panachai.t@dwp.com.
