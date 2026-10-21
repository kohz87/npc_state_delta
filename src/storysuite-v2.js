// Story Suite v2 adapter (Story Block 2, docs/v2/SPEC.md §6 and MODULES.md §D in Story Block).
//
// NPC State Delta stays a standalone engine: its storage, capture, prompts and history rules are
// its own and nothing here changes them. When a Story Block v2 host is on the page, Delta also
// registers as module `npc-state-delta` (no domains) with four read-only queries, a Cast tab that
// shows Delta's own present-cast cards, and a settings section that carries Delta's own settings
// panel into the Story Suite overlay. While hosted, the copy in SillyTavern's extensions drawer is
// hidden; if the host goes away it comes back exactly where it was.
//
// Without a v2 host (no Story Block, or a v1 Story Block whose global has no `ready`/`sdk`) this
// module does nothing: it looks for the host a bounded number of times and then stops. The v1
// handshake (suite.js, suite-handshake.js, story-block-tabs.js) keeps working with v1 hosts; with a
// v2 host (`apiVersion: 2`) it offers nothing (suite-handshake.js storyBlockIsV2), and this adapter
// sends V2_HOST_EVENT when it registers and when the host goes away so the v1 side can follow.
//
// Waiting for the host: the spec names no page event for it, so the adapter polls
// `globalThis.StoryBlock` every 250 ms, 40 times (10 s, the same bound as the v1 tabs), and once it
// has `ready` (or `sdk`) waits on that promise. Going away: every 5 s, while hosted, it checks that
// `globalThis.StoryBlock` is still the host it registered with; when it is not, the drawer copy is
// restored and the search starts again.
//
// Pure apart from the DOM it is given: no SillyTavern import, and every outside thing (Delta's
// runtime api, the host global, the document, timers) is injectable for tests.
import { resolveDossierTarget } from '../suite-handshake.js';

export const MODULE_ID = 'npc-state-delta';
export const MODULE_NAME = 'NPC State Delta';
export const CAST_TAB_ID = 'cast';
export const QUERY_NAMES = Object.freeze(['npc.present', 'npc.dossier', 'npc.known', 'npc.portrait']);
/** Sent on the document with detail { hosted } when Delta registers with a v2 host and when it goes away. */
export const V2_HOST_EVENT = 'npc-state-delta:v2-host';
export const HOST_RETRY_MS = 250;
export const HOST_RETRY_ATTEMPTS = 40;
export const HOST_ALIVE_MS = 5000;
export const SECTION_WATCH_MS = 1000;

// What npc.dossier returns: the dossier's own fields, as the dossier shows them. Book-keeping
// (evidence, change ledgers, portrait prompts and images, timestamps, locks) stays inside Delta.
export const DOSSIER_FIELDS = Object.freeze([
    'id', 'name', 'aliases', 'role', 'species', 'gender', 'age', 'apparentAge', 'birthDate', 'homeBase',
    'appearance', 'appearanceForms', 'currentForm', 'personality', 'speech', 'mannerisms', 'behaviorProfile',
    'background', 'memories', 'keyRelationships', 'relationshipSummary', 'relationship',
    'mood', 'location', 'goal', 'status', 'customFields',
    'lifeState', 'present', 'worldActive', 'archived', 'minor',
]);
const RELATIONSHIP_KEYS = ['trust', 'affection', 'desire', 'tension'];

const PLACEHOLDER_FLAG = 'npcStateDeltaPlaceholder';
const HIDDEN_FLAG = 'npcStateDeltaHosted';
const PANE_CLASS = 'npc-state-delta-story-pane';
const EVENTS = Object.freeze({
    settingsMounted: 'npc-state-delta:settings-mounted',
    castRendered: 'npc-state-delta:cast-rendered',
    enabledChanged: 'npc-state-delta:enabled-changed',
});

/** True when `host` looks like Story Block v2's global: a `ready` promise or an `sdk` object. */
export function isV2Host(host) {
    if (!host || (typeof host !== 'object' && typeof host !== 'function')) return false;
    return typeof host.ready?.then === 'function' || typeof host.sdk?.registerModule === 'function';
}

// A JSON round trip: plain objects, arrays, strings, finite numbers, booleans and null only.
function plainCopy(value) {
    if (value === undefined) return undefined;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return undefined;
    }
}

