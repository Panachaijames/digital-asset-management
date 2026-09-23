# =============================================================================
# Deploy dwp-dam (Next.js 15) to Google Cloud Run.
#
# What it does:
#   1. Sets the target project and enables the required APIs.
#   2. Ensures the Artifact Registry repo exists.
#   3. Builds & pushes the image via Cloud Build (cloudbuild.yaml + Dockerfile).
#   4. Deploys to Cloud Run, injecting the 4 runtime secrets at deploy time.
#
# Prereqs:
#   - gcloud CLI installed and authenticated:  gcloud auth login
#   - You have Editor/Owner (or equivalent) on the target GCP project.
#   - .env.local is filled in (real values), OR you answer the prompts.
#
# Run from anywhere:
#   powershell -ExecutionPolicy Bypass -File .\deploy.ps1
# =============================================================================

param(
    [switch]$EnsureBuildPermissions
)

$ErrorActionPreference = "Stop"

# Run from the repo root so Cloud Build uploads this directory as the context.
Set-Location $PSScriptRoot

# -----------------------------------------------------------------------------
# 1. Configuration  --  edit these to match your project.
# -----------------------------------------------------------------------------
$projectId = "dwp2026"        # <-- GCP project ID
$serviceName = "dwp-dam"              # Cloud Run service name
$region = "asia-southeast3"      # Cloud Run + Artifact Registry region
$repo = "dwp-dam"             # Artifact Registry repository name
$allowUnauthenticated = $true         # PUBLIC access. See SECURITY note below.

$image = "$region-docker.pkg.dev/$projectId/$repo/$serviceName" + ":latest"
# This image contains only Dockerfile's `deps` stage. It lets fresh Cloud Build
# workers reuse `npm ci` whenever package-lock.json has not changed.
$depsCacheImage = "$region-docker.pkg.dev/$projectId/$repo/$serviceName" + ":deps-cache"

Write-Host "==> Deploy '$serviceName' -> project '$projectId' ($region)" -ForegroundColor Cyan
if ($allowUnauthenticated) {
    Write-Host "==> SECURITY: service will be PUBLIC (--allow-unauthenticated)." -ForegroundColor Yellow
    Write-Host "    This app has no built-in auth and writes to your Google Drive" -ForegroundColor Yellow
    Write-Host "    and Supabase. Put it behind IAM / SSO before real use." -ForegroundColor Yellow
}

# -----------------------------------------------------------------------------
# 2. Helpers
# -----------------------------------------------------------------------------
function Get-EnvValue {
    param([string[]]$Content, [string]$Key)
    foreach ($line in $Content) {
        if ($line -match "^\s*$([regex]::Escape($Key))\s*=\s*(.*)$") {
            $val = $matches[1].Trim()
            # A value pasted straight out of the downloaded JSON key file often
            # carries JSON's trailing comma ("-----END PRIVATE KEY-----\n",).
            # Drop it BEFORE the quote check below — otherwise the value starts
            # with a quote but ends with a comma, the pair-strip doesn't fire,
            # and the quotes stay embedded in the key. OpenSSL then rejects the
            # PEM at runtime ("DECODER routines::unsupported") on a deploy that
            # otherwise looked completely successful.
            if ($val.EndsWith(',')) { $val = $val.Substring(0, $val.Length - 1).TrimEnd() }
            # Strip a single pair of surrounding quotes if present.
            if ($val.Length -ge 2 -and (
                    ($val.StartsWith('"') -and $val.EndsWith('"')) -or
                    ($val.StartsWith("'") -and $val.EndsWith("'")))) {
                $val = $val.Substring(1, $val.Length - 2)
            }
            return $val
        }
    }
    return ""
}

function Read-Required {
    param([string]$Prompt, [string]$Current)
    if (-not [string]::IsNullOrWhiteSpace($Current)) { return $Current }
    $v = Read-Host -Prompt $Prompt
    if ([string]::IsNullOrWhiteSpace($v)) {
        Write-Error "$Prompt is required."
        exit 1
    }
    return $v
}

