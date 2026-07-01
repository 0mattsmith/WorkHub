<#
  release.ps1 — bump the version, commit, tag and push a new WorkHub release.

  It now bumps the version for you (patch by default), so you never edit
  package.json by hand.

  What it does:
    1. Reads "version" from package.json and bumps it (patch/minor/major),
       or sets it to an exact value if you pass -SetVersion.
    2. Writes the new version back to package.json.
    3. Commits all pending changes (message optional).
    4. Pushes commits, then creates + pushes the tag vX.Y.Z — this is what
       triggers the GitHub Actions "Build & Release" workflow.

  Usage (from anywhere):
    .\release.ps1                         # bump patch (1.0.4 -> 1.0.5), msg = "vX.Y.Z"
    .\release.ps1 "Fix Slack login"       # bump patch, custom commit message
    .\release.ps1 "New feature" -Level minor    # 1.0.5 -> 1.1.0
    .\release.ps1 "Big release" -Level major    # 1.1.0 -> 2.0.0
    .\release.ps1 "Hotfix" -SetVersion 1.2.3    # set an exact version
#>

param(
  [string]$Message,
  [ValidateSet('patch', 'minor', 'major')]
  [string]$Level = 'patch',
  [string]$SetVersion
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot   # always run from this script's folder

if (-not (Test-Path "package.json")) {
  Write-Error "package.json not found in $PSScriptRoot"; exit 1
}

# --- read current version ----------------------------------------------------
$raw = Get-Content "package.json" -Raw
$m = [regex]::Match($raw, '"version"\s*:\s*"(\d+)\.(\d+)\.(\d+)"')
if (-not $m.Success) {
  Write-Error "Couldn't find a semver version (X.Y.Z) in package.json"; exit 1
}
$major = [int]$m.Groups[1].Value
$minor = [int]$m.Groups[2].Value
$patch = [int]$m.Groups[3].Value
$old = "$major.$minor.$patch"

# --- compute the new version -------------------------------------------------
if ($SetVersion) {
  if ($SetVersion -notmatch '^\d+\.\d+\.\d+$') { Write-Error "SetVersion must look like 1.2.3"; exit 1 }
  $new = $SetVersion
} else {
  switch ($Level) {
    'major' { $major++; $minor = 0; $patch = 0 }
    'minor' { $minor++; $patch = 0 }
    'patch' { $patch++ }
  }
  $new = "$major.$minor.$patch"
}
$tag = "v$new"

Write-Host "WorkHub release: $old -> $new  (tag $tag)" -ForegroundColor Cyan

# --- guard: tag must not already exist --------------------------------------
if ((git tag --list $tag) -eq $tag) {
  Write-Error "Tag $tag already exists. Pass a higher -SetVersion."; exit 1
}

# --- write the new version back (preserves file formatting) ------------------
$raw = [regex]::Replace($raw, '("version"\s*:\s*")\d+\.\d+\.\d+(")', "`${1}$new`${2}", 1)
# -NoNewline keeps the file's existing trailing newline instead of adding one
Set-Content -Path "package.json" -Value $raw -NoNewline -Encoding UTF8
Write-Host "Bumped package.json to $new" -ForegroundColor Green

if (-not $Message) { $Message = $tag }

# --- commit, push, tag, push tag --------------------------------------------
git add -A
git commit -m $Message
Write-Host "Committed: $Message" -ForegroundColor Green

git push
git tag $tag
git push origin $tag

Write-Host ""
Write-Host "Pushed tag $tag. The 'Build & Release' workflow will build the" -ForegroundColor Green
Write-Host "installers and publish Release $tag. Watch it in the Actions tab." -ForegroundColor Green
