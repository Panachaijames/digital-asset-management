# =============================================================================
# Update the Cloud Run service's env vars from .env.local — WITHOUT rebuilding.
#
# Use this when the image is already deployed and you only need to (re)set or
# change environment variables (e.g. add GEMINI_API_KEY, rotate a key, fix a
# missing GOOGLE_SERVICE_ACCOUNT_*). Takes ~15s vs a full deploy.ps1 rebuild.
#
#   powershell -ExecutionPolicy Bypass -File .\set-env.ps1
# =============================================================================

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# Must match deploy.ps1.
$projectId   = "dwp2026"
$serviceName = "dwp-dam"
$region      = "asia-southeast3"

function Get-EnvValue {
    param([string[]]$Content, [string]$Key)
    foreach ($line in $Content) {
        if ($line -match "^\s*$([regex]::Escape($Key))\s*=\s*(.*)$") {
            $val = $matches[1].Trim()
            # Drop JSON's trailing comma before the quote-pair strip below —
            # see the longer note in deploy.ps1's Get-EnvValue.
            if ($val.EndsWith(',')) { $val = $val.Substring(0, $val.Length - 1).TrimEnd() }
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

function ConvertTo-YamlValue {
    param([string]$Value)
    return "'" + ($Value -replace "'", "''") + "'"
}

$envFile = Join-Path $PSScriptRoot ".env.local"
if (-not (Test-Path $envFile)) { Write-Error "$envFile not found."; exit 1 }
$content = Get-Content $envFile

$supabaseUrl   = Get-EnvValue -Content $content -Key "SUPABASE_URL"
$supabaseKey   = Get-EnvValue -Content $content -Key "SUPABASE_ANON_KEY"
$gsaEmail      = Get-EnvValue -Content $content -Key "GOOGLE_SERVICE_ACCOUNT_EMAIL"
$gsaPrivateKey = Get-EnvValue -Content $content -Key "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"
$geminiKey     = Get-EnvValue -Content $content -Key "GEMINI_API_KEY"
$geminiModel   = Get-EnvValue -Content $content -Key "GEMINI_MODEL"
$damApiKeys       = Get-EnvValue -Content $content -Key "DAM_API_KEYS"
$damPublicBaseUrl = Get-EnvValue -Content $content -Key "DAM_PUBLIC_BASE_URL"
$damSiteRoots     = Get-EnvValue -Content $content -Key "DAM_SITE_ROOTS"
# Optional — Google Slides export; all three have working defaults (see deploy.ps1).
$damSlidesExportPath = Get-EnvValue -Content $content -Key "DAM_SLIDES_EXPORT_PATH"
$damSlidesShareWith  = Get-EnvValue -Content $content -Key "DAM_SLIDES_SHARE_WITH"
$damSigningSecret    = Get-EnvValue -Content $content -Key "DAM_SIGNING_SECRET"
# Optional — restricts which origins may frame /embed; unset means any site
# may frame it (see deploy.ps1).
$damEmbedOrigins     = Get-EnvValue -Content $content -Key "DAM_EMBED_ORIGINS"
# Required — SSO via the dwp auth broker (see deploy.ps1). APP_ID is optional.
# This file uses --env-vars-file, which REPLACES the service's whole env set, so
# omitting these here would wipe them from production on the next run.
$dwpAuthUrl    = Get-EnvValue -Content $content -Key "DWP_AUTH_URL"
$dwpAuthSecret = Get-EnvValue -Content $content -Key "DWP_AUTH_SECRET"
$appId         = Get-EnvValue -Content $content -Key "APP_ID"
# Optional — v2 project-library preview (see deploy.ps1). Never the service-role key.
$damV2SupabaseUrl       = Get-EnvValue -Content $content -Key "DAM_V2_SUPABASE_URL"
$damV2SupabaseAnonKey   = Get-EnvValue -Content $content -Key "DAM_V2_SUPABASE_ANON_KEY"
$damV2SupabaseJwtSecret = Get-EnvValue -Content $content -Key "DAM_V2_SUPABASE_JWT_SECRET"
$damV2Browse            = Get-EnvValue -Content $content -Key "DAM_V2_BROWSE"

foreach ($pair in @(
    @{ n = "SUPABASE_URL"; v = $supabaseUrl },
    @{ n = "SUPABASE_ANON_KEY"; v = $supabaseKey },
    @{ n = "GOOGLE_SERVICE_ACCOUNT_EMAIL"; v = $gsaEmail },
    @{ n = "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"; v = $gsaPrivateKey },
    @{ n = "DWP_AUTH_URL"; v = $dwpAuthUrl },
    @{ n = "DWP_AUTH_SECRET"; v = $dwpAuthSecret })) {
    if ([string]::IsNullOrWhiteSpace($pair.v)) {
        Write-Error "$($pair.n) is missing from .env.local."
        exit 1
    }
}

# Fail fast on a malformed private key — nothing validates it until the first
# Drive request on the live service (see deploy.ps1 for the full note).
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

# Same SSO checks as deploy.ps1 — this script can set env vars on its own, so
# without them a malformed broker URL or a truncated secret ships here and
# every sign-in fails with a silent redirect loop rather than an error.
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
if ($damV2SupabaseJwtSecret -and $damV2SupabaseJwtSecret.Length -lt 32) {
    Write-Error ("DAM_V2_SUPABASE_JWT_SECRET is too short for an HS256 key (need at least 32 " +
        "characters, got $($damV2SupabaseJwtSecret.Length)). Copy the v2 project's legacy JWT secret exactly.")
    exit 1
}

$yamlLines = @(
    "SUPABASE_URL: $(ConvertTo-YamlValue $supabaseUrl)"
    "SUPABASE_ANON_KEY: $(ConvertTo-YamlValue $supabaseKey)"
    "GOOGLE_SERVICE_ACCOUNT_EMAIL: $(ConvertTo-YamlValue $gsaEmail)"
    "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: $(ConvertTo-YamlValue $gsaPrivateKey)"
    "DWP_AUTH_URL: $(ConvertTo-YamlValue $dwpAuthUrl)"
    "DWP_AUTH_SECRET: $(ConvertTo-YamlValue $dwpAuthSecret)"
)
if ($geminiKey)   { $yamlLines += "GEMINI_API_KEY: $(ConvertTo-YamlValue $geminiKey)" }
if ($geminiModel) { $yamlLines += "GEMINI_MODEL: $(ConvertTo-YamlValue $geminiModel)" }
if ($damApiKeys)       { $yamlLines += "DAM_API_KEYS: $(ConvertTo-YamlValue $damApiKeys)" }
if ($damPublicBaseUrl) { $yamlLines += "DAM_PUBLIC_BASE_URL: $(ConvertTo-YamlValue $damPublicBaseUrl)" }
if ($damSiteRoots)     { $yamlLines += "DAM_SITE_ROOTS: $(ConvertTo-YamlValue $damSiteRoots)" }
if ($damSlidesExportPath) { $yamlLines += "DAM_SLIDES_EXPORT_PATH: $(ConvertTo-YamlValue $damSlidesExportPath)" }
if ($damSlidesShareWith)  { $yamlLines += "DAM_SLIDES_SHARE_WITH: $(ConvertTo-YamlValue $damSlidesShareWith)" }
if ($damSigningSecret)    { $yamlLines += "DAM_SIGNING_SECRET: $(ConvertTo-YamlValue $damSigningSecret)" }
if ($damEmbedOrigins)     { $yamlLines += "DAM_EMBED_ORIGINS: $(ConvertTo-YamlValue $damEmbedOrigins)" }
if ($appId)               { $yamlLines += "APP_ID: $(ConvertTo-YamlValue $appId)" }
if ($damV2SupabaseUrl)       { $yamlLines += "DAM_V2_SUPABASE_URL: $(ConvertTo-YamlValue $damV2SupabaseUrl)" }
if ($damV2SupabaseAnonKey)   { $yamlLines += "DAM_V2_SUPABASE_ANON_KEY: $(ConvertTo-YamlValue $damV2SupabaseAnonKey)" }
if ($damV2SupabaseJwtSecret) { $yamlLines += "DAM_V2_SUPABASE_JWT_SECRET: $(ConvertTo-YamlValue $damV2SupabaseJwtSecret)" }
if ($damV2Browse)            { $yamlLines += "DAM_V2_BROWSE: $(ConvertTo-YamlValue $damV2Browse)" }

$envYamlPath = Join-Path ([System.IO.Path]::GetTempPath()) ("dwp-dam-env-" + [System.Guid]::NewGuid().ToString() + ".yaml")
[System.IO.File]::WriteAllText($envYamlPath, (($yamlLines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))

try {
    Write-Host "==> Updating env vars on '$serviceName' ($region)..." -ForegroundColor Cyan
    gcloud run services update $serviceName `
        --region $region `
        --env-vars-file $envYamlPath `
        --project $projectId
    if ($LASTEXITCODE -ne 0) { Write-Error "Failed to update env vars."; exit $LASTEXITCODE }
}
finally {
    Remove-Item $envYamlPath -ErrorAction SilentlyContinue
}

Write-Host "==> Done. New revision is live with updated env vars." -ForegroundColor Green
