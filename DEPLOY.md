# Deploying dwp-dam to Google Cloud Run

This adds everything needed to build and deploy the app as a container on
Cloud Run:

| File | Purpose |
| --- | --- |
| `Dockerfile` | Multi-stage build → small runtime image from Next's standalone output. |
| `.dockerignore` | Keeps secrets/build output out of the image context. |
| `.gcloudignore` | Controls what Cloud Build uploads as the build context. |
| `cloudbuild.yaml` | Builds & pushes the image to Artifact Registry. |
| `deploy.ps1` | One-shot: enable APIs → ensure repo → build → deploy with env vars. |
| `next.config.js` | `output: "standalone"` was added for a lean container. |
| `public/.gitkeep` | Ensures `public/` exists for the Docker `COPY`. |

## How env vars flow

All env vars are read **at runtime** (none are `NEXT_PUBLIC_*`), so **nothing
sensitive is passed to the build** — values are set on the Cloud Run service at
deploy time:

- `SUPABASE_URL` — public
- `SUPABASE_ANON_KEY` — Supabase's public/anon key (safe to expose; works
  because `common_dam_assets` has RLS disabled)
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` — not sensitive
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` — **a real secret**; keep the literal
  `\n` escapes (the app un-escapes them at runtime)
- `GEMINI_API_KEY` — **optional secret**. When set, each uploaded image is
  auto-classified into the dwp sector taxonomy via Google Gemini vision. Leave
  it blank to disable AI (the manual taxonomy picker still works).
- `GEMINI_MODEL` — optional; defaults to `gemini-3.6-flash`. Set
  `gemini-pro-latest` for higher-accuracy (slower, pricier) classification.
  It must be a model your key can actually see — check with
  `curl "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY"`,
  because Google retires flash/pro versions and an unknown name 404s every
  classification. `lib/gemini.ts` probes how to suppress reasoning on whatever
  model you name (the `thinkingBudget` / `thinkingLevel` dialects differ per
  release), so no code change is needed when switching.

- `DWP_AUTH_URL` — **required**. Origin of the central dwp auth broker, no
  trailing slash. Read server-side only: `app/api/session/route.ts` exchanges the
  Google `id_token` for a session JWT here. Deliberately **not** a
  `NEXT_PUBLIC_` var — see the note below.
- `DWP_AUTH_SECRET` — **a real secret**. The HS256 key shared with the broker;
  `middleware.ts` verifies every session cookie with it. Must match the broker
  exactly. Both scripts refuse a value under 32 characters, because a missing or
  short secret otherwise produces a silent redirect loop rather than an error.
- `APP_ID` — optional; defaults to `dwp-dam` (`lib/authConfig.ts`). This app's
  registered id at the broker; the middleware rejects tokens minted for a
  different app.

- `DAM_EMBED_ORIGINS` — optional; **restricts** which parent origins may frame
  this app. Comma- or space-separated, scheme and host only, no path, e.g.
  `https://www.dwp.com,https://hub.dwp.com`. **Unset means any site may frame
  any page** (`frame-ancestors *`), which is the intended default. A bare `*`
  is the explicit spelling of it. See "Framing and embedding" below.

- `DAM_V2_SUPABASE_URL` — optional; the v2 project library's Supabase URL.
  Public.
- `DAM_V2_SUPABASE_ANON_KEY` — optional; the v2 project's anon (publishable)
  key. Public-ish: it only bootstraps PostgREST, and row-level security plus the
  search RPCs are the guard.
- `DAM_V2_SUPABASE_JWT_SECRET` — optional, **a real secret**. The v2 project's
  legacy HS256 JWT secret (project settings, JWT). The server mints a 5-minute
  token with it for every v2 call, so it can pass RLS as **any** user: treat it
  like the service-account key. Both scripts refuse a value under 32
  characters.
- `DAM_V2_BROWSE` — optional switch: `off` (default) | `optin` | `on`. See
  "Project library (v2) preview" below.

