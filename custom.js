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
     .SpeedDial (regular)
       .thumbnail-favicon          ← Vivaldi's safe injection point
         .custom-layout-wrapper    ← centering only, no card mutations
           .custom-icon-wrapper    ← fixed size, flex child
             <svg>

     .SpeedDial.folder
       .thumbnail-favicon-folder             ← Vivaldi's safe injection point
         .thumbnail-favicon-children         ← Vivaldi's native 4-up preview (fallback)
         .vivaldi-swift-folder-preview        ← our 2x2 grid, shown only once complete
           .vivaldi-swift-folder-slot × 4

   AUTOMATIC ICONS
   ================
   Speed Dial icons are resolved automatically from the tile's
   target website — no manual upload, positioning, or scaling.
   Regular tiles and folders each get their own processing path
   (SpeedDialIconController dispatches between them) but share
   every lower-level piece — one cache, one provider, one
   sanitizer. Vivaldi's native favicon/preview is always the
   fallback and is only ever hidden after a validated, sanitized
   replacement is ready to render.

     SpeedDialIconController → dispatches a tile to one of:
     AutoIconController      → regular tile: URL → domain → icon
     FolderPreviewController → folder tile: children → icons → grid
     BookmarksApi             → chrome.bookmarks — the PRIMARY source
                                of a tile's/child's destination URL
                                (confirmed via Vivaldi's own React
                                source: data-id IS the bookmark id);
                                DOM/favicon scraping below is the
                                fallback if this API is ever unavailable
     SpeedDialUrlResolver    → recovers a regular tile's target URL
     FolderChildResolver     → recovers up to 4 child URLs from a folder
     FaviconUrl              → shared low-level favicon-srcset parsing
     DomainNormalizer        → URL → apex domain
     BrandResolver           → domain → theSVG slug candidate(s)
     IconService              → cache (memory + chrome.storage.local),
                                negative caching, in-flight dedup —
                                the single source of truth both
                                controllers above resolve icons through
     TheSvgProvider           → fetches + validates SVGs from
                                https://thesvg.org (jsDelivr mirror
                                as a fallback host)
     IconSanitizer            → same sanitizer the old manual-upload
                                feature used; unchanged and reused
     Renderer                 → builds/injects both the single-icon
                                and the folder-grid wrapper hierarchies
     ContextMenu               → Add Speed Dial / Add Folder (via
                                BookmarksApi.create), Change Position,
                                Remove Speed Dial (via removeTree)
     RepositionMode            → visual on/off affordance around
                                Vivaldi's own native tile dragging —
                                deliberately does not reimplement
                                drag-and-drop itself; see its header

   No version numbers here — git history is the changelog.
   ============================================================ */

"use strict";


/* ============================================================
   DEBUG
   ============================================================
   Two independent layers, because getting *any* diagnostic signal
   out of Vivaldi's own UI process is the hard part here — regular
   webpage DevTools (F12 on a tab) attaches to that tab, not to
   window.html, so a command typed there never reaches this script
   at all. To actually reach the right console: open
   vivaldi://inspect/#apps/ and click "inspect" under the entry for
   Vivaldi's window.html (opens in a new window) — or open any
   vivaldi:// internal page (e.g. vivaldi://startpage) and use
   DevTools from there instead of from a regular tab.

   1. window.__vivaldiSwift — always populated, no flag needed.
      Open the correct console (see above) and type
      `__vivaldiSwift` to see live counts and, for folders, the
      last known state per tile. If this is undefined even in the
      correct console, the script itself never ran (check the
      Console tab for a load-time error, and confirm custom.js was
      actually reinstalled and Vivaldi fully restarted — not just
      the page reloaded — after the last update).

   2. Verbose per-card/per-mutation logging — opt-in, since it's
      too noisy to leave on by default. Enable with
      `localStorage.setItem("vivaldi-swift-debug", "1")` typed into
      that *same correct console*, then reload the page (Ctrl+R
      inside that window is fine for this part — only a full
      restart is needed after reinstalling the files themselves).
   ============================================================ */

const DEBUG = (() => {
    try { return localStorage.getItem("vivaldi-swift-debug") === "1"; }
    catch { return false; }
})();

function debugLog(...args) {
    if (DEBUG) console.log("[Vivaldi Swift]", ...args);
}

const __diag = {
    ready:        false,
    loadedAt:     new Date().toISOString(),
    bookmarksApiAvailable: null, // set once at bootstrap — null means "not checked yet"
    regularCards: { total: 0, success: 0, notFound: 0, error: 0 },
    folders:      new Map(), // tileId -> { signature, generation, childCount, resolvedCount, lastUpdated }
    cacheEntries: 0,
};
try { window.__vivaldiSwift = __diag; } catch { /* non-fatal if window is somehow unavailable */ }


/* ============================================================
   SELECTORS
   ============================================================
   Every Vivaldi-DOM-specific selector string used anywhere in
   this file lives here — nothing else hardcodes one. If a future
   Vivaldi build renames one of these, this is the only place that
   needs updating.
   ============================================================ */

const SELECTORS = {
    speedDial:            ".SpeedDial",
    regularIconClass:     "SpeedDial--Icon",
    folderClass:          "folder",
    regularFaviconContainer: ".thumbnail-favicon",
    folderPreviewContainer:  ".thumbnail-favicon-folder",
    regularFavicon:       ":scope > .thumbnail-favicon > img.favicon, :scope .thumbnail-favicon img.favicon",
    folderChildren:       ":scope .thumbnail-favicon-children",
    faviconImg:           "img.favicon",
};

console.log("[Vivaldi Swift] loading…");


/* ============================================================
   CONSTANTS
   ============================================================ */

const OBSERVER_DEBOUNCE_MS = 100;

/** How long a resolved icon is trusted before we re-check it. */
const POSITIVE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** How long a confirmed "no icon for this domain" is trusted. */
const NEGATIVE_CACHE_TTL_MS = 7  * 24 * 60 * 60 * 1000; // 7 days
/** How long a network/CSP/timeout failure is trusted — short,
 *  so a transient outage doesn't masquerade as "not found". */
const ERROR_CACHE_TTL_MS    = 60 * 60 * 1000;            // 1 hour


/* ============================================================
   IconSanitizer
   ============================================================
   Unchanged from the manual-upload era: allowlist/blocklist walk,
   attribute scrub, ID namespacing. This is the same trust boundary
   an automatically-fetched SVG has to cross — remote origin, so if
   anything, it deserves more scrutiny than a user's own upload did,
   not less.
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

        svgEl.querySelectorAll("*").forEach(el => {
            REF_ATTRS.forEach(attr => {
                const v = el.getAttribute(attr);
                if (v?.startsWith("url(#")) {
                    const ref = v.slice(5, -1);
                    if (idMap.has(ref)) el.setAttribute(attr, `url(#${idMap.get(ref)})`);
                }
            });

            ["href", "xlink:href"].forEach(attr => {
                const v = el.getAttribute(attr);
                if (v?.startsWith("#")) {
                    const ref = v.slice(1);
                    if (idMap.has(ref)) el.setAttribute(attr, `#${idMap.get(ref)}`);
                }
            });

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

        const rawW = svgEl.getAttribute("width");
        const rawH = svgEl.getAttribute("height");

        _walk(svgEl);

        let viewBox = svgEl.getAttribute("viewBox");
        if (!viewBox) {
            const w = parseFloat(rawW) || 512;
            const h = parseFloat(rawH) || 512;
            viewBox = `0 0 ${w} ${h}`;
        }

        svgEl.removeAttribute("width");
        svgEl.removeAttribute("height");

        svgEl.setAttribute("viewBox", viewBox);
        svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");

        if (idPrefix) _namespaceIds(svgEl, idPrefix);

        return new XMLSerializer().serializeToString(svgEl);
    }

    return { sanitize, namespaceIds: _namespaceIds };

})();


/* ============================================================
   DOM HELPERS
   ============================================================
   Small, centralized Vivaldi-DOM-specific lookups. If Vivaldi's
   Speed Dial markup changes, these are the functions to update —
   nothing else in the file re-derives them independently.
   ============================================================ */

/**
 * Regular (non-folder) tile's icon host container.
 * @param   {Element} tile
 * @returns {Element|null}
 */
function getRegularIconContainer(tile) {
    return tile.querySelector(SELECTORS.regularFaviconContainer);
}

/**
 * Folder tile's preview host container — the element our
 * .vivaldi-swift-folder-preview grid is injected into, sibling to
 * Vivaldi's native .thumbnail-favicon-children.
 * @param   {Element} tile
 * @returns {Element|null}
 */
function getFolderPreviewContainer(tile) {
    return tile.querySelector(SELECTORS.folderPreviewContainer);
}

/**
 * Folder tile's native multi-favicon preview container.
 * @param   {Element} tile
 * @returns {Element|null}
 */
function getFolderChildrenContainer(tile) {
    return tile.querySelector(SELECTORS.folderChildren);
}

