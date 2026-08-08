#!/usr/bin/env bash
#
# Vivaldi Swift — installer (Linux + macOS)
# ----------------------------------------------------------------------------
# One command, no flags required:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/Utkarsh-tiwari27/Vivaldi-Swift/main/installers/install.sh)
#
# What it does:
#   detect OS -> find Vivaldi -> download vivaldi_swift.css + custom.js into
#   ~/Vivaldi-Swift (the canonical local copy) -> validate -> patch
#   window.html -> verify -> report success.
#
# ~/Vivaldi-Swift is the source of truth for the locally installed payload;
# the copies inside Vivaldi's own resource directory are a deployed copy of
# it. A future repair tool can reuse ~/Vivaldi-Swift after a Vivaldi update
# without re-downloading anything — that repair tool is not implemented yet.
#
# Safe to run any number of times: re-running with nothing changed does
# nothing. Re-run this same command after a Vivaldi update to reapply the
# patch (Vivaldi updates replace window.html).
#
# Exit codes: 0 ok  1 unsupported/not found  2 permission  3 patch failed
# ----------------------------------------------------------------------------

set -euo pipefail

REPO="Utkarsh-tiwari27/Vivaldi-Swift"
RAW_BASE="https://raw.githubusercontent.com/$REPO/main"
CSS_FILE="vivaldi_swift.css"
JS_FILE="custom.js"
MARK_START="<!-- VIVALDI_SWIFT_START -->"
MARK_END="<!-- VIVALDI_SWIFT_END -->"

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_G=$'\033[32m'; C_R=$'\033[31m'; C_Y=$'\033[33m'; C_0=$'\033[0m'
else
    C_G=""; C_R=""; C_Y=""; C_0=""
fi
ok()   { echo "${C_G}✓${C_0} $*"; }
info() { echo "  $*"; }
warn() { echo "${C_Y}!${C_0} $*"; }
die()  { echo "${C_R}✗${C_0} $*" >&2; exit "${2:-1}"; }

echo "Vivaldi Swift Installer"
echo

# ---------------------------------------------------------------------------
# Test hooks (fixture testing only — normal use never sets these):
#   VIVALDI_SWIFT_TEST_HOME       overrides the resolved real home directory
#   VIVALDI_SWIFT_TEST_VIVALDI    overrides Vivaldi discovery with this path
#   VIVALDI_SWIFT_TEST_SOURCE     serves downloads from this local dir
#                                 instead of curl-ing GitHub
#   VIVALDI_SWIFT_TEST_SKIP_PROC  skip the "is Vivaldi running" check
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 0. Resolve the real desktop user's HOME — correct even when this script
#    itself is invoked through sudo (where $HOME would otherwise be /root),
#    and correct if the user pre-emptively ran the whole thing as root.
#    Everything under ~/Vivaldi-Swift is created as this user, always.
# ---------------------------------------------------------------------------
if [ -n "${VIVALDI_SWIFT_TEST_HOME:-}" ]; then
    REAL_USER="$(id -un)"
    REAL_HOME="$VIVALDI_SWIFT_TEST_HOME"
elif [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
    REAL_USER="$SUDO_USER"
    REAL_HOME="$(eval echo "~$SUDO_USER")"
elif [ "$(id -u)" -eq 0 ]; then
    die "Running this installer directly as root (not via sudo) isn't supported — there's no way to know which desktop user's Vivaldi to patch. Run it as your normal user; it will ask for sudo only if needed." 2
else
    REAL_USER="$(id -un)"
    REAL_HOME="$HOME"
fi
[ -d "$REAL_HOME" ] || die "Could not resolve a real home directory for $REAL_USER." 2

# Run a command as the real user (no-op if we're already that user).
run_as_user() {
    if [ "$(id -u)" -eq 0 ] && [ "$REAL_USER" != "$(id -un)" ]; then
        sudo -u "$REAL_USER" -H "$@"
    else
        "$@"
    fi
}

SWIFT_DIR="$REAL_HOME/Vivaldi-Swift"
BACKUP_DIR="$SWIFT_DIR/backups"
run_as_user mkdir -p "$SWIFT_DIR" "$BACKUP_DIR"

trap 'echo; die "Interrupted — no changes were left half-applied." 130' INT TERM

# ---------------------------------------------------------------------------
# 1. Detect OS
# ---------------------------------------------------------------------------
case "$(uname -s)" in
    Linux)  OS="linux" ;;
    Darwin) OS="macos" ;;
    *) die "Unsupported operating system: $(uname -s). Vivaldi Swift supports Linux and macOS here (see the README for Windows)." ;;
esac
command -v curl >/dev/null 2>&1 || die "curl is required."
ok "Detected $OS, installing for $REAL_USER (\$HOME=$REAL_HOME)"