`DAM_V2_SUPABASE_SERVICE_ROLE_KEY` also lives in `.env.local`, but it is
**never** sent to Cloud Run: it bypasses row-level security, and only the
terminal scripts (`scripts/v2-*.mjs`) use it. Neither deploy script reads it.

> **Why there is no `NEXT_PUBLIC_DWP_AUTH_URL`.** Next inlines `NEXT_PUBLIC_*`
> at **build** time, and the Docker builder stage receives no env vars
> (`cloudbuild.yaml` runs `docker build` with no `--build-arg`). Such a var would
> be `undefined` in the browser on Cloud Run while working perfectly under
> `npm run dev` — a failure invisible to a typecheck, a lint and a local run.
> The broker exchange is therefore done server-side. Keep the "all env vars are
> read at runtime" invariant above intact.

`deploy.ps1` reads these from `.env.local` (prompting for any that are missing)
and passes them via a temporary `--env-vars-file`, which handles the multi-line
private key safely.

> **Both scripts must list every var.** `deploy.ps1` and `set-env.ps1` each use
> `--env-vars-file`, which **replaces the service's entire env-var set**. A var
> added to only one of them gets wiped from production the next time the other
> runs. Add new vars to both, in the same commit.

### Framing and embedding

**The whole app is embeddable.** Any site may put any page of it in an
`<iframe>`; a signed-in viewer sees the real app inside that frame.
`middleware.ts` sets `Content-Security-Policy: frame-ancestors` from
`lib/framing.ts` on every response, and sets **no** `X-Frame-Options` — that
header has no working allowlist form, so it would veto the CSP in browsers that
read it first. Set `DAM_EMBED_ORIGINS` to narrow framing to named origins.

This was chosen knowingly (2026-09-17). The trade-off, stated plainly: a parent
page cannot read across origins into a frame it does not own, so framing leaks
nothing by itself — but `/browse` carries Delete, Auto-tag and permission
controls, and an open rule leaves room for clickjacking, where a hostile page
overlays its own button on one of ours. `DAM_EMBED_ORIGINS` closes that with no
code change.

Sign-in sets **three** cookies with the same token, because which one a browser
will keep depends on the browser and on where the sign-in happened:

| Cookie | Attributes | Kept when |
|---|---|---|
| `dwp_session` | `SameSite=Lax` | ordinary top-level use |
| `dwp_embed` | `SameSite=None; Secure` | a frame whose browser allows third-party cookies, or has granted Storage Access |
| `dwp_frame` | `SameSite=None; Secure; Partitioned` | written from inside a frame, on Chrome with third-party cookies off or Firefox |

All three are cleared on logout with matching attributes — a mismatch in name,
path, `SameSite` or `Secure` leaves the old cookie in place and logout silently
does nothing.

**Signing in from inside the frame** is a popup, not a redirect
(`components/framedSignIn.ts`). Google Sign-In cannot render in a nested
cross-site frame, but a popup is a top-level window on this origin where it
works normally. `/login?popup=1` signs in, posts the Google credential back to
its opener and closes; the frame probes `/api/session` and, only if the session
did not reach it, re-exchanges that credential itself so the `Set-Cookie` lands
in the frame's own jar. Safari refuses third-party cookie writes outright, so
there it ends on a second button that calls `requestStorageAccess()`.
`crossSiteCookieAllowed()` in `lib/framing.ts` is the entire security model for
that cookie, and it is three rules:

1. **A write** (anything but GET/HEAD) is accepted only when the `Origin` header
   equals this host. Browsers always send `Origin` on a non-GET request and
   cannot be made to forge it, so a POST from another site is refused. This is
   the standard CSRF defence for a `SameSite=None` cookie and it replaces what
   Lax was doing. The comparison is host-to-host — a prefix check would let
   `localhost:3000.evil.com` through.
