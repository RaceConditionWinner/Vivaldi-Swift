<div align="center">

# Vivaldi Swift

**A frosted/liquid-glass redesign for the Vivaldi browser using custom CSS/JS mods.**

Refined spacing, glass surfaces, and custom high-quality Speed Dial icons.

[![Platform](https://img.shields.io/badge/platform-linux%20%7C%20macOS%20%7C%20windows-informational?style=flat-square)](#installation)
[![Vivaldi](https://img.shields.io/badge/vivaldi-6.0%2B-orange?style=flat-square)](https://vivaldi.com/download/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

<p>
<a href="#installation">Installation</a> •
<a href="#features">Features</a> •
<a href="#custom-icons">Custom Icons</a> •
<a href="#updating">Updating</a> •
<a href="#uninstalling">Uninstalling</a> •
<a href="#faq">FAQ</a>
</p>

</div>

<p align="center">
  <img
    src="https://github.com/user-attachments/assets/6300d09f-cc61-4149-9870-3c789e883129"
    alt="Vivaldi Swift Hero"
    width="400"
  />
</p>

<br>

<table align="center">
<tr>
<td align="center" width="50%">
<img src="https://github.com/user-attachments/assets/eb892458-3671-48e7-8064-c36609c62e05" alt="Vivaldi Swift Browser UI" width="480"><br>
<sub><b>Browser UI</b></sub>
</td>
<td align="center" width="50%">
<img src="https://github.com/user-attachments/assets/2287183f-f30b-47cc-b1fd-9af20c1f3a59" alt="Vivaldi Swift Speed Dial" width="480"><br>
<sub><b>Custom Speed Dial icon</b></sub>
</td>
</tr>
</table>

<br>

## Overview

This CSS + JS mod gives the Vivaldi browser UI a liquid-glass redesign, plus the ability to set
high-quality custom icons (SVG or PNG) for your Speed Dial cards, with per-icon position and scale.

## Installation

Copy the command for your OS, paste it into a terminal, press **Enter**. That's it — no flags,
no prompts, no manual paths to fill in.

### Linux / macOS

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Utkarsh-tiwari27/Vivaldi-Swift/main/installers/install.sh)
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/Utkarsh-tiwari27/Vivaldi-Swift/main/installers/install.ps1 | iex
```

The installer detects your Vivaldi installation, downloads `vivaldi_swift.css` and `custom.js`
into a canonical local folder, patches Vivaldi's UI to load them, verifies the result, and tells
you when it's done. If it needs administrator/root privileges to write to your Vivaldi install, it
will ask for them at that point — never for anything outside your Vivaldi installation.

Restart Vivaldi afterwards to see the change.

### Where files go

The installer keeps one canonical local copy of Vivaldi Swift under your home directory, and
deploys a copy of it into Vivaldi's own resource folder:

```
~/Vivaldi-Swift/              (%USERPROFILE%\Vivaldi-Swift on Windows)
├── custom.js                 ← canonical copy
├── vivaldi_swift.css         ← canonical copy
└── backups/
    └── window.html.orig      ← one backup of your original, untouched window.html

<Vivaldi resources>/
├── window.html                (patched)
├── custom.js                  (deployed copy)
└── vivaldi_swift.css          (deployed copy)
```

`~/Vivaldi-Swift` always belongs to your normal user account, even if the installer needed
`sudo`/administrator rights to reach the Vivaldi folder itself.

## Supported installations

| Type | Support |
|---|---|
| Linux — official `.deb` / `.rpm` (installs under `/opt`) | ✅ Full |
| macOS — `/Applications` or `~/Applications`, incl. Homebrew Cask | ✅ Full |
| Windows — per-user (`%LocalAppData%`) or per-machine (`Program Files`) | ✅ Full |
| Linux Snap | ❌ Not supported — Vivaldi's files are mounted read-only |
| Linux/macOS Flatpak | ❌ Not supported — same reason |

Snap and Flatpak builds sandbox Vivaldi's application files in a way that makes patching
`window.html` impossible without breaking the package's integrity checks. If you're on one of
these and want Vivaldi Swift, the most reliable path today is switching to the official `.deb`/`.rpm`
or `.app` build.

If more than one native Vivaldi installation is found (for example both a per-user and a
per-machine install on Windows, or Stable alongside Snapshot on Linux), the installer won't guess
— it lists what it found and asks you to remove or rename the one you don't use before rerunning.

## Updating

**Vivaldi Swift itself:** rerun the same install command above. It always fetches the current
`vivaldi_swift.css` and `custom.js` from this repository, updates the canonical copy under
`~/Vivaldi-Swift`, and redeploys it. If nothing has actually changed, it says so and exits without
touching anything.

**After Vivaldi updates:** a Vivaldi update replaces `window.html`, which removes the patch (this
is a Vivaldi limitation, not something Vivaldi Swift can prevent — see [FAQ](#faq)). Rerun the same
install command to reapply it. There is intentionally no background service watching for this; see
the FAQ for why. (A repair step that reuses the canonical `~/Vivaldi-Swift` copy automatically after
an update is planned but not implemented yet — today, rerunning the command is the update path.)

## Uninstalling

Vivaldi Swift is two files plus a small marked block in one Vivaldi file — there's no uninstall
script to keep in sync with the installer. To remove it:

1. Open `window.html` in your Vivaldi resources folder (see paths below) and delete everything
   between and including the `<!-- VIVALDI_SWIFT_START -->` and `<!-- VIVALDI_SWIFT_END -->` lines
   — or just restore it from the backup the installer made at
   `~/Vivaldi-Swift/backups/window.html.orig` (`%USERPROFILE%\Vivaldi-Swift\backups\window.html.orig`
   on Windows).
2. Delete `vivaldi_swift.css` and `custom.js` from that same Vivaldi resources folder.
3. Optionally delete the `~/Vivaldi-Swift` folder itself.
4. Restart Vivaldi.

Resource folder paths:
- Linux: `<install>/resources/vivaldi/` (e.g. `/opt/vivaldi/resources/vivaldi/`)
- macOS: `Vivaldi.app/Contents/Resources/vivaldi/`
- Windows: `...\Vivaldi\Application\<version>\resources\vivaldi\`

## Custom Icons

Right-click any Speed Dial tile → **Change Icon** to upload an SVG or PNG. Uploaded SVGs are
sanitized (scripts, event handlers, and external references are stripped) before use. Use
**Customize Layout** on the same menu to adjust icon size, position, padding, and scale; **Reset
Icon** / **Reset Layout** revert to defaults.

## FAQ

**Why does Vivaldi Swift stop working after I update Vivaldi?**
Vivaldi updates replace the versioned application folder — including `window.html`, the one file
Vivaldi Swift patches to load its CSS/JS. There's no supported way to inject a script into Vivaldi's
UI that survives that. Rerunning the install command takes a few seconds and reapplies the patch.

**Why isn't there a background updater that fixes this automatically?**
An earlier version of this project used one (a systemd/launchd/Scheduled-Task service polling for
changes). It added real complexity — a persistent process, timers, and its own failure modes — for
what is, in practice, an occasional one-line command. We'd rather you run that command than run a
daemon on your machine full-time. See the implementation notes in the repository history if you're
curious about the tradeoff.

**Does this work on Vivaldi Snapshot builds?**
Yes, as long as the Snapshot build is a native `.deb`/`.rpm`/`.app`/per-user or per-machine Windows
install — detection isn't channel-specific, it just needs a `window.html` it can write to.

**Is it safe to run the installer command multiple times?**
Yes — it's idempotent. Re-running it with nothing changed prints "Vivaldi Swift is already
installed and up to date" and exits without touching anything; re-running it after a Vivaldi
update or a Vivaldi Swift file update reapplies the patch cleanly, keeping exactly one marker
block and one backup.

## License

MIT — see [LICENSE](LICENSE).