/**
 * The (up to 4) native <img class="favicon"> nodes inside a folder's
 * children container, in DOM order.
 * @param   {Element} tile
 * @returns {Element[]}
 */
function getFolderPreviewFaviconNodes(tile) {
    const container = getFolderChildrenContainer(tile);
    return container ? Array.from(container.querySelectorAll(SELECTORS.faviconImg)) : [];
}

/**
 * Return a tile's Vivaldi-assigned data-id, or null.
 * Cards can be reordered, recreated, or moved — data-id is the
 * stable per-card identity, never DOM position or title text.
 * @param   {Element} tile
 * @returns {string|null}
 */
function getTileId(tile) { return tile.dataset.id || null; }

/**
 * Deterministic SVG ID-namespace prefix for a tile.
 * @param {string} tileId
 * @returns {string}
 */
function _idPrefix(tileId) {
    const slug = (tileId || "x")
        .slice(-8)
        .replace(/[^a-zA-Z0-9]/g, "_");
    return `sd4-${slug}-`;
}

/* Centralized Speed Dial type detection — the rest of the file asks
   these two functions, never `tile.classList.contains(...)` directly,
   so a future Vivaldi DOM change only needs an update here. */
function isRegularSpeedDial(tile) {
    return tile.classList.contains(SELECTORS.regularIconClass)
        && !tile.classList.contains(SELECTORS.folderClass);
}
function isFolderSpeedDial(tile) {
    return tile.classList.contains(SELECTORS.folderClass);
}


/* ============================================================
   FaviconUrl
   ============================================================
   Low-level, reusable extraction of a page URL from one of
   Vivaldi's native <img class="favicon"> elements:

       chrome://favicon2/?size=32&pageUrl=https://github.com/

   Used by SpeedDialUrlResolver (one favicon per regular tile) and
   by FolderChildResolver (up to four favicons per folder tile) —
   written once here so neither reimplements srcset/URL parsing.
   ============================================================ */

const FaviconUrl = (() => {

    /**
     * Ordered candidate URLs to try for one <img class="favicon">
     * element: the browser's own resolved choice first (currentSrc,
     * already accounts for srcset descriptors/DPR — but can be empty
     * before layout has run), then the plain src attribute, then every
     * srcset candidate in listed order. Vivaldi is expected to set
     * these synchronously at element-creation time in every case we've
     * observed, but nothing here assumes that — if a candidate isn't
     * populated yet, it's simply absent from this list and we fall
     * through to the next.
     * @param {Element|null} img
     * @returns {string[]}
     */
    function _candidateUrls(img) {
        if (!img) return [];
        const out = [];
        if (img.currentSrc) out.push(img.currentSrc);
        if (img.src) out.push(img.src);

        const srcset = img.getAttribute("srcset") || img.srcset;
        if (srcset) {
            for (const candidate of srcset.split(",")) {
                const url = candidate.trim().split(/\s+/)[0];
                if (url) out.push(url);
            }
        }
        return out;
    }

    /** @param {Element|null} img — an <img class="favicon"> element */
    function extractFromImg(img) {
        for (const candidate of _candidateUrls(img)) {
            const unwrapped = cleanHttpUrl(_extractDestinationParam(candidate));
            if (unwrapped) return unwrapped;

            // Vivaldi's own Favicon component (confirmed from its real source:
            // the render() branch keyed on loadType "faviconSkipCache"/"data")
            // sometimes sets `src` directly to an already-meaningful URL with
            // no chrome://favicon2 wrapper at all — no srcset, no query params.
            // If a candidate is already a plain http(s) URL on its own, use it
            // as-is rather than only ever looking for a wrapped param.
            const direct = cleanHttpUrl(candidate);
            if (direct) return direct;
        }
        return null;
    }

    /**
     * Same extraction as extractFromImg, but returns every intermediate
     * value instead of just the final answer — used only by debug
     * logging (FolderChildResolver), never on the hot path.
     * @param {Element|null} img
     */
    function extractDetailed(img) {
        const candidateUrls = _candidateUrls(img);
        const attempts = candidateUrls.map(candidate => {
            const param = _extractDestinationParam(candidate);
            const unwrapped = cleanHttpUrl(param);
            const direct = unwrapped ? null : cleanHttpUrl(candidate);
            return { candidate, param, cleaned: unwrapped || direct };
        });
        return {
            currentSrc: img?.currentSrc || null,
            src:        img?.src || null,
            srcset:     img?.getAttribute("srcset") || img?.srcset || null,
            attempts,
            result:     attempts.find(a => a.cleaned)?.cleaned || null,
        };
    }

    /**
     * Vivaldi's real Favicon component (confirmed from its actual source,
     * module 97009 in bundle.js) builds the srcset as either:
     *
     *   chrome://favicon2/?size=N&pageUrl=<destination>   (loadType "page")
     *   chrome://favicon2/?size=N&iconUrl=<favicon-asset>  (loadType
     *                                                       "faviconFromCache",
     *                                                       used whenever the
     *                                                       bookmark already
     *                                                       has a cached
     *                                                       faviconUrl — this
     *                                                       is the common case
     *                                                       for folder preview
     *                                                       children, which is
     *                                                       exactly why folders
     *                                                       kept failing while
     *                                                       regular tiles —
     *                                                       which hit "page"
     *                                                       far more often —
     *                                                       mostly didn't)
     *
     * iconUrl isn't guaranteed to be the destination page itself — it can be
     * the favicon *asset's* own URL — but that's overwhelmingly same-origin
     * in practice, so it's a far better outcome than never extracting
     * anything at all. pageUrl is tried first whenever both could apply.
     */
    function _extractDestinationParam(faviconUrl) {
        try {
            const params = new URL(faviconUrl, location.href).searchParams;
            return params.get("pageUrl") || params.get("iconUrl");
        } catch {
            // Defensive fallback only — chrome://favicon2 URLs parse fine
            // with the URL constructor in practice, but never let a parser
            // edge case break icon resolution for every other tile too.
            const m = /[?&](?:pageUrl|iconUrl)=([^&]+)/.exec(faviconUrl);
            return m ? decodeURIComponent(m[1]) : null;
        }
    }

    /** @param {string|null} raw */
    function cleanHttpUrl(raw) {
        if (!raw) return null;
        try {
            const u = new URL(raw);
            if (u.protocol !== "http:" && u.protocol !== "https:") return null;
            return u.href;
        } catch {
            return null;
        }
    }

    return { extractFromImg, extractDetailed, cleanHttpUrl };

})();


/* ============================================================
   SpeedDialUrlResolver
   ============================================================
   Vivaldi's Speed Dial cards do not reliably expose an <a href>.
   The one thing every regular (non-folder) tile does expose is
   its native favicon — see FaviconUrl above for how that's read.

   Strategy, in order:
     1. Explicit data-url / data-uri / data-href / href, in case a
        future Vivaldi build (or another mod) provides one directly.
     2. pageUrl extracted from the native favicon's srcset.
     3. Give up — the tile keeps its native favicon, untouched.

   Folders are out of scope for this resolver: they have no single
   target URL. See FolderChildResolver for how folders are handled.
   ============================================================ */

/* ============================================================
   BookmarksApi
   ============================================================
   Every Speed Dial tile IS a bookmark node in Vivaldi's model —
   confirmed directly from Vivaldi's own React source (bundle.js):
   the tile's `data-id` is literally the bookmark node's `id`
   (`"data-id": e.id` in the render() that builds the outer
   .SpeedDial div), and that same bundle calls
   `chrome.bookmarks.getTree()` itself, from this same UI context,
   to walk the bookmark tree.

   That makes the standard chrome.bookmarks API a far more direct
   source of truth than reverse-engineering a destination URL out
   of a rendered favicon element's src/srcset — it hands back the
   bookmark's actual `.url` (or, for a folder, its `.children`
   array of `{id, url, ...}`) with no parsing or guessing at all.

   Used as the *first* strategy everywhere it applies; DOM/favicon
   scraping (SpeedDialUrlResolver / FolderChildResolver's existing
   logic) remains as the fallback if this API is ever unavailable
   or errors, so nothing regresses if some Vivaldi build restricts
   it from this context.
   ============================================================ */

