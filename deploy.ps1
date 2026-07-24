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

$ErrorActionPreference = "Stop"

# Run from the repo root so Cloud Build uploads this directory as the context.
Set-Location $PSScriptRoot

# -----------------------------------------------------------------------------
# 1. Configuration  --  edit these to match your project.
# -----------------------------------------------------------------------------
$projectId   = "dwpaivibecode"        # <-- GCP project ID
$serviceName = "dwp-dam"              # Cloud Run service name
$region      = "asia-southeast3"      # Cloud Run + Artifact Registry region
$repo        = "dwp-dam"             # Artifact Registry repository name
$allowUnauthenticated = $true         # PUBLIC access. See SECURITY note below.

$image = "$region-docker.pkg.dev/$projectId/$repo/$serviceName" + ":latest"

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
} else {
    Write-Host "==> $envFile not found; will prompt for required values." -ForegroundColor Yellow
}

$supabaseUrl   = Get-EnvValue -Content $content -Key "SUPABASE_URL"
$supabaseKey   = Get-EnvValue -Content $content -Key "SUPABASE_ANON_KEY"
$gsaEmail      = Get-EnvValue -Content $content -Key "GOOGLE_SERVICE_ACCOUNT_EMAIL"
$gsaPrivateKey = Get-EnvValue -Content $content -Key "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"

$supabaseUrl   = Read-Required -Prompt "Enter SUPABASE_URL"                    -Current $supabaseUrl
$supabaseKey   = Read-Required -Prompt "Enter SUPABASE_ANON_KEY"              -Current $supabaseKey
$gsaEmail      = Read-Required -Prompt "Enter GOOGLE_SERVICE_ACCOUNT_EMAIL"    -Current $gsaEmail
$gsaPrivateKey = Read-Required -Prompt "Enter GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY" -Current $gsaPrivateKey

# Optional — AI classification. If GEMINI_API_KEY is blank, AI is simply off
# and the app falls back to the manual taxonomy picker.
$geminiKey   = Get-EnvValue -Content $content -Key "GEMINI_API_KEY"
$geminiModel = Get-EnvValue -Content $content -Key "GEMINI_MODEL"

# Optional — external image API for consumer sites (docs/API-PLAN.md).
# If DAM_API_KEYS is blank, the /api/v1 endpoints reject every request.
$damApiKeys       = Get-EnvValue -Content $content -Key "DAM_API_KEYS"
$damPublicBaseUrl = Get-EnvValue -Content $content -Key "DAM_PUBLIC_BASE_URL"

# -----------------------------------------------------------------------------
# 4. Project setup: APIs + Artifact Registry repo (idempotent).
# -----------------------------------------------------------------------------
Write-Host "==> Setting project + enabling APIs..." -ForegroundColor Cyan
gcloud config set project $projectId | Out-Null
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project $projectId
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
Write-Host "==> Ensuring Cloud Build service account has build permissions..." -ForegroundColor Cyan
$projectNumber = (gcloud projects describe $projectId --format="value(projectNumber)").Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($projectNumber)) {
    Write-Warning "Could not read project number; skipping IAM grants. If 'builds submit' fails with a permission error, grant roles/artifactregistry.writer, roles/logging.logWriter and roles/storage.objectViewer to the Cloud Build service account manually."
} else {
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

# -----------------------------------------------------------------------------
# 5. Build & push the image via Cloud Build.
# -----------------------------------------------------------------------------
Write-Host "==> Building image via Cloud Build: $image" -ForegroundColor Cyan
gcloud builds submit `
    --config cloudbuild.yaml `
    --substitutions "_IMAGE=$image" `
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
)
# Optional AI vars — only sent when set.
if ($geminiKey)   { $yamlLines += "GEMINI_API_KEY: $(ConvertTo-YamlValue $geminiKey)" }
if ($geminiModel) { $yamlLines += "GEMINI_MODEL: $(ConvertTo-YamlValue $geminiModel)" }
# Optional external-API vars — only sent when set.
if ($damApiKeys)       { $yamlLines += "DAM_API_KEYS: $(ConvertTo-YamlValue $damApiKeys)" }
if ($damPublicBaseUrl) { $yamlLines += "DAM_PUBLIC_BASE_URL: $(ConvertTo-YamlValue $damPublicBaseUrl)" }
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
