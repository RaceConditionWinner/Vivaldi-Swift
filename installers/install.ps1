<#
.SYNOPSIS
    Vivaldi Swift installer for Windows.

.DESCRIPTION
    One command, no parameters required:

      irm https://raw.githubusercontent.com/Utkarsh-tiwari27/Vivaldi-Swift/main/installers/install.ps1 | iex

    Detects Vivaldi (per-user or per-machine), downloads vivaldi_swift.css
    and custom.js into the canonical local folder %USERPROFILE%\Vivaldi-Swift,
    validates them, patches window.html between marker comments, and
    verifies the result. Safe to run any number of times, and this is also
    how you reapply the patch after a Vivaldi update replaces window.html.

    %USERPROFILE%\Vivaldi-Swift is the source of truth for the locally
    installed payload; the copies inside Vivaldi's own resource directory
    are a deployed copy of it. A future repair tool can reuse this folder
    after a Vivaldi update without re-downloading anything — that repair
    tool is not implemented yet.

.NOTES
    Exit codes: 0 ok, 1 not found/unsupported, 2 permission, 3 patch failed
#>

[CmdletBinding()]
param(
    # Internal — set automatically when this script relaunches itself
    # elevated. Not for interactive use.
    [switch]$AlreadyElevated
)

$ErrorActionPreference = "Stop"

$Repo      = "Utkarsh-tiwari27/Vivaldi-Swift"
$RawBase   = "https://raw.githubusercontent.com/$Repo/main"
$CssFile   = "vivaldi_swift.css"
$JsFile    = "custom.js"
$MarkStart = "<!-- VIVALDI_SWIFT_START -->"
$MarkEnd   = "<!-- VIVALDI_SWIFT_END -->"