/** One NPC record's dossier fields (DOSSIER_FIELDS) as a fresh plain copy. Missing fields are left out. */
export function dossierFields(npc) {
    if (!npc || typeof npc !== 'object') return null;
    const out = {};
    for (const field of DOSSIER_FIELDS) {
        if (field === 'relationship') {
            const rel = npc.relationship && typeof npc.relationship === 'object' ? npc.relationship : null;
            if (rel) out.relationship = Object.fromEntries(RELATIONSHIP_KEYS.map(key => [key, Number.isFinite(Number(rel[key])) ? Number(rel[key]) : 0]));
            continue;
        }
        const value = plainCopy(npc[field]);
        if (value !== undefined) out[field] = value;
    }
    return out;
}

// ---- portraits (MODULES §F11: a companion or NPC's portrait comes from Delta) ----

// The raster image types Delta accepts for a portrait (index.js setNpcPortrait); compressed
// portraits are stored as data:image/webp.
const DATA_IMAGE = /^data:image\/(?:png|jpeg|jpg|webp|gif|avif|bmp);base64,[a-z0-9+/=]+$/i;
const URL_BASE = 'https://npc-state-delta.invalid/';

/**
 * `value` when it is safe to hand to another module as an image URL, else null: a data: URL of a
 * raster image, an https: URL, or a same-origin relative URL (a path, never `//host`). Anything
 * else (javascript:, http:, blob:, svg data, control characters) is null.
 */
