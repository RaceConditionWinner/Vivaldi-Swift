/* ============================================================
   VIVALDI SWIFT — custom.js
   ============================================================

   RULES
   =====
   • NEVER touch .SpeedDial transform, left, top, z-index —
     these belong to Vivaldi's GPU layout pipeline.
   • NEVER replace or resize native Speed Dial nodes.
   • ALL customisation lives inside injected wrappers.
   • Vivaldi owns everything above .custom-layout-wrapper.
   • We own everything inside it.

   INJECTION HIERARCHY
   ===================
     .SpeedDial
       .thumbnail-favicon          ← Vivaldi's safe injection point
         .custom-layout-wrapper    ← padding · scale  (CSS vars)
           .custom-icon-wrapper    ← size · offset    (CSS vars)
             <svg> or <img>

   LAYOUT PROPERTIES (wrapper-scoped, no card mutations)
   ======================================================
     --custom-icon-size      icon diameter (px)
     --custom-icon-offset-x  horizontal nudge  (px)
     --custom-icon-offset-y  vertical nudge    (px)
     --custom-padding        thumbnail inset   (px)
     --custom-wrapper-scale  content scale     (unitless)

   Grouped by concern below: storage, icon sanitizing, asset
   handling, rendering/injection, the editing overlay, the
   context menu, the icon picker modal, and DOM observation.
   No version numbers here — git history is the changelog.
   ============================================================ */

"use strict";

console.log("[Vivaldi Swift] loading…");


/* ============================================================
   CONSTANTS
   ============================================================ */

const OBSERVER_DEBOUNCE_MS = 100;
const STORAGE_KEY = "vivaldi_swift";


/* ============================================================
   StorageManager
   ============================================================
   {
     tiles: {
       [tileId]: {
         icon?:   { type: "svg"|"png", data: string },
         layout?: {
           iconSize, iconOffsetX, iconOffsetY,
           thumbnailPadding, wrapperScale
         }
       }
     }
   }

   All layout properties are wrapper-scoped.
   No card-level position or size fields.

   This is the one storage schema Vivaldi Swift has ever needed
   to support going forward. Earlier builds used a different
   storage key and an older layout shape; that migration code
   has been removed; upgrading from one of those very old builds
   resets custom icons once, which is preferable to carrying
   permanent migration code for a handful of legacy users.
   ============================================================ */

const StorageManager = (() => {

    /** @type {{ tiles:Object.<string,object> }} */
    let _store = { tiles: {} };

    /** Frozen default layout — single allocation, never mutated. */
    const _DEFAULT_LAYOUT = Object.freeze({
        iconSize:         44,
        iconOffsetX:      0,
        iconOffsetY:      0,
        thumbnailPadding: 0,
        wrapperScale:     1.0,
    });

    /** Return a mutable copy of the default layout. */
    function _defaultLayout() { return { ..._DEFAULT_LAYOUT }; }

    /** True when layout differs from defaults (warrants keeping in storage). */
    function _layoutIsCustom(layout) {
        if (!layout) return false;
        // Guard against NaN/non-finite values that could slip in from corrupted storage
        const safe = (v, def) => Number.isFinite(v) ? v : def;
        return (
            safe(layout.iconSize,         44)  !== 44  ||
            safe(layout.iconOffsetX,       0)  !== 0   ||
            safe(layout.iconOffsetY,       0)  !== 0   ||
            safe(layout.thumbnailPadding,  0)  !== 0   ||
            safe(layout.wrapperScale,    1.0)  !== 1.0
        );
    }

    /** Hydrate from chrome.storage.local. */
    async function init() {
        try {
            const result = await chrome.storage.local.get(STORAGE_KEY);
            const raw = result[STORAGE_KEY];

            if (raw?.tiles && typeof raw.tiles === "object") {
                _store = { tiles: {} };
                for (const [id, rec] of Object.entries(raw.tiles)) {
                    const valid = _validateRecord(rec);
                    if (valid) _store.tiles[id] = valid;
                }
            } else {
                _store = { tiles: {} };
            }
            const n = Object.keys(_store.tiles).length;
            console.log(`[Vivaldi Swift] Hydrated — ${n} tile record(s).`);
        } catch (e) {
            console.error("[Vivaldi Swift] Storage init failed:", e);
            _store = { tiles: {} };
        }
    }

    /**
     * Validate a single tile record from external storage.
     * Returns a clean record or null if the record is unsalvageable.
     */
    function _validateRecord(rec) {
        if (!rec || typeof rec !== "object") return null;
        const out = {};

        // Validate icon
        if (rec.icon && typeof rec.icon === "object") {
            const { type, data } = rec.icon;
            if ((type === "svg" || type === "png") &&
                typeof data === "string" &&
                data.length > 0 &&
                data.length < 5_000_000) {         // 5 MB hard cap
                out.icon = { type, data };
            }
        }

        // Validate layout (numeric fields only)
        if (rec.layout && typeof rec.layout === "object") {
            const l = rec.layout;
            const num = (v, def) => Number.isFinite(Number(v)) ? Number(v) : def;
            out.layout = {
                iconSize:         num(l.iconSize,         44),
                iconOffsetX:      num(l.iconOffsetX,       0),
                iconOffsetY:      num(l.iconOffsetY,       0),
                thumbnailPadding: num(l.thumbnailPadding,  0),
                wrapperScale:     num(l.wrapperScale,    1.0),
            };
        }

        return Object.keys(out).length ? out : null;
    }

    function _persist() {
        chrome.storage.local
            .set({ [STORAGE_KEY]: _store })
            .catch(e => console.error("[Vivaldi Swift] Persist failed:", e));
    }

    /* ── Full-record accessors ─────────────────────────────── */

    function get(id)    { return _store.tiles[id] || null; }
    function has(id)    { return !!_store.tiles[id]; }
    function remove(id) { if (id in _store.tiles) { delete _store.tiles[id]; _persist(); } }

    async function clear() {
        _store = { tiles: {} };
        try   { await chrome.storage.local.remove(STORAGE_KEY); }
        catch (e) { console.error("[Vivaldi Swift] Clear failed:", e); }
    }

    /* ── Icon accessors ────────────────────────────────────── */

    function getIcon(id)    { return _store.tiles[id]?.icon || null; }
    function hasIcon(id)    { return !!_store.tiles[id]?.icon; }

    function setIcon(id, icon) {
        if (!_store.tiles[id]) _store.tiles[id] = {};
        _store.tiles[id].icon = icon;
        _persist();
    }

    function removeIcon(id) {
        if (!_store.tiles[id]) return;
        delete _store.tiles[id].icon;
        // Prune record if layout is also default/absent
        if (!_layoutIsCustom(_store.tiles[id].layout)) {
            delete _store.tiles[id];
        }
        _persist();
    }

    /* ── Layout accessors ──────────────────────────────────── */

    function getLayout(id) {
        return { ..._defaultLayout(), ...(_store.tiles[id]?.layout || {}) };
    }

    function hasCustomLayout(id) {
        return _layoutIsCustom(_store.tiles[id]?.layout);
    }

    function setLayout(id, layout) {
        if (!_store.tiles[id]) _store.tiles[id] = {};
        _store.tiles[id].layout = { ..._defaultLayout(), ...layout };
        _persist();
    }

    function resetLayout(id) {
        if (!_store.tiles[id]) return;
        delete _store.tiles[id].layout;
        if (!_store.tiles[id].icon) delete _store.tiles[id];
        _persist();
    }

    return {
        init,
        get, has, remove, clear,
        getIcon, hasIcon, setIcon, removeIcon,
        getLayout, hasCustomLayout, setLayout, resetLayout,
        defaultLayout: _defaultLayout,
    };

})();