const BookmarksApi = (() => {

    function available() {
        try { return typeof chrome !== "undefined" && !!chrome.bookmarks?.getChildren && !!chrome.bookmarks?.get; }
        catch { return false; }
    }

    /** @param {string} id @returns {Promise<object|null>} the bookmark node, or null on any failure */
    function get(id) {
        return new Promise(resolve => {
            try {
                chrome.bookmarks.get(id, nodes => {
                    if (chrome.runtime.lastError) { resolve(null); return; }
                    resolve(nodes?.[0] || null);
                });
            } catch {
                resolve(null);
            }
        });
    }

    /** @param {string} id @returns {Promise<object[]|null>} child bookmark nodes in order, or null on any failure */
    function getChildren(id) {
        return new Promise(resolve => {
            try {
                chrome.bookmarks.getChildren(id, nodes => {
                    if (chrome.runtime.lastError) { resolve(null); return; }
                    resolve(nodes || null);
                });
            } catch {
                resolve(null);
            }
        });
    }

    /**
     * Removes a bookmark node and, if it's a folder, everything inside it —
     * a Speed Dial tile IS a bookmark node either way (see the module
     * header), so removeTree is correct for both a regular tile and a
     * folder tile without needing to branch on which one it is.
     * @param {string} id @returns {Promise<boolean>} true on confirmed success
     */
    function removeTree(id) {
        return new Promise(resolve => {
            try {
                chrome.bookmarks.removeTree(id, () => resolve(!chrome.runtime.lastError));
            } catch {
                resolve(false);
            }
        });
    }

    /**
     * Creates a new bookmark (a Speed Dial tile) or folder as a sibling
     * of an existing node — used for the "Add Speed Dial" / "Add Folder"
     * context menu actions.
     * @param {{parentId:string, title:string, url?:string, index?:number}} details
     *        omit `url` to create a folder instead of a regular tile
     * @returns {Promise<object|null>} the created node, or null on failure
     */
    function create(details) {
        return new Promise(resolve => {
            try {
                chrome.bookmarks.create(details, node => {
                    if (chrome.runtime.lastError) { resolve(null); return; }
                    resolve(node || null);
                });
            } catch {
                resolve(null);
            }
        });
    }

    return { available, get, getChildren, removeTree, create };

})();


/* ============================================================
   SpeedDialUrlResolver
   ============================================================
   Vivaldi's Speed Dial cards do not reliably expose an <a href>.
   Preferred strategy, in order:
     1. Explicit data-url / data-uri / data-href / href, in case a
        future Vivaldi build (or another mod) provides one directly.
     2. chrome.bookmarks.get(tileId).url — the bookmark's own
        recorded URL, no parsing required (see BookmarksApi above).
     3. pageUrl/iconUrl extracted from the native favicon's srcset
        (see FaviconUrl) — the fallback if the bookmarks API isn't
        available for any reason.

   Folders are out of scope for this resolver: they have no single
   target URL. See FolderChildResolver for how folders are handled.
   ============================================================ */

const SpeedDialUrlResolver = (() => {

    async function resolve(tile) {
        if (!isRegularSpeedDial(tile)) return null;

        const attr = _fromAttributes(tile);
        if (attr) return attr;

        const viaBookmarks = await _fromBookmarksApi(tile);
        if (viaBookmarks) return viaBookmarks;

        return _fromFavicon(tile);
    }

    function _fromAttributes(tile) {
        const raw =
            tile.dataset.url ||
            tile.dataset.uri ||
            tile.dataset.href ||
            tile.getAttribute("href");
        return FaviconUrl.cleanHttpUrl(raw);
    }

    async function _fromBookmarksApi(tile) {
        if (!BookmarksApi.available()) return null;
        const tileId = getTileId(tile);
        if (!tileId) return null;

        const node = await BookmarksApi.get(tileId);
        return node?.url ? FaviconUrl.cleanHttpUrl(node.url) : null;
    }

    function _fromFavicon(tile) {
        const img = tile.querySelector(SELECTORS.regularFavicon);
        return FaviconUrl.extractFromImg(img);
    }

    return { resolve };

})();


/* ============================================================
   DomainNormalizer
   ============================================================
   URL → apex-ish domain used as the cache/lookup key.

   This intentionally stops short of a full Public Suffix List
   (that's a large, frequently-updated dataset for a problem this
   feature only needs an approximate answer to). It handles the
   plain case (labels.length <= 2) exactly, and the handful of
   extremely common "co.uk"-shaped second-level ccTLDs explicitly.
   Anything more exotic falls back to the naive last-two-labels
   guess, which just means a brand lookup for a rare ccTLD may
   occasionally use a slightly-too-broad domain — worst case is a
   negative cache entry, not a wrong icon on someone else's tile.

   One deliberate exception to "always collapse to apex": a small
   set of domains host multiple distinct, separately-branded
   products under one apex (gemini.google.com and mail.google.com
   are visually nothing alike, and collapsing both to "google.com"
   would show every Google product the same generic icon). For
   those specific apexes only, the immediate subdomain is kept as
   part of the identity instead of being stripped — see
   MULTI_PRODUCT_APEX below. Everything else (the vast majority of
   domains) still collapses normally, which keeps the cache
   effective: five Speed Dials to different docs.google.com URLs
   still share one lookup and one cache entry.
   ============================================================ */

const DomainNormalizer = (() => {

    const CC_SECOND_LEVEL = new Set([
        "co.uk", "org.uk", "gov.uk", "ac.uk",
        "co.jp", "co.in", "co.nz", "co.za", "co.kr",
        "com.au", "com.br", "com.mx", "com.tr", "com.sg", "com.hk",
    ]);

    /** Apex domains whose first-level subdomain is its own distinct brand. */
    const MULTI_PRODUCT_APEX = new Set(["google.com"]);

    function normalize(rawUrl) {
        let host;
        try {
            host = new URL(rawUrl).hostname.toLowerCase();
        } catch {
            return null;
        }
        if (!host) return null;

        host = host.replace(/^www\./, "");
        const apex = _apex(host);

        if (MULTI_PRODUCT_APEX.has(apex) && host !== apex) return host;
        return apex;
    }

    function _apex(host) {
        const labels = host.split(".").filter(Boolean);
        if (labels.length <= 2) return host;

        const lastTwo = labels.slice(-2).join(".");
        if (CC_SECOND_LEVEL.has(lastTwo) && labels.length >= 3) {
            return labels.slice(-3).join(".");
        }
        return lastTwo;
    }

    return { normalize };

})();


/* ============================================================
   FolderChildResolver
   ============================================================
   Folders have no single target URL — they represent a set of
   Speed Dials. Evidence for their DOM shape comes from two
   places: the project's own CSS, which has always targeted
   `img.favicon` elements *inside* `.thumbnail-favicon-children`
   (i.e. Vivaldi renders the same native favicon element for a
   folder's child previews that it renders for a regular tile —
   FaviconUrl's srcset-parsing logic therefore applies unchanged),
   and the confirmed regular-tile favicon URL format reused as-is.

   What is NOT independently verified — the DOM reconnaissance
   capture this project was built from contained zero folders — is
   whether native DOM order always matches the visual 2x2 grid
   order, and whether exactly ≤4 favicon elements are ever present
   at once. The renderer (see FolderPreviewRenderer) is built so
   getting that assumption wrong degrades to "icons in a slightly
   different order," never to a blank or broken folder — see its
   header comment for how.
   ============================================================ */

const FolderChildResolver = (() => {

    const MAX_CHILDREN = 4;

    /**
     * @param   {Element} folderTile
     * @returns {Promise<Array<{index:number, url:string|null, domain:string|null, faviconUrl:string|null}>>}
     */
    async function resolve(folderTile) {
        if (!isFolderSpeedDial(folderTile)) return [];

        const favicons = getFolderPreviewFaviconNodes(folderTile).slice(0, MAX_CHILDREN);
        if (!favicons.length) return [];

        const bookmarkChildren = await _bookmarkChildren(folderTile);

        return favicons.map((img, index) => {
            // Preferred: the bookmark's own recorded URL for this exact
            // child, by position — see BookmarksApi. Falls back to
            // scraping the rendered favicon's src/srcset only if the API
            // wasn't available or didn't return enough children.
            const bookmarkUrl = bookmarkChildren?.[index]?.url
                ? FaviconUrl.cleanHttpUrl(bookmarkChildren[index].url)
                : null;
            const url    = bookmarkUrl || FaviconUrl.extractFromImg(img);
            const domain = url ? DomainNormalizer.normalize(url) : null;
            const source = bookmarkUrl ? "bookmarks" : (url ? "favicon" : null);

            // img.currentSrc/img.src is the browser's own resolved favicon
            // image source — kept as a per-slot visual fallback even when
            // URL resolution fails entirely (the image can still be
            // perfectly renderable; we just can't determine what site it
            // represents, so it never drives an SVG lookup). A slot only
            // ever ends up with neither url nor faviconUrl if the <img>
            // itself has no usable src/srcset at all.
            const faviconUrl = img.currentSrc || img.src || null;

            // Two Speed Dials inside the same folder can legitimately point
            // at the same domain (e.g. two different github.com repos) —
            // that's a real, valid state, not something to silently merge
            // or drop. Both slots resolve to the same icon, which is
            // correct. IconService's in-flight/positive cache already
            // ensures that costs one lookup, not two.
            return { index, url: url || null, domain, faviconUrl, source };
        });
    }

    /**
     * @param {Element} folderTile
     * @returns {Promise<object[]|null>} first MAX_CHILDREN bookmark child
     *          nodes in order, or null if the API is unavailable/failed —
     *          callers must fall back to DOM scraping per-slot in that case.
     */
    async function _bookmarkChildren(folderTile) {
        if (!BookmarksApi.available()) return null;
        const folderId = getTileId(folderTile);
        if (!folderId) return null;

        const children = await BookmarksApi.getChildren(folderId);
        return children ? children.slice(0, MAX_CHILDREN) : null;
    }

    return { resolve };

})();


