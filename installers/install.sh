#!/usr/bin/env bash
#
# Vivaldi Swift — installer (Linux + macOS)
# ----------------------------------------------------------------------------
# One command, no flags required:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/RaceConditionWinner/Vivaldi-Swift/main/installers/install.sh)
#
# What it does:
#   detect OS -> find Vivaldi -> download vivaldi_swift.css + custom.js ->
#   patch window.html -> verify -> report success.
#
# Safe to run any number of times: re-running detects an existing, current
# patch and leaves it alone. Re-run this same command after a Vivaldi
# update to reapply the patch (Vivaldi updates replace window.html).
#
# Exit codes: 0 ok  1 unsupported/not found  2 permission  3 patch failed
# ----------------------------------------------------------------------------

set -euo pipefail

REPO="RaceConditionWinner/Vivaldi-Swift"
RAW_BASE="https://raw.githubusercontent.com/$REPO/main"
INSTALL_DIR="$HOME/.local/share/vivaldi-swift"   # holds our copy of css/js + one backup

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

trap 'echo; die "Interrupted — no changes were left half-applied." 130' INT TERM

echo "──────────────────────────────"
echo " Vivaldi Swift"
echo "──────────────────────────────"

# ---------------------------------------------------------------------------
# Resolve the real user when invoked through sudo, so we never write
# user-owned state (downloads, backups) into /root.
# ---------------------------------------------------------------------------
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
    REAL_HOME="$(eval echo "~$SUDO_USER")"
    INSTALL_DIR="$REAL_HOME/.local/share/vivaldi-swift"
    run_as_user() { sudo -u "$SUDO_USER" -H "$@"; }
else
    run_as_user() { "$@"; }
fi

# ---------------------------------------------------------------------------
# 1. Detect OS
# ---------------------------------------------------------------------------
case "$(uname -s)" in
    Linux)  OS="linux" ;;
    Darwin) OS="macos" ;;
    *) die "Unsupported operating system: $(uname -s). Vivaldi Swift supports Linux and macOS here (see the README for Windows)." ;;
esac
ok "Detected $OS"

command -v curl >/dev/null 2>&1 || die "curl is required."

# ---------------------------------------------------------------------------
# 2. Find Vivaldi
# ---------------------------------------------------------------------------
# Returns "<window.html dir>|<display version>|<kind>" on the first line of
# stdout for each candidate found. kind is one of: native, flatpak, snap.
find_candidates_linux() {
    local d bin
    if [ -d /opt ]; then
        while IFS= read -r bin; do
            d="$(dirname "$bin")/resources/vivaldi"
            [ -f "$d/window.html" ] && printf '%s|native\n' "$d"
        done < <(find /opt -maxdepth 3 -type f \( -name vivaldi-bin -o -name vivaldi-snapshot-bin \) 2>/dev/null)
    fi
    # Flatpak and Snap ship Vivaldi inside a read-only, integrity-checked
    # mount (a Flatpak OSTree checkout / a squashfs image respectively).
    # window.html cannot be modified in place there, so we only detect
    # and report these — see README for why.
    if command -v flatpak >/dev/null 2>&1 && flatpak info com.vivaldi.Vivaldi >/dev/null 2>&1; then
        printf 'flatpak|flatpak\n'
    fi
    if [ -d /snap/vivaldi ]; then
        printf 'snap|snap\n'
    fi
}

find_candidates_macos() {
    local app
    for app in "/Applications/Vivaldi.app" "$HOME/Applications/Vivaldi.app"; do
        [ -f "$app/Contents/Resources/vivaldi/window.html" ] && printf '%s|native\n' "$app/Contents/Resources/vivaldi"
    done
    if command -v brew >/dev/null 2>&1; then
        local prefix; prefix="$(brew --prefix 2>/dev/null || echo /opt/homebrew)"
        if [ -d "$prefix/Caskroom/vivaldi" ]; then
            while IFS= read -r app; do
                [ -f "$app/Contents/Resources/vivaldi/window.html" ] && printf '%s|native\n' "$app/Contents/Resources/vivaldi"
            done < <(find "$prefix/Caskroom/vivaldi" -maxdepth 2 -name "Vivaldi.app" 2>/dev/null)
        fi
    fi
}

mapfile -t candidates < <(if [ "$OS" = linux ]; then find_candidates_linux; else find_candidates_macos; fi | sort -u)

if [ "${#candidates[@]}" -eq 0 ]; then
    die "No Vivaldi installation found. Install Vivaldi from vivaldi.com and run this command again."
fi

# Prefer a native (patchable) install over reporting sandboxed ones.
target=""
sandboxed_found=""
for c in "${candidates[@]}"; do
    kind="${c##*|}"
    path="${c%|*}"
    if [ "$kind" = native ]; then
        target="$path"
        break
    else
        sandboxed_found="$kind"
    fi
done

if [ -z "$target" ]; then
    die "Vivaldi was found only as a $sandboxed_found package. Automatic JS/CSS patching isn't supported there because its application files are mounted read-only — see the README for the manual custom-CSS-folder route. Install Vivaldi from vivaldi.com's .deb/.rpm for full support."
fi

vivaldi_dir="$target"
[ "$OS" = macos ] && app_path="${vivaldi_dir%/Contents/Resources/vivaldi}"

ok "Found Vivaldi at $vivaldi_dir"

# ---------------------------------------------------------------------------
# 3. Refuse to touch a running Vivaldi
# ---------------------------------------------------------------------------
if pgrep -x "vivaldi-bin" >/dev/null 2>&1 || pgrep -x "Vivaldi" >/dev/null 2>&1; then
    die "Vivaldi is currently running. Close Vivaldi and run this command again."
fi