2. **A document or iframe load** always passes. That is the framed page itself.
3. **Any other read** (fetch, `<img>`, `<script>`) must carry
   `Sec-Fetch-Site: same-origin`, so the cookie cannot hotlink DAM images or
   JSON onto someone else's page. Inside our own frame these are same-origin.

`/login` and `/api/session` are now **inside** the matcher so they carry the
same framing header as everything else. They are still ungated — both are in
`PUBLIC_PATHS`, which returns before any session work. `next.config.js` has no
`headers()` block: a static rule there would silently beat middleware for
whatever path it matched.

`app/login/LoginForm.tsx` detects that it is framed (`window.self !==
window.top`) and does not even load the Google script, because Google Sign-In
cannot run in a nested cross-site frame. It offers a Storage Access retry and a
new-tab sign-in instead. `/embed` keeps its own signed-out card rather than
redirecting; `docs/DAM-EMBED-GUIDE.md` is the consumer-facing guide.

### Signing in

Access is granted per person in the broker console, per app. A user with no
grant for `dwp-dam` reaches `/login`, signs in with Google, and is told the
broker rejected them — the app itself has no user list. The session cookie is
httpOnly and expires with the token (~12h); there is no refresh, so a user is
bounced to `/login` at expiry and loses any in-flight upload.

Note the avatar cache (`dwp_pic_<email>` in `localStorage`,
`lib/profileCache.ts`) deliberately **survives logout** so One Tap sign-ins reuse
the picture across sessions. It is capped at 5 entries, but on a shared machine
it does retain prior users' names and photo URLs.

### Project library (v2) preview

`/browse` can show the v2 project library, read-only, beside the current one.
It is invisible unless `DAM_V2_SUPABASE_URL`, `DAM_V2_SUPABASE_ANON_KEY` and
`DAM_V2_SUPABASE_JWT_SECRET` are all set; `DAM_V2_BROWSE` then picks the
default (`optin`: current library, `?source=v2` switches; `on`: the reverse).
`GET /api/v2/status` reports the mode; `/api/v2/assets` and
`/api/v2/compat/assets` answer 404 while it is `off`.

- **Identity.** Each person gets a `dam_users` row from the RPC
  `dam_provision_user`, called with the web tier's own system principal
  (`00000000-0000-0000-0000-000000000005`, seeded by the migrations) — never
  the service-role key. It runs best-effort at sign-in (capped at 1.5 s, never
  blocks it) and again on the first `/api/v2` call. Addresses in
  `users.auto_activate_domains` (`dwp.com`) start active; anyone else gets
  `403 account_inactive` until a Global Admin activates them.
- **Never a 401.** `/api/v2` refuses with 403, 404, 422, 502 or 503, because a
  401 would send the browser round the sign-in loop (`SessionExpiryGuard`).
  `502 v2_auth_failed` almost always means `DAM_V2_SUPABASE_JWT_SECRET` does
  not match the project (or its legacy secret has been revoked in favour of
  signing keys); `503 v2_not_ready` means the migrations are not applied yet.
- **Migrations are yours to apply.** The SQL is in `supabase/migrations/`
  (`supabase db push`). Afterwards, from the repo root:
  `node scripts/v2-backfill-search.mjs` (a dry run: counts only), then the same
  with `--write` to fill the search table, then
  `node scripts/v2-verify.mjs --email <you>@dwp.com` for a read-only check.
  Only then set `DAM_V2_BROWSE` and run `set-env.ps1`.

## Prerequisites

1. Install the **gcloud CLI** and sign in:
   ```powershell
   gcloud auth login
   ```
2. Have Editor/Owner on the target project (default `dwp2026`).
   Owner (or Project IAM Admin) is needed the *first* time so the script can
   grant the Cloud Build service account its roles; see the note below.
3. Fill in real values in `.env.local`.

## Deploy

From the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

To change the target, edit the config block at the top of `deploy.ps1`
(`$projectId`, `$serviceName`, `$region`, `$repo`). If your project doesn't have
an `asia-southeast3` region, switch `$region` to one it supports (e.g.
`asia-southeast1`) — verify with `gcloud run regions list`.