/* ============================================================
   BrandResolver
   ============================================================
   Domain → ordered list of theSVG slug candidates.

   Most domains need no mapping at all — "github.com" → "github"
   falls straight out of the apex label. The alias table exists
   only for the handful of cases where the domain's first label
   and the brand's actual slug diverge.
   ============================================================ */

const BrandResolver = (() => {

    const ALIASES = new Map([
        ["x.com", "twitter"],
        ["mail.google.com", "gmail"], // the only Google product whose subdomain label ("mail")
                                       // doesn't match its actual brand name — see
                                       // DomainNormalizer's MULTI_PRODUCT_APEX for why
                                       // "mail.google.com" reaches this function intact
                                       // instead of being collapsed to "google.com".
    ]);

    function candidates(domain) {
        const out = [];
        if (ALIASES.has(domain)) out.push(ALIASES.get(domain));

        const label = domain.split(".")[0];
        if (label && !out.includes(label)) out.push(label);

        return out;
    }

    return { candidates };

})();


/* ============================================================
   TheSvgProvider
   ============================================================
   Talks to theSVG's public, unauthenticated static CDN:
       https://thesvg.org/icons/{slug}/{variant}.svg
   with the jsDelivr mirror as a fallback host when the primary
   host errors (not when it 404s — a 404 means "no such icon",
   not "host is unreachable", and retrying the same lookup on a
   mirror won't change that).

   Only the normalized domain (never a full URL, path, or query
   string) is ever used to build a request — see the module
   header for the rest of the privacy rationale.

   Every branch below returns a tri-state result so the caller
   can distinguish "confirmed no icon" from "couldn't check" —
   see IconService for why that distinction drives different
   cache lifetimes.
   ============================================================ */

const TheSvgProvider = (() => {

    const PRIMARY_BASE = "https://thesvg.org/icons";
    const MIRROR_BASE  = "https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons";
    const VARIANTS     = ["default", "color", "mono"];
    const FETCH_TIMEOUT_MS = 5000;
    const MAX_RESPONSE_BYTES = 200_000; // reject anything implausibly large for a brand glyph

    /**
     * @param   {string} domain — normalized apex domain
     * @returns {Promise<{status:"success",svg:string}|{status:"not-found"}|{status:"error"}>}
     */
    async function lookup(domain) {
        const slugs = BrandResolver.candidates(domain);
        let sawError = false;

        for (const slug of slugs) {
            for (const variant of VARIANTS) {
                const path = `/${encodeURIComponent(slug)}/${variant}.svg`;

                const primary = await _tryFetch(PRIMARY_BASE + path);
                if (primary.status === "success") return primary;
                if (primary.status === "error") {
                    sawError = true;
                    const mirror = await _tryFetch(MIRROR_BASE + path);
                    if (mirror.status === "success") return mirror;
                }
            }
        }

        return { status: sawError ? "error" : "not-found" };
    }

    async function _tryFetch(url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        try {
            const res = await fetch(url, {
                signal:          controller.signal,
                credentials:     "omit",
                referrerPolicy:  "no-referrer",
                mode:            "cors",
            });

            if (res.status === 404) return { status: "not-found" };
            if (!res.ok)             return { status: "error" };

            const text = await res.text();
            if (!text || text.length > MAX_RESPONSE_BYTES) return { status: "error" };

            // A 200 response that isn't actually SVG (rate-limit page,
            // HTML error page masquerading as 200, etc.) must never be
            // treated as "found" — sniff before we even try to parse it.
            if (!/^\uFEFF?\s*(<\?xml|<svg)/i.test(text)) return { status: "not-found" };

            let clean;
            try {
                clean = IconSanitizer.sanitize(text);
            } catch {
                // Fetched something SVG-shaped that failed sanitization —
                // treat as unusable rather than caching it as a success.
                return { status: "error" };
            }

            return { status: "success", svg: clean };
        } catch {
            return { status: "error" };
        } finally {
            clearTimeout(timer);
        }
    }

    return { lookup };

})();


/* ============================================================
   IconService
   ============================================================
   Layered cache in front of TheSvgProvider:
     in-memory Map  → chrome.storage.local  → provider lookup

   Also de-duplicates concurrent lookups for the same domain
   (e.g. three Speed Dials all pointing at github.com trigger
   exactly one network request, not three).

   Cache is keyed by domain, not by tile — icon identity belongs
   to the website, not to any one Speed Dial card.
   ============================================================ */

