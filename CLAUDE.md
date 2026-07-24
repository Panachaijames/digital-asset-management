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

- **The local dev server (`npm run dev`) uses the PRODUCTION Supabase and
  Google Drive** (same `.env.local` credentials as the deployed service).
  Deleting assets/folders from a local dev session deletes real data — and
  logs nothing to Cloud Logging. Treat local testing of destructive features
  as production actions.

- Next.js 15 (App Router) DAM. Image files live in Google Drive Shared Drives
  (service-account auth, `lib/googleDrive.ts`); metadata lives in Supabase
  (`common_dam_assets`, `common_dam_presets` — RLS disabled on both).
- Internal routes (`/api/*`) are unauthenticated and serve the app UI.
  External API (`/api/v1/*`) requires per-site keys from `DAM_API_KEYS`
  (format `name:key:scopes`, scopes joined with `+`); consumer docs live in
  `docs/API-PLAN.md` and the per-site guides in `docs/`.
- Env vars reach Cloud Run ONLY via the hardcoded pass-through lists in
  `deploy.ps1` AND `set-env.ps1` — adding a var to `.env.local` alone never
  reaches production; add it to both scripts.
- GCP: project `dwpaivibecode`, service `dwp-dam`, region `asia-southeast3`,
  URL https://dwp-dam-4w57ydlk6q-eu.a.run.app. Read-only `gcloud` commands
  are fine; mutations fall under the deploy rule above.
- The `dwp_Digital_Asset/ApiTest` Drive folder is for safe write-endpoint
  testing (clean up test rows via the delete endpoints afterward).
