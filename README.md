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
<img src="https://github.com/user-attachments/assets/8ef7915d-40f7-47e3-b427-14fc551db6f2" alt="Vivaldi Swift Browser UI" width="480"><br>
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

This CSS + JS mod gives the Vivaldi browser UI a liquid-glass redesign, plus automatically-resolved,
high-quality SVG icons for your Speed Dial cards — no uploading, positioning, or scaling required.

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


**Vivaldi Swift itself:** rerun the same install command above. It always fetches the current
`vivaldi_swift.css` and `custom.js` from this repository, updates the canonical copy under
`~/Vivaldi-Swift`, and redeploys it. If nothing has actually changed, it says so and exits without
touching anything.

## Custom Icons

Speed Dial icons are resolved automatically — there's nothing to upload, position, or scale.
Vivaldi Swift recovers each tile's target domain from Vivaldi's own favicon data and looks it up
against [theSVG](https://thesvg.org), a free, open-licensed icon CDN. A match is sanitized (the
same allowlist-based pass the old manual-upload feature used) and swapped in for the native
favicon; anything that can't be resolved — an unlisted site, a network hiccup — just keeps
Vivaldi's native favicon, automatically and silently. See [`icons/README.md`](icons/README.md)
for how the lookup and caching work.

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










