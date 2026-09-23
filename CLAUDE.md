# CLAUDE.md — dwp-dam

## Working agreements (IMPORTANT — read first)

- **NEVER deploy without explicit permission from the user.** Do not run
  `deploy.ps1`, `set-env.ps1`, `gcloud builds submit`, `gcloud run deploy`,
  or anything else that changes the Cloud Run service, its image, or its env
  vars — unless the user explicitly asked for that specific deployment in
  their current message. Build, typecheck, and verify locally, then STOP and
  tell the user it's ready. One approval covers ONE deploy; it never carries
  forward to the next change.

## Project notes

- **UI follows the dwp.intelligence UI Standard** — the operative spec is
  checked in at `docs/dwp_Intelligence_UI_Consistency_Review.md`: §5 carries
  the corrected token/shell/component code, §6 the 13 gaps still unruled.
  It supersedes `docs/dwp_Studio_UI_System.md`, which is kept because the
  standard's hex values were read off it.
  **Eight tokens, nothing else** (`app/globals.css`, as RGB triplets so
  `bg-accent/5` works): bg `#F7F7F5`, surface `#FFFFFF`, text `#2C2C2A`,
  muted `#5F5E5A`, accent `#A5680F`, border `#D9D7CE`, on-accent `#FFFFFF`,
  danger `#7E2B25`. Dark swaps colour only. There is no green, no blue and no
  second red — a signal is the accent, or danger.
  `tailwind.config.ts` **replaces** (not extends) `fontSize`, `fontWeight`,
  `borderRadius`, `boxShadow` and `borderWidth`, which is what enforces the
  standard globally: five sizes (12/14/16/20/24), weights 400/500 only
  (`font-bold` resolves to 500), every radius 6px, every shadow `none` except
  `shadow-menu` for a floating overlay. Never re-add a scale key with an
  off-standard value, and never write `text-[Npx]` or a raw Tailwind palette
  colour (`slate-*`, `indigo-*`, `emerald-*`…) or a hex.
  Shell geometry: sidebar `w-sidebar` 240px on `surface` with one hairline
  (no dark chrome), top bar `h-topbar` 56px, tabs `h-tab` 40px. Wordmark, then
  the app name at 16px/500. Feedback (labelled, `message-square`) and the user
  photo with a status dot sit at the far right of the top bar — identity is
  not duplicated in the sidebar footer.
  The app is named **"Digital Assets"** in one place and one way, and page
  titles match their sidebar label exactly: Assets | Upload | Import |
  Taxonomy. A page header is title + one-line description + at most one
  primary action, with **no** uppercase eyebrow (the Studio system had one;
  this standard does not).
  Appearance is Light | Dark | System: Light is `:root`, Dark is `.dark`, and
  **System is `.claude`, the warm cream/coral palette** — a deliberate LOCAL
  EXCEPTION to the standard, kept by user decision (2026-08-07, reaffirmed
  2026-09-07). The standard would have System follow the OS (gap 6), but that
  reads as a dead control on a light-set machine because it just mirrors
  Light. All three modes define the same eight `--dwp-*` tokens, so a mode is
  a re-colouring and nothing more — never give a component a mode-specific
  class. `applyMode()` in `components/ThemeToggle.tsx` and the no-flash script
  in `app/layout.tsx` must stay in step: both stamp the same two classes.
  Copy: Title Case labels, verb-first sentence-case buttons, no ampersands,
  no arrows, British spellings, no exclamation marks, no marketing tone.

- **The local dev server (`npm run dev`) uses the PRODUCTION Supabase and
  Google Drive** (same `.env.local` credentials as the deployed service).
  Deleting assets/folders from a local dev session deletes real data — and
  logs nothing to Cloud Logging. Treat local testing of destructive features
  as production actions.

- Next.js 15 (App Router) DAM. Image files live in Google Drive Shared Drives
  (service-account auth, `lib/googleDrive.ts`); metadata lives in Supabase
  (`common_dam_assets`, `common_dam_presets` — RLS disabled on both).