function ConvertTo-YamlValue {
    param([string]$Value)
    # Single-quoted YAML scalar: backslashes (the private key's \n), JWT dots
    # and URL chars are all literal. A literal single quote is doubled.
    return "'" + ($Value -replace "'", "''") + "'"
}

# -----------------------------------------------------------------------------
# 3. Load runtime env vars from .env.local (prompt for anything missing).
# -----------------------------------------------------------------------------
$envFile = Join-Path $PSScriptRoot ".env.local"
$content = @()
if (Test-Path $envFile) {
    $content = Get-Content $envFile
    Write-Host "==> Loaded env vars from $envFile" -ForegroundColor DarkGray
}
else {
    Write-Host "==> $envFile not found; will prompt for required values." -ForegroundColor Yellow
}

$supabaseUrl = Get-EnvValue -Content $content -Key "SUPABASE_URL"
$supabaseKey = Get-EnvValue -Content $content -Key "SUPABASE_ANON_KEY"
$gsaEmail = Get-EnvValue -Content $content -Key "GOOGLE_SERVICE_ACCOUNT_EMAIL"
$gsaPrivateKey = Get-EnvValue -Content $content -Key "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"

$supabaseUrl = Read-Required -Prompt "Enter SUPABASE_URL"                    -Current $supabaseUrl
$supabaseKey = Read-Required -Prompt "Enter SUPABASE_ANON_KEY"              -Current $supabaseKey
$gsaEmail = Read-Required -Prompt "Enter GOOGLE_SERVICE_ACCOUNT_EMAIL"    -Current $gsaEmail
$gsaPrivateKey = Read-Required -Prompt "Enter GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY" -Current $gsaPrivateKey

# Fail fast on a malformed private key. Every Drive call needs it, but nothing
# validates it until the first request hits the deployed service — so without
# this check a stray quote or comma ships a service where the folder tree is
# silently empty and uploads fail.
$pemCheck = $gsaPrivateKey.Replace('\n', "`n").Trim()
if (-not ($pemCheck.StartsWith("-----BEGIN") -and $pemCheck.EndsWith("PRIVATE KEY-----"))) {
    Write-Error ("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is malformed. It must start with " +
        "'-----BEGIN PRIVATE KEY-----' and end with '-----END PRIVATE KEY-----'. " +
        "Check .env.local for stray quotes or a trailing comma copied from the JSON key file.")
    exit 1
}
if ($gsaEmail -notmatch '^[^@]+@[^@]+\.iam\.gserviceaccount\.com$') {
    Write-Error "GOOGLE_SERVICE_ACCOUNT_EMAIL doesn't look like a service account address: '$gsaEmail'"
    exit 1
}

# Optional — AI classification. If GEMINI_API_KEY is blank, AI is simply off
# and the app falls back to the manual taxonomy picker.
$geminiKey = Get-EnvValue -Content $content -Key "GEMINI_API_KEY"
$geminiModel = Get-EnvValue -Content $content -Key "GEMINI_MODEL"

# Optional — external image API for consumer sites (docs/API-PLAN.md).
# If DAM_API_KEYS is blank, the /api/v1 endpoints reject every request.
$damApiKeys = Get-EnvValue -Content $content -Key "DAM_API_KEYS"
$damPublicBaseUrl = Get-EnvValue -Content $content -Key "DAM_PUBLIC_BASE_URL"
# Optional per-site folder roots (site:path,...) — fences a consumer key to one
# folder and lets it send short, relative folder locations.
$damSiteRoots = Get-EnvValue -Content $content -Key "DAM_SITE_ROOTS"

