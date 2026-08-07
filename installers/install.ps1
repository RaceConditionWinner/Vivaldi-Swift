<#
.SYNOPSIS
    Vivaldi Swift installer for Windows.

.DESCRIPTION
    One command, no parameters required:

      irm https://raw.githubusercontent.com/Utkarsh-tiwari27/Vivaldi-Swift/main/installers/install.ps1 | iex

    Detects Vivaldi (per-user or per-machine), downloads vivaldi_swift.css
    and custom.js, patches window.html between marker comments, and
    verifies the result. Safe to run any number of times, and this is
    also how you reapply the patch after a Vivaldi update replaces
    window.html.

.NOTES
    Exit codes: 0 ok, 1 not found/unsupported, 2 permission, 3 patch failed
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$Repo    = "Utkarsh-tiwari27/Vivaldi-Swift"
$RawBase = "https://raw.githubusercontent.com/$Repo/main"
$CssFile = "vivaldi_swift.css"
$JsFile  = "custom.js"
$MarkStart = "<!-- VIVALDI_SWIFT_START -->"
$MarkEnd   = "<!-- VIVALDI_SWIFT_END -->"
$InstallDir = Join-Path $env:LOCALAPPDATA "VivaldiSwift"

function Ok($msg)   { Write-Host "OK  $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "    $msg" }
function Warn($msg) { Write-Host "!   $msg" -ForegroundColor Yellow }
function Die($msg, [int]$code = 1) {
    Write-Host "X   $msg" -ForegroundColor Red
    exit $code
}

Write-Host "──────────────────────────────"
Write-Host " Vivaldi Swift"
Write-Host "──────────────────────────────"

# ---------------------------------------------------------------------------
# 1. Find Vivaldi — newest version directory under each known root.
# ---------------------------------------------------------------------------
function Find-Vivaldi {
    $roots = @(
        (Join-Path $env:LOCALAPPDATA "Vivaldi"),
        (Join-Path $env:ProgramFiles "Vivaldi"),
        (Join-Path ${env:ProgramFiles(x86)} "Vivaldi")
    ) | Where-Object { $_ -and (Test-Path $_) }

    $found = @()
    foreach ($root in $roots) {
        $appRoot = Join-Path $root "Application"
        if (-not (Test-Path $appRoot)) { continue }
        Get-ChildItem -Path $appRoot -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object {
                $candidate = Join-Path $_.FullName "resources\vivaldi"
                if (Test-Path (Join-Path $candidate "window.html")) {
                    $found += $candidate
                }
            }
    }
    return $found | Select-Object -Unique
}

$candidates = Find-Vivaldi
if ($candidates.Count -eq 0) {
    Die "No Vivaldi installation found under LocalAppData or Program Files. Install Vivaldi from vivaldi.com and run this command again."
}
$vivaldiDir = $candidates[0]
Ok "Found Vivaldi at $vivaldiDir"

# ---------------------------------------------------------------------------
# 2. Refuse to touch a running Vivaldi.
# ---------------------------------------------------------------------------
if (Get-Process -Name "vivaldi" -ErrorAction SilentlyContinue) {
    Die "Vivaldi is currently running. Close Vivaldi and run this command again."
}

# ---------------------------------------------------------------------------
# 3. Elevate if this Vivaldi install isn't writable by the current user
#    (per-machine installs under Program Files typically need this).
#    Re-launches itself once via UAC; a marker environment variable
#    prevents an elevation loop.
# ---------------------------------------------------------------------------
function Test-Writable([string]$path) {
    try {
        $probe = Join-Path $path ".vivaldi-swift-write-test"
        [IO.File]::WriteAllText($probe, "test")
        Remove-Item $probe -Force
        return $true
    } catch { return $false }
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not (Test-Writable $vivaldiDir) -and -not $isAdmin) {
    if ($env:VIVALDI_SWIFT_ELEVATED -eq "1") {
        Die "Still no write permission to $vivaldiDir after elevation. Aborting to avoid a loop." 2
    }
    Info "Administrator privileges are required to patch $vivaldiDir — requesting elevation..."
    $env:VIVALDI_SWIFT_ELEVATED = "1"
    $psCommand = "irm https://raw.githubusercontent.com/$Repo/main/installers/install.ps1 | iex"
    try {
        Start-Process powershell -Verb RunAs -ArgumentList @(
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $psCommand
        ) -Wait
    } catch {
        Die "Elevation was declined or failed. Vivaldi Swift was not installed." 2
    }
    exit 0
}

# ---------------------------------------------------------------------------
# 4. Download, validate, install into $InstallDir.
# ---------------------------------------------------------------------------
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "backups") | Out-Null