# ---------------------------------------------------------------------------
# 2. Find Vivaldi. Emits "<window.html dir>|<kind>" per candidate found.
#    kind: native | flatpak | snap
# ---------------------------------------------------------------------------
find_candidates_linux() {
    local bin d
    if [ -d /opt ]; then
        while IFS= read -r bin; do
            d="$(dirname "$bin")/resources/vivaldi"
            [ -f "$d/window.html" ] && printf '%s|native\n' "$d"
        done < <(find /opt -maxdepth 3 -type f \( -name vivaldi-bin -o -name vivaldi-snapshot-bin \) 2>/dev/null)
    fi
    # Flatpak/Snap ship Vivaldi inside a read-only, integrity-checked mount
    # (an OSTree checkout / a squashfs image). window.html cannot be
    # modified in place there — detect and report, never attempt to write.
    if command -v flatpak >/dev/null 2>&1 && flatpak info com.vivaldi.Vivaldi >/dev/null 2>&1; then
        printf 'flatpak|flatpak\n'
    fi
    if [ -d /snap/vivaldi ]; then
        printf 'snap|snap\n'
    fi
}

find_candidates_macos() {
    local app prefix
    for app in "/Applications/Vivaldi.app" "$REAL_HOME/Applications/Vivaldi.app"; do
        [ -f "$app/Contents/Resources/vivaldi/window.html" ] && printf '%s|native\n' "$app/Contents/Resources/vivaldi"
    done
    if command -v brew >/dev/null 2>&1; then
        prefix="$(brew --prefix 2>/dev/null || echo /opt/homebrew)"
        if [ -d "$prefix/Caskroom/vivaldi" ]; then
            while IFS= read -r app; do
                [ -f "$app/Contents/Resources/vivaldi/window.html" ] && printf '%s|native\n' "$app/Contents/Resources/vivaldi"
            done < <(find "$prefix/Caskroom/vivaldi" -maxdepth 2 -name "Vivaldi.app" 2>/dev/null)
        fi
    fi
}

mapfile -t candidates < <(
    if [ -n "${VIVALDI_SWIFT_TEST_VIVALDI:-}" ]; then
        printf '%s|native\n' "$VIVALDI_SWIFT_TEST_VIVALDI"
    elif [ "$OS" = linux ]; then
        find_candidates_linux
    else
        find_candidates_macos
    fi | sort -u
)

if [ "${#candidates[@]}" -eq 0 ]; then
    die "No Vivaldi installation found. Install Vivaldi from vivaldi.com and run this command again."
fi

native_candidates=()
sandboxed_kind=""
for c in "${candidates[@]}"; do
    kind="${c##*|}"
    path="${c%|*}"
    if [ "$kind" = native ]; then native_candidates+=("$path"); else sandboxed_kind="$kind"; fi
done

if [ "${#native_candidates[@]}" -eq 0 ]; then
    die "Vivaldi was found only as a $sandboxed_kind package. Automatic JS/CSS patching isn't supported there because its application files are mounted read-only — see the README. Install Vivaldi from vivaldi.com's .deb/.rpm (or the .app build on macOS) for full support."
fi

if [ "${#native_candidates[@]}" -gt 1 ]; then
    warn "Multiple Vivaldi installations found — refusing to guess which one to patch:"
    for p in "${native_candidates[@]}"; do info "  $p"; done
    die "Remove or rename the installation you don't use, then rerun this command." 1
fi

vivaldi_dir="${native_candidates[0]}"
[ "$OS" = macos ] && app_path="${vivaldi_dir%/Contents/Resources/vivaldi}"
ok "Found Vivaldi at $vivaldi_dir"

# ---------------------------------------------------------------------------
# 3. Refuse to touch a running Vivaldi
# ---------------------------------------------------------------------------
if pgrep -x "vivaldi-bin" >/dev/null 2>&1 || pgrep -x "Vivaldi" >/dev/null 2>&1; then
    if [ -z "${VIVALDI_SWIFT_TEST_SKIP_PROC:-}" ]; then
        die "Vivaldi is currently running. Close Vivaldi fully and run this command again. Nothing was modified."
    fi
fi

# ---------------------------------------------------------------------------
# 4. Elevation — requested only for the Vivaldi-directory write itself,
#    never for discovery, download, or ~/Vivaldi-Swift.
# ---------------------------------------------------------------------------
NEEDS_SUDO=0
if [ ! -w "$vivaldi_dir" ]; then
    NEEDS_SUDO=1
    command -v sudo >/dev/null 2>&1 || die "No write permission to $vivaldi_dir and sudo is unavailable." 2
fi
sudo_if_needed() { if [ "$NEEDS_SUDO" -eq 1 ]; then sudo "$@"; else "$@"; fi }
if [ "$NEEDS_SUDO" -eq 1 ]; then
    sudo -v || die "Administrator privileges are required to patch $vivaldi_dir." 2