# Optional — Google Slides export (POST /api/slides/export, "Slides" in the
# browse toolbar). All three have working defaults:
#   DAM_SLIDES_EXPORT_PATH  where decks are saved; default
#                           "<SharedDrive>/Slide Exports"
#   DAM_SLIDES_SHARE_WITH   emails granted writer on each new deck; by default
#                           nobody, since Shared Drive members can already open
#   DAM_SIGNING_SECRET      HMAC key for the short-lived image URLs Google
#                           fetches; defaults to the service-account key
$damSlidesExportPath = Get-EnvValue -Content $content -Key "DAM_SLIDES_EXPORT_PATH"
$damSlidesShareWith = Get-EnvValue -Content $content -Key "DAM_SLIDES_SHARE_WITH"
$damSigningSecret = Get-EnvValue -Content $content -Key "DAM_SIGNING_SECRET"

# Optional — RESTRICTS which parent origins may frame /embed, comma-separated
# (e.g. "https://www.dwp.com,https://hub.dwp.com"). Unset means any site may
# frame it, which is the intended default: /embed is still behind SSO and
# read-only. See docs/DAM-EMBED-GUIDE.md.
$damEmbedOrigins = Get-EnvValue -Content $content -Key "DAM_EMBED_ORIGINS"

# Optional — read-only preview of the v2 project library (/api/v2/*, the
# "Project library" toggle on /browse). v2 stays invisible unless the URL, the
# anon key AND the JWT secret are all set (lib/v2/config.ts). DAM_V2_BROWSE is
# off (default) | optin | on. DAM_V2_SUPABASE_SERVICE_ROLE_KEY is deliberately
# NOT sent: it bypasses row-level security and only the scripts in scripts/
# use it — the web tier provisions users with its own system token instead.
$damV2SupabaseUrl = Get-EnvValue -Content $content -Key "DAM_V2_SUPABASE_URL"
$damV2SupabaseAnonKey = Get-EnvValue -Content $content -Key "DAM_V2_SUPABASE_ANON_KEY"
$damV2SupabaseJwtSecret = Get-EnvValue -Content $content -Key "DAM_V2_SUPABASE_JWT_SECRET"
$damV2Browse = Get-EnvValue -Content $content -Key "DAM_V2_BROWSE"

# Required — SSO via the dwp auth broker (middleware.ts + /api/session).
# APP_ID is optional; lib/authConfig.ts defaults it to "dwp-dam".
$dwpAuthUrl = Get-EnvValue -Content $content -Key "DWP_AUTH_URL"
$dwpAuthSecret = Get-EnvValue -Content $content -Key "DWP_AUTH_SECRET"
$appId = Get-EnvValue -Content $content -Key "APP_ID"

$dwpAuthUrl = Read-Required -Prompt "Enter DWP_AUTH_URL"    -Current $dwpAuthUrl
$dwpAuthSecret = Read-Required -Prompt "Enter DWP_AUTH_SECRET" -Current $dwpAuthSecret

# Fail fast, like the service-account checks above. Neither of these is
# validated until a user tries to sign in on the deployed service, and the
# failure mode is a silent redirect loop rather than an error.
if ($dwpAuthUrl -notmatch '^https://[^/\s]+$') {
    Write-Error ("DWP_AUTH_URL must be an absolute https origin with no trailing " +
        "slash or path, e.g. https://dwp-auth-....run.app. Got: '$dwpAuthUrl'")
    exit 1
}
if ($dwpAuthSecret.Length -lt 32) {
    Write-Error ("DWP_AUTH_SECRET is too short for an HS256 key (need at least 32 " +
        "characters, got $($dwpAuthSecret.Length)). It must match the broker's value exactly.")
    exit 1
}
# Optional, but checked when present: a truncated paste would otherwise ship a
# service that quietly reports the project library as switched off.
if ($damV2SupabaseJwtSecret -and $damV2SupabaseJwtSecret.Length -lt 32) {
    Write-Error ("DAM_V2_SUPABASE_JWT_SECRET is too short for an HS256 key (need at least 32 " +
        "characters, got $($damV2SupabaseJwtSecret.Length)). Copy the v2 project's legacy JWT secret exactly.")
    exit 1
}

# -----------------------------------------------------------------------------
# 4. Project setup: APIs + Artifact Registry repo (idempotent).
# -----------------------------------------------------------------------------
Write-Host "==> Setting project + enabling APIs..." -ForegroundColor Cyan
gcloud config set project $projectId | Out-Null
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com slides.googleapis.com --project $projectId
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to enable required APIs."; exit $LASTEXITCODE }

