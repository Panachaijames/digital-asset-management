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
- `GEMINI_MODEL` — optional; defaults to `gemini-3.5-flash`. Set
  `gemini-3.5-pro` for higher-accuracy classification.

`deploy.ps1` reads these from `.env.local` (prompting for any that are missing)
and passes them via a temporary `--env-vars-file`, which handles the multi-line
private key safely.

## Prerequisites

1. Install the **gcloud CLI** and sign in:
   ```powershell
   gcloud auth login
   ```
2. Have Editor/Owner on the target project (default `dwpaivibecode`).
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

Just re-run `deploy.ps1` — it rebuilds `:latest` and rolls out a new revision.
```