function Ok($msg)   { Write-Host "OK  $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "    $msg" }
function Warn($msg) { Write-Host "!   $msg" -ForegroundColor Yellow }
function Die($msg, [int]$code = 1) {
    Write-Host "X   $msg" -ForegroundColor Red
    exit $code
}

Write-Host "Vivaldi Swift Installer"
Write-Host ""

# ---------------------------------------------------------------------------
# 0. Canonical local directory. $env:USERPROFILE is correct even when this
#    script relaunches itself elevated (UAC keeps the same user profile —
#    Windows elevation is not a user switch the way sudo is), so no special
#    "real user" resolution is needed the way it is on Unix.
# ---------------------------------------------------------------------------
$SwiftDir   = if ($env:VIVALDI_SWIFT_TEST_HOME) { Join-Path $env:VIVALDI_SWIFT_TEST_HOME "Vivaldi-Swift" }
              else { Join-Path $env:USERPROFILE "Vivaldi-Swift" }
$BackupDir  = Join-Path $SwiftDir "backups"
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$displayUser = if ($env:USERNAME) { $env:USERNAME } else { $env:USER }
Ok "Installing for $displayUser (canonical dir: $SwiftDir)"

# ---------------------------------------------------------------------------
# 1. Find Vivaldi — version-aware sort, not lexical string sort, so 7.10.x
#    doesn't get placed below 7.9.x.
# ---------------------------------------------------------------------------
function Get-SortableVersion([string]$name) {
    # Vivaldi version directories are dotted numerics (e.g. "7.10.1234.56").
    # Parse what we can; non-numeric/unexpected directory names sort last
    # rather than crashing detection.
    try { return [version]($name -replace '[^0-9.]', '') }
    catch { return [version]"0.0.0.0" }
}

function Find-Vivaldi {
    if ($env:VIVALDI_SWIFT_TEST_VIVALDI) {
        return @([PSCustomObject]@{
            Path    = $env:VIVALDI_SWIFT_TEST_VIVALDI
            Root    = $env:VIVALDI_SWIFT_TEST_VIVALDI
            Version = "test"
        })
    }

    $roots = @(
        $env:LOCALAPPDATA,
        $env:ProgramFiles,
        ${env:ProgramFiles(x86)}
    ) | Where-Object { $_ } | ForEach-Object { Join-Path $_ "Vivaldi" } | Where-Object { Test-Path $_ }

    $found = @()
    foreach ($root in $roots) {
        $appRoot = Join-Path $root "Application"
        if (-not (Test-Path $appRoot)) { continue }
        Get-ChildItem -Path $appRoot -Directory -ErrorAction SilentlyContinue |
            Sort-Object { Get-SortableVersion $_.Name } -Descending |
            ForEach-Object {
                $candidate = Join-Path $_.FullName "resources\vivaldi"
                if (Test-Path (Join-Path $candidate "window.html")) {
                    $found += [PSCustomObject]@{
                        Path    = $candidate
                        Root    = $root
                        Version = $_.Name
                    }
                }
            }
    }
    return $found
}

$candidates = @(Find-Vivaldi)
if ($candidates.Count -eq 0) {
    Die "No Vivaldi installation found under LocalAppData or Program Files. Install Vivaldi from vivaldi.com and run this command again."
}

# Pick the newest version per root, then require a single root overall —
# per-user + per-machine installs both present is genuinely ambiguous, so
# we refuse to guess rather than silently pick one.
$byRoot = $candidates | Group-Object Root
if ($byRoot.Count -gt 1) {
    Warn "Multiple Vivaldi installations found — refusing to guess which one to patch:"
    foreach ($g in $byRoot) { Info "  $($g.Group[0].Path)" }
    Die "Remove or rename the installation you don't use, then rerun this command." 1
}

$vivaldiDir = $candidates[0].Path
Ok "Found Vivaldi $($candidates[0].Version) at $vivaldiDir"

# ---------------------------------------------------------------------------
# 2. Refuse to touch a running Vivaldi.
# ---------------------------------------------------------------------------
if (-not $env:VIVALDI_SWIFT_TEST_SKIP_PROC -and (Get-Process -Name "vivaldi" -ErrorAction SilentlyContinue)) {
    Die "Vivaldi is currently running. Close Vivaldi fully and run this command again. Nothing was modified."
}

# ---------------------------------------------------------------------------
# 3. Elevate only if the Vivaldi directory itself needs it — never for
#    discovery, download, or the canonical ~\Vivaldi-Swift folder above.
#    Relaunches this exact script file (not a fresh download) via UAC, with
#    a switch parameter (not an env var) guarding against a loop, and no
#    Invoke-Expression involved.
# ---------------------------------------------------------------------------
function Test-Writable([string]$path) {
    try {
        $probe = Join-Path $path ".vivaldi-swift-write-test"
        [IO.File]::WriteAllText($probe, "test")
        Remove-Item $probe -Force
        return $true
    } catch { return $false }
}

try {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {
    # WindowsPrincipal is unavailable outside Windows (e.g. cross-platform
    # test runs on pwsh/Linux) — fail safe by assuming not-admin, which
    # simply means the writability check below decides whether elevation
    # is requested, same as it would on Windows for a non-admin user.
    $isAdmin = $false
}

if (-not (Test-Writable $vivaldiDir) -and -not $isAdmin) {
    if ($AlreadyElevated) {
        Die "Still no write permission to $vivaldiDir after elevation. Aborting to avoid a loop." 2
    }
    Info "Administrator privileges are required to patch $vivaldiDir — requesting elevation..."

    # Stage the exact running script to a stable temp path so the elevated
    # process runs the same revision, whether we were invoked as a local
    # .ps1 file or piped in via `irm | iex` (which has no $PSCommandPath).
    $stagedScript = Join-Path ([IO.Path]::GetTempPath()) "vivaldi-swift-install-staged.ps1"
    if ($PSCommandPath -and (Test-Path $PSCommandPath)) {
        Copy-Item $PSCommandPath $stagedScript -Force
    } else {
        $MyInvocation.MyCommand.ScriptBlock.ToString() | Set-Content -Path $stagedScript -Encoding utf8
    }

    try {
        Start-Process powershell -Verb RunAs -ArgumentList @(
            "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", "`"$stagedScript`"", "-AlreadyElevated"
        ) -Wait
    } catch {
        Die "Elevation was declined or failed. Vivaldi Swift was not installed." 2
    } finally {
        Remove-Item $stagedScript -Force -ErrorAction SilentlyContinue
    }
    exit 0
}

# ---------------------------------------------------------------------------
# 4. Download into a temp dir, validate, THEN replace the canonical copies
#    under ~\Vivaldi-Swift. A failed download never touches a previously
#    working canonical payload.
# ---------------------------------------------------------------------------
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$workDir = Join-Path ([IO.Path]::GetTempPath()) ("vivaldi-swift-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

function Test-Payload([string]$path, [string]$label) {
    if (-not (Test-Path $path) -or (Get-Item $path).Length -eq 0) {
        Die "$label downloaded as an empty file. The existing local copy under $SwiftDir was not touched."
    }
    $head = (Get-Content $path -TotalCount 5 -ErrorAction SilentlyContinue) -join "`n"
    if ($head -and $head -match "(?i)<html") {
        Die "$label looks like an HTML error page, not source — GitHub may be unreachable or the repo layout changed. The existing local copy under $SwiftDir was not touched."
    }
}

try {
    Info "Downloading Vivaldi Swift files..."
    foreach ($f in @($CssFile, $JsFile)) {
        $dest = Join-Path $workDir $f
        if ($env:VIVALDI_SWIFT_TEST_SOURCE) {
            $src = Join-Path $env:VIVALDI_SWIFT_TEST_SOURCE $f
            if (-not (Test-Path $src)) {
                Die "Failed to download $f. Check your connection. The existing local copy under $SwiftDir was not touched."
            }
            Copy-Item $src $dest -Force
        } else {
            try {
                Invoke-WebRequest -Uri "$RawBase/$f" -OutFile $dest -UseBasicParsing
            } catch {
                Die "Failed to download $f. Check your connection. The existing local copy under $SwiftDir was not touched. ($($_.Exception.Message))"
            }
        }
        Test-Payload $dest $f
    }
    Ok "Downloaded and validated $CssFile and $JsFile"

    Copy-Item (Join-Path $workDir $CssFile) (Join-Path $SwiftDir $CssFile) -Force
    Copy-Item (Join-Path $workDir $JsFile)  (Join-Path $SwiftDir $JsFile)  -Force
    Ok "Updated canonical copy at $SwiftDir"

    # -------------------------------------------------------------------
    # 5. Validate window.html and the marker state before touching it.
    # -------------------------------------------------------------------
    $windowHtml = Join-Path $vivaldiDir "window.html"
    if (-not (Test-Path $windowHtml)) {
        Die "window.html not found at $vivaldiDir — this Vivaldi build may use an unexpected layout. Nothing was modified."
    }
    $current = Get-Content -Path $windowHtml -Raw
    if ([string]::IsNullOrEmpty($current)) {
        Die "window.html at $vivaldiDir is empty — this looks like a broken Vivaldi install, not something to patch. Nothing was modified."
    }

    function Count-Occurrences([string]$haystack, [string]$needle) {
        if ([string]::IsNullOrEmpty($haystack)) { return 0 }
        return ([regex]::Matches($haystack, [regex]::Escape($needle))).Count
    }

    $startCount = Count-Occurrences $current $MarkStart
    $endCount   = Count-Occurrences $current $MarkEnd

    $state = $null
    if ($startCount -eq 0 -and $endCount -eq 0) {
        $state = "unpatched"
    } elseif ($startCount -eq 1 -and $endCount -eq 1) {
        $state = "patched"
    } else {
        Die "Cannot patch: window.html has a malformed Vivaldi Swift marker state (START=$startCount, END=$endCount). This needs a human to look at it — nothing was modified. If you have a backup under $BackupDir you can restore it manually and rerun this installer." 3
    }

    if ($state -eq "unpatched" -and -not $current.Contains("</body>")) {
        Die "window.html doesn't contain a </body> tag — unexpected Vivaldi layout. Nothing was modified." 3
    }

    $block = "$MarkStart`n<link rel=`"stylesheet`" href=`"$CssFile`">`n<script src=`"$JsFile`"></script>`n$MarkEnd"
    $installedCss = Join-Path $vivaldiDir $CssFile
    $installedJs  = Join-Path $vivaldiDir $JsFile

    # -------------------------------------------------------------------
    # 6. Idempotency check — skip the patch entirely if the installed
    #    payload already matches what we just downloaded.
    # -------------------------------------------------------------------
    $alreadyCurrent = $false
    if ($state -eq "patched" -and (Test-Path $installedCss) -and (Test-Path $installedJs)) {
        $cssSame = (Get-FileHash $installedCss).Hash -eq (Get-FileHash (Join-Path $workDir $CssFile)).Hash
        $jsSame  = (Get-FileHash $installedJs).Hash  -eq (Get-FileHash (Join-Path $workDir $JsFile)).Hash
        $alreadyCurrent = $cssSame -and $jsSame
    }

    if ($alreadyCurrent) {
        Ok "Vivaldi Swift is already installed and up to date."
        Write-Host ""
        Ok "Nothing to do. Restart Vivaldi if you haven't already."
        exit 0
    }

    # -------------------------------------------------------------------
    # 7. Backup — keep exactly one, and never let a Swift-patched
    #    window.html overwrite a clean original backup on reinstall.
    # -------------------------------------------------------------------
    $backupPath = Join-Path $BackupDir "window.html.orig"
    if ($state -eq "unpatched" -and -not (Test-Path $backupPath)) {
        try {
            Copy-Item $windowHtml $backupPath -Force
            Ok "Backed up original window.html"
        } catch {
            Die "Could not create a backup of window.html. Nothing was modified." 3
        }
    } elseif ($state -eq "unpatched") {
        Info "Existing clean backup found — leaving it as-is."
    }

    # -------------------------------------------------------------------
    # 8. Generate the patched content in memory, validate it, THEN write.
    #    PowerShell's Set-Content on a local NTFS path is effectively a
    #    single write; this is a validated staged replacement rather than
    #    a cross-process atomic rename, and it's described that way here
    #    rather than overclaiming atomicity.
    # -------------------------------------------------------------------
    if ($state -eq "patched") {
        $pattern = [regex]::Escape($MarkStart) + "(?s).*?" + [regex]::Escape($MarkEnd)
        $newContent = [regex]::Replace($current, $pattern, { param($m) $block })
    } else {
        $newContent = $current -replace "</body>", "$block`n</body>"
    }

    if ([string]::IsNullOrWhiteSpace($newContent)) {
        Die "Generated an empty window.html — aborting before touching anything." 3
    }

    $genStart = Count-Occurrences $newContent $MarkStart
    $genEnd   = Count-Occurrences $newContent $MarkEnd
    $genCss   = Count-Occurrences $newContent "href=`"$CssFile`""
    $genJs    = Count-Occurrences $newContent "src=`"$JsFile`""
    if ($genStart -ne 1 -or $genEnd -ne 1 -or $genCss -ne 1 -or $genJs -ne 1) {
        Die "Patch generation did not produce exactly one marker/loader pair (START=$genStart END=$genEnd CSS=$genCss JS=$genJs) — aborting. Nothing was modified." 3
    }
    if (($newContent -split "`n").Count -lt ($current -split "`n").Count) {
        Die "Generated window.html has fewer lines than the original — looks like content was truncated. Aborting. Nothing was modified." 3
    }

    function Restore-Backup {
        Warn "Rolling back window.html to the last known-good backup..."
        if (Test-Path $backupPath) {
            try {
                Copy-Item $backupPath $windowHtml -Force
                Ok "Rollback succeeded."
            } catch {
                Warn "Rollback FAILED — window.html at $windowHtml may be inconsistent. Restore manually from $backupPath."
            }
        } else {
            Warn "No backup available to roll back to."
        }
    }

    try {
        Set-Content -Path $windowHtml -Value $newContent -NoNewline -Encoding utf8
    } catch {
        Restore-Backup
        Die "Could not write patched window.html: $($_.Exception.Message)" 3
    }

    try {
        Copy-Item (Join-Path $SwiftDir $CssFile) $installedCss -Force
        Copy-Item (Join-Path $SwiftDir $JsFile)  $installedJs  -Force
    } catch {
        Restore-Backup
        Die "Could not deploy $CssFile / $JsFile into $vivaldiDir." 3
    }
    Ok "Patched window.html and deployed Swift files"

    # -------------------------------------------------------------------
    # 9. Verify the installed result, not just the staged content.
    # -------------------------------------------------------------------
    $verify = Get-Content -Path $windowHtml -Raw
    $vStart = Count-Occurrences $verify $MarkStart
    $vEnd   = Count-Occurrences $verify $MarkEnd
    if ($vStart -ne 1 -or $vEnd -ne 1) {
        Restore-Backup
        Die "Verification failed: installed window.html has START=$vStart END=$vEnd markers." 3
    }
    if (-not (Test-Path $installedCss) -or (Get-Item $installedCss).Length -eq 0) { Die "Verification failed: $CssFile missing at target." 3 }
    if (-not (Test-Path $installedJs)  -or (Get-Item $installedJs).Length -eq 0)  { Die "Verification failed: $JsFile missing at target." 3 }
    Ok "Verified installation"

    Write-Host ""
    Ok "Vivaldi Swift installed successfully."
    Info "Restart Vivaldi to see it. Rerun this command any time to update or reapply it."
}
finally {
    Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue
}