# Check whether the repo exists. Relax $ErrorActionPreference around ONLY this
# call: under "Stop", Windows PowerShell 5.1 turns gcloud's NOT_FOUND stderr
# (redirected with 2>$null) into a TERMINATING error, which would abort the
# script before the create branch could run on a first-time deploy.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
gcloud artifacts repositories describe $repo --location $region --project $projectId 2>$null | Out-Null
$repoMissing = ($LASTEXITCODE -ne 0)
$ErrorActionPreference = $prevEAP

if ($repoMissing) {
    Write-Host "==> Creating Artifact Registry repo '$repo' in $region..." -ForegroundColor Cyan
    gcloud artifacts repositories create $repo `
        --repository-format=docker `
        --location=$region `
        --description="Container images for $serviceName" `
        --project $projectId
    if ($LASTEXITCODE -ne 0) { Write-Error "Failed to create Artifact Registry repo."; exit $LASTEXITCODE }
}

# Ensure the Cloud Build service account can push images + write logs. Since
# mid-2024, builds run as the Compute Engine default SA, which on newer /
# locked-down projects starts with NO roles — without these the first
# `gcloud builds submit` can fail at source fetch, image push, or log write.
# Best-effort: needs you to have Owner / Project IAM Admin. If it can't set IAM
# (you're only Editor, or the roles already exist) it warns and continues,
# since the build still succeeds when the permissions are already present.
if ($EnsureBuildPermissions) {
    Write-Host "==> Ensuring Cloud Build service account has build permissions..." -ForegroundColor Cyan
    $projectNumber = (gcloud projects describe $projectId --format="value(projectNumber)").Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($projectNumber)) {
        Write-Warning "Could not read project number; skipping IAM grants. If 'builds submit' fails with a permission error, grant roles/artifactregistry.writer, roles/logging.logWriter and roles/storage.objectViewer to the Cloud Build service account manually."
    }
    else {
        $buildSa = "$projectNumber-compute@developer.gserviceaccount.com"
        foreach ($role in @("roles/artifactregistry.writer", "roles/logging.logWriter", "roles/storage.objectViewer")) {
            gcloud projects add-iam-policy-binding $projectId `
                --member="serviceAccount:$buildSa" `
                --role=$role `
                --condition=None `
                --quiet | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "Could not grant $role to $buildSa (you may lack IAM-admin rights, or the role is already present). Continuing."
            }
        }
    }
}
else {
    Write-Host "==> Reusing existing Cloud Build IAM grants (pass -EnsureBuildPermissions only to repair them)." -ForegroundColor DarkGray
}

