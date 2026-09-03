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
         .custom-layout-wrapper    ← centering only, no card mutations
           .custom-icon-wrapper    ← fixed size, flex child
             <svg>

   AUTOMATIC ICONS
   ================
   Speed Dial icons are resolved automatically from the tile's
   target website — no manual upload, positioning, or scaling.
   See the module map below. Vivaldi's native favicon is always
   the fallback and is only ever hidden after a validated,
   sanitized replacement SVG is ready to render.

     SpeedDialUrlResolver  → recovers the tile's target URL
     DomainNormalizer      → URL → apex domain
     BrandResolver         → domain → theSVG slug candidate(s)
     IconService           → cache (memory + chrome.storage.local),
                              negative caching, in-flight dedup
     TheSvgProvider        → fetches + validates SVGs from
                              https://thesvg.org (jsDelivr mirror
                              as a fallback host)
     IconSanitizer         → same sanitizer the old manual-upload
                              feature used; unchanged and reused
     Renderer              → builds/injects the wrapper hierarchy

   No version numbers here — git history is the changelog.
   ============================================================ */

"use strict";

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
 * Return the icon host container for a tile.
 * @param   {Element} tile
 * @returns {Element|null}
 */
function getContainer(tile) {
    return tile.querySelector(".thumbnail-favicon, .thumbnail-favicon-folder");
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

function isRegularSpeedDial(tile) {
    // Folders get their own preview thumbnail (a grid of their children's
    // favicons). We never touch that — see SpeedDialUrlResolver notes on
    // folders below.
    return tile.classList.contains("SpeedDial--Icon")
        && !tile.classList.contains("folder");
}


/* ============================================================
   SpeedDialUrlResolver
   ============================================================
   Vivaldi's Speed Dial cards do not reliably expose an <a href>.
   The one thing every regular (non-folder) tile does expose is
   its native favicon, whose src/srcset encodes the target page:

       chrome://favicon2/?size=32&pageUrl=https://github.com/

   Strategy, in order:
     1. Explicit data-url / data-uri / data-href / href, in case a
        future Vivaldi build (or another mod) provides one directly.
     2. pageUrl extracted from the native favicon's srcset.
     3. Give up — the tile keeps its native favicon, untouched.

   Folders are skipped entirely: they have no single target URL,
   and their favicon container renders a grid of child favicons,
   not one site's icon — there is nothing here for the automatic
   pipeline to correctly attach to.
   ============================================================ */

const SpeedDialUrlResolver = (() => {

    function resolve(tile) {
        if (!isRegularSpeedDial(tile)) return null;
        return _fromAttributes(tile) || _fromFavicon(tile) || null;
    }

    function _fromAttributes(tile) {
        const raw =
            tile.dataset.url ||
            tile.dataset.uri ||
            tile.dataset.href ||
            tile.getAttribute("href");
        return _clean(raw);
    }

    function _fromFavicon(tile) {
        const img = tile.querySelector(
            ":scope > .thumbnail-favicon > img.favicon, :scope .thumbnail-favicon img.favicon"
        );
        const srcset = img?.getAttribute("srcset") || img?.srcset;
        if (!srcset) return null;

        // srcset is a comma-separated candidate list, each
        // "<url> <descriptor>" (e.g. "chrome://favicon2/?...=64 64w").
        // Every candidate points at the same page — the first is enough.
        for (const candidate of srcset.split(",")) {
            const url = candidate.trim().split(/\s+/)[0];
            if (!url) continue;

            const pageUrl = _extractPageUrl(url);
            const cleaned = _clean(pageUrl);
            if (cleaned) return cleaned;
        }
        return null;
    }

    function _extractPageUrl(faviconUrl) {
        try {
            return new URL(faviconUrl, location.href).searchParams.get("pageUrl");
        } catch {
            // Defensive fallback only — chrome://favicon2 URLs parse fine
            // with the URL constructor in practice, but never let a parser
            // edge case break icon resolution for every other tile too.
            const m = /[?&]pageUrl=([^&]+)/.exec(faviconUrl);
            return m ? decodeURIComponent(m[1]) : null;
        }
    }

    function _clean(raw) {
        if (!raw) return null;
        try {
            const u = new URL(raw);
            if (u.protocol !== "http:" && u.protocol !== "https:") return null;
            return u.href;
        } catch {
            return null;
        }
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
   ============================================================ */

const DomainNormalizer = (() => {

    const CC_SECOND_LEVEL = new Set([
        "co.uk", "org.uk", "gov.uk", "ac.uk",
        "co.jp", "co.in", "co.nz", "co.za", "co.kr",
        "com.au", "com.br", "com.mx", "com.tr", "com.sg", "com.hk",
    ]);

    function normalize(rawUrl) {
        let host;
        try {
            host = new URL(rawUrl).hostname.toLowerCase();
        } catch {
            return null;
        }
        if (!host) return null;

        host = host.replace(/^www\./, "");
        return _apex(host);
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

    return { renderLayoutWrapper, renderSVG };

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

    function process(tile) {
        if (!isRegularSpeedDial(tile)) return;
        if (_started.has(tile)) return;
        _started.add(tile);

        const url = SpeedDialUrlResolver.resolve(tile);
        if (!url) return; // no recoverable URL — native favicon stands, nothing more to do

        const domain = DomainNormalizer.normalize(url);
        if (!domain) return;

        IconService.resolve(domain)
            .then(result => _apply(tile, domain, result))
            .catch(e => console.warn("[Vivaldi Swift] Auto-icon lookup failed:", e));
    }

    function _apply(tile, expectedDomain, result) {
        if (result.status !== "success") return; // not-found / error → native favicon stands

        // The async lookup may have outlived the tile (removed, or Vivaldi
        // recycled this element for a different card while we were
        // fetching). Re-check both connectivity and identity before
        // touching the DOM.
        if (!tile.isConnected) return;
        const stillSameCard = SpeedDialUrlResolver.resolve(tile);
        if (!stillSameCard || DomainNormalizer.normalize(stillSameCard) !== expectedDomain) return;

        const container = getContainer(tile);
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

    function processAll() {
        for (const tile of document.querySelectorAll(".SpeedDial")) {
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
        _render();
        _position(e.clientX, e.clientY);
    }

    const _REMOVE_SVG = `<svg class="swift-menu-icon-svg" viewBox="0 0 16 16" fill="none">
        <path d="M3 4h10M6 4V3a.5.5 0 0 1 .5-.5h3A.5.5 0 0 1 10 3v1
                 M5 4v8.5a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5V4"
              stroke="currentColor" stroke-width="1.25"
              stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

    function _render() {
        _el.innerHTML = `
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

        if (item.dataset.action === "remove-sd") _removeSpeedDial(tile);
    }

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
   Scoped, targeted mutation handling:
     • Newly added .SpeedDial nodes → processed immediately.
     • Subtree additions that might contain tiles → debounced
       full processAll() for correctness.
     • Removals and attribute mutations → ignored (nothing here
       needs observer-driven teardown; AutoIconController already
       re-checks tile identity when its async work resolves).
   ============================================================ */

(() => {

    let _debounceTimer = null;

    function _onMutation(mutations) {
        for (const m of mutations) {
            if (m.type !== "childList" || !m.addedNodes.length) continue;

            for (const node of m.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;

                if (node.classList?.contains("SpeedDial")) {
                    AutoIconController.process(node);
                    continue;
                }

                if (node.querySelector?.(".SpeedDial")) {
                    clearTimeout(_debounceTimer);
                    _debounceTimer = setTimeout(AutoIconController.processAll, OBSERVER_DEBOUNCE_MS);
                    return; // one pending scan is enough
                }
            }
        }
    }

    const _observer = new MutationObserver(_onMutation);
    _observer.observe(document, { childList: true, subtree: true });

    async function _bootstrap() {
        ContextMenu.init();

        await IconService.init();

        if (typeof requestIdleCallback === "function") {
            requestIdleCallback(AutoIconController.processAll, { timeout: 500 });
        } else {
            AutoIconController.processAll();
        }

        console.log("[Vivaldi Swift] Ready.");
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _bootstrap);
    } else {
        _bootstrap();
    }

})();