fi

# ---------------------------------------------------------------------------
# 5. Download into a temp dir, validate, THEN replace the canonical copies
#    under ~/Vivaldi-Swift. A failed download never touches a previously
#    working canonical payload.
# ---------------------------------------------------------------------------
work_dir="$(run_as_user mktemp -d)"
cleanup() { rm -rf "$work_dir" 2>/dev/null || true; }
trap cleanup EXIT

validate_payload() {
    local f="$1" label="$2"
    [ -s "$f" ] || die "$label downloaded as an empty file."
    head -c 200 "$f" | grep -qi "<html" \
        && die "$label looks like an HTML error page, not source — GitHub may be unreachable or the repo layout changed."
    return 0
}

info "Downloading Vivaldi Swift files..."
for f in "$CSS_FILE" "$JS_FILE"; do
    if [ -n "${VIVALDI_SWIFT_TEST_SOURCE:-}" ]; then
        cp "$VIVALDI_SWIFT_TEST_SOURCE/$f" "$work_dir/$f" 2>/dev/null \
            || die "Failed to download $f. Check your connection. The existing local copy under $SWIFT_DIR was not touched."
    else
        run_as_user curl -fsSL -o "$work_dir/$f" "$RAW_BASE/$f" \
            || die "Failed to download $f. Check your connection. The existing local copy under $SWIFT_DIR was not touched."
    fi
    validate_payload "$work_dir/$f" "$f"
done
ok "Downloaded and validated $CSS_FILE and $JS_FILE"

run_as_user cp "$work_dir/$CSS_FILE" "$SWIFT_DIR/$CSS_FILE"
run_as_user cp "$work_dir/$JS_FILE" "$SWIFT_DIR/$JS_FILE"
ok "Updated canonical copy at $SWIFT_DIR"

# ---------------------------------------------------------------------------
# 6. Patch window.html
# ---------------------------------------------------------------------------
window_html="$vivaldi_dir/window.html"
[ -f "$window_html" ] || die "window.html not found at $vivaldi_dir — this Vivaldi build may use an unexpected layout. Nothing was modified."
[ -r "$window_html" ] || die "window.html at $vivaldi_dir is not readable. Nothing was modified." 2
[ -s "$window_html" ] || die "window.html at $vivaldi_dir is empty — this looks like a broken Vivaldi install, not something to patch. Nothing was modified."

count_marker() { (grep -oF "$1" "$2" 2>/dev/null || true) | wc -l | tr -d ' '; }

start_count="$(count_marker "$MARK_START" "$window_html")"
end_count="$(count_marker "$MARK_END" "$window_html")"

case "${start_count}:${end_count}" in
    "0:0")   state="unpatched" ;;
    "1:1")   state="patched" ;;
    *)
        die "Cannot patch: window.html has a malformed Vivaldi Swift marker state (START=$start_count, END=$end_count). This needs a human to look at it — nothing was modified. If you have a backup under $BACKUP_DIR you can restore it manually and rerun this installer." 3
        ;;
esac

if [ "$state" = "unpatched" ]; then
    grep -qF "</body>" "$window_html" \
        || die "window.html doesn't contain a </body> tag — unexpected Vivaldi layout. Nothing was modified." 3
fi

BLOCK="$MARK_START
<link rel=\"stylesheet\" href=\"$CSS_FILE\">
<script src=\"$JS_FILE\"></script>
$MARK_END"

# ---------------------------------------------------------------------------
# 7. Idempotency check — skip the patch entirely if the installed payload
#    already matches what we just downloaded.
# ---------------------------------------------------------------------------
if [ "$state" = "patched" ] \
   && cmp -s "$work_dir/$CSS_FILE" "$vivaldi_dir/$CSS_FILE" 2>/dev/null \
   && cmp -s "$work_dir/$JS_FILE" "$vivaldi_dir/$JS_FILE" 2>/dev/null; then
    ok "Vivaldi Swift is already installed and up to date."
    echo
    ok "Nothing to do. Restart Vivaldi if you haven't already."
    exit 0
fi

# ---------------------------------------------------------------------------
# 8. Backup — keep exactly one, and never let a Swift-patched window.html
#    overwrite a clean original backup on reinstall.
# ---------------------------------------------------------------------------
backup_path="$BACKUP_DIR/window.html.orig-$OS"
if [ "$state" = "unpatched" ] && [ ! -f "$backup_path" ]; then
    run_as_user cp "$window_html" "$backup_path" \
        || die "Could not create a backup of window.html. Nothing was modified." 3
    ok "Backed up original window.html"
elif [ "$state" = "unpatched" ]; then
    info "Existing clean backup found — leaving it as-is."
fi

# ---------------------------------------------------------------------------
# 9. Generate the patched file in the temp dir (same filesystem as
#    $window_html isn't guaranteed, so this is a validated staged
#    replacement, not a true atomic rename across filesystems).
# ---------------------------------------------------------------------------
tmp_html="$work_dir/window.html"