- **Sign-in is SSO via the central dwp auth broker.** `middleware.ts` verifies
  the broker's HS256 JWT (cookie `dwp_session`) on every page and every internal
  `/api/*` route; unauthenticated pages redirect to `/login`, unauthenticated
  internal APIs get a **401 JSON, never a 307** (a redirect would make `fetch()`
  return HTML and re-POST in-flight upload bodies). The Google `id_token` is
  exchanged for that JWT **server-side** in `app/api/session/route.ts` — the
  browser never talks to the broker, because `NEXT_PUBLIC_*` cannot reach the
  client in this repo (the Docker builder stage gets no env vars). Three vars:
  `DWP_AUTH_URL`, `DWP_AUTH_SECRET`, optional `APP_ID`.
  The matcher deliberately **excludes `/api/v1`, `/api/slides/image`,
  `_next/static`, `_next/image`, `favicon.ico` and `icon.svg`** — gating any of
  them breaks the external API consumers, Slides export, or the self-hosted
  Inter font. `x-dwp-email` / `x-dwp-role` are forwarded to handlers, but they
  are spoofable on any path the matcher does not cover, so **no handler on an
  excluded path may trust them**. `role` is forwarded and deliberately NOT
  enforced — every current broker grant is `viewer`, so gating on it would lock
  everyone out.
- **The whole app is embeddable.** Any site may frame any page (user decision,
  2026-09-17, after the read-only-gallery-only option was built and rejected).
  `middleware.ts` sets `frame-ancestors` from `lib/framing.ts` on EVERY response
  and sets no `X-Frame-Options` at all — XFO has no working allowlist form, so
  it would veto the CSP in browsers that read it first. **`DAM_EMBED_ORIGINS`
  NARROWS** framing to a list; unset or `*` means any site. Do not "fix" the
  unset case to same-origin, and do not re-add `frame-ancestors 'none'` — both
  readings were considered and rejected. Before this NOTHING set a framing
  header, so the app was framable anyway, just undeclared.
  The accepted cost is **clickjacking**: `/browse` carries Delete, Auto-tag and
  permission controls, and a hostile page can overlay its own button on one of
  ours. The user was shown this and chose zero-config over an origin allowlist.
  **You can sign in from inside the frame**, via a POPUP
  (`components/framedSignIn.ts`): Google Sign-In cannot render in a nested
  cross-site frame, but a popup is a TOP-LEVEL window on our origin where it
  works normally. `/login?popup=1` signs in, `postMessage`s the Google
  credential back to its opener (addressed to our own origin, so a hostile host
  page can neither read nor forge it) and closes; the frame then probes
  `/api/session` and, only if the session did not reach it, re-exchanges that
  credential ITSELF so the `Set-Cookie` lands in the FRAME's jar. Never
  "simplify" that into letting the popup do the exchange alone — a cookie
  written in the popup is first-party, and a browser with third-party cookies
  off will not hand it to the frame.
  Sign-in therefore sets THREE cookies, same token: `dwp_session`
  (`SameSite=Lax`, top level), `dwp_embed` (`None; Secure`, frames where 3P
  cookies are allowed or Storage Access was granted) and `dwp_frame`
  (`None; Secure; Partitioned`, the only one Chrome-with-3PC-off and Firefox
  keep when it is written from inside a frame). All three are cleared on
  logout with matching attributes, or the browser keeps the old one.
  Safari refuses every third-party cookie write, so there the frame's exchange
  cannot stick and the flow ends in `needs-continue` — a second button running
  `requestStorageAccess()`, which needs its own user gesture and so cannot be
  chained onto the popup. `crossSiteCookieAllowed()`
  in `lib/framing.ts` is the whole security model for it, in three rules: a
  write (non-GET/HEAD) needs `Origin` to equal this host (the standard CSRF
  defence replacing Lax — compare HOSTS, never prefixes, or
  `localhost:3000.evil.com` passes); a document/iframe load always passes; any
  other read needs `Sec-Fetch-Site: same-origin`, so the cookie cannot hotlink
  DAM images or JSON onto another site.
  `/login` and `/api/session` are now INSIDE the matcher so they carry the same
  framing header — they are still ungated, by `PUBLIC_PATHS`, which is exactly
  what that list was written for. `next.config.js` has no `headers()` block: a
  static rule there would silently beat middleware for whatever it matched.
  `LoginForm` detects framing (`window.self !== window.top`) and swaps the
  Google button — which cannot run in a nested cross-site frame — for a Storage
  Access retry plus a new-tab sign-in.
  `/embed` remains as a chrome-free read-only gallery (`app/embed/page.tsx`,
  `components/EmbedGallery.tsx`, `docs/DAM-EMBED-GUIDE.md`): query-string
  driven, no AppShell, and it must never mount `SessionExpiryGuard`, whose 401
  redirect would navigate the host page's frame. It is the one page that renders
  its own signed-out card instead of redirecting.
  `/api/assets` now takes `offset` (it always ordered by `created_at` then
  `id`, so paging is safe); `/browse` still does not page.
- Internal routes (`/api/*`) serve the app UI and now sit behind that session
  gate; the external `/api/v1/*` API remains API-key-only.
  External API (`/api/v1/*`) requires per-site keys from `DAM_API_KEYS`
  (format `name:key:scopes`, scopes joined with `+`); consumer docs live in
  `docs/API-PLAN.md` and the per-site guides in `docs/`.