$workDir = Join-Path ([IO.Path]::GetTempPath()) ("vivaldi-swift-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

try {
    Info "Downloading Vivaldi Swift files..."
    foreach ($f in @($CssFile, $JsFile)) {
        $dest = Join-Path $workDir $f
        try {
            Invoke-WebRequest -Uri "$RawBase/$f" -OutFile $dest -UseBasicParsing
        } catch {
            Die "Failed to download $f. Check your connection. ($($_.Exception.Message))"
        }
        if (-not (Test-Path $dest) -or (Get-Item $dest).Length -eq 0) {
            Die "$f downloaded as an empty file."
        }
        $head = Get-Content $dest -TotalCount 5 -Raw -ErrorAction SilentlyContinue
        if ($head -and $head -match "(?i)<html") {
            Die "$f looks like an HTML error page, not source — GitHub may be unreachable or the repo layout changed."
        }
    }
    Ok "Downloaded $CssFile and $JsFile"

    Copy-Item (Join-Path $workDir $CssFile) (Join-Path $InstallDir $CssFile) -Force
    Copy-Item (Join-Path $workDir $JsFile)  (Join-Path $InstallDir $JsFile)  -Force

    # -----------------------------------------------------------------------
    # 5. Patch window.html — idempotent, marker-delimited, verified.
    # -----------------------------------------------------------------------
    $windowHtml = Join-Path $vivaldiDir "window.html"
    $block = "$MarkStart`n<link rel=`"stylesheet`" href=`"$CssFile`">`n<script src=`"$JsFile`"></script>`n$MarkEnd"

    $current = Get-Content -Path $windowHtml -Raw
    $installedCss = Join-Path $vivaldiDir $CssFile
    $installedJs  = Join-Path $vivaldiDir $JsFile

    $alreadyCurrent = $false
    if ($current.Contains($MarkStart) -and (Test-Path $installedCss) -and (Test-Path $installedJs)) {
        $cssSame = (Get-FileHash $installedCss).Hash -eq (Get-FileHash (Join-Path $workDir $CssFile)).Hash
        $jsSame  = (Get-FileHash $installedJs).Hash  -eq (Get-FileHash (Join-Path $workDir $JsFile)).Hash
        $alreadyCurrent = $cssSame -and $jsSame
    }

    if ($alreadyCurrent) {
        Ok "window.html already patched and up to date"
    } else {
        $backupPath = Join-Path $InstallDir "backups\window.html"
        if (-not $current.Contains($MarkStart)) {
            try {
                Copy-Item $windowHtml $backupPath -Force
            } catch {
                Die "Could not create a backup of window.html. Nothing was modified." 3
            }
        }

        if ($current.Contains($MarkStart)) {
            $pattern = [regex]::Escape($MarkStart) + "(?s).*?" + [regex]::Escape($MarkEnd)
            $newContent = [regex]::Replace($current, $pattern, { param($m) $block })
        } else {
            $newContent = $current -replace "</body>", "$block`n</body>"
        }

        if ([string]::IsNullOrWhiteSpace($newContent)) {
            Die "Generated an empty window.html — aborting before touching anything." 3
        }
        if (-not $newContent.Contains($MarkStart)) {
            Die "Patch generation did not produce the expected markers — aborting." 3
        }

        try {
            Set-Content -Path $windowHtml -Value $newContent -NoNewline -Encoding utf8
        } catch {
            Die "Could not write patched window.html: $($_.Exception.Message)" 3
        }
        Ok "Patched window.html"
    }

    Copy-Item (Join-Path $InstallDir $CssFile) $installedCss -Force
    Copy-Item (Join-Path $InstallDir $JsFile)  $installedJs  -Force

    # -------------------------------------------------------------------
    # 6. Verify
    # -------------------------------------------------------------------
    $verify = Get-Content -Path $windowHtml -Raw
    if (-not $verify.Contains($MarkStart)) { Die "Verification failed: markers missing from window.html." 3 }
    if (-not (Test-Path $installedCss) -or (Get-Item $installedCss).Length -eq 0) { Die "Verification failed: $CssFile missing at target." 3 }
    if (-not (Test-Path $installedJs)  -or (Get-Item $installedJs).Length -eq 0)  { Die "Verification failed: $JsFile missing at target." 3 }
    Ok "Verified installation"

    Write-Host "──────────────────────────────"
    Ok "Vivaldi Swift is ready. Restart Vivaldi to see it."
    Info "A Vivaldi update will replace window.html and remove this patch —"
    Info "just rerun this same command afterwards to reapply it."
}
finally {
    Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue
}
