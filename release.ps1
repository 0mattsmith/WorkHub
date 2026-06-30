<#
  release.ps1 — commit, tag and push a new WorkHub release.

  What it does:
    1. Reads the "version" from package.json.
    2. Commits any pending changes (message optional).
    3. Pushes commits to the current branch.
    4. Creates the tag vX.Y.Z and pushes it — this is what triggers the
       GitHub Actions "Build & Release" workflow that builds the installers.

  Usage (from anywhere):
    .\release.ps1                       # commit msg defaults to "vX.Y.Z"
    .\release.ps1 "Fix Slack login"     # custom commit message

  Tip: bump "version" in package.json BEFORE running, so the tag is new.
#>

param(
  [string]$Message
)

$ErrorActionPreference = "Stop"

# Always work from this script's folder, wherever it's called from.
Set-Location -Path $PSScriptRoot

# --- read version from package.json -----------------------------------------
if (-not (Test-Path "package.json")) {
  Write-Error "package.json not found in $PSScriptRoot"
  exit 1
}
$pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
$version = $pkg.version
if ([string]::IsNullOrWhiteSpace($version)) {
  Write-Error "No 'version' field found in package.json"
  exit 1
}
$tag = "v$version"
if (-not $Message) { $Message = $tag }

Write-Host "WorkHub release -> $tag" -ForegroundColor Cyan

# --- guard: tag must not already exist --------------------------------------
$existing = git tag --list $tag
if ($existing -eq $tag) {
  Write-Error "Tag $tag already exists. Bump 'version' in package.json first."
  exit 1
}

# --- commit any pending changes ---------------------------------------------
git add -A
# Only commit if there's something staged (avoids an error on a clean tree).
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  git commit -m $Message
  Write-Host "Committed: $Message" -ForegroundColor Green
} else {
  Write-Host "No pending changes to commit." -ForegroundColor Yellow
}

# --- push commits, then the tag ---------------------------------------------
git push
git tag $tag
git push origin $tag

Write-Host ""
Write-Host "Pushed tag $tag. The 'Build & Release' workflow will now build the" -ForegroundColor Green
Write-Host "installers and publish Release $tag. Watch progress in the Actions tab." -ForegroundColor Green