- Env vars reach Cloud Run ONLY via the hardcoded pass-through lists in
  `deploy.ps1` AND `set-env.ps1` — adding a var to `.env.local` alone never
  reaches production; add it to both scripts.
- GCP: project `dwp2026`, service `dwp-dam`, region `asia-southeast3`.
  Live URL (verified 2026-08-04): https://dwp-dam-s2r2rmdlzq-eu.a.run.app —
  now in `DAM_PUBLIC_BASE_URL` and the `docs/DAM-API-GUIDE-*.md` base URLs.
  The old `dwpaivibecode` URL (https://dwp-dam-4w57ydlk6q-eu.a.run.app) is
  dead (404). The URL is project-specific, so after any project move re-read it
  from `gcloud run services describe dwp-dam --region asia-southeast3
  --format "value(status.url)"` and update `.env.local` + the guides again.
  Read-only `gcloud` commands are fine; mutations fall under the deploy rule
  above.
- The `dwp_Digital_Asset/ApiTest` Drive folder is for safe write-endpoint
  testing (clean up test rows via the delete endpoints afterward).
- **Drive's whole-drive folder listing (`files.list` with a `q` filter over a
  Shared Drive) is eventually consistent on a scale of HOURS** — measured
  2026-09-04: folders created 40+ min earlier were still absent, and a probe
  folder never appeared in 6 min of polling. Consistent within seconds:
  `files.get`, `'<parent>' in parents` listings, name+parent queries, and
  `changes.list`. So the folder tree comes from `lib/folderIndex.ts`: one
  bootstrap listing per process, then the Drive Changes API, with the change
  token persisted per drive in Supabase table `common_dam_drive_sync` (see
  `supabase/schema.sql`, DEPLOY.md) so a cold-started instance replays what
  the listing hasn't indexed yet. Folder lookups in `lib/googleDrive.ts` are
  index-first (case-insensitive, like Drive's name query — always use the
  returned real name/path, never the caller's spelling), with Drive's query as
  fallback. Never reintroduce a plain `files.list` folder walk for anything
  that must reflect recent changes. The client keeps a short-lived overlay of
  its own creates/deletes in `lib/clientFolderChanges.ts`.
- **Slides export** (`/browse` → Select → Slides, `POST /api/slides/export`)
  needs `slides.googleapis.com` enabled on `dwp2026` — `deploy.ps1` now enables
  it alongside run/cloudbuild/artifactregistry. It also needs
  `DAM_PUBLIC_BASE_URL` to be internet-reachable, because Google's Slides
  servers fetch each image from `/api/slides/image` themselves; that endpoint is
  HMAC-signed (secret defaults to the service-account key, normalised so a dev
  server and Cloud Run derive the same one). Decks land in
  `DAM_SLIDES_EXPORT_PATH` or `<SharedDrive>/Slide Exports`, created on demand.
- **v2 (project-based library)** is a SEPARATE Supabase project: schema in
  `SCHEMA.sql` (applied baseline, never edited) plus `supabase/migrations/`,
  which the USER applies with `supabase db push` — never push, reset or repair
  from a session, and never touch that database from a test (use
  `tools/pgtest`, PGlite). The app side is read-only: `lib/v2/*` and
  `app/api/v2/*` (`status`, `assets`, `compat/assets`, the last in
  `/api/assets`'s shape for `/browse`). It is invisible unless
  `DAM_V2_SUPABASE_URL`, `DAM_V2_SUPABASE_ANON_KEY` and
  `DAM_V2_SUPABASE_JWT_SECRET` are all set; `DAM_V2_BROWSE` is
  `off` | `optin` | `on`. Every env read is lazy (no module-scope client), and
  nothing in `lib/v2` may be imported by `middleware.ts` or `lib/auth.ts`.
  The server mints a 5-minute HS256 token per principal (claims carry BOTH
  `principal` and `principal_type`); roles and studios are read from tables,
  not claims. Users are provisioned by the RPC `dam_provision_user` under the
  web system principal `00000000-0000-0000-0000-000000000005` — the web tier
  never holds `DAM_V2_SUPABASE_SERVICE_ROLE_KEY` (scripts only; not in the
  deploy lists). **`/api/v2` never answers 401** — only middleware may, for a
  missing dwp session; anything else would loop through `SessionExpiryGuard`.
  Visibility is decided by `dam_search_assets` from the caller's token; the
  compat route returns the v2 id as `id`, so no v1 write route can act on it.