/* ============================================================
   PHASE 3 — IconSanitizer  (upgraded)
   ============================================================
   Security pass unchanged (allowlist, blocklist, attr scrub).
   Enhancements:
     • Removes width/height from SVG root (CSS controls sizing).
     • Sets preserveAspectRatio="xMidYMid meet".
     • Preserves viewBox; generates fallback from w/h before removal.
     • sanitize(raw, idPrefix) namespaces IDs when prefix supplied;
       called by Renderer at injection time.
   ============================================================ */

const IconSanitizer = (() => {

    const ALLOWED = new Set([
        "svg","g","defs","symbol","use","title","desc",
        "path","circle","ellipse","rect","line","polyline","polygon",
        "lineargradient","radialgradient","stop",
        "mask","clippath",
        "filter","fegaussianblur","feblend","fecolormatrix",
        "fecomponenttransfer","fecomposite","feconvolvematrix",
        "fediffuselighting","fedisplacementmap","fedistantlight",
        "feflood","fefunca","fefuncb","fefuncg","fefuncr",
        "feimage","femerge","femergenode","femorphology",
        "feoffset","fepointlight","fespecularlighting",
        "fespotlight","fetile","feturbulence",
        "text","tspan","textpath",
        "image","marker","pattern",
    ]);

    const BLOCKED = new Set([
        "script","foreignobject","iframe","object","embed",
        "link","style","html","head","body","base","meta",
        "applet","frame","frameset",
    ]);

    function _walk(node) {
        for (let i = node.children.length - 1; i >= 0; i--) {
            const child = node.children[i];
            const tag   = child.tagName.toLowerCase();
            if (BLOCKED.has(tag))  { node.removeChild(child); continue; }
            if (!ALLOWED.has(tag)) { node.removeChild(child); continue; }
            _walk(child);
        }
        _scrubAttrs(node);
    }

    function _scrubAttrs(el) {
        for (const attr of Array.from(el.attributes)) {
            const name  = attr.name.toLowerCase();
            const value = attr.value;

            if (/^on/i.test(name)) { el.removeAttribute(attr.name); continue; }

            if (name === "href" || name === "xlink:href" || name === "action") {
                if (!value.startsWith("#") && value.trim() !== "") {
                    el.removeAttribute(attr.name); continue;
                }
            }

            if (name === "src") {
                if (!value.startsWith("#") && !/^data:image\//i.test(value)) {
                    el.removeAttribute(attr.name); continue;
                }
            }

            if (/javascript:/i.test(value) || /vbscript:/i.test(value)) {
                el.removeAttribute(attr.name); continue;
            }

            if (name === "style") {
                const cleaned = value
                    .replace(/url\s*\(\s*['"]?\s*(?:javascript|vbscript)[^)]*['"]?\s*\)/gi, "url(#)")
                    .replace(/url\s*\(\s*['"]?\s*data:(?!image\/(?:png|jpeg|gif|webp|svg\+xml))[^)]*['"]?\s*\)/gi, "url(#)");
                if (cleaned !== value) el.setAttribute("style", cleaned);
            }
        }
    }

    /**
     * Prefix all id attributes and cross-references within an SVG element.
     * Prevents ID collisions when multiple SVGs are injected into the page.
     * @param {SVGElement} svgEl
     * @param {string}     prefix
     */
    function _namespaceIds(svgEl, prefix) {
        const idMap = new Map();

        // Pass 1 — collect and rename id attributes
        svgEl.querySelectorAll("[id]").forEach(el => {
            const old = el.getAttribute("id");
            const nw  = prefix + old;
            idMap.set(old, nw);
            el.setAttribute("id", nw);
        });

        if (!idMap.size) return;

        const REF_ATTRS = [
            "fill","stroke","filter","clip-path","mask",
            "marker-start","marker-mid","marker-end",
        ];

        // Pass 2 — update cross-references
        svgEl.querySelectorAll("*").forEach(el => {
            // url(#id) attribute references
            REF_ATTRS.forEach(attr => {
                const v = el.getAttribute(attr);
                if (v?.startsWith("url(#")) {
                    const ref = v.slice(5, -1);
                    if (idMap.has(ref)) el.setAttribute(attr, `url(#${idMap.get(ref)})`);
                }
            });

            // href / xlink:href fragment references
            ["href", "xlink:href"].forEach(attr => {
                const v = el.getAttribute(attr);
                if (v?.startsWith("#")) {
                    const ref = v.slice(1);
                    if (idMap.has(ref)) el.setAttribute(attr, `#${idMap.get(ref)}`);
                }
            });

            // url() inside style attributes
            const style = el.getAttribute("style");
            if (style) {
                let s = style;
                idMap.forEach((nw, old) => {
                    s = s.replace(
                        new RegExp(
                            `url\\(#${old.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&")}\\)`,
                            "g"
                        ),
                        `url(#${nw})`
                    );
                });
                if (s !== style) el.setAttribute("style", s);
            }
        });
    }

    /**
     * Sanitize a raw SVG string.
     * @param {string} raw      — untrusted SVG source
     * @param {string} idPrefix — optional ID namespace prefix (applied after sanitize)
     * @returns {string}        — clean SVG markup
     * @throws  {Error}         — on parse error or missing <svg> root
     */
    function sanitize(raw, idPrefix = "") {
        const parser = new DOMParser();
        const doc    = parser.parseFromString(raw, "image/svg+xml");

        if (doc.querySelector("parsererror")) throw new Error("SVG parse error");

        const svgEl = doc.documentElement;
        if (!svgEl || svgEl.tagName.toLowerCase() !== "svg") {
            throw new Error("No SVG root element found");
        }

        // Capture dimensions before removal (needed for fallback viewBox)
        const rawW = svgEl.getAttribute("width");
        const rawH = svgEl.getAttribute("height");

        // Security pass
        _walk(svgEl);

        // Preserve or generate viewBox
        let viewBox = svgEl.getAttribute("viewBox");
        if (!viewBox) {
            const w = parseFloat(rawW) || 512;
            const h = parseFloat(rawH) || 512;
            viewBox = `0 0 ${w} ${h}`;
        }

        // Remove dimensional attributes — CSS/renderer controls sizing
        svgEl.removeAttribute("width");
        svgEl.removeAttribute("height");

        // Enforce aspect ratio and viewBox
        svgEl.setAttribute("viewBox", viewBox);
        svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");

        // Namespace IDs if a prefix was supplied
        if (idPrefix) _namespaceIds(svgEl, idPrefix);

        return new XMLSerializer().serializeToString(svgEl);
    }

    return { sanitize, namespaceIds: _namespaceIds };

})();


/* ============================================================
   PHASE 2 — AssetManager
   ============================================================
   Validates and normalises SVG and PNG assets before they are
   handed to the Renderer or stored.  Does NOT merge into
   IconModal or IconSanitizer.
   ============================================================ */

const AssetManager = (() => {

    /** Max PNG file size accepted for storage (post-resize the data URL
     *  will be much smaller, but we gate the raw upload here). */
    const MAX_PNG_BYTES = 4 * 1024 * 1024;  // 4 MB
    /** Maximum icon dimension in pixels after PNG normalisation. */
    const PNG_RENDER_DIM = 128;

    /**
     * Validate and normalise a raw SVG string.
     * Returns a renderer-ready asset object.
     * @param  {string} raw
     * @returns {{ type:"svg", data:string }}
     * @throws {Error}
     */
    function normalizeSVG(raw) {
        // Sanitize without an ID prefix — namespacing happens at render time.
        const clean = IconSanitizer.sanitize(raw);
        return { type: "svg", data: clean };
    }

    /**
     * Validate and normalise a PNG/JPEG/WebP File.
     * Uses createImageBitmap for off-thread decode, then draws to canvas.
     * Returns a data-URL-backed asset object.
     * @param  {File} file
     * @returns {Promise<{ type:"png", data:string }>}
     */
    function normalizePNG(file) {
        return new Promise((resolve, reject) => {
            if (file.type === "image/svg+xml") {
                reject(new Error("Use the SVG tab for SVG files.")); return;
            }
            if (!file.type.startsWith("image/")) {
                reject(new Error("File is not a recognised image format.")); return;
            }
            if (file.size > MAX_PNG_BYTES) {
                reject(new Error(`Image exceeds 4 MB limit (${(file.size/1048576).toFixed(1)} MB).`)); return;
            }

            // createImageBitmap decodes off the main thread (where supported)
            // and avoids the base64 round-trip of FileReader.readAsDataURL.
            const objectURL = URL.createObjectURL(file);
            createImageBitmap(file)
                .then(bitmap => {
                    URL.revokeObjectURL(objectURL);
                    const scale = Math.min(1, PNG_RENDER_DIM / Math.max(bitmap.width, bitmap.height));
                    const w     = Math.max(1, Math.round(bitmap.width  * scale));
                    const h     = Math.max(1, Math.round(bitmap.height * scale));

                    const canvas = document.createElement("canvas");
                    canvas.width  = w;
                    canvas.height = h;
                    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
                    bitmap.close();   // free GPU/memory resource immediately

                    resolve({ type: "png", data: canvas.toDataURL("image/png") });
                })
                .catch(() => {
                    // createImageBitmap not available or decode failed — fall back
                    URL.revokeObjectURL(objectURL);
                    const reader    = new FileReader();
                    reader.onerror  = () => reject(new Error("Failed to read file."));
                    reader.onload   = (e) => {
                        const img    = new Image();
                        img.onerror  = () => reject(new Error("Image could not be decoded."));
                        img.onload   = () => {
                            const scale = Math.min(1, PNG_RENDER_DIM / Math.max(img.width, img.height));
                            const w     = Math.max(1, Math.round(img.width  * scale));
                            const h     = Math.max(1, Math.round(img.height * scale));
                            const canvas = document.createElement("canvas");
                            canvas.width  = w;
                            canvas.height = h;
                            canvas.getContext("2d").drawImage(img, 0, 0, w, h);
                            resolve({ type: "png", data: canvas.toDataURL("image/png") });
                        };
                        img.src = e.target.result;
                    };
                    reader.readAsDataURL(file);
                });
        });
    }

    /**
     * Build a preview DOM element for insertion into .swift-preview-tile.
     * Uses a fixed 44 px size — matches default icon dimensions.
     * @param  {{ type:string, data:string }} asset
     * @returns {HTMLElement}
     */
    function preparePreview(asset) {
        if (asset.type === "svg") {
            const wrap = document.createElement("div");
            wrap.className = "custom-icon-wrapper custom-icon-wrapper--svg";
            wrap.innerHTML = asset.data;
            const svgEl = wrap.querySelector("svg");
            if (svgEl) {
                svgEl.style.cssText = "display:block;width:44px;height:44px;flex-shrink:0;";
            }
            return wrap;
        }

        if (asset.type === "png") {
            const wrap = document.createElement("div");
            wrap.className = "custom-icon-wrapper custom-icon-wrapper--png";
            const img      = document.createElement("img");
            img.src        = asset.data;
            img.alt        = "";
            img.draggable  = false;
            img.style.cssText = "display:block;width:44px;height:44px;object-fit:contain;flex-shrink:0;";
            wrap.appendChild(img);
            return wrap;
        }

        throw new Error(`Unknown asset type: "${asset.type}"`);
    }

    return { normalizeSVG, normalizePNG, preparePreview };

})();


/* ============================================================
   HELPERS
   ============================================================ */

/**
 * Return the icon host container for a tile.
 * Single combined selector — one DOM traversal instead of two.
 * @param   {Element} tile
 * @returns {Element|null}
 */
function getContainer(tile) {
    return tile.querySelector(".thumbnail-favicon, .thumbnail-favicon-folder");
}

/**
 * Return a tile's Vivaldi-assigned data-id, or null.
 * @param   {Element} tile
 * @returns {string|null}
 */
function getTileId(tile) { return tile.dataset.id || null; }

/**
 * Generate a safe ID namespace prefix from a tile ID.
 * Deterministic so the same tile always gets the same prefix.
 * @param {string} tileId
 * @returns {string}
 */
function _idPrefix(tileId) {
    const slug = (tileId || "x")
        .slice(-8)
        .replace(/[^a-zA-Z0-9]/g, "_");
    return `sd4-${slug}-`;
}


/* ============================================================
   Renderer
   ============================================================
   renderLayoutWrapper()  Create .custom-layout-wrapper.
   renderSVG()            Create .custom-icon-wrapper with inline SVG.
   renderPNG()            Create .custom-icon-wrapper with <img>.
   applyLayout()          Set --custom-padding / --custom-wrapper-scale
                          on the layout wrapper.
   applyTransforms()      Set --custom-icon-size / --custom-icon-offset-*
                          on the icon wrapper.

   RULE: Neither applyLayout nor applyTransforms may touch
   .SpeedDial or any of its native attributes.
   ============================================================ */

const Renderer = (() => {

    /* Styles applied to .custom-layout-wrapper at injection time.
       Lives inside .thumbnail-favicon (position:static, overflow:hidden)
       so injectTile() first promotes the container to position:relative. */
    const LAYOUT_WRAPPER_BASE = {
        position:        "absolute",
        inset:           "0",
        display:         "flex",
        alignItems:      "center",
        justifyContent:  "center",
        pointerEvents:   "none",
        zIndex:          "1",
        overflow:        "visible",
    };

    /* Styles applied to .custom-icon-wrapper.
       It is a flex-child of the layout wrapper, NOT absolutely positioned.
       Width / height are driven by --custom-icon-size via CSS. */
    const ICON_WRAPPER_BASE = {
        position:    "relative",
        display:     "flex",
        alignItems:  "center",
        justifyContent: "center",
        pointerEvents: "none",
        flexShrink:  "0",
        overflow:    "visible",
    };

    /** Create an empty .custom-layout-wrapper. */
    function renderLayoutWrapper() {
        const wrap     = document.createElement("div");
        wrap.className = "custom-layout-wrapper";
        Object.assign(wrap.style, LAYOUT_WRAPPER_BASE);
        return wrap;
    }

    /**
     * Create a .custom-icon-wrapper containing an inline SVG.
     * IDs are namespaced by idPrefix to avoid global collisions.
     */
    function renderSVG(svgString, idPrefix) {
        const wrap     = document.createElement("div");
        wrap.className = "custom-icon-wrapper custom-icon-wrapper--svg";
        Object.assign(wrap.style, ICON_WRAPPER_BASE);
        wrap.innerHTML = svgString;

        const svgEl = wrap.querySelector("svg");
        if (svgEl) {
            svgEl.style.cssText = "display:block;width:100%;height:100%;flex-shrink:0;";
            if (idPrefix) _namespaceInPlace(svgEl, idPrefix);
        }

        return wrap;
    }

    /**
     * Apply ID namespacing to a live SVG element already in the page DOM.
     * The SVG is already sanitized — skip the full sanitize round-trip and
     * call the namespace pass directly.  This eliminates:
     *   XMLSerializer → full sanitize (parse + walk + serialize) → DOMParser
     * and replaces it with a single in-place DOM mutation pass.
     */
    function _namespaceInPlace(svgEl, prefix) {
        IconSanitizer.namespaceIds(svgEl, prefix);
    }

    /** Create a .custom-icon-wrapper containing an <img> for PNG assets. */
    function renderPNG(dataUrl) {
        const wrap     = document.createElement("div");
        wrap.className = "custom-icon-wrapper custom-icon-wrapper--png";
        Object.assign(wrap.style, ICON_WRAPPER_BASE);

        const img      = document.createElement("img");
        img.src        = dataUrl;
        img.alt        = "";
        img.draggable  = false;
        img.style.cssText = "display:block;width:100%;height:100%;object-fit:contain;flex-shrink:0;";
        wrap.appendChild(img);
        return wrap;
    }

    /**
     * Apply layout properties to the .custom-layout-wrapper
     * exclusively via CSS custom properties.
     * NEVER called on .SpeedDial.
     * @param {HTMLElement} layoutWrapper
     * @param {object}      layout
     */
    function applyLayout(layoutWrapper, layout) {
        if (!layoutWrapper || !layout) return;
        layoutWrapper.style.setProperty(
            "--custom-padding",       `${layout.thumbnailPadding || 0}px`
        );
        layoutWrapper.style.setProperty(
            "--custom-wrapper-scale", String(layout.wrapperScale || 1.0)
        );
    }

    /**
     * Apply icon-level transforms to the .custom-icon-wrapper
     * exclusively via CSS custom properties.
     * @param {HTMLElement} iconWrapper
     * @param {object}      layout
     */
    function applyTransforms(iconWrapper, layout) {
        if (!iconWrapper || !layout) return;
        iconWrapper.style.setProperty(
            "--custom-icon-size",     `${layout.iconSize    || 44}px`
        );
        iconWrapper.style.setProperty(
            "--custom-icon-offset-x", `${layout.iconOffsetX || 0}px`
        );
        iconWrapper.style.setProperty(
            "--custom-icon-offset-y", `${layout.iconOffsetY || 0}px`
        );
    }

    return { renderLayoutWrapper, renderSVG, renderPNG, applyLayout, applyTransforms };

})();


/* ============================================================
   INJECTION ENGINE
   ============================================================
   injectTile()   — idempotent; builds wrapper hierarchy.
   reinjectTile() — clears guard, tears down wrappers, re-injects.
   scanTiles()    — iterates every .SpeedDial in the document.

   RULE: injectTile never reads or writes .SpeedDial.style.
   All customisation targets .thumbnail-favicon and its children.
   ============================================================ */

/**
 * Inject the wrapper hierarchy into a single tile.
 * Structure after injection:
 *   .thumbnail-favicon (position:relative)
 *     .custom-layout-wrapper  (abs fill, CSS vars: padding, scale)
 *       .custom-icon-wrapper  (flex child, CSS vars: size, offsets)
 *         svg | img
 *
 * @param {Element} tile — .SpeedDial element
 */
function injectTile(tile) {
    if (tile.dataset.sdInjected) return;

    const tileId = getTileId(tile);
    if (!tileId) return;

    tile.dataset.sdInjected = "1";

    const record = StorageManager.get(tileId);
    if (!record?.icon) return;   // No custom icon — leave native favicon alone.

    const container = getContainer(tile);
    if (!container) return;

    // .thumbnail-favicon is position:static by default;
    // promote to relative so our absolute wrapper is contained by it.
    container.style.position = "relative";

    // Hide native favicon.
    const favicon = tile.querySelector(".favicon");
    if (favicon) favicon.style.opacity = "0";

    // Suppress folder preview children.
    const folderKids = container.querySelector(".thumbnail-favicon-children");
    if (folderKids) {
        folderKids.style.opacity       = "0";
        folderKids.style.pointerEvents = "none";
    }

    // Remove any prior injection.
    container.querySelector(".custom-layout-wrapper")?.remove();
    container.querySelector(".custom-icon-wrapper")?.remove();
    container.querySelector(".custom-svg-icon")?.remove();

    // Build the hierarchy.
    const layoutWrapper = Renderer.renderLayoutWrapper();
    const icon          = record.icon;
    const prefix        = _idPrefix(tileId);
    const iconWrapper   = (icon.type === "svg")
        ? Renderer.renderSVG(icon.data, prefix)
        : Renderer.renderPNG(icon.data);

    layoutWrapper.appendChild(iconWrapper);
    container.appendChild(layoutWrapper);

    // Apply layout via CSS custom properties — zero card-level side effects.
    const layout = record.layout || StorageManager.defaultLayout();
    Renderer.applyLayout(layoutWrapper, layout);
    Renderer.applyTransforms(iconWrapper, layout);
}

/**
 * Clear injection state, remove wrappers, restore native state, re-inject.
 * Call after StorageManager writes to apply changes to the live DOM.
 * NEVER modifies .SpeedDial.style — Vivaldi owns the card.
 * @param {Element} tile
 */
function reinjectTile(tile) {
    delete tile.dataset.sdInjected;

    const container = getContainer(tile);
    if (container) {
        container.querySelector(".custom-layout-wrapper")?.remove();
        container.querySelector(".custom-icon-wrapper")?.remove();
        container.querySelector(".custom-svg-icon")?.remove();

        const favicon = tile.querySelector(".favicon");
        if (favicon) favicon.style.opacity = "";

        const folderKids = container.querySelector(".thumbnail-favicon-children");
        if (folderKids) {
            folderKids.style.opacity       = "";
            folderKids.style.pointerEvents = "";
        }
    }

    injectTile(tile);
}

/**
 * Scan all .SpeedDial tiles in the document.
 * Synchronous — reads from in-memory StorageManager cache only.
 */
function scanTiles() {
    for (const tile of document.querySelectorAll(".SpeedDial")) {
        injectTile(tile);
    }
}


/* ============================================================
   PHASE 6 — IconModal  (dual SVG / PNG)
   ============================================================
   Self-contained modal lifecycle with two-tab picker flow.
   Both SVG and PNG paths converge into the same preview + apply
   pipeline via AssetManager.
   ============================================================ */

const IconModal = (() => {

    let _el           = null;
    let _activeTile   = null;
    let _pendingAsset = null;  // { type, data } awaiting Apply
    let _activeTab    = "svg"; // "svg" | "png"

    /** Cached DOM element refs — populated once at init(), never repeated. */
    let _dom = null;

    function init() {
        _el = _buildDOM();
        document.body.appendChild(_el);
        _cacheDOM();
        _bindEvents();
    }

    /** Cache all static element references after DOM is built. */
    function _cacheDOM() {
        _dom = {
            overlay:     _el,
            dialog:      _el.querySelector(".swift-modal-dialog"),
            title:       _el.querySelector("#swift-modal-title"),
            closeBtn:    _el.querySelector("#swift-modal-close"),
            tabBar:      _el.querySelector("#swift-tab-bar"),
            pickerPane:  _el.querySelector("#swift-picker-pane"),
            dropZone:    _el.querySelector("#swift-drop-zone"),
            dropTitle:   _el.querySelector("#swift-drop-title"),
            fileInput:   _el.querySelector("#swift-file-input"),
            previewPane: _el.querySelector("#swift-preview-pane"),
            previewTile: _el.querySelector("#swift-preview-tile"),
            validation:  _el.querySelector("#swift-validation"),
            reselectBtn: _el.querySelector("#swift-reselect-btn"),
            cancelBtn:   _el.querySelector("#swift-cancel-btn"),
            applyBtn:    _el.querySelector("#swift-apply-btn"),
        };
    }

    /* ── DOM construction ──────────────────────────────────── */

    function _buildDOM() {
        const el     = document.createElement("div");
        el.id        = "swift-icon-modal";
        el.className = "swift-modal-overlay";

        el.innerHTML = `
<div class="swift-modal-dialog" role="dialog" aria-modal="true"
     aria-labelledby="swift-modal-title" tabindex="-1">

  <div class="swift-modal-header">
    <h2 class="swift-modal-title" id="swift-modal-title">Change Icon</h2>
    <button class="swift-modal-close" id="swift-modal-close" aria-label="Close">
      <svg viewBox="0 0 14 14" fill="none">
        <path d="M1 1l12 12M13 1L1 13" stroke="currentColor"
              stroke-width="1.75" stroke-linecap="round"/>
      </svg>
    </button>
  </div>

  <div class="swift-tab-bar" id="swift-tab-bar" role="tablist">
    <button class="swift-tab swift-tab--active" id="swift-tab-svg"
            role="tab" aria-selected="true" data-tab="svg">
      <svg class="swift-tab-icon" viewBox="0 0 14 14" fill="none">
        <rect x="1" y="1" width="12" height="12" rx="1.5"
              stroke="currentColor" stroke-width="1.2"/>
        <path d="M4 9l2-4 2 4M9 5v4"
              stroke="currentColor" stroke-width="1.2"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      SVG
    </button>
    <button class="swift-tab" id="swift-tab-png"
            role="tab" aria-selected="false" data-tab="png">
      <svg class="swift-tab-icon" viewBox="0 0 14 14" fill="none">
        <rect x="1" y="1" width="12" height="12" rx="1.5"
              stroke="currentColor" stroke-width="1.2"/>
        <circle cx="4.5" cy="4.5" r="1.2" fill="currentColor"/>
        <path d="M1.5 9.5L4 7l2.5 2 2-2 4 4"
              stroke="currentColor" stroke-width="1.2"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      PNG
    </button>
  </div>

  <div class="swift-modal-body">

    <div class="swift-picker-pane" id="swift-picker-pane">
      <div class="swift-drop-zone" id="swift-drop-zone">
        <svg class="swift-drop-icon" viewBox="0 0 56 56" fill="none">
          <rect x="4" y="4" width="48" height="48" rx="10"
                stroke="currentColor" stroke-width="1.5"
                stroke-dasharray="5 4"/>
          <path d="M28 18v20M19 28l9-10 9 10"
                stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <p class="swift-drop-title" id="swift-drop-title">Drop SVG file here</p>
        <p class="swift-drop-sub">or browse from disk</p>
        <label class="swift-btn swift-btn--secondary" for="swift-file-input">Browse…</label>
        <input type="file" id="swift-file-input"
               accept=".svg,image/svg+xml" aria-label="Select icon file">
      </div>
    </div>

    <div class="swift-preview-pane" id="swift-preview-pane">
      <div class="swift-preview-label">Preview</div>
      <div class="swift-preview-tile" id="swift-preview-tile"></div>
      <div class="swift-validation" id="swift-validation"></div>
      <button class="swift-btn swift-btn--ghost swift-btn--sm"
              id="swift-reselect-btn">Choose a different file</button>
    </div>

  </div>

  <div class="swift-modal-footer">
    <button class="swift-btn swift-btn--ghost"    id="swift-cancel-btn">Cancel</button>
    <button class="swift-btn swift-btn--primary"  id="swift-apply-btn" disabled>Apply</button>
  </div>

</div>`;

        return el;
    }

    /* ── Event binding (once at init) ──────────────────────── */

    function _bindEvents() {
        _dom.closeBtn.onclick    = close;
        _dom.cancelBtn.onclick   = close;
        _dom.applyBtn.onclick    = _apply;
        _dom.reselectBtn.onclick = _resetPicker;

        _dom.overlay.onclick = e => { if (e.target === _dom.overlay) close(); };

        _dom.fileInput.onchange = e => {
            const f = e.target.files[0];
            if (f) _loadFile(f);
        };

        // Tab switching
        _dom.tabBar.addEventListener("click", e => {
            const tab = e.target.closest("[data-tab]");
            if (tab) _switchTab(tab.dataset.tab);
        });

        // Drop zone
        const dz = _dom.dropZone;
        dz.addEventListener("click", e => {
            if (!e.target.closest("label")) _dom.fileInput.click();
        });
        dz.addEventListener("dragover",  e => { e.preventDefault(); dz.classList.add("swift-drop-zone--active"); });
        dz.addEventListener("dragleave", ()  => dz.classList.remove("swift-drop-zone--active"));
        dz.addEventListener("drop",      e => {
            e.preventDefault();
            dz.classList.remove("swift-drop-zone--active");
            const f = e.dataTransfer?.files[0];
            if (f) _loadFile(f);
        });

        document.addEventListener("keydown", e => {
            if (e.key === "Escape" && _dom.overlay.style.display !== "none") close();
        });
    }

    /* ── Tab management ────────────────────────────────────── */

    function _switchTab(tab) {
        if (_activeTab === tab) return;
        _activeTab = tab;

        _dom.tabBar.querySelectorAll(".swift-tab").forEach(t => {
            const active = t.dataset.tab === tab;
            t.classList.toggle("swift-tab--active", active);
            t.setAttribute("aria-selected", String(active));
        });

        if (tab === "svg") {
            _dom.fileInput.accept = ".svg,image/svg+xml";
            _dom.dropTitle.textContent = "Drop SVG file here";
        } else {
            _dom.fileInput.accept = ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp";
            _dom.dropTitle.textContent = "Drop PNG / JPG file here";
        }

        _resetPicker();
    }

    /* ── Public lifecycle ──────────────────────────────────── */

    /** Open modal for a given tile, pre-populating if icon exists. */
    function open(tile) {
        _activeTile   = tile;
        _pendingAsset = null;
        _activeTab    = "svg";

        _dom.title.textContent = tile.classList.contains("folder")
            ? "Change Folder Icon" : "Change Icon";

        // Reset to SVG tab
        _dom.tabBar.querySelectorAll(".swift-tab").forEach(t => {
            const active = t.dataset.tab === "svg";
            t.classList.toggle("swift-tab--active", active);
            t.setAttribute("aria-selected", String(active));
        });
        _dom.fileInput.accept      = ".svg,image/svg+xml";
        _dom.dropTitle.textContent = "Drop SVG file here";

        // Pre-populate if custom icon already stored
        const id       = getTileId(tile);
        const existing = id ? StorageManager.getIcon(id) : null;

        if (existing) {
            _pendingAsset = existing;
            _showPreview(existing);
            _setValidation(
                `Current custom ${existing.type.toUpperCase()} icon — browse to replace.`,
                "info"
            );
            _dom.applyBtn.disabled = false;
        } else {
            _resetPicker();
        }

        _dom.overlay.style.display = "flex";
        requestAnimationFrame(() => _dom.dialog?.focus?.());
    }

    /** Hide the modal and clear all transient state. */
    function close() {
        _dom.overlay.style.display = "none";
        _activeTile                = null;
        _pendingAsset              = null;
    }

    /* ── Private helpers ───────────────────────────────────── */

    function _resetPicker() {
        _pendingAsset                   = null;
        _dom.pickerPane.style.display   = "";
        _dom.previewPane.style.display  = "none";
        _dom.applyBtn.disabled          = true;
        _dom.fileInput.value            = "";
        _dom.validation.textContent     = "";
        _dom.validation.className       = "swift-validation";
        _dom.previewTile.innerHTML      = "";
    }

    function _loadFile(file) {
        if (_activeTab === "svg") {
            const isSvg = file.name.toLowerCase().endsWith(".svg") ||
                          file.type === "image/svg+xml";
            if (!isSvg) {
                _setValidation("Please select an SVG (.svg) file for this tab.", "error");
                return;
            }
            const reader   = new FileReader();
            reader.onload  = e => _processSVG(e.target.result);
            reader.onerror = () => _setValidation("Failed to read file.", "error");
            reader.readAsText(file);
        } else {
            _processPNG(file);
        }
    }

    function _processSVG(raw) {
        try {
            const asset        = AssetManager.normalizeSVG(raw);
            _pendingAsset      = asset;
            _showPreview(asset);
            _setValidation("SVG validated and ready to apply.", "success");
            _dom.applyBtn.disabled = false;
        } catch (err) {
            _pendingAsset          = null;
            _dom.applyBtn.disabled = true;
            _dom.pickerPane.style.display  = "none";
            _dom.previewPane.style.display = "flex";
            _dom.previewTile.innerHTML     = "";
            _setValidation(`Invalid SVG: ${err.message}`, "error");
        }
    }

    async function _processPNG(file) {
        _setValidation("Processing image…", "info");
        _dom.pickerPane.style.display  = "none";
        _dom.previewPane.style.display = "flex";
        _dom.previewTile.innerHTML     = "";
        _dom.applyBtn.disabled         = true;
        try {
            const asset        = await AssetManager.normalizePNG(file);
            _pendingAsset      = asset;
            _showPreview(asset);
            _setValidation("Image validated and ready to apply.", "success");
            _dom.applyBtn.disabled = false;
        } catch (err) {
            _pendingAsset = null;
            _setValidation(`Invalid image: ${err.message}`, "error");
        }
    }

    function _showPreview(asset) {
        _dom.pickerPane.style.display  = "none";
        _dom.previewPane.style.display = "flex";
        _dom.previewTile.innerHTML     = "";
        _dom.previewTile.appendChild(AssetManager.preparePreview(asset));
    }

    function _setValidation(message, type) {
        _dom.validation.textContent = message;
        _dom.validation.className   = `swift-validation swift-validation--${type}`;
    }

    /** Commit pending asset to storage and live-inject. */
    function _apply() {
        if (!_pendingAsset || !_activeTile) return;

        const id = getTileId(_activeTile);
        if (!id) {
            _setValidation("Speed Dial has no ID — cannot save. Reload the page.", "error");
            return;
        }

        StorageManager.setIcon(id, _pendingAsset);
        reinjectTile(_activeTile);
        close();
    }

    return { init, open, close };

})();


/* ============================================================
   EditingEngine
   ============================================================
   Operates EXCLUSIVELY on injected wrappers.
   Never reads or writes .SpeedDial geometry.

   Pointer Events drive two drag interactions:
     icon-move   — translate icon within the thumbnail
     icon-resize — scale icon diameter

   A floating properties panel handles:
     Icon size     (stepper, mirrors drag result)
     Padding       (stepper — inset inside thumbnail)
     Scale         (stepper — content scale of layout wrapper)

   Draft state is held in memory throughout editing.
   A single StorageManager.setLayout() is issued on commit().
   ============================================================ */

const EditingEngine = (() => {

    let _tile        = null;
    let _overlay     = null;   // handles appended to tile
    let _panel       = null;   // floating properties panel
    let _draft       = null;   // { tileId, layout: {...} }
    let _ptStart     = null;   // { x, y } pointer origin
    let _mode        = null;   // "icon-move" | "icon-resize"
    let _docClickOff = null;
    let _docKeyOff   = null;

    /* ── CSS custom property names ─────────────────────────── */
    const P_SIZE    = "--custom-icon-size";
    const P_OFSX    = "--custom-icon-offset-x";
    const P_OFSY    = "--custom-icon-offset-y";
    const P_PAD     = "--custom-padding";
    const P_SCALE   = "--custom-wrapper-scale";

    /* ── Public ─────────────────────────────────────────────── */

    function enter(tile) {
        if (_tile === tile) return;
        if (_tile) exit();

        const tileId = getTileId(tile);   // cached — used twice below
        _tile  = tile;
        _draft = {
            tileId,
            layout: { ...StorageManager.getLayout(tileId) },
        };

        tile.classList.add("SpeedDial--editing");

        _overlay = _buildOverlay(tile);
        tile.appendChild(_overlay);
        _overlay.addEventListener("pointerdown", _onHandleDown);

        _panel = _buildPanel();
        document.body.appendChild(_panel);
        _positionPanel();
        _panel.addEventListener("click", _onPanelClick);

        document.querySelectorAll(".SpeedDial").forEach(t => {
            if (t !== tile) t.classList.add("SpeedDial--muted");
        });

        _docClickOff = e => {
            if (!_tile?.contains(e.target) && !_panel?.contains(e.target)) cancel();
        };
        _docKeyOff = e => {
            if (e.key === "Escape") cancel();
            if (e.key === "Enter")  commit();
        };
        setTimeout(() => {
            document.addEventListener("click",   _docClickOff);
            document.addEventListener("keydown", _docKeyOff);
        }, 50);
    }

    function exit() {
        if (!_tile) return;

        _tile.classList.remove("SpeedDial--editing");
        _overlay?.remove();  _overlay = null;
        _panel?.remove();    _panel   = null;

        document.querySelectorAll(".SpeedDial--muted").forEach(t =>
            t.classList.remove("SpeedDial--muted")
        );

        document.removeEventListener("pointermove", _onPointerMove);
        document.removeEventListener("pointerup",   _onPointerUp);
        document.removeEventListener("click",       _docClickOff);
        document.removeEventListener("keydown",     _docKeyOff);

        _tile = _draft = _ptStart = _mode = null;
    }

    /** One storage write; apply final layout to live wrappers; exit. */
    function commit() {
        if (!_tile || !_draft) return;
        StorageManager.setLayout(_draft.tileId, _draft.layout);
        _applyDraftToDOM();
        exit();
    }

    /** Restore from storage; discard draft; exit. */
    function cancel() {
        if (!_tile) return;
        const stored = StorageManager.getLayout(getTileId(_tile));
        _applyToDOM(stored);
        exit();
    }

    /* ── Overlay (icon handles only) ────────────────────────── */

    function _buildOverlay(tile) {
        const ov     = document.createElement("div");
        ov.className = "sd-edit-overlay";

        if (tile.querySelector(".custom-icon-wrapper")) {
            const im          = document.createElement("div");
            im.className      = "sd-edit-icon-move";
            im.dataset.editAction = "icon-move";
            im.title          = "Drag to reposition icon";
            ov.appendChild(im);

            const ir          = document.createElement("div");
            ir.className      = "sd-edit-icon-resize";
            ir.dataset.editAction = "icon-resize";
            ir.title          = "Drag to resize icon";
            ov.appendChild(ir);
        }

        return ov;
    }

    /* ── Properties panel ───────────────────────────────────── */

    function _buildPanel() {
        const p     = document.createElement("div");
        p.className = "sd-edit-panel";

        p.innerHTML = `
<div class="sd-edit-panel__header">
  <span class="sd-edit-panel__title">Customize Layout</span>
</div>
<div class="sd-edit-panel__body">
  <div class="sd-edit-row">
    <span class="sd-edit-row__label">Icon size</span>
    <div class="sd-edit-stepper">
      <button class="sd-edit-stepper__btn" data-prop="iconSize" data-delta="-2">−</button>
      <span   class="sd-edit-stepper__val" id="sd-val-iconSize">44px</span>
      <button class="sd-edit-stepper__btn" data-prop="iconSize" data-delta="2">+</button>
    </div>
  </div>
  <div class="sd-edit-row">
    <span class="sd-edit-row__label">Padding</span>
    <div class="sd-edit-stepper">
      <button class="sd-edit-stepper__btn" data-prop="thumbnailPadding" data-delta="-2">−</button>
      <span   class="sd-edit-stepper__val" id="sd-val-thumbnailPadding">0px</span>
      <button class="sd-edit-stepper__btn" data-prop="thumbnailPadding" data-delta="2">+</button>
    </div>
  </div>
  <div class="sd-edit-row">
    <span class="sd-edit-row__label">Scale</span>
    <div class="sd-edit-stepper">
      <button class="sd-edit-stepper__btn" data-prop="wrapperScale" data-delta="-0.05">−</button>
      <span   class="sd-edit-stepper__val" id="sd-val-wrapperScale">1.00×</span>
      <button class="sd-edit-stepper__btn" data-prop="wrapperScale" data-delta="0.05">+</button>
    </div>
  </div>
</div>
<div class="sd-edit-panel__footer">
  <button class="sd-edit-panel__btn sd-edit-panel__btn--cancel" data-panel-action="cancel">Cancel</button>
  <button class="sd-edit-panel__btn sd-edit-panel__btn--commit" data-panel-action="commit">Apply</button>
</div>`;

        _syncPanel(p);
        return p;
    }

    function _positionPanel() {
        if (!_panel || !_tile) return;
        const bcr   = _tile.getBoundingClientRect();
        const left  = Math.min(Math.max(8, bcr.left), window.innerWidth  - 212);
        const below = bcr.bottom + 10;
        const above = bcr.top    - 186;
        const top   = (below + 180 < window.innerHeight) ? below : Math.max(8, above);
        _panel.style.cssText = `position:fixed;top:${top}px;left:${left}px;z-index:10002;`;
    }

    function _syncPanel(panel = _panel) {
        if (!panel || !_draft) return;
        const l = _draft.layout;
        const q = (id) => panel.querySelector(id);
        const s = q("#sd-val-iconSize");         if (s) s.textContent = `${l.iconSize ?? 44}px`;
        const p = q("#sd-val-thumbnailPadding"); if (p) p.textContent = `${l.thumbnailPadding ?? 0}px`;
        const w = q("#sd-val-wrapperScale");     if (w) w.textContent = `${(l.wrapperScale ?? 1).toFixed(2)}×`;
    }

    function _onPanelClick(e) {
        const action = e.target.closest("[data-panel-action]")?.dataset.panelAction;
        if (action === "commit") { commit(); return; }
        if (action === "cancel") { cancel(); return; }

        const btn = e.target.closest("[data-prop]");
        if (!btn || !_draft) return;

        const prop  = btn.dataset.prop;
        const delta = parseFloat(btn.dataset.delta);
        const l     = _draft.layout;

        if      (prop === "iconSize") {
            l.iconSize = Math.round(Math.max(16, Math.min(128, (l.iconSize ?? 44) + delta)));
        } else if (prop === "thumbnailPadding") {
            l.thumbnailPadding = Math.round(Math.max(0, Math.min(24, (l.thumbnailPadding ?? 0) + delta)));
        } else if (prop === "wrapperScale") {
            l.wrapperScale = parseFloat(
                Math.max(0.5, Math.min(2.0, (l.wrapperScale ?? 1) + delta)).toFixed(2)
            );
        }

        _applyDraftToDOM();
        _syncPanel();
    }

    /* ── Apply helpers ──────────────────────────────────────── */

    function _applyDraftToDOM() { _applyToDOM(_draft.layout); }

    function _applyToDOM(layout) {
        const lw = _tile?.querySelector(".custom-layout-wrapper");
        const iw = _tile?.querySelector(".custom-icon-wrapper");
        if (lw) Renderer.applyLayout(lw, layout);
        if (iw) Renderer.applyTransforms(iw, layout);
    }

    /* ── Pointer handlers ───────────────────────────────────── */

    function _onHandleDown(e) {
        const el = e.target.closest("[data-edit-action]");
        if (!el) return;

        e.preventDefault();
        e.stopPropagation();

        _ptStart = { x: e.clientX, y: e.clientY };
        _mode    = el.dataset.editAction;

        _overlay.setPointerCapture(e.pointerId);
        document.addEventListener("pointermove", _onPointerMove, { passive: false });
        document.addEventListener("pointerup",   _onPointerUp,   { once: true });
    }

    function _onPointerMove(e) {
        if (!_ptStart || !_mode) return;
        const dx = e.clientX - _ptStart.x;
        const dy = e.clientY - _ptStart.y;
        if (_mode === "icon-move")   _previewIconMove(dx, dy);
        if (_mode === "icon-resize") _previewIconResize(dx, dy);
    }

    function _onPointerUp(e) {
        document.removeEventListener("pointermove", _onPointerMove);
        if (!_ptStart || !_mode) return;

        const dx = e.clientX - _ptStart.x;
        const dy = e.clientY - _ptStart.y;
        if (_mode === "icon-move")   _finaliseIconMove(dx, dy);
        if (_mode === "icon-resize") _finaliseIconResize(dx, dy);

        _syncPanel();
        _ptStart = _mode = null;
    }

    /* ── Preview (live CSS vars, zero storage writes) ───────── */

    function _previewIconMove(dx, dy) {
        const iw = _tile?.querySelector(".custom-icon-wrapper");
        if (!iw) return;
        iw.style.setProperty(P_OFSX, `${(_draft.layout.iconOffsetX || 0) + dx}px`);
        iw.style.setProperty(P_OFSY, `${(_draft.layout.iconOffsetY || 0) + dy}px`);
    }

    function _previewIconResize(dx, dy) {
        const iw = _tile?.querySelector(".custom-icon-wrapper");
        if (iw) iw.style.setProperty(P_SIZE, `${_calcIconSize(dx, dy)}px`);
    }

    /* ── Finalise (write to draft, not storage) ─────────────── */

    function _finaliseIconMove(dx, dy) {
        _draft.layout.iconOffsetX = (_draft.layout.iconOffsetX || 0) + dx;
        _draft.layout.iconOffsetY = (_draft.layout.iconOffsetY || 0) + dy;
    }

    function _finaliseIconResize(dx, dy) {
        _draft.layout.iconSize = _calcIconSize(dx, dy);
    }

    function _calcIconSize(dx, dy) {
        return Math.round(Math.max(16, Math.min(128,
            (_draft.layout.iconSize || 44) + (dx + dy) / 2
        )));
    }

    return { enter, exit, commit, cancel };

})();


/* ============================================================
   PHASE 5 — ContextMenu  (expanded)
   ============================================================
   Items:
     Change Icon           (always)
     Reset Icon            (only when custom icon exists)
     ────────────────────
     Remove Speed Dial     (always)
     ────────────────────
     Customize Layout      (always)
     Reset Layout          (only when non-default layout stored)
   ============================================================ */

const ContextMenu = (() => {

    let _el         = null;
    let _activeTile = null;

    function init() {
        _el           = document.createElement("div");
        _el.id        = "swift-context-menu";
        _el.className = "swift-context-menu";
        document.body.appendChild(_el);

        _el.addEventListener("click", _onItemClick);
        document.addEventListener("contextmenu", _onContextMenu, true);
        document.addEventListener("click",       _onDocClick);
        document.addEventListener("keydown",     e => {
            if (e.key === "Escape") _dismiss();
        });
    }

    function _onContextMenu(e) {
        const tile = e.target.closest(".SpeedDial");
        if (!tile) { _dismiss(); return; }

        e.preventDefault();
        e.stopImmediatePropagation();

        _activeTile = tile;
        _render(tile);
        _position(e.clientX, e.clientY);
    }

    /* ── SVG micro-icons ────────────────────────────────────── */

    const _SVG = {
        changeIcon: `<svg class="swift-menu-icon-svg" viewBox="0 0 16 16" fill="none">
            <rect x="1" y="3" width="14" height="10" rx="1.5"
                  stroke="currentColor" stroke-width="1.25"/>
            <circle cx="5.5" cy="7" r="1.5" fill="currentColor"/>
            <path d="M1 10.5l3.5-3 3 2.5 2.5-2.5L15 10.5"
                  stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
        </svg>`,

        resetIcon: `<svg class="swift-menu-icon-svg" viewBox="0 0 16 16" fill="none">
            <path d="M3 8a5 5 0 1 0 1.5-3.5"
                  stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
            <path d="M1 5l2.5 2.5L6 5"
                  stroke="currentColor" stroke-width="1.25"
                  stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`,

        remove: `<svg class="swift-menu-icon-svg" viewBox="0 0 16 16" fill="none">
            <path d="M3 4h10M6 4V3a.5.5 0 0 1 .5-.5h3A.5.5 0 0 1 10 3v1
                     M5 4v8.5a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5V4"
                  stroke="currentColor" stroke-width="1.25"
                  stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`,

        layout: `<svg class="swift-menu-icon-svg" viewBox="0 0 16 16" fill="none">
            <rect x="1.5" y="1.5" width="13" height="13" rx="2"
                  stroke="currentColor" stroke-width="1.25"/>
            <path d="M8 4v8M4 8h8"
                  stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
        </svg>`,

        resetLayout: `<svg class="swift-menu-icon-svg" viewBox="0 0 16 16" fill="none">
            <path d="M3 8a5 5 0 1 0 1-3" stroke="currentColor"
                  stroke-width="1.25" stroke-linecap="round"/>
            <path d="M1.5 4.5l2 2 2-2" stroke="currentColor"
                  stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M8 5v3l2 1" stroke="currentColor"
                  stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`,
    };

    /* ── Render menu for the right-clicked tile ─────────────── */

    function _render(tile) {
        const id            = getTileId(tile);
        const hasCustomIcon = id ? StorageManager.hasIcon(id)         : false;
        const hasCustomLay  = id ? StorageManager.hasCustomLayout(id) : false;
        const isFolder      = tile.classList.contains("folder");
        const changeLabel   = isFolder ? "Change Folder Icon" : "Change Icon";

        let html = `
            <div class="swift-menu-item" data-action="change-icon">
                ${_SVG.changeIcon}<span>${changeLabel}</span>
            </div>`;

        if (hasCustomIcon) {
            html += `
            <div class="swift-menu-separator"></div>
            <div class="swift-menu-item swift-menu-item--danger" data-action="reset-icon">
                ${_SVG.resetIcon}<span>Reset Icon</span>
            </div>`;
        }

        html += `
            <div class="swift-menu-separator"></div>
            <div class="swift-menu-item swift-menu-item--danger" data-action="remove-sd">
                ${_SVG.remove}<span>Remove Speed Dial</span>
            </div>
            <div class="swift-menu-separator"></div>
            <div class="swift-menu-item" data-action="customize-layout">
                ${_SVG.layout}<span>Customize Layout</span>
            </div>`;

        if (hasCustomLay) {
            html += `
            <div class="swift-menu-item swift-menu-item--danger" data-action="reset-layout">
                ${_SVG.resetLayout}<span>Reset Layout</span>
            </div>`;
        }

        _el.innerHTML = html;
    }

    /* ── Viewport-safe positioning ──────────────────────────── */

    function _position(x, y) {
        _el.style.visibility = "hidden";
        _el.style.display    = "block";

        requestAnimationFrame(() => {
            const r  = _el.getBoundingClientRect();
            const cx = (x + r.width  > window.innerWidth)  ? x - r.width  : x;
            const cy = (y + r.height > window.innerHeight)  ? y - r.height : y;

            _el.style.left       = `${cx}px`;
            _el.style.top        = `${cy}px`;
            _el.style.visibility = "";
        });
    }

    /* ── Item dispatch ──────────────────────────────────────── */

    function _onItemClick(e) {
        const item = e.target.closest("[data-action]");
        if (!item) return;

        const action = item.dataset.action;
        const tile   = _activeTile;

        _dismiss();
        if (!tile) return;

        switch (action) {
            case "change-icon": {
                IconModal.open(tile);
                break;
            }
            case "reset-icon": {
                const id = getTileId(tile);
                if (id) { StorageManager.removeIcon(id); reinjectTile(tile); }
                break;
            }
            case "remove-sd": {
                _removeSpeedDial(tile);
                break;
            }
            case "customize-layout": {
                // Defer slightly so the dismiss animation completes
                requestAnimationFrame(() => EditingEngine.enter(tile));
                break;
            }
            case "reset-layout": {
                const id = getTileId(tile);
                if (id) { StorageManager.resetLayout(id); reinjectTile(tile); }
                break;
            }
        }
    }

    /* ── Speed Dial removal ─────────────────────────────────── */
    /* Vivaldi already owns Speed Dial deletion — clicking its own remove
       control is the one reliable way to trigger it. There is no
       supported public API for this, so no private-API guessing and no
       synthetic keyboard events standing in for a click that may not
       actually be wired to anything. */

    function _removeSpeedDial(tile) {
        const removeBtn = tile.querySelector(
            ".RemoveButton, [data-vivaldi-action='remove'], [aria-label='Remove']"
        );
        if (removeBtn) {
            removeBtn.click();
        } else {
            console.warn("[Vivaldi Swift] No native remove control found on this tile.");
        }
    }

    function _onDocClick(e) {
        if (_el && !_el.contains(e.target)) _dismiss();
    }

    function _dismiss() {
        if (_el) _el.style.display = "none";
    }

    return { init };

})();


/* ============================================================
   OBSERVER + BOOTSTRAP  (self-contained IIFE)
   ============================================================
   Wrapping these in an IIFE keeps _observerTimeout, observer,
   and _bootstrap out of the outer scope, preventing accidental
   re-entry or external interference.

   The observer uses targeted mutation handling:
     • Newly added .SpeedDial nodes → injected immediately.
     • Subtree additions that might contain tiles → debounced
       full scanTiles() for correctness.
     • Removals and attribute mutations → ignored (tiles carry
       their own cleanup; no observer-driven teardown needed).
   ============================================================ */

(() => {

    let _debounceTimer = null;

    function _onMutation(mutations) {
        for (const m of mutations) {
            if (m.type !== "childList" || !m.addedNodes.length) continue;

            for (const node of m.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;

                // Direct SpeedDial addition — inject immediately, no debounce.
                if (node.classList?.contains("SpeedDial")) {
                    injectTile(node);
                    continue;
                }

                // Container that may hold SpeedDials — debounced scan.
                if (node.querySelector?.(".SpeedDial")) {
                    clearTimeout(_debounceTimer);
                    _debounceTimer = setTimeout(scanTiles, OBSERVER_DEBOUNCE_MS);
                    return;   // one pending scan is enough
                }
            }
        }
    }

    const _observer = new MutationObserver(_onMutation);
    _observer.observe(document, { childList: true, subtree: true });

    async function _bootstrap() {
        ContextMenu.init();
        IconModal.init();

        await StorageManager.init();

        if (typeof requestIdleCallback === "function") {
            requestIdleCallback(scanTiles, { timeout: 500 });
        } else {
            scanTiles();
        }

        console.log("[Vivaldi Swift] Ready.");
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _bootstrap);
    } else {
        _bootstrap();
    }

})();