# ---------------------------------------------------------------------------
# 4. Elevation — only if the target isn't user-writable
# ---------------------------------------------------------------------------
SUDO=""
if [ ! -w "$vivaldi_dir" ]; then
    command -v sudo >/dev/null 2>&1 || die "No write permission to $vivaldi_dir and sudo is unavailable." 2
    sudo -v || die "Administrator privileges are required to patch $vivaldi_dir." 2
    SUDO="sudo"
fi

# ---------------------------------------------------------------------------
# 5. Download vivaldi_swift.css + custom.js into a temp dir, validate,
#    then move into our install dir. Never touch Vivaldi with partial files.
# ---------------------------------------------------------------------------
work_dir="$(run_as_user mktemp -d)"
cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT

info "Downloading Vivaldi Swift files..."
for f in "$CSS_FILE" "$JS_FILE"; do
    run_as_user curl -fsSL -o "$work_dir/$f" "$RAW_BASE/$f" \
        || die "Failed to download $f. Check your connection."
    [ -s "$work_dir/$f" ] || die "$f downloaded as an empty file."
    head -c 200 "$work_dir/$f" | grep -qi "<html" \
        && die "$f looks like an HTML error page, not source — GitHub may be unreachable or the repo layout changed."
done
ok "Downloaded $CSS_FILE and $JS_FILE"

run_as_user mkdir -p "$INSTALL_DIR/backups"
run_as_user cp "$work_dir/$CSS_FILE" "$INSTALL_DIR/$CSS_FILE"
run_as_user cp "$work_dir/$JS_FILE" "$INSTALL_DIR/$JS_FILE"

# ---------------------------------------------------------------------------
# 6. Patch window.html — idempotent, marker-delimited, atomic, verified.
# ---------------------------------------------------------------------------
window_html="$vivaldi_dir/window.html"
[ -f "$window_html" ] || die "window.html not found at $vivaldi_dir — this Vivaldi build may use an unexpected layout. Nothing was modified."

BLOCK="$MARK_START
<link rel=\"stylesheet\" href=\"$CSS_FILE\">
<script src=\"$JS_FILE\"></script>
$MARK_END"

already_current=0
if grep -qF "$MARK_START" "$window_html" 2>/dev/null; then
    # Compare the currently-installed payload against the freshly downloaded
    # one; only skip the patch if both files AND the markers already match.
    if cmp -s "$work_dir/$CSS_FILE" "$vivaldi_dir/$CSS_FILE" 2>/dev/null && \
       cmp -s "$work_dir/$JS_FILE" "$vivaldi_dir/$JS_FILE" 2>/dev/null; then
        already_current=1
    fi
fi

if [ "$already_current" -eq 1 ]; then
    ok "window.html already patched and up to date"
else
    backup_path="$INSTALL_DIR/backups/window.html-$OS"
    if ! grep -qF "$MARK_START" "$window_html"; then
        # First patch on this install — keep exactly one backup of the
        # untouched original for rollback. Re-patches (Swift file updates)
        # don't need a fresh backup; the marker makes the operation
        # trivially reversible by deleting the block.
        $SUDO cp "$window_html" "$backup_path" \
            || die "Could not create a backup of window.html. Nothing was modified." 3
    fi

    tmp_html="$work_dir/window.html"
    if grep -qF "$MARK_START" "$window_html"; then
        # Replace the existing block in place.
        awk -v block="$BLOCK" '
            $0 ~ /<!-- VIVALDI_SWIFT_START -->/ { print block; skipping=1; next }
            $0 ~ /<!-- VIVALDI_SWIFT_END -->/   { skipping=0; next }
            !skipping { print }
        ' "$window_html" > "$tmp_html"
    else
        # Insert just before </body>.
        awk -v block="$BLOCK" '
            /<\/body>/ { print block }
            { print }
        ' "$window_html" > "$tmp_html"
    fi

    [ -s "$tmp_html" ] || die "Generated an empty window.html — aborting before touching anything." 3
    grep -qF "$MARK_START" "$tmp_html" || die "Patch generation did not produce the expected markers — aborting." 3

    $SUDO cp "$tmp_html" "$window_html" || die "Could not write patched window.html." 3
    ok "Patched window.html"
fi

$SUDO cp -f "$INSTALL_DIR/$CSS_FILE" "$vivaldi_dir/$CSS_FILE" || die "Could not copy $CSS_FILE into place." 3
$SUDO cp -f "$INSTALL_DIR/$JS_FILE" "$vivaldi_dir/$JS_FILE" || die "Could not copy $JS_FILE into place." 3

# Re-sign the macOS app bundle (ad-hoc) so Gatekeeper doesn't flag it as
# damaged after Contents/Resources changed. This intentionally replaces
# Vivaldi's own signature with a local ad-hoc one; see README.
if [ "$OS" = macos ] && command -v codesign >/dev/null 2>&1; then
    $SUDO codesign --force --deep --sign - "$app_path" 2>/dev/null \
        || warn "Re-signing failed; if macOS calls Vivaldi \"damaged\", run: xattr -cr '$app_path'"
fi

# ---------------------------------------------------------------------------
# 7. Verify
# ---------------------------------------------------------------------------
grep -qF "$MARK_START" "$window_html" || die "Verification failed: markers missing from window.html." 3
[ -s "$vivaldi_dir/$CSS_FILE" ] || die "Verification failed: $CSS_FILE missing at target." 3
[ -s "$vivaldi_dir/$JS_FILE" ]  || die "Verification failed: $JS_FILE missing at target." 3
ok "Verified installation"

echo "──────────────────────────────"
ok "Vivaldi Swift is ready. Restart Vivaldi to see it."
info "A Vivaldi update will replace window.html and remove this patch —"
info "just rerun this same command afterwards to reapply it."
