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
$projectId   = "dwpaivibecode"
$serviceName = "dwp-dam"
$region      = "asia-southeast3"

function Get-EnvValue {
    param([string[]]$Content, [string]$Key)
    foreach ($line in $Content) {
        if ($line -match "^\s*$([regex]::Escape($Key))\s*=\s*(.*)$") {
            $val = $matches[1].Trim()
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

foreach ($pair in @(
    @{ n = "SUPABASE_URL"; v = $supabaseUrl },
    @{ n = "SUPABASE_ANON_KEY"; v = $supabaseKey },
    @{ n = "GOOGLE_SERVICE_ACCOUNT_EMAIL"; v = $gsaEmail },
    @{ n = "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"; v = $gsaPrivateKey })) {
    if ([string]::IsNullOrWhiteSpace($pair.v)) {
        Write-Error "$($pair.n) is missing from .env.local."
        exit 1
    }
}

$yamlLines = @(
    "SUPABASE_URL: $(ConvertTo-YamlValue $supabaseUrl)"
    "SUPABASE_ANON_KEY: $(ConvertTo-YamlValue $supabaseKey)"
    "GOOGLE_SERVICE_ACCOUNT_EMAIL: $(ConvertTo-YamlValue $gsaEmail)"
    "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: $(ConvertTo-YamlValue $gsaPrivateKey)"
)
if ($geminiKey)   { $yamlLines += "GEMINI_API_KEY: $(ConvertTo-YamlValue $geminiKey)" }
if ($geminiModel) { $yamlLines += "GEMINI_MODEL: $(ConvertTo-YamlValue $geminiModel)" }
if ($damApiKeys)       { $yamlLines += "DAM_API_KEYS: $(ConvertTo-YamlValue $damApiKeys)" }
if ($damPublicBaseUrl) { $yamlLines += "DAM_PUBLIC_BASE_URL: $(ConvertTo-YamlValue $damPublicBaseUrl)" }

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
