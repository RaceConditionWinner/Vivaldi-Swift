# Icons

Vivaldi Swift's Speed Dial custom icon system (`js/custom.js` →
`AssetManager` / `IconModal`) is entirely runtime: icons are uploaded
per-tile through **Right-click a Speed Dial card → Change Icon**,
sanitized and stored in the browser itself. `custom.js` never reads icon
files from disk or from this repository — there is no path it expects
here.

This `icons/` directory is just a convenient place to keep source SVG/PNG
assets you plan to upload through that flow (e.g. a personal icon pack).
It is copied into your install directory for reference, but nothing in
the patch or update engine depends on its contents.

## Quick rules

- SVGs are preferred over PNGs: they scale cleanly across the tile sizes
  the Speed Dial editor supports, and are automatically sanitized and
  ID-namespaced by `IconSanitizer` when uploaded.
- Keep icons visually consistent: single-color or duotone glyphs on a
  transparent background, centered within their viewBox, generally work
  best with the glass tile background.
- Do not commit trademarked or copyrighted icon sets without verifying
  their license permits redistribution. [thesvg.org](https://thesvg.org/)
  is a good source of open-licensed icons.