if [ "$state" = "patched" ]; then
    awk -v block="$BLOCK" '
        $0 ~ /<!-- VIVALDI_SWIFT_START -->/ { print block; skipping=1; next }
        $0 ~ /<!-- VIVALDI_SWIFT_END -->/   { skipping=0; next }
        !skipping { print }
    ' "$window_html" > "$tmp_html"
else
    awk -v block="$BLOCK" '
        /<\/body>/ && !done { print block; done=1 }
        { print }
    ' "$window_html" > "$tmp_html"
fi

# ---------------------------------------------------------------------------
# 10. Validate the generated file before it ever touches the real target.
# ---------------------------------------------------------------------------
[ -s "$tmp_html" ] || die "Generated an empty window.html — aborting before touching anything." 3

gen_start="$(count_marker "$MARK_START" "$tmp_html")"
gen_end="$(count_marker "$MARK_END" "$tmp_html")"
gen_css="$( (grep -oF "href=\"$CSS_FILE\"" "$tmp_html" 2>/dev/null || true) | wc -l | tr -d ' ')"
gen_js="$( (grep -oF "src=\"$JS_FILE\"" "$tmp_html" 2>/dev/null || true) | wc -l | tr -d ' ')"

if [ "$gen_start" != "1" ] || [ "$gen_end" != "1" ] || [ "$gen_css" != "1" ] || [ "$gen_js" != "1" ]; then
    die "Patch generation did not produce exactly one marker/loader pair (START=$gen_start END=$gen_end CSS=$gen_css JS=$gen_js) — aborting. Nothing was modified." 3
fi

# The document must still plausibly be the same Vivaldi document — a crude
# but cheap sanity check against silent truncation.
orig_lines="$(wc -l < "$window_html" | tr -d ' ')"
new_lines="$(wc -l < "$tmp_html" | tr -d ' ')"
if [ "$new_lines" -lt "$orig_lines" ]; then
    die "Generated window.html has fewer lines ($new_lines) than the original ($orig_lines) — looks like content was truncated. Aborting. Nothing was modified." 3
fi

# ---------------------------------------------------------------------------
# 11. Staged replacement + copy of the CSS/JS payload, with rollback on
#     any failure from here on.
# ---------------------------------------------------------------------------
rollback() {
    warn "Rolling back window.html to the last known-good backup..."
    if [ -f "$backup_path" ]; then
        sudo_if_needed cp "$backup_path" "$window_html" \
            && ok "Rollback succeeded." \
            || warn "Rollback FAILED — window.html at $window_html may be inconsistent. Restore manually from $backup_path."
    else
        warn "No backup available to roll back to."
    fi
}

if ! sudo_if_needed cp "$tmp_html" "$window_html"; then
    rollback
    die "Could not write patched window.html." 3
fi

if ! sudo_if_needed cp -f "$SWIFT_DIR/$CSS_FILE" "$vivaldi_dir/$CSS_FILE" \
   || ! sudo_if_needed cp -f "$SWIFT_DIR/$JS_FILE" "$vivaldi_dir/$JS_FILE"; then
    rollback
    die "Could not deploy $CSS_FILE / $JS_FILE into $vivaldi_dir." 3
fi
ok "Patched window.html and deployed Swift files"

# Re-sign the macOS app bundle (ad-hoc) so Gatekeeper doesn't flag it as
# damaged after Contents/Resources changed. This intentionally replaces
# Vivaldi's own signature with a local ad-hoc one — it does not touch any
# other application or any system-wide security setting.
if [ "$OS" = macos ] && command -v codesign >/dev/null 2>&1; then
    if ! sudo_if_needed codesign --force --deep --sign - "$app_path" 2>/dev/null; then
        warn "Re-signing failed; if macOS calls Vivaldi \"damaged\", run: xattr -cr '$app_path'"
    fi
fi

# ---------------------------------------------------------------------------
# 12. Verify the installed result, not just the staged file.
# ---------------------------------------------------------------------------
final_start="$(count_marker "$MARK_START" "$window_html")"
final_end="$(count_marker "$MARK_END" "$window_html")"
if [ "$final_start" != "1" ] || [ "$final_end" != "1" ]; then
    rollback
    die "Verification failed: installed window.html has START=$final_start END=$final_end markers." 3
fi
[ -s "$vivaldi_dir/$CSS_FILE" ] || die "Verification failed: $CSS_FILE missing at target." 3
[ -s "$vivaldi_dir/$JS_FILE" ]  || die "Verification failed: $JS_FILE missing at target." 3
ok "Verified installation"

echo
ok "Vivaldi Swift installed successfully."
info "Restart Vivaldi to see it. Rerun this command any time to update or reapply it."