export function safeImageUrl(value) {
    if (typeof value !== 'string') return null;
    const url = value.trim();
    if (!url || /[\u0000-\u001f\u007f\\]/.test(url)) return null;
    if (/^data:/i.test(url)) return DATA_IMAGE.test(url) ? url : null;
    let parsed;
    try {
        parsed = new URL(url, URL_BASE);
    } catch {
        return null;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return /^https:\/\//i.test(url) && parsed.protocol === 'https:' && parsed.hostname ? url : null;
    // A path on the page's own server (SillyTavern's /user/images/…), never `//host` or a bare ?query or #hash.
    return !/^[?#]/.test(url) && parsed.origin === new URL(URL_BASE).origin ? url : null;
}

/**
 * The portrait Delta shows for one NPC record, as its dossier and present cast do: the current
 * appearance form's own image when that form has one, else the main portrait. `formPortraits` is
 * Delta's { [form name]: { dataUrl } }. A safe URL (safeImageUrl) or null.
 */
export function portraitUrl(npc, formPortraits = {}) {
    if (!npc || typeof npc !== 'object') return null;
    const candidates = [];
    const form = typeof npc.currentForm === 'string' ? npc.currentForm.trim().toLocaleLowerCase() : '';
    if (form && formPortraits && typeof formPortraits === 'object') {
        const image = Object.entries(formPortraits).find(([name]) => String(name).trim().toLocaleLowerCase() === form)?.[1];
        if (image && typeof image === 'object') candidates.push(image.dataUrl);
    }
    const main = npc.portrait && typeof npc.portrait === 'object' ? npc.portrait : {};
    candidates.push(main.dataUrl, main.url, main.src);
    for (const candidate of candidates) {
        const url = safeImageUrl(candidate);
        if (url) return url;
    }
    return null;
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
// Used only if story-block-tabs.js cannot be loaded: the same empty line, without the Scan button.
const fallbackEmptyCast = reason => `<div class="npc-state-delta-story-empty-state"><p class="npc-state-delta-story-empty">${escapeHtml(reason?.text || 'No NPC is present in the latest scene.')}</p></div>`;

/**
 * The adapter. Options (all optional except in tests):
 *   suiteApi   Delta's v1 suite api (index.js SUITE_API): npcs() gives { id, name, aliases, present, archived }.
 *   delta      () => Delta's runtime api (window.NPCStateDelta): presentCastHtml, fillPresentCast,
 *              castEmptyReason, getNpc, formPortraits, isEnabled, scan, addNpc.
 *   panelId    id of Delta's settings panel in the extensions drawer.
 *   version    Delta's version, for the module definition.
 *   host       () => the Story Block global.
 *   doc, timers, loadEmptyCast (() => Promise<emptyCastHtml>), logger.
 */
export function createStorySuiteV2Adapter({
    suiteApi = null,
    delta = () => globalThis.NPCStateDelta,
    panelId = 'npc_state_delta_settings',
    version = '',
    host = () => globalThis.StoryBlock,
    doc = globalThis.document,
    timers = globalThis,
    loadEmptyCast = () => import('../story-block-tabs.js').then(module => module.emptyCastHtml),
    retryMs = HOST_RETRY_MS,
    attempts = HOST_RETRY_ATTEMPTS,
    aliveMs = HOST_ALIVE_MS,
    watchMs = SECTION_WATCH_MS,
    logger = console,
} = {}) {
    let started = false;
    let pollTimer = null;
    let aliveTimer = null;
    let watchTimer = null;
    let hostRef = null;          // the Story Block global we connected to
    let sdkRef = null;           // the sdk we registered with (once per sdk)
    let hosted = false;
    let emptyCast = fallbackEmptyCast;
    let mounted = null;          // { el, node, placeholder, drawer } while the panel is in the overlay
    let pendingSection = null;   // a section element waiting for the panel to mount
    let castEl = null;           // the last element the Cast tab rendered into
    let listening = false;
    let pending = null;          // the connection attempt in progress, if any
    const savedDisplay = new WeakMap();

    const warn = (message, error) => {
        try { logger?.warn?.(`[NPC State Delta] ${message}`, error); } catch { /* logging only */ }
    };
    const runtime = () => {
        try { return delta?.() || null; } catch { return null; }
    };
    const enabled = () => runtime()?.isEnabled?.() !== false;
    const panel = () => {
        try { return doc?.getElementById?.(panelId) || null; } catch { return null; }
    };

    // ---- queries (read-only; fresh plain copies; empty while Delta is off or still loading) ----

    const npcList = () => {
        if (!enabled()) return [];
        try {
            const list = suiteApi?.npcs?.();
            return Array.isArray(list) ? list.filter(npc => npc && typeof npc === 'object') : [];
        } catch (error) {
            warn('Story Suite v2 query failed', error);
            return [];
        }
    };
    const names = list => list.map(npc => String(npc.name ?? '').trim()).filter(Boolean);
    const queries = Object.freeze({
        /** Names of the NPCs present in the current scene, in dossier order. */
        'npc.present': () => names(npcList().filter(npc => npc.present === true && npc.archived !== true)),
        /** Names of every tracked (not archived) NPC, in dossier order. */
        'npc.known': () => names(npcList().filter(npc => npc.archived !== true)),
        /** One NPC's dossier fields by name, alias or id (case-insensitive, exact), or null. */
        'npc.dossier': (state, args) => {
            try {
                const id = resolveDossierTarget(npcList(), args?.name);
                if (!id) return null;
                return dossierFields(runtime()?.getNpc?.(id));
            } catch (error) {
                warn('Story Suite v2 dossier query failed', error);
                return null;
            }
        },
        /** One NPC's portrait URL by name, alias or id (as npc.dossier finds them), or null (§F11). */
        'npc.portrait': (state, args) => {
            try {
                const id = resolveDossierTarget(npcList(), args?.name);
                if (!id) return null;
                const api = runtime();
                const npc = api?.getNpc?.(id);
                if (!npc) return null;
                let forms = {};
                try { forms = api?.formPortraits?.(id) || {}; } catch { forms = {}; }
                return portraitUrl(npc, forms);
            } catch (error) {
                warn('Story Suite v2 portrait query failed', error);
                return null;
            }
        },
    });

    // ---- the drawer copy ----

    function hidePanel(node) {
        if (!node?.style || node.dataset?.[HIDDEN_FLAG] === '1') return;
        savedDisplay.set(node, node.style.display ?? '');
        node.style.display = 'none';
        if (node.dataset) node.dataset[HIDDEN_FLAG] = '1';
    }

    function showPanel(node) {
        if (!node?.style || node.dataset?.[HIDDEN_FLAG] !== '1') return;
        node.style.display = savedDisplay.get(node) ?? '';
        savedDisplay.delete(node);
        delete node.dataset[HIDDEN_FLAG];
    }

    // While hosted, the panel is hidden wherever it is except inside the overlay.
    function syncDrawer() {
        const node = panel();
        if (!node || (mounted && mounted.node === node)) return;
        if (hosted) hidePanel(node);
        else showPanel(node);
    }

    // ---- the settings section ----

    function stopWatch() {
        if (watchTimer !== null) timers.clearInterval?.(watchTimer);
        watchTimer = null;
    }

    // Back before its placeholder (v1 overlay rule). A panel Delta removed meanwhile is left alone;
    // one whose place is gone stays where it is.
    function unmountSection() {
        stopWatch();
        if (!mounted) return;
        const { el, node, placeholder, drawer, parent } = mounted;
        mounted = null;
        drawer?.classList?.remove?.('story-suite-drawer');
        if (node.dataset) delete node.dataset.storySuiteMoved;
        const ours = el.contains?.(node);
        if (ours && placeholder.parentNode) placeholder.parentNode.insertBefore(node, placeholder);
        else if (ours && parent?.isConnected) parent.appendChild(node);
        placeholder.remove?.();
        syncDrawer();
    }

    function watchSection() {
        stopWatch();
        // The overlay may drop the section's element without telling anyone: the panel then goes
        // home at once, so Delta's own code (which finds it by id) keeps finding it.
        watchTimer = timers.setInterval?.(() => {
            if (!mounted) return stopWatch();
            if (!mounted.el.isConnected || mounted.node.parentNode !== mounted.el) unmountSection();
        }, watchMs) ?? null;
        watchTimer?.unref?.();
    }

    function mountSection(el) {
        if (!el) return () => {};
        if (mounted && mounted.el !== el) unmountSection();
        const node = panel();
        if (!node) {
            pendingSection = el;
            el.textContent = "NPC State Delta's settings are still loading.";
            return () => { if (pendingSection === el) pendingSection = null; };
        }
        pendingSection = null;
        if (!mounted) {
            const placeholder = doc.createElement('div');
            placeholder.className = 'story-suite-placeholder';
            placeholder.hidden = true;
            placeholder.style.display = 'none';
            placeholder.dataset[PLACEHOLDER_FLAG] = '1';
            node.before(placeholder);
            // Its SillyTavern drawer shows open in the overlay, as v1's overlay shows it.
            const drawer = node.querySelector?.('.inline-drawer') || null;
            drawer?.classList?.add?.('story-suite-drawer');
            if (node.dataset) node.dataset.storySuiteMoved = MODULE_ID;
            mounted = { el, node, placeholder, drawer, parent: placeholder.parentNode };
        }
        showPanel(node);
        if (typeof el.replaceChildren === 'function') el.replaceChildren(node);
        else el.appendChild(node);
        watchSection();
        return () => { if (mounted?.el === el) unmountSection(); };
    }

    // ---- the Cast tab ----

    function bindCastActions(el) {
        if (el.__npcStateDeltaV2Actions) return;
        el.__npcStateDeltaV2Actions = true;
        el.addEventListener?.('click', event => {
            const action = event.target?.closest?.('[data-npc-state-delta-action]')?.dataset?.npcStateDeltaAction;
            if (action === 'scan') return void runtime()?.scan?.();
            if (action === 'add') return void runtime()?.addNpc?.();
        });
    }

    // Delta's own present-cast cards (the same markup as v1's Present NPCs tab), or why it is empty.
    function renderCast(el) {
        if (!el) return;
        castEl = el;
        bindCastActions(el);
        const api = runtime();
        let body;
        if (!api) body = emptyCast({ text: 'NPC State Delta is still loading.' });
        else if (!enabled()) body = emptyCast({ text: 'NPC State Delta is off.' });
        else body = String(api.presentCastHtml?.() || '') || emptyCast(api.castEmptyReason?.());
        const html = `<div class="${PANE_CLASS}">${body}</div>`;
        if (el.__npcStateDeltaV2Cast === html) return;
        el.innerHTML = html;
        el.__npcStateDeltaV2Cast = html;
        // The now lines and chatter bubbles get their text through textContent, never markup.
        api?.fillPresentCast?.(el);
    }

    // ---- the module definition ----

    const definition = Object.freeze({
        id: MODULE_ID,
        name: MODULE_NAME,
        version: String(version),
        domains: {},
        queries,
        settings: {
            defaults: {},
            schema: {},
            section: (el) => mountSection(el),
        },
        tabs: [{
            id: CAST_TAB_ID,
            title: 'Cast',
            icon: 'fa-masks-theater',
            render: (el) => {
                try { renderCast(el); } catch (error) { warn('Story Suite v2 Cast tab failed', error); }
            },
        }],
    });

    // ---- host lifecycle ----

    // story-block-tabs.js and index.js take back (or offer again) what v1 gave Story Block.
    function announceHosted(on) {
        try {
            if (typeof doc?.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
                doc.dispatchEvent(new CustomEvent(V2_HOST_EVENT, { detail: { hosted: on } }));
            }
        } catch (error) {
            warn('Story Suite v2 host event failed', error);
        }
    }

    function listen() {
        if (listening || typeof doc?.addEventListener !== 'function') return;
        listening = true;
        doc.addEventListener(EVENTS.settingsMounted, () => {
            if (!hosted) return;
            if (pendingSection?.isConnected) mountSection(pendingSection);
            else syncDrawer();
        });
        const rerender = () => {
            if (hosted && castEl?.isConnected) {
                try { renderCast(castEl); } catch (error) { warn('Story Suite v2 Cast tab failed', error); }
            }
        };
        doc.addEventListener(EVENTS.castRendered, rerender);
        doc.addEventListener(EVENTS.enabledChanged, rerender);
    }

    function register(sdk, from, attempt) {
        if (hostRef !== from) return false;
        if (host() !== from) {
            // Replaced while it was getting ready: look again (still within the bound).
            hostRef = null;
            if (started) schedulePoll(attempt + 1);
            return false;
        }
        if (typeof sdk?.registerModule !== 'function' || sdkRef === sdk) return false;
        sdkRef = sdk;
        try {
            sdk.registerModule(definition);
        } catch (error) {
            warn('Story Suite v2 registration failed; Delta keeps working on its own', error);
            return false;
        }
        hosted = true;
        listen();
        syncDrawer();
        announceHosted(true);
        aliveTimer = timers.setInterval?.(check, aliveMs) ?? null;
        aliveTimer?.unref?.();
        return true;
    }

    function connect(sb, attempt) {
        hostRef = sb;
        const ready = typeof sb.ready?.then === 'function' ? sb.ready : Promise.resolve(sb.sdk);
        const cast = Promise.resolve().then(() => loadEmptyCast()).then(fn => {
            if (typeof fn === 'function') emptyCast = fn;
        }, () => { /* keep the fallback line */ });
        return Promise.all([ready, cast])
            .then(([sdk]) => register(sdk, sb, attempt))
            .catch(error => {
                warn('Story Block v2 did not become ready; Delta keeps working on its own', error);
                return false;
            });
    }

    function poll(attempt) {
        pollTimer = null;
        if (!started || hostRef) return;
        const sb = host();
        if (isV2Host(sb)) {
            pending = connect(sb, attempt);
            return;
        }
        schedulePoll(attempt + 1);
    }

    function schedulePoll(attempt) {
        if (attempt > attempts || pollTimer !== null) return;
        pollTimer = timers.setTimeout?.(() => poll(attempt), retryMs) ?? null;
        pollTimer?.unref?.();
    }

    // The host went away (or was replaced): everything goes back as it was before hosting.
    function unhost() {
        if (aliveTimer !== null) timers.clearInterval?.(aliveTimer);
        aliveTimer = null;
        const was = hosted;
        hosted = false;
        hostRef = null;
        sdkRef = null;
        pendingSection = null;
        castEl = null;
        unmountSection();
        syncDrawer();
        if (was) announceHosted(false);
    }

    /** Checks that the host is still there; restores the drawer and looks again when it is not. */
    function check() {
        if (!hostRef || host() === hostRef) return hosted;
        unhost();
        if (started) poll(0);
        return false;
    }

    return Object.freeze({
        definition,
        /** Start looking for the host (idempotent). */
        start() {
            if (started) return;
            started = true;
            poll(0);
        },
        /** Stop looking and give everything back (tests; a reload of Delta). */
        stop() {
            started = false;
            if (pollTimer !== null) timers.clearTimeout?.(pollTimer);
            pollTimer = null;
            unhost();
        },
        check,
        hosted: () => hosted,
        /** Resolves (true when it registered) once the latest connection attempt has settled. */
        settled: () => pending ?? Promise.resolve(false),
    });
}

let adapter = null;

/** Start the page's one adapter (index.js calls this once at startup); later calls return the same one. */
export function startStorySuiteV2(options = {}) {
    if (!adapter) {
        adapter = createStorySuiteV2Adapter(options);
        adapter.start();
    }
    return adapter;
}