On success it prints the service URL.

## One-time Supabase step: the folder-tree sync table

The folder tree (browse sidebar, upload picker search, `GET /api/v1/folders`)
is kept current with the Google Drive **Changes API**, because Drive's
whole-drive folder listing is eventually consistent on a scale of hours — new
folders used to be missing from the tree for a long time after they were
created. The app replays the change feed from a token it stores per Shared
Drive in Supabase, so a new Cloud Run instance (or one restarted after scaling
to zero) still knows about folders created in the hours before it started.

Run the `common_dam_drive_sync` block at the end of `supabase/schema.sql` once
in the Supabase **SQL editor** (it is `create table if not exists`, so
re-running the whole file is fine). Use the SQL editor, not the Table Editor:
the app writes with the anon key like the other tables, so row-level security
must stay off (the block includes the `disable row level security` line).
Until the table exists the app still works — new folders appear immediately on
the instance that created them — but it logs `[folder-index] The
common_dam_drive_sync table is missing` on startup and loses that cross-restart
guarantee.

## ⚠️ Security: the service is deployed PUBLIC

`deploy.ps1` uses `--allow-unauthenticated`, matching the reference script. The
app has **no built-in auth**, and because `common_dam_assets` has RLS disabled the anon
key has full read/write to it, so anyone who reaches the URL can upload to your
Drive and read/write your Supabase table. Before real use, either:

- set `$allowUnauthenticated = $false` in `deploy.ps1` and front it with IAM /
  IAP / your dwp.com SSO, **and/or**
- add an auth check inside the API routes (see the "No auth" note in
  `README.md`).

## Known constraint: first deploy on a locked-down project

On GCP projects/orgs created on/after 2024-05-03, the Cloud Build service
account (the Compute Engine default SA,
`PROJECT_NUMBER-compute@developer.gserviceaccount.com`) starts with **no roles**,
so the first `gcloud builds submit` can fail at image push or log write.
`deploy.ps1` best-effort grants it `roles/artifactregistry.writer`,
`roles/logging.logWriter`, and `roles/storage.objectViewer` — but that grant
itself needs you to be **Owner / Project IAM Admin** (a plain Editor can't set
IAM policy). If the grant is skipped with a warning and the build then fails on
permissions, ask a project admin to grant those three roles to that SA once.

## Known constraint: upload size

Cloud Run caps a single HTTP/1 request body at **32 MiB**. The client handles
this automatically by splitting uploads into sequential batches of ≤ ~24 MB
(max 8 files each), so batches and whole-folder drops of any total size work.
The remaining hard limit is **~30 MB per individual file** — larger files are
rejected client-side with a clear error. To lift that, serve the container over
HTTP/2 (`--use-http2`) or upload bytes directly to Drive from the client.

Note `serverActions.bodySizeLimit` in `next.config.js` does **not** apply here —
it governs Server Actions (this app has none), not Route Handlers.

## Recommended hardening: Secret Manager

With the anon key, the only truly sensitive value is
`GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`. Instead of a plain env var, store it in
Secret Manager and reference it:

```powershell
gcloud secrets create dam-gsa-key --data-file=-   # paste the private key, Ctrl+Z, Enter
gcloud run deploy dwp-dam --region asia-southeast3 `
  --set-secrets "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=dam-gsa-key:latest"
```

Grant the Cloud Run runtime service account the
`roles/secretmanager.secretAccessor` role on the secret.

## Redeploying

After the first deploy, Cloud Build restores a `:deps-cache` image, so an
unchanged `package-lock.json` reuses the `npm ci` layer instead of reinstalling
dependencies. The first cached deploy still builds normally; later source-only
changes should be materially faster.

Normal deploys also skip repeated IAM policy writes. If Cloud Build permissions
need to be repaired after a project/IAM change, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -EnsureBuildPermissions
```

Just re-run `deploy.ps1` — it rebuilds `:latest` and rolls out a new revision.
```