const IconService = (() => {

    const CACHE_KEY      = "vivaldi_swift_auto_icons";
    const CACHE_VERSION  = 1;
    const MAX_ENTRIES    = 800;   // evict oldest by updatedAt beyond this
    const MAX_PERSIST_SVG_BYTES = 60_000; // larger icons still render this
                                           // session but aren't persisted —
                                           // see _persistable() below

    /** @type {Map<string, {status:string, svg?:string, updatedAt:number}>} */
    const _mem = new Map();
    /** @type {Map<string, Promise<object>>} */
    const _inflight = new Map();

    let _persistTimer = null;

    async function init() {
        try {
            const result = await chrome.storage.local.get(CACHE_KEY);
            const raw = result[CACHE_KEY];
            if (raw && raw.version === CACHE_VERSION && raw.domains && typeof raw.domains === "object") {
                for (const [domain, entry] of Object.entries(raw.domains)) {
                    if (_validEntry(entry)) _mem.set(domain, entry);
                }
            }
            console.log(`[Vivaldi Swift] Auto-icon cache hydrated — ${_mem.size} domain(s).`);
            __diag.cacheEntries = _mem.size;
        } catch (e) {
            console.error("[Vivaldi Swift] Auto-icon cache init failed:", e);
        }
    }

    function _validEntry(entry) {
        if (!entry || typeof entry !== "object") return false;
        if (!["success", "not-found", "error"].includes(entry.status)) return false;
        if (!Number.isFinite(entry.updatedAt)) return false;
        if (entry.status === "success" && typeof entry.svg !== "string") return false;
        return true;
    }

    function _ttlFor(status) {
        if (status === "success")   return POSITIVE_CACHE_TTL_MS;
        if (status === "not-found") return NEGATIVE_CACHE_TTL_MS;
        return ERROR_CACHE_TTL_MS;
    }

    function _isFresh(entry) {
        return (Date.now() - entry.updatedAt) < _ttlFor(entry.status);
    }

    function _schedulePersist() {
        if (_persistTimer) return;
        _persistTimer = setTimeout(() => {
            _persistTimer = null;
            _persist();
        }, 500);
    }

    function _persist() {
        // Evict oldest entries beyond MAX_ENTRIES before writing.
        if (_mem.size > MAX_ENTRIES) {
            const sorted = [..._mem.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
            const toDrop = sorted.slice(0, _mem.size - MAX_ENTRIES);
            for (const [domain] of toDrop) _mem.delete(domain);
        }

        const domains = {};
        for (const [domain, entry] of _mem.entries()) {
            domains[domain] = _persistable(entry);
        }

        chrome.storage.local
            .set({ [CACHE_KEY]: { version: CACHE_VERSION, domains } })
            .catch(e => console.error("[Vivaldi Swift] Auto-icon cache persist failed:", e));
    }

    /** Drop oversized SVG payloads from the persisted copy; keep them in memory. */
    function _persistable(entry) {
        if (entry.status === "success" && entry.svg && entry.svg.length > MAX_PERSIST_SVG_BYTES) {
            return { status: "error", updatedAt: entry.updatedAt };
        }
        return entry;
    }

    /**
     * @param   {string} domain
     * @returns {Promise<{status:string, svg?:string}>}
     */
    function resolve(domain) {
        const cached = _mem.get(domain);
        if (cached && _isFresh(cached)) return Promise.resolve(cached);

        if (_inflight.has(domain)) return _inflight.get(domain);

        const p = TheSvgProvider.lookup(domain)
            .catch(() => ({ status: "error" }))
            .then(result => {
                const entry = { status: result.status, svg: result.svg, updatedAt: Date.now() };
                _mem.set(domain, entry);
                _schedulePersist();
                return entry;
            })
            .finally(() => _inflight.delete(domain));

        _inflight.set(domain, p);
        return p;
    }

    return { init, resolve };

})();


/* ============================================================
   Renderer
   ============================================================
   Builds the injected wrapper hierarchy. No per-tile layout
   customization exists anymore — the wrapper always centers its
   icon at a fixed size via CSS custom-property defaults, so this
   module has nothing left to configure per tile beyond the SVG
   content itself.
   ============================================================ */

const Renderer = (() => {

    const LAYOUT_WRAPPER_BASE = {
        position:        "absolute",
        inset:           "0",
        display:         "flex",
        alignItems:      "center",
        justifyContent:  "center",
        pointerEvents:   "none",
        userSelect:      "none",
        zIndex:          "1",
        overflow:        "visible",
    };

    const ICON_WRAPPER_BASE = {
        position:       "relative",
        display:        "flex",
        alignItems:     "center",
        justifyContent: "center",
        pointerEvents:  "none",
        userSelect:     "none",
        flexShrink:     "0",
        overflow:       "visible",
    };

    function renderLayoutWrapper() {
        const wrap     = document.createElement("div");
        wrap.className = "custom-layout-wrapper";
        Object.assign(wrap.style, LAYOUT_WRAPPER_BASE);
        return wrap;
    }

    /**
     * @param {string} svgString — already sanitized
     * @param {string} idPrefix
     */
    function renderSVG(svgString, idPrefix) {
        const wrap     = document.createElement("div");
        wrap.className = "custom-icon-wrapper custom-icon-wrapper--svg";
        Object.assign(wrap.style, ICON_WRAPPER_BASE);
        wrap.innerHTML = svgString;
        wrap.setAttribute("aria-hidden", "true"); // decorative — tile title carries the accessible name

        const svgEl = wrap.querySelector("svg");
        if (svgEl) {
            svgEl.style.cssText = "display:block;width:100%;height:100%;flex-shrink:0;";
            if (idPrefix) IconSanitizer.namespaceIds(svgEl, idPrefix);
        }

        return wrap;
    }

    /**
     * Per-count grid container styles. Four icons is the only case
     * that's genuinely a 2x2 grid; 1-3 icons get a layout sized for
     * that count specifically (see this function's header) rather
     * than a 4-cell grid with empty cells stretched to fill it.
     *
     * Deliberately NOT position:absolute/inset:0 — .thumbnail-favicon-folder
     * (the parent we're appended into) already centers its children via
     * flex/grid place-content, both natively and via this project's own
     * "ICON POSITIONING" CSS rule, exactly the way .custom-layout-wrapper
     * centers the single-icon case for regular tiles. Filling the whole
     * (non-square, ~90x64) container and dividing it with 1fr/percentage
     * stretching was the actual cause of the uneven spacing — icon size
     * came out different in each direction because the container isn't
     * square. Fixed pixel sizes (via CSS custom properties, see
     * vivaldi_swift.css) sidestep that entirely: every slot is a true
     * square regardless of the parent's aspect ratio, the same way
     * --custom-icon-size works for regular tiles.
     */
    const LAYOUT_BY_COUNT = {
        1: { display: "flex", alignItems: "center", justifyContent: "center" },
        2: { display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "center" },
        3: { display: "grid", gridTemplateColumns: "repeat(2, var(--custom-folder-slot-size))", gridTemplateRows: "repeat(2, var(--custom-folder-slot-size))" },
        4: { display: "grid", gridTemplateColumns: "repeat(2, var(--custom-folder-slot-size))", gridTemplateRows: "repeat(2, var(--custom-folder-slot-size))" },
    };

    /** Slot side length per count — smaller counts get a bit more visual weight per icon. */
    const SLOT_SIZE_BY_COUNT = { 1: "34px", 2: "24px", 3: "20px", 4: "20px" };

    function _makeSlot(slot, index, folderIdPrefix) {
        const cell = document.createElement("div");
        cell.className = "vivaldi-swift-folder-slot";
        cell.dataset.index = String(index);

        if (slot?.svg) {
            const iconEl = renderSVG(slot.svg, `${folderIdPrefix}slot${index}-`);
            cell.appendChild(iconEl);
        } else if (slot?.faviconUrl) {
            const img = document.createElement("img");
            img.src = slot.faviconUrl;
            img.alt = "";
            cell.appendChild(img);
        }
        // Neither available → cell stays empty (transparent), never a broken-image icon.

        return cell;
    }

    /**
     * Builds a complete, self-contained folder preview — laid out for
     * however many icons are actually available (1, 2, 3, or 4), not
     * always a 2x2 grid with empty cells stretched to fill unused
     * space:
     *
     *   1  →  single icon, centered
     *   2  →  side by side
     *   3  →  two on top, one centered underneath
     *   4  →  standard 2x2 grid
     *
     * Every slot gets *something* rendered — an SVG if one resolved,
     * otherwise that child's own native favicon image (re-hosted, not
     * borrowed from the live native DOM) — so the grid is never a
     * worse representation than Vivaldi's native preview would be,
     * only ever an equal or better one. That's what makes it safe to
     * swap in wholesale rather than trying to overlay partial results
     * on top of native content of unknown layout.
     *
     * @param {Array<{index:number, svg?:string, faviconUrl?:string}>} slots — already
     *        sorted by index; length is however many real children the
     *        folder has (1-4), not necessarily 4
     * @param {string} folderIdPrefix — unique per folder tile
     */
    function renderFolderPreview(slots, folderIdPrefix) {
        const grid = document.createElement("div");
        grid.className = "vivaldi-swift-folder-preview";
        grid.setAttribute("aria-hidden", "true");

        const present = slots.filter(s => s.svg || s.faviconUrl);
        const count = Math.min(present.length, 4) || 1; // defensive floor; caller already guards count===0

        Object.assign(grid.style, LAYOUT_BY_COUNT[count]);
        grid.style.setProperty("--custom-folder-slot-size", SLOT_SIZE_BY_COUNT[count]);
        grid.dataset.count = String(count);

        if (count === 3) {
            // [A][B] on row 1, [C] centered spanning both columns on row 2.
            const [a, b, c] = present;
            const cellA = _makeSlot(a, a.index, folderIdPrefix);
            const cellB = _makeSlot(b, b.index, folderIdPrefix);
            const cellC = _makeSlot(c, c.index, folderIdPrefix);
            cellA.style.gridColumn = "1"; cellA.style.gridRow = "1";
            cellB.style.gridColumn = "2"; cellB.style.gridRow = "1";
            cellC.style.gridColumn = "1 / span 2"; cellC.style.gridRow = "2";
            cellC.style.justifySelf = "center";
            grid.append(cellA, cellB, cellC);
        } else if (count === 1) {
            grid.appendChild(_makeSlot(present[0], present[0].index, folderIdPrefix));
        } else if (count === 2) {
            present.forEach(s => grid.appendChild(_makeSlot(s, s.index, folderIdPrefix)));
        } else {
            present.slice(0, 4).forEach(s => grid.appendChild(_makeSlot(s, s.index, folderIdPrefix)));
        }

        return grid;
    }

    return { renderLayoutWrapper, renderSVG, renderFolderPreview };

})();


/* ============================================================
   AutoIconController
   ============================================================
   Orchestrates one tile: resolve URL → normalize domain → cache/
   provider lookup → render. Progressive enhancement throughout —
   the native favicon stays fully interactive and visible until
   (and unless) a validated replacement is ready to swap in.

   State tracking uses a WeakSet rather than a DOM attribute:
   this is pure implementation bookkeeping with no CSS or
   debugging value, and a WeakSet correctly "forgets" a tile if
   Vivaldi ever recreates the underlying element, which a DOM
   attribute surviving on a stale node would not.
   ============================================================ */

const AutoIconController = (() => {

    /** Tiles whose async resolution has already been kicked off. */
    const _started = new WeakSet();

    async function process(tile) {
        if (!isRegularSpeedDial(tile)) return;
        if (_started.has(tile)) return;
        _started.add(tile);

        const url = await SpeedDialUrlResolver.resolve(tile);
        if (!url) return; // no recoverable URL — native favicon stands, nothing more to do

        const domain = DomainNormalizer.normalize(url);
        if (!domain) return;

        try {
            const result = await IconService.resolve(domain);
            debugLog("Regular card", getTileId(tile) || "(no id)", "— URL:", domain, "— icon:", result.status);
            __diag.regularCards.total += 1;
            if (result.status === "success")        __diag.regularCards.success  += 1;
            else if (result.status === "not-found")  __diag.regularCards.notFound += 1;
            else                                     __diag.regularCards.error    += 1;
            await _apply(tile, domain, result);
        } catch (e) {
            console.warn("[Vivaldi Swift] Auto-icon lookup failed:", e);
        }
    }

    async function _apply(tile, expectedDomain, result) {
        if (result.status !== "success") return; // not-found / error → native favicon stands

        // The async lookup may have outlived the tile (removed, or Vivaldi
        // recycled this element for a different card while we were
        // fetching). Re-check both connectivity and identity before
        // touching the DOM.
        if (!tile.isConnected) return;
        const stillSameCard = await SpeedDialUrlResolver.resolve(tile);
        if (!stillSameCard || DomainNormalizer.normalize(stillSameCard) !== expectedDomain) return;

        const container = getRegularIconContainer(tile);
        if (!container) return;

        // Avoid double-injection if this tile is somehow processed twice
        // (e.g. a fresh element with the same identity after a re-render).
        if (container.querySelector(".custom-layout-wrapper")) return;

        // .thumbnail-favicon is position:static by default; promote to
        // relative so our absolute layout wrapper is contained by it.
        container.style.position = "relative";

        const layoutWrapper = Renderer.renderLayoutWrapper();
        const iconWrapper   = Renderer.renderSVG(result.svg, _idPrefix(getTileId(tile) || expectedDomain));
        layoutWrapper.appendChild(iconWrapper);
        container.appendChild(layoutWrapper);

        // The SVG was already fetched, validated, and sanitized as text
        // before we ever got here — there is no async "did the image
        // load" step the way there would be for an <img src="..."> or a
        // blob URL, so hiding the native favicon can happen in the same
        // synchronous block as the successful injection above.
        const favicon = tile.querySelector(".favicon");
        if (favicon) favicon.style.opacity = "0";

        tile.dataset.vivaldiSwiftIcon = "auto"; // debugging/CSS hook only, not a state gate
    }

    return { process };

})();


/* ============================================================
   FolderPreviewController
   ============================================================
   Folder counterpart to AutoIconController. Discovers up to four
   child domains (FolderChildResolver), resolves each independently
   through the *same* IconService regular tiles use, and — only once
   every lookup has settled — builds one complete replacement grid
   (Renderer.renderFolderPreview) and swaps it in.

   This fixes the previous blank-folder regression, which had two
   causes stacked on each other: (1) folders were never given a
   replacement of any kind, and (2) pre-existing CSS from the old
   manual-icon era unconditionally hid Vivaldi's native folder
   preview regardless. That CSS has been removed — see
   vivaldi_swift.css — so an un-processed or unresolvable folder now
   simply shows its normal native preview, same as before this
   feature existed at all.

   Per-slot fallback (SVG → that child's own native favicon → empty)
   is handled inside Renderer.renderFolderPreview itself, which is
   why this controller can safely wait for full settlement rather
   than juggling partial DOM updates as each lookup completes —
   see that function's header comment for the reasoning.

   Content-change detection: a folder's children can change without
   its own tile element ever being recreated (items dragged in/out,
   reordered). Each call to process() re-discovers the current
   children and compares a signature (built from each slot's actual
   destination URL, not just its normalized domain, so a same-domain-
   different-page change is still detected — see FolderChildResolver)
   against the signature last *started*. A mismatch always supersedes
   whatever's currently resolving, via a per-tile generation counter:
   starting new work never waits for old work to finish first, and old
   work simply discards its own result if the generation has moved on
   by the time it completes. This replaces an earlier version of this
   controller that gated new work behind `!prior.resolving`, which
   could permanently drop a content change that arrived while a
   previous resolution for that same folder was still in flight.
   ============================================================ */

const FolderPreviewController = (() => {

    /**
     * @typedef {{signature:string, generation:number}} FolderState
     * @type {WeakMap<Element, FolderState>}
     */
    const _state = new WeakMap();

    async function process(tile) {
        if (!isFolderSpeedDial(tile)) return;

        const tileKey = getTileId(tile) || `(no id, ${Math.random().toString(36).slice(2, 8)})`;

        const children = await FolderChildResolver.resolve(tile);
        const signature = children.map(c => `${c.index}:${c.url || ""}`).join("|");

        let state = _state.get(tile);
        if (!state) {
            state = { signature: null, generation: 0 };
            _state.set(tile, state);
        }

        // Detection itself is recorded before the "nothing changed" early
        // return below, so a folder that's found but never gets any
        // further still shows up in __vivaldiSwift.folders — if the map
        // stays empty entirely, isFolderSpeedDial() is never matching
        // anything, which is a different (and earlier) problem than
        // anything downstream.
        __diag.folders.set(tileKey, {
            ...( __diag.folders.get(tileKey) || {} ),
            childCount: children.length,
            lastSeenAt: new Date().toISOString(),
        });

        if (state.signature === signature) return; // already started (or already applied) for this exact content

        state.signature  = signature;
        state.generation += 1;
        const myGeneration = state.generation;

        if (DEBUG) {
            debugLog(`Folder ${getTileId(tile) || "(no id)"} — signature changed, generation ${myGeneration}`);
            debugLog(`  preview container: ${getFolderPreviewContainer(tile) ? "found" : "MISSING"}`);
            debugLog(`  children container: ${getFolderChildrenContainer(tile) ? "found" : "MISSING"}`);
            debugLog(`  favicon nodes: ${getFolderPreviewFaviconNodes(tile).length}`);
            children.forEach(c => {
                debugLog(`  child ${c.index}: url=${c.url || "(none)"} domain=${c.domain || "(none)"} source=${c.source || "(none)"} faviconUrl=${c.faviconUrl || "(none)"}`);
            });
        }

        if (!children.length) {
            _clearPreview(tile);
            debugLog(`Folder ${getTileId(tile) || "(no id)"} — no favicon nodes found, native preview stands.`);
            return;
        }

        Promise.allSettled(
            children.map(child =>
                // A child with no resolvable domain (extraction failed for
                // every candidate on that <img>) never reaches the network —
                // it still carries a faviconUrl fallback through to
                // rendering, just with no possibility of an SVG upgrade.
                child.domain
                    ? IconService.resolve(child.domain).then(result => ({ ...child, result }))
                    : Promise.resolve({ ...child, result: { status: "not-found" } })
            )
        ).then(settled => {
            // The folder's contents may have changed again while these
            // lookups were in flight — the generation captured above
            // will no longer match state.generation in that case, and
            // this (now-stale) result is dropped. Note this is *not*
            // gated behind "no newer work has started" — newer work is
            // always allowed to start immediately (see the signature
            // check above), so by the time we get here the newer
            // generation may already be resolving or even applied.
            if (state.generation !== myGeneration) {
                debugLog(`Folder ${getTileId(tile) || "(no id)"} — generation ${myGeneration} superseded by ${state.generation}, discarding.`);
                return;
            }
            const resolvedCount = settled.filter(r => r.status === "fulfilled" && r.value.result?.status === "success").length;
            __diag.folders.set(tileKey, {
                ...( __diag.folders.get(tileKey) || {} ),
                resolvedCount,
                lastResult: settled.map(r => r.status === "fulfilled"
                    ? `${r.value.domain || "(no domain)"}:${r.value.result?.status}`
                    : "rejected"),
                lastUpdated: new Date().toISOString(),
            });
            if (DEBUG) {
                settled.forEach(r => {
                    if (r.status === "fulfilled") debugLog(`  ${r.value.domain} → ${r.value.result?.status}`);
                });
            }
            _apply(tile, settled);
        });
    }

    function _apply(tile, settled) {
        if (!tile.isConnected) return;
        const childrenContainer = getFolderChildrenContainer(tile);
        if (!childrenContainer) return; // folder DOM changed shape under us — leave native alone

        const container = getFolderPreviewContainer(tile);
        if (!container) return;

        // Preserve original discovery order regardless of which lookup
        // settled first — Promise.allSettled already preserves input
        // order in its output array, but this is the one invariant the
        // whole feature depends on, so it's asserted explicitly here
        // rather than trusted implicitly.
        const slots = settled
            .filter(r => r.status === "fulfilled")
            .map(r => r.value)
            .sort((a, b) => a.index - b.index)
            .map(child => ({
                index:      child.index,
                svg:        child.result?.status === "success" ? child.result.svg : undefined,
                faviconUrl: child.faviconUrl,
            }));

        // Nothing usable at all (every lookup errored/not-found AND, in
        // principle, every faviconUrl was somehow also missing) → don't
        // render an empty grid over a perfectly fine native preview.
        const hasAnyContent = slots.some(s => s.svg || s.faviconUrl);
        if (!hasAnyContent) { _clearPreview(tile); return; }

        container.style.position = "relative";

        const folderSlug = (getTileId(tile) || Math.random().toString(36).slice(2))
            .replace(/[^a-zA-Z0-9]/g, "_");
        const folderIdPrefix = `sd4-folder-${folderSlug}-`;
        const grid = Renderer.renderFolderPreview(slots, folderIdPrefix);

        // Build the new grid completely before touching anything already
        // in the DOM, then swap in one step — this is what keeps a content
        // change (Part 18) from ever producing a flash of "no preview".
        const existing = container.querySelector(".vivaldi-swift-folder-preview");
        if (existing) existing.replaceWith(grid); else container.appendChild(grid);

        // The grid is a complete, self-contained representation (real SVG
        // or a re-hosted native favicon per slot — see renderFolderPreview),
        // so — exactly as with regular tiles — hiding native content can
        // happen in the same synchronous block as a successful append.
        childrenContainer.style.opacity = "0";

        tile.dataset.vivaldiSwiftIcon = "auto-folder"; // debugging/CSS hook only
        const tileKey = getTileId(tile);
        if (tileKey) {
            __diag.folders.set(tileKey, {
                ...( __diag.folders.get(tileKey) || {} ),
                injected: true,
                slotsShown: slots.filter(s => s.svg || s.faviconUrl).length,
            });
        }
        debugLog(`Folder ${getTileId(tile) || "(no id)"} — preview injected: true — resolved ${slots.filter(s => s.svg).length}/${slots.length} — native hidden: true`);
    }

    /** Undo our own additions, reverting to whatever Vivaldi renders natively. */
    function _clearPreview(tile) {
        const container = getFolderPreviewContainer(tile);
        const existing = container?.querySelector(".vivaldi-swift-folder-preview");
        if (existing) existing.remove();

        const childrenContainer = getFolderChildrenContainer(tile);
        if (childrenContainer) childrenContainer.style.opacity = "";

        delete tile.dataset.vivaldiSwiftIcon;
    }

    return { process };

})();


/* ============================================================
   SpeedDialIconController
   ============================================================
   Thin dispatcher — the only place in the file that branches on
   Speed Dial type. Both scanning entry points (initial bootstrap
   scan, MutationObserver callback) go through this, so there is
   exactly one processAll() and one per-tile routing decision, not
   a separate scan for folders and another for regular tiles.
   ============================================================ */

const SpeedDialIconController = (() => {

    function process(tile) {
        if (isFolderSpeedDial(tile)) {
            FolderPreviewController.process(tile);
        } else if (isRegularSpeedDial(tile)) {
            AutoIconController.process(tile);
        }
    }

    function processAll() {
        for (const tile of document.querySelectorAll(SELECTORS.speedDial)) {
            process(tile);
        }
    }

    return { process, processAll };

})();


/* ============================================================
   ContextMenu
   ============================================================
   Vivaldi already owns Speed Dial deletion — clicking its own
   remove control is the one reliable way to trigger it, and there
   is no supported public API for it, so this stays a thin
   shortcut rather than a reimplementation. Icon assignment is no
   longer a manual action, so this menu no longer offers it.

   Add Speed Dial / Add Folder go through chrome.bookmarks.create()
   — the same API BookmarksApi already uses elsewhere — since a
   Speed Dial tile IS a bookmark node; Vivaldi's own reactive UI
   picks up the new node and renders it, no DOM manipulation needed.

   Change Position does not implement its own drag-and-drop. Vivaldi
   already does — every tile's own class list includes "draggable",
   and its real onDragStart/onDragOver/onDrop handlers already
   reorder tiles by dragging (confirmed directly from Vivaldi's own
   source). Reimplementing that would mean fighting React for control
   of the same gesture on the same elements, which is a losing,
   flicker-prone fight, not a feature — see RepositionMode below for
   what this does instead.
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
        const tile = e.target.closest(SELECTORS.speedDial);
        if (!tile) { _dismiss(); return; }

        e.preventDefault();
        e.stopImmediatePropagation();

        _activeTile = tile;
        _render();
        _position(e.clientX, e.clientY);
    }

    const _REMOVE_SVG = `<svg class="swift-menu-icon-svg" viewBox="0 0 16 16" fill="none">
        <path d="M3 4h10M6 4V3a.5.5 0 0 1 .5-.5h3A.5.5 0 0 1 10 3v1
                 M5 4v8.5a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5V4"
              stroke="currentColor" stroke-width="1.25"
              stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

    const _ADD_DIAL_SVG = `<svg class="swift-menu-icon-svg" viewBox="0 0 16 16" fill="none">
        <rect x="2.5" y="2.5" width="11" height="11" rx="2"
              stroke="currentColor" stroke-width="1.25"/>
        <path d="M8 5.5v5M5.5 8h5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
    </svg>`;

    const _ADD_FOLDER_SVG = `<svg class="swift-menu-icon-svg" viewBox="0 0 16 16" fill="none">
        <path d="M2.5 4.5A1 1 0 0 1 3.5 3.5h3l1.2 1.6h4.8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"
              stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
        <path d="M8 8v3M6.5 9.5h3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
    </svg>`;

    const _MOVE_SVG = `<svg class="swift-menu-icon-svg" viewBox="0 0 16 16" fill="none">
        <path d="M8 2.5v11M2.5 8h11M4.5 5l-2 3 2 3M11.5 5l2 3-2 3M5 4.5l3-2 3 2M5 11.5l3 2 3-2"
              stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

    function _render() {
        _el.innerHTML = `
            <div class="swift-menu-item" data-action="add-sd">
                ${_ADD_DIAL_SVG}<span>Add Speed Dial</span>
            </div>
            <div class="swift-menu-item" data-action="add-folder">
                ${_ADD_FOLDER_SVG}<span>Add Folder</span>
            </div>
            <div class="swift-menu-item" data-action="reposition">
                ${_MOVE_SVG}<span>Change Position</span>
            </div>
            <div class="swift-menu-separator"></div>
            <div class="swift-menu-item swift-menu-item--danger" data-action="remove-sd">
                ${_REMOVE_SVG}<span>Remove Speed Dial</span>
            </div>`;
    }

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

    function _onItemClick(e) {
        const item = e.target.closest("[data-action]");
        if (!item) return;

        const tile = _activeTile;
        _dismiss();
        if (!tile) return;

        switch (item.dataset.action) {
            case "remove-sd":   _removeSpeedDial(tile); break;
            case "add-sd":      _addSpeedDial(tile);    break;
            case "add-folder":  _addFolder(tile);       break;
            case "reposition":  RepositionMode.enter(); break;
        }
    }

    /**
     * New tiles are created as a sibling immediately after the
     * right-clicked one — same parent folder (or the top-level Speed
     * Dial root if the tile isn't nested), next index. There's no
     * reliable DOM fallback for creation the way .close is for
     * removal (no generic "add" button to guess a selector for), so
     * this is bookmarks-API-only; it fails visibly (an alert) rather
     * than silently if that API isn't available.
     */
    async function _addSpeedDial(tile) {
        const parent = await _siblingParent(tile);
        if (!parent) return _createUnavailable();

        const title = prompt("Title for the new Speed Dial:", "");
        if (title === null) return; // cancelled
        const url = prompt("URL for the new Speed Dial:", "https://");
        if (url === null) return; // cancelled

        const cleanedUrl = FaviconUrl.cleanHttpUrl(url);
        if (!cleanedUrl) { alert("That doesn't look like a valid http(s) URL."); return; }

        const created = await BookmarksApi.create({
            parentId: parent.parentId,
            index:    parent.index,
            title:    title || cleanedUrl,
            url:      cleanedUrl,
        });
        if (!created) _createUnavailable();
    }

    async function _addFolder(tile) {
        const parent = await _siblingParent(tile);
        if (!parent) return _createUnavailable();

        const title = prompt("Folder name:", "New Folder");
        if (title === null) return; // cancelled

        const created = await BookmarksApi.create({
            parentId: parent.parentId,
            index:    parent.index,
            title:    title || "New Folder",
            // omitting `url` is what makes chrome.bookmarks.create() a folder
        });
        if (!created) _createUnavailable();
    }

    /** @returns {Promise<{parentId:string, index:number}|null>} */
    async function _siblingParent(tile) {
        if (!BookmarksApi.available()) return null;
        const tileId = getTileId(tile);
        if (!tileId) return null;

        const node = await BookmarksApi.get(tileId);
        if (!node?.parentId) return null;

        return { parentId: node.parentId, index: (node.index ?? 0) + 1 };
    }

    function _createUnavailable() {
        alert("Vivaldi Swift couldn't create that — the bookmarks API isn't available right now.");
    }

    /**
     * A Speed Dial tile IS a bookmark node (data-id is literally the
     * bookmark id — confirmed from Vivaldi's own React source; see
     * BookmarksApi's header comment), so chrome.bookmarks.removeTree()
     * is the direct, correct way to remove one regardless of whether
     * it's a regular tile or a folder.
     *
     * This used to click a guessed selector (.RemoveButton /
     * [data-vivaldi-action='remove'] / [aria-label='Remove']) that
     * doesn't exist in Vivaldi's real DOM at all — confirmed against
     * both the actual bundle.js and common.css, which is why this
     * silently did nothing before. The real native button is
     * `.close` (top-right, hover-revealed) — kept below as an
     * automatic fallback for the one real gap removeTree has: Vivaldi
     * has a genuine "Show Delete Speed Dial Button" setting, and
     * nothing here can distinguish "bookmarks API unavailable" from
     * "user turned that setting off elsewhere" — but removeTree
     * doesn't depend on that setting or on any particular DOM
     * structure at all, so it's tried first.
     */
    async function _removeSpeedDial(tile) {
        const tileId = getTileId(tile);
        if (tileId && BookmarksApi.available()) {
            const removed = await BookmarksApi.removeTree(tileId);
            if (removed) return;
        }

        const closeBtn = tile.querySelector(".close, .RemoveButton, [data-vivaldi-action='remove'], [aria-label='Remove']");
        if (closeBtn) {
            closeBtn.click();
        } else {
            console.warn("[Vivaldi Swift] Could not remove this Speed Dial — bookmarks API failed and no native remove control was found on the tile.");
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
   RepositionMode
   ============================================================
   A discoverable, deliberate wrapper around Vivaldi's own native
   tile dragging (see ContextMenu's header comment for why this
   doesn't reimplement dragging itself). Activating it does exactly
   two things, neither of which touches drag mechanics at all:
     1. Adds a body-level class so CSS can visually mark every tile
        as "this is draggable right now" (outline + grab cursor).
     2. Shows a small dismissible banner explaining that and how to
        exit — Escape, the banner's own button, or a plain click
        anywhere outside a tile.
   Native dragging is not actually gated behind this — it works
   the same with or without this mode active, exactly as it always
   has ("existing workflow continues to work as-is"). What this adds
   is purely the guided, explicit on/off affordance that was asked
   for, without the risk of a second system fighting React for
   control of the same gesture.
   ============================================================ */

const RepositionMode = (() => {

    const ACTIVE_CLASS = "vivaldi-swift-reposition-mode";
    let _banner = null;
    let _active = false;

    function enter() {
        if (_active) return;
        _active = true;

        document.body.classList.add(ACTIVE_CLASS);
        _showBanner();

        document.addEventListener("keydown", _onKeydown);
        // Capture phase, and only acts on clicks outside any tile — this
        // must never swallow the click that starts a native drag.
        document.addEventListener("click", _onDocClick, true);
    }

    function exit() {
        if (!_active) return;
        _active = false;

        document.body.classList.remove(ACTIVE_CLASS);
        _banner?.remove();
        _banner = null;

        document.removeEventListener("keydown", _onKeydown);
        document.removeEventListener("click", _onDocClick, true);
    }

    function _showBanner() {
        _banner = document.createElement("div");
        _banner.className = "vivaldi-swift-reposition-banner";
        _banner.innerHTML = `
            <span>Drag any Speed Dial to reposition it.</span>
            <button type="button">Done</button>`;
        _banner.querySelector("button").addEventListener("click", exit);
        document.body.appendChild(_banner);
    }

    function _onKeydown(e) {
        if (e.key === "Escape") exit();
    }

    function _onDocClick(e) {
        if (!e.target.closest(SELECTORS.speedDial) && !e.target.closest(".vivaldi-swift-reposition-banner")) {
            exit();
        }
    }

    return { enter, exit };

})();


/* ============================================================
   VisualDiagnostics
   ============================================================
   Everything above this point requires finding the correct
   DevTools target (vivaldi://inspect/#apps/) before it's any use
   at all — a real, confirmed obstacle in this project's own
   troubleshooting so far. This renders the same information
   directly on the page instead: a small corner badge, on by
   default, that needs no console access to read at all.

   Persistently dismissible per-profile (chrome.storage.local, same
   store IconService already uses) so it doesn't have to be turned
   off every session once things are confirmed working — but it
   defaults ON, specifically because a debug aid nobody can
   successfully turn on is worse than one that's mildly in the way
   until dismissed once.
   ============================================================ */

const VisualDiagnostics = (() => {

    const DISMISS_KEY = "vivaldi_swift_diagnostics_dismissed";
    let _el = null;
    let _dismissed = false;

    async function init() {
        try {
            const result = await chrome.storage.local.get(DISMISS_KEY);
            _dismissed = !!result[DISMISS_KEY];
        } catch { /* default to shown if storage itself is unavailable */ }

        if (_dismissed) return;
        _render();
        _tick();
        setInterval(_tick, 1000);
    }

    function _render() {
        _el = document.createElement("div");
        _el.id = "vivaldi-swift-diagnostics";
        Object.assign(_el.style, {
            position: "fixed", bottom: "12px", right: "12px", zIndex: "999999",
            background: "rgba(20,20,24,.92)", color: "#e8e8ec",
            font: "11px/1.5 -apple-system,Segoe UI,sans-serif",
            padding: "8px 10px", borderRadius: "8px", maxWidth: "300px",
            boxShadow: "0 4px 16px rgba(0,0,0,.4)", pointerEvents: "auto",
            whiteSpace: "pre-wrap",
        });

        const close = document.createElement("span");
        close.textContent = "✕";
        Object.assign(close.style, { float: "right", cursor: "pointer", marginLeft: "8px", opacity: ".7" });
        close.title = "Dismiss (remembers this choice)";
        close.addEventListener("click", _dismissBadge);

        _el.appendChild(close);
        const body = document.createElement("div");
        body.className = "vivaldi-swift-diagnostics-body";
        _el.appendChild(body);
        document.body.appendChild(_el);
    }

    function _dismissBadge() {
        _el?.remove();
        _el = null;
        try { chrome.storage.local.set({ [DISMISS_KEY]: true }); } catch { /* best-effort */ }
    }

    function _tick() {
        if (!_el) return;
        const body = _el.querySelector(".vivaldi-swift-diagnostics-body");
        if (!body) return;

        const folderLines = [...__diag.folders.entries()]
            .slice(-4)
            .map(([id, s]) => `  #${id}: ${s.childCount ?? "?"} children, ${s.resolvedCount ?? 0} resolved${s.injected ? " ✓shown" : ""}`)
            .join("\n");

        body.textContent =
            `Vivaldi Swift — ${__diag.ready ? "ready" : "loading…"}\n` +
            `bookmarks API: ${__diag.bookmarksApiAvailable === null ? "?" : (__diag.bookmarksApiAvailable ? "yes" : "no")}\n` +
            `regular cards: ${__diag.regularCards.success}✓ ${__diag.regularCards.notFound}∅ ${__diag.regularCards.error}✗\n` +
            `folders seen: ${__diag.folders.size}` +
            (folderLines ? `\n${folderLines}` : "");
    }

    return { init };

})();


/* ============================================================
   OBSERVER + BOOTSTRAP  (self-contained IIFE)
   ============================================================
   Scoped, targeted mutation handling:
     • Newly added .SpeedDial nodes, or nodes added *inside* an
       existing one (e.g. a folder's native child-favicon list
       changing in place — see FolderPreviewController's Part-18
       content-change detection) → reprocess that owning tile.
     • src/srcset/class attribute changes on anything inside a tile
       (Vivaldi is expected to set a favicon's destination synchronously
       at element-creation time in every case observed so far, but
       nothing here assumes that always holds — if Vivaldi ever
       populates it via a later attribute write instead of at
       insertion, this is what catches that) → reprocess the owning
       tile. attributeFilter keeps this from firing on unrelated
       attribute churn elsewhere on the page.
     • Larger subtree additions that might contain brand-new tiles
       nested inside them (e.g. the whole grid re-rendering) →
       debounced full processAll(), rather than reasoning about
       every node in a bulk-inserted subtree individually.
     • Every branch is idempotent — both controllers no-op when
       nothing has actually changed, including reprocessing their
       own just-inserted preview node once and immediately no-op'ing
       on an unchanged signature — so redundant triggers (a childList
       and several attribute mutations all landing for the same
       folder in one batch) cost at most one real re-diff, deduped
       below via the owners Set.
   ============================================================ */

(() => {

    let _debounceTimer = null;

    function _onMutation(mutations) {
        const owners = new Set();
        let needsFullScan = false;

        for (const m of mutations) {
            if (m.type === "attributes") {
                const owner = m.target.nodeType === Node.ELEMENT_NODE
                    ? m.target.closest?.(SELECTORS.speedDial)
                    : null;
                if (owner) owners.add(owner);
                continue;
            }

            if (m.type !== "childList" || !m.addedNodes.length) continue;

            for (const node of m.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;

                const owner = node.closest?.(SELECTORS.speedDial);
                if (owner) { owners.add(owner); continue; }

                if (node.querySelector?.(SELECTORS.speedDial)) needsFullScan = true;
            }
        }

        // Every mutation in this batch that pointed at a specific tile is
        // resolved to at most one process() call per tile, regardless of
        // how many individual attribute/childList mutations it produced —
        // this is the "batching" the naive per-mutation version lacked.
        for (const owner of owners) SpeedDialIconController.process(owner);

        if (needsFullScan) {
            clearTimeout(_debounceTimer);
            _debounceTimer = setTimeout(SpeedDialIconController.processAll, OBSERVER_DEBOUNCE_MS);
        }
    }

    const _observer = new MutationObserver(_onMutation);
    _observer.observe(document, {
        childList:      true,
        subtree:        true,
        attributes:     true,
        attributeFilter: ["src", "srcset", "class"],
    });

    async function _bootstrap() {
        ContextMenu.init();
        VisualDiagnostics.init();

        await IconService.init();

        if (typeof requestIdleCallback === "function") {
            requestIdleCallback(SpeedDialIconController.processAll, { timeout: 500 });
        } else {
            SpeedDialIconController.processAll();
        }

        __diag.ready = true;
        __diag.bookmarksApiAvailable = BookmarksApi.available();
        console.log("[Vivaldi Swift] Ready.");
        console.log(
            `[Vivaldi Swift] Found ${document.querySelectorAll(SELECTORS.speedDial).length} tile(s) ` +
            `(${document.querySelectorAll(`${SELECTORS.speedDial}.${SELECTORS.folderClass}`).length} folder(s)) on initial scan. ` +
            `Type __vivaldiSwift in this console at any time for live diagnostics.`
        );
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _bootstrap);
    } else {
        _bootstrap();
    }

})();