# -----------------------------------------------------------------------------
# 5. Build & push the image via Cloud Build.
# -----------------------------------------------------------------------------
Write-Host "==> Building image via Cloud Build: $image (using dependency cache)" -ForegroundColor Cyan
gcloud builds submit `
    --config cloudbuild.yaml `
    --substitutions "_IMAGE=$image,_DEPS_CACHE_IMAGE=$depsCacheImage" `
    --project $projectId
if ($LASTEXITCODE -ne 0) { Write-Error "Cloud Build failed. Aborting deployment."; exit $LASTEXITCODE }

# -----------------------------------------------------------------------------
# 6. Deploy to Cloud Run, injecting runtime env vars via a temp env-vars file.
#    (A file is far more robust than --set-env-vars for the multi-line key.)
# -----------------------------------------------------------------------------
$envYamlPath = Join-Path ([System.IO.Path]::GetTempPath()) ("dwp-dam-env-" + [System.Guid]::NewGuid().ToString() + ".yaml")
$yamlLines = @(
    "SUPABASE_URL: $(ConvertTo-YamlValue $supabaseUrl)"
    "SUPABASE_ANON_KEY: $(ConvertTo-YamlValue $supabaseKey)"
    "GOOGLE_SERVICE_ACCOUNT_EMAIL: $(ConvertTo-YamlValue $gsaEmail)"
    "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: $(ConvertTo-YamlValue $gsaPrivateKey)"
    "DWP_AUTH_URL: $(ConvertTo-YamlValue $dwpAuthUrl)"
    "DWP_AUTH_SECRET: $(ConvertTo-YamlValue $dwpAuthSecret)"
)
# Optional AI vars — only sent when set.
if ($geminiKey) { $yamlLines += "GEMINI_API_KEY: $(ConvertTo-YamlValue $geminiKey)" }
if ($geminiModel) { $yamlLines += "GEMINI_MODEL: $(ConvertTo-YamlValue $geminiModel)" }
# Optional external-API vars — only sent when set.
if ($damApiKeys) { $yamlLines += "DAM_API_KEYS: $(ConvertTo-YamlValue $damApiKeys)" }
if ($damPublicBaseUrl) { $yamlLines += "DAM_PUBLIC_BASE_URL: $(ConvertTo-YamlValue $damPublicBaseUrl)" }
if ($damSiteRoots) { $yamlLines += "DAM_SITE_ROOTS: $(ConvertTo-YamlValue $damSiteRoots)" }
if ($damSlidesExportPath) { $yamlLines += "DAM_SLIDES_EXPORT_PATH: $(ConvertTo-YamlValue $damSlidesExportPath)" }
if ($damSlidesShareWith) { $yamlLines += "DAM_SLIDES_SHARE_WITH: $(ConvertTo-YamlValue $damSlidesShareWith)" }
if ($damSigningSecret) { $yamlLines += "DAM_SIGNING_SECRET: $(ConvertTo-YamlValue $damSigningSecret)" }
if ($damEmbedOrigins) { $yamlLines += "DAM_EMBED_ORIGINS: $(ConvertTo-YamlValue $damEmbedOrigins)" }
# Optional SSO var — lib/authConfig.ts defaults to "dwp-dam" when unset.
if ($appId) { $yamlLines += "APP_ID: $(ConvertTo-YamlValue $appId)" }
# Optional v2 project-library vars — only sent when set (never the service-role key).
if ($damV2SupabaseUrl) { $yamlLines += "DAM_V2_SUPABASE_URL: $(ConvertTo-YamlValue $damV2SupabaseUrl)" }
if ($damV2SupabaseAnonKey) { $yamlLines += "DAM_V2_SUPABASE_ANON_KEY: $(ConvertTo-YamlValue $damV2SupabaseAnonKey)" }
if ($damV2SupabaseJwtSecret) { $yamlLines += "DAM_V2_SUPABASE_JWT_SECRET: $(ConvertTo-YamlValue $damV2SupabaseJwtSecret)" }
if ($damV2Browse) { $yamlLines += "DAM_V2_BROWSE: $(ConvertTo-YamlValue $damV2Browse)" }
# Write UTF-8 without BOM so gcloud's YAML parser reads it cleanly.
[System.IO.File]::WriteAllText($envYamlPath, (($yamlLines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))

try {
    Write-Host "==> Deploying to Cloud Run..." -ForegroundColor Cyan
    $authFlag = if ($allowUnauthenticated) { "--allow-unauthenticated" } else { "--no-allow-unauthenticated" }
    gcloud run deploy $serviceName `
        --image $image `
        --platform managed `
        --region $region `
        $authFlag `
        --port 8080 `
        --memory 1Gi `
        --cpu 1 `
        --timeout 300 `
        --env-vars-file $envYamlPath `
        --project $projectId
    if ($LASTEXITCODE -ne 0) { Write-Error "Cloud Run deploy failed."; exit $LASTEXITCODE }
}
finally {
    Remove-Item $envYamlPath -ErrorAction SilentlyContinue
}

$serviceUrl = gcloud run services describe $serviceName --region $region --project $projectId --format "value(status.url)"
Write-Host ""
Write-Host "==> Deployment complete." -ForegroundColor Green
if ($serviceUrl) { Write-Host "    URL: $serviceUrl" -ForegroundColor Green }
