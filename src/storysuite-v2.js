// Story Suite v2 adapter (Story Block 2, docs/v2/SPEC.md §6 and MODULES.md §D in Story Block).
//
// NPC State Delta stays a standalone engine: its storage, capture, prompts and history rules are
// its own and nothing here changes them. When a Story Block v2 host is on the page, Delta also
// registers as module `npc-state-delta` with read-only queries, a Dossiers tab (id `cast`, the tab once
// called Cast) that is the dossier browser (and the same Dossiers as a screen in Story Block's game view),
// and a settings section that carries Delta's own settings panel into the Story Suite overlay. The present
// cast's cards are on Story Director's World screen (World → Now → Here) when it is there, drawn by Delta
// through the page API `globalThis.NPCStateDeltaCast` (PAGE_API, below); without Story Director they stay
// at the top of Dossiers (Story Block MODULES §F119). It also owns one small domain, `npc` (src/npc-meters.js; F81, F90): each NPC's
// meters, stages and unlocked hidden notes in the per-reply state, so they swipe and delete back
// with the replies. While hosted that slice is the truth for meter values: index.js reads it back
// through sliceView() for the dossier view and the injection, and sends its scanner's relationship
// changes as `npc.adjust` (adjust()); the `~ npc` change line, an NPC card under each reply and the
// meters beside the present cast's cards come from here. While hosted, the copy in SillyTavern's extensions drawer is
// hidden; if the host goes away it comes back exactly where it was. While hosted, <html> also carries
// HOSTED_FLAG, which index.js and the CSS read (launcher, in-chat cast default, sidecar checks).
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
import {
    FEATURE_PRESETS, FEATURE_SOCIAL, FEATURE_STAGES, MILESTONE_KIND, NPC_KIND, SOCIAL_QUERY, createNpcPart, limitsFromLines, limitsToLines, meterValue,
    normalizeSecrets, secretsFromLines, secretsToLines, wordKey,
} from './npc-meters.js';
import { normalizeLimits, presetCatalog, presetIds } from './npc-meters-presets.js';
import { METERS_CARD_ID, metersCardScreen } from './npc-meters-screen.js';
import { DOSSIER_FIELDS } from './fields/registry.js';
import { escapeHtml } from './util/html.js';

export const MODULE_ID = 'npc-state-delta';
export const MODULE_NAME = 'NPC State Delta';
// The tab's id stays `cast` (and the screen's `npc-state-delta/cast`) so a reader's saved tab order still
// finds it; its title is Dossiers (MODULES §F119).
export const CAST_TAB_ID = 'cast';
export const DOSSIERS_TITLE = 'Dossiers';
export const DOSSIERS_ICON = 'fa-address-book';
/**
 * Dossiers as a game-view screen (Story Block's full-screen view lists screens, not module tabs): mount
 * `screen` only, so the Story panel keeps its one Dossiers tab. Its template is one widget,
 * CAST_WIDGET, that draws exactly what the tab draws (the dossier list, and the present cast's cards and
 * meters above it while Story Director's World does not show them).
 */
export const CAST_SCREEN_ID = 'npc-state-delta/cast';
export const CAST_WIDGET = 'npc-state-delta.cast';
// Story Block places the suite's own screens itself (view/screens.js SUITE_NAV: Dossiers last); an older
// host reads this number.
export const CAST_SCREEN_ORDER = 35;
/** Story Director's World view: while it is on, the present cast's cards are drawn there, not in Dossiers. */
export const WORLD_FEATURE = 'story-director.world';
/**
 * The page API for Story Director's World screen, on `globalThis` while the adapter runs (read-only; it
 * changes nothing in Delta): { version, available(), render(el, { slot }) → number of present cards drawn,
 * onChange(fn) → off }. `render` draws Delta's own present-cast cards and meters into `el` (the markup and
 * classes the Cast tab drew) and, with `slot(name, aliases)` → a node or null, puts that node inside each
 * present person's card (class PAGE_SLOT_CLASS; drawn again on every render). `onChange(fn)` calls `fn`
 * after Delta's cast or state may have changed (a cast drawn, a scan or edit, Delta on or off, hosted or
 * not); the caller redraws then.
 */
export const PAGE_API = 'NPCStateDeltaCast';
export const PAGE_SLOT_CLASS = 'npc-state-delta-v2-slot';
export const QUERY_NAMES = Object.freeze(['npc.present', 'npc.dossier', 'npc.known', 'npc.portrait', 'npc.meters', 'npc.cast', 'npc.next', 'npc.socialModifier']);
export const COMMAND_NAMES = Object.freeze(['npc.adjust', 'npc.set', 'npc.refresh', 'npc.milestone', 'npc.tick']);
// The replies after which Delta takes its per-reply step (npc.tick): a new reply or a new swipe of
// one, never a Continue, a Re-read or late change lines (the same reply again).
export const TICK_TURNS = Object.freeze(['normal', 'swipe', 'regenerate']);
// The pack content kind for meter presets (Story Block's packs.content).
export const PRESET_KIND = 'meterPresets';
export { METERS_CARD_ID };
/** Sent on the document with detail { hosted } when Delta registers with a v2 host and when it goes away. */
export const V2_HOST_EVENT = 'npc-state-delta:v2-host';
/**
 * Set to '1' on <html> (data-npc-state-delta-story-block-v2) while Delta is registered with a v2
 * host, removed when it goes away. index.js and the CSS read it: the floating launcher hides (unless
 * the reader keeps it), the in-chat cast takes v1's "Only in Story Block" default, and automatic
 * freshness checks trust an already-seen missing sidecar.
 */
export const HOSTED_FLAG = 'npcStateDeltaStoryBlockV2';
export const HOST_RETRY_MS = 250;
export const HOST_RETRY_ATTEMPTS = 40;
export const HOST_ALIVE_MS = 5000;
export const SECTION_WATCH_MS = 1000;

// What npc.dossier returns: the dossier's own fields, as the dossier shows them (DOSSIER_FIELDS, from
// the field registry). Book-keeping (evidence, change ledgers, portrait prompts and images,
// timestamps, locks) and the hidden notes stay inside Delta.
export { DOSSIER_FIELDS };
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
export function dossierFields(npc, { customFieldNames } = {}) {
    if (!npc || typeof npc !== 'object') return null;
    const out = {};
    for (const field of DOSSIER_FIELDS) {
        if (field === 'customFields' && Array.isArray(customFieldNames)) {
            // (cleanup step 7) Only the configured custom fields, as the dossier and the injection show.
            const configured = customFieldNames.map(name => String(name ?? '').trim().toLowerCase()).filter(Boolean);
            const kept = Object.entries(npc.customFields && typeof npc.customFields === 'object' ? npc.customFields : {})
                .filter(([name]) => configured.includes(String(name).trim().toLowerCase()));
            if (kept.length) out.customFields = Object.fromEntries(kept.map(([name, value]) => [name, String(value ?? '')]));
            continue;
        }
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

const METER_TONES = new Set(['neutral', 'accent', 'good', 'warn', 'bad', 'info']);

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
 *   headReply  () => the index of the latest reply (the reader's own meter values start its window).
 *   doc, timers, loadEmptyCast (() => Promise<emptyCastHtml>), logger.
 */
// DOM helpers for the Cast markup (text is set with textContent; nothing is parsed as markup).
const elementOf = (doc, tag, className = '', text = null) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== null && text !== undefined) node.textContent = String(text);
    return node;
};
// One meter as ss.meter draws it (WIDGETS.md: role="meter", aria values, `ss-w-meter-*` parts, `--ss-w-ratio` on the track).
// `def`: { id, label, min, max, tone }. `extra` (optional): { text, ceiling, ticks: [{ at, label }], delta }.
export function meterBarNode(doc, def, value, stage = '', extra = {}) {
    const min = Number.isFinite(def?.min) ? def.min : -100;
    const max = Number.isFinite(def?.max) && def.max > min ? def.max : min + 100;
    const now = Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Math.round(Number(value)) : min));
    const at = point => Math.round(((Math.min(max, Math.max(min, point)) - min) / (max - min)) * 10000) / 10000;
    const ratio = at(now);
    const text = typeof extra?.text === 'string' && extra.text ? extra.text : stage ? `${now} · ${stage}` : String(now);
    const tone = METER_TONES.has(def?.tone) ? def.tone : 'neutral';
    const label = String(def?.label ?? def?.id ?? '');
    const delta = Number.isInteger(extra?.delta) && extra.delta !== 0 ? extra.delta : 0;
    const node = elementOf(doc, 'div', `ss-w ss-w-meter ss-w-tone-${tone}${ratio >= 1 ? ' ss-w-full' : ''}${ratio <= 0 ? ' ss-w-empty' : ''}`);
    node.setAttribute('role', 'meter');
    node.setAttribute('aria-label', label);
    node.setAttribute('aria-valuemin', String(min));
    node.setAttribute('aria-valuemax', String(max));
    node.setAttribute('aria-valuenow', String(now));
    node.setAttribute('aria-valuetext', text);
    node.dataset.meter = String(def?.id ?? '');
    const head = elementOf(doc, 'div', 'ss-w-meter-head');
    head.append(elementOf(doc, 'span', 'ss-w-meter-label', label));
    const value_ = elementOf(doc, 'span', 'ss-w-meter-value', text);
    value_.setAttribute('aria-hidden', 'true');
    if (delta) value_.append(elementOf(doc, 'span', `npc-state-delta-v2-delta ${delta > 0 ? 'npc-state-delta-v2-delta-up' : 'npc-state-delta-v2-delta-down'}`, `${delta > 0 ? '▲' : '▼'}${Math.abs(delta)}`));
    head.append(value_);
    const track = elementOf(doc, 'div', 'ss-w-meter-track');
    track.setAttribute('style', `--ss-w-ratio: ${ratio}`);
    track.append(elementOf(doc, 'div', 'ss-w-meter-fill'));
    for (const tick of (Array.isArray(extra?.ticks) ? extra.ticks : []).slice(0, 8)) {
        if (!Number.isFinite(tick?.at)) continue;
        const mark = elementOf(doc, 'span', 'npc-state-delta-v2-tick');
        mark.setAttribute('style', `--npc-state-delta-at: ${at(tick.at)}`);
        mark.setAttribute('title', `${tick.label ?? ''} ${tick.at}`.trim());
        track.append(mark);
    }
    if (Number.isFinite(extra?.ceiling) && extra.ceiling < max) {
        const mark = elementOf(doc, 'span', 'npc-state-delta-v2-ceiling');
        mark.setAttribute('style', `--npc-state-delta-at: ${at(extra.ceiling)}`);
        mark.setAttribute('title', `Ceiling ${extra.ceiling}`);
        track.append(mark);
    }
    node.append(head, track);
    return node;
}

export function createStorySuiteV2Adapter({
    suiteApi = null,
    delta = () => globalThis.NPCStateDelta,
    panelId = 'npc_state_delta_settings',
    version = '',
    host = () => globalThis.StoryBlock,
    headReply = () => null,
    doc = globalThis.document,
    timers = globalThis,
    loadEmptyCast = () => import('../story-block-tabs.js').then(module => module.emptyCastHtml),
    retryMs = HOST_RETRY_MS,
    attempts = HOST_RETRY_ATTEMPTS,
    aliveMs = HOST_ALIVE_MS,
    watchMs = SECTION_WATCH_MS,
    logger = console,
    // True while the reader keeps the calendar in Delta (Source of truth: calendar "mine"): no story clock.
    calendarOwn = () => false,
    // Delta's dossier list markup and projection (story-block-tabs.js, dossier-ui.js), as v1's Dossiers tab.
    loadDossierList = () => Promise.all([import('../story-block-tabs.js'), import('../dossier-ui.js')])
        .then(([tabs, ui]) => ({ rowNodes: tabs.dossierRowNodes, project: ui.dossierIndexProjection, filter: ui.filterDossierIndex })),
    // Where the page API (PAGE_API) goes; null for none.
    page = globalThis,
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
    const castViews = new Set(); // the game view's Cast screens (CAST_WIDGET) drawn now
    let listening = false;
    let pending = null;          // the connection attempt in progress, if any
    let sectionLead = null;      // the meter presets block above Delta's panel in the settings section
    let offTurn = null;          // unsubscribes from the host's 'turn' event
    let lastTick = Promise.resolve(null);
    let listParts = null;        // loadDossierList's { rowNodes, project, filter } once loaded
    let rowsCache = { key: null, rows: [] };
    const watchers = new Set();  // the page API's onChange subscribers
    const savedDisplay = new WeakMap();
    // Delta's own commands on their way to the host, by type and payload: npc.adjust takes a reader's
    // action at the top only when it is one of these (the scanner's), never a button that names it.
    const ownSends = new Map();
    const sendKey = (type, payload) => {
        try { return `${type}\n${JSON.stringify(payload)}`; } catch { return null; }
    };

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
    const presentList = () => npcList().filter(npc => npc.present === true && npc.archived !== true);
    // Delta's own record for a name, alias or id (as npc.dossier finds it), or null.
    const dossierOf = name => {
        const id = resolveDossierTarget(npcList(), name);
        if (!id) return null;
        const npc = runtime()?.getNpc?.(id);
        return npc && typeof npc === 'object' ? npc : null;
    };
    const storedSettings = () => {
        try { return sdkRef?.settings?.(MODULE_ID) ?? {}; } catch { return {}; }
    };

    // ---- the npc slice (src/npc-meters.js) ----

    // A feature's switch from the host (MODULES §F100), or undefined when the host has no Features
    // API yet (the part then uses the feature's default).
    const hostFeature = id => {
        try {
            if (typeof sdkRef?.feature === 'function') return sdkRef.feature(id);
            if (typeof sdkRef?.features?.isOn === 'function') return sdkRef.features.isOn(id);
        } catch { /* the default */ }
        return undefined;
    };
    // The presets the reader may use: the built-in ones and the enabled packs' `meterPresets`.
    const catalog = () => {
        let records = [];
        if (hosted && typeof sdkRef?.query === 'function') {
            try {
                const list = sdkRef.query('packs.content', { kind: PRESET_KIND });
                records = Array.isArray(list) ? list : [];
            } catch { records = []; }
        }
        return presetCatalog(records);
    };
    // One dossier's meter setup (the editor's): { track, limits }.
    const setupOf = npc => {
        const setup = npc?.meterSetup && typeof npc.meterSetup === 'object' ? npc.meterSetup : {};
        return { track: typeof setup.track === 'string' ? setup.track : '', limits: normalizeLimits(setup.limits) };
    };

    const part = createNpcPart({
        resolve: name => {
            const npc = dossierOf(name);
            return npc ? { name: npc.name, aliases: Array.isArray(npc.aliases) ? npc.aliases : [], relationship: npc.relationship } : null;
        },
        baseline: () => runtime()?.relationshipBaseline?.() ?? {},
        // Only the rules (and the titles screens show while locked) leave the dossier for the
        // handlers and screens; the texts go to the tail and to an unlocked note's screen line alone.
        secretRules: (name, labels = []) => {
            const npc = dossierOf(name) ?? labels.map(dossierOf).find(Boolean);
            return normalizeSecrets(npc?.secrets).map(({ id, meter, at, title }) => ({ id, meter, at, ...(title ? { title } : {}) }));
        },
        secretTexts: (name, ids = []) => {
            const npc = dossierOf(name);
            return normalizeSecrets(npc?.secrets).filter(secret => ids.includes(secret.id)).map(({ id, text }) => ({ id, text }));
        },
        setup: (name, labels = []) => setupOf(dossierOf(name) ?? labels.map(dossierOf).find(Boolean)),
        presets: catalog,
        feature: hostFeature,
        present: () => names(presentList()),
        settings: storedSettings,
        ownCommand: (type, payload) => (ownSends.get(sendKey(type, payload)) ?? 0) > 0,
        headReply: () => headReply?.(),
    });
    // The slice entries at the head, by key (null when the host cannot answer).
    const sliceEntries = () => {
        if (!hosted || typeof sdkRef?.query !== 'function') return null;
        try {
            const list = sdkRef.query('npc.meters', {});
            return Array.isArray(list) ? list : null;
        } catch {
            return null;
        }
    };
    const entryFor = (entries, npc) => {
        if (!entries?.length || !npc) return null;
        const byKey = Object.fromEntries(entries.map(entry => [entry.key, entry]));
        const who = part.identify(byKey, npc.name);
        return who && Object.hasOwn(byKey, who.key) ? byKey[who.key] : null;
    };
    // The built-in meters of a slice entry as Delta's `relationship`.
    const relationshipOf = (entry, fallback = {}) => Object.fromEntries(RELATIONSHIP_KEYS.map(key => [key, Number.isInteger(entry?.meters?.[key]) ? entry.meters[key] : (Number(fallback?.[key]) || 0)]));

    // What the host's ss.meter widget takes. Story Block's view work adds `ceiling`, `ticks` and
    // `delta`; a host that lists its widgets' props says whether it has them (null: it does not say,
    // and the props are passed as they are: ss.meter reads only the props it knows).
    const meterProps = () => {
        try {
            const widgets = typeof sdkRef?.widgets === 'function' ? sdkRef.widgets() : host()?.widgets;
            const props = widgets?.['ss.meter']?.props;
            return props && typeof props === 'object' ? new Set(Object.keys(props)) : null;
        } catch {
            return null;
        }
    };
    // npc.cast for a host whose ss.meter has no ceiling or delta yet: they go into the bar's text.
    const castFor = (state, args) => {
        const list = part.queries['npc.cast'](state, args ?? {});
        const props = meterProps();
        if (!props || ['ceiling', 'ticks', 'delta'].every(prop => props.has(prop))) return list;
        const fold = bar => {
            const out = { ...bar };
            if (!props.has('ceiling')) {
                if (Number.isInteger(out.ceiling)) out.text = `${out.text} · max ${out.ceiling}`;
                delete out.ceiling;
                delete out.floor;
            }
            if (!props.has('ticks')) delete out.ticks;
            if (!props.has('delta')) {
                if (Number.isInteger(out.delta) && out.delta) out.text = `${out.text} ${out.delta > 0 ? '▲' : '▼'}${Math.abs(out.delta)}`;
                delete out.delta;
            }
            return out;
        };
        return list.map(entry => ({ ...entry, bars: entry.bars.map(fold), still: entry.still.map(fold) }));
    };

    const queries = Object.freeze({
        /**
         * Names of the NPCs present in the current scene, in dossier order. With { meters: true },
         * [{ name, meters, stages }] instead (the slice's values; null meters for someone it has no entry for).
         */
        'npc.present': (state, args) => {
            const list = presentList();
            if (args?.meters !== true) return names(list);
            return list.map(npc => {
                const entry = part.queries['npc.meters'](state, { name: npc.name });
                return { name: String(npc.name ?? '').trim(), meters: entry?.meters ?? null, stages: entry?.stages ?? {} };
            }).filter(item => item.name);
        },
        /** Names of every tracked (not archived) NPC, in dossier order. */
        'npc.known': () => names(npcList().filter(npc => npc.archived !== true)),
        /**
         * One NPC's dossier fields by name, alias or id (case-insensitive, exact), or null. While the
         * slice has an entry for them, `relationship` is the slice's and `meters`, `stages` and
         * `unlocked` (note ids) are added. Hidden notes are never part of it.
         */
        'npc.dossier': (state, args) => {
            try {
                const npc = dossierOf(args?.name);
                if (!npc) return null;
                const names = runtime()?.customFieldNames?.();
                const out = dossierFields(npc, { customFieldNames: Array.isArray(names) ? names : undefined });
                const entry = part.queries['npc.meters'](state, { name: npc.name });
                if (entry) {
                    out.relationship = relationshipOf(entry, out.relationship);
                    out.meters = entry.meters;
                    out.stages = entry.stages;
                    out.unlocked = entry.unlocked;
                }
                return out;
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
        /** npc.meters({ name }) → { key, name, meters, stages, unlocked, … } | null; no name: every entry. */
        'npc.meters': (state, args) => part.queries['npc.meters'](state, args ?? {}),
        /** npc.cast() → the slice's NPCs with their bars, ladder line and locked-note teasers, present first (the NPC card). */
        'npc.cast': (state, args) => castFor(state, args),
        /** npc.next({ name }) → the NPC's ladder from here: { rank, next, risk, text } ("what's missing"), or null. */
        'npc.next': (state, args) => part.queries['npc.next'](state, args ?? {}),
        /**
         * npc.socialModifier({ name, skill }) → { mod, name, skill, reasons: [{ text, value }] } | null:
         * what an NPC's meters, stage and disposition do to a social check against them (src/social-check.js).
         * Null while Delta is off, for a skill that is not social, an unknown name, or the feature off
         * (the host answers null itself then). Reads the state it is given; never calls the model.
         */
        [SOCIAL_QUERY]: Object.assign((state, args) => {
            if (!enabled()) return null;
            try {
                return part.queries[SOCIAL_QUERY](state, args ?? {});
            } catch (error) {
                warn('Story Suite v2 social check query failed', error);
                return null;
            }
        }, { feature: FEATURE_SOCIAL }),
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

    // `lead`: the meter presets block, shown above Delta's own panel.
    function mountSection(el, lead = null) {
        if (!el) return () => {};
        if (mounted && mounted.el !== el) unmountSection();
        const node = panel();
        if (lead) sectionLead = lead;
        if (!node) {
            pendingSection = el;
            const loading = "NPC State Delta's settings are still loading.";
            if (sectionLead && typeof el.replaceChildren === 'function' && typeof doc?.createElement === 'function') {
                const line = doc.createElement('p');
                line.textContent = loading;
                el.replaceChildren(sectionLead, line);
            } else el.textContent = loading;
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
        const top = sectionLead && sectionLead.ownerDocument === node.ownerDocument ? sectionLead : null;
        if (typeof el.replaceChildren === 'function') el.replaceChildren(...(top ? [top] : []), node);
        else {
            if (top) el.appendChild(top);
            el.appendChild(node);
        }
        watchSection();
        return () => { if (mounted?.el === el) unmountSection(); };
    }

    // ---- the Dossiers tab (once Cast) ----

    function bindCastActions(el) {
        if (el.__npcStateDeltaV2Actions) return;
        el.__npcStateDeltaV2Actions = true;
        el.addEventListener?.('click', event => {
            const action = event.target?.closest?.('[data-npc-state-delta-action]')?.dataset?.npcStateDeltaAction;
            if (action === 'scan') return void runtime()?.scan?.();
            if (action === 'add') return void runtime()?.addNpc?.();
            // A dossier row opens that dossier (v1's Dossiers tab did the same).
            const row = event.target?.closest?.('.npc-state-delta-story-row');
            if (row?.dataset?.npcId) runtime()?.openDossier?.(row.dataset.npcId);
        });
        // The search box filters the list in place: only the list is drawn again, so the box keeps its focus.
        el.addEventListener?.('input', event => {
            const box = event.target;
            if (!box?.classList?.contains?.('npc-state-delta-story-search')) return;
            el.__npcStateDeltaV2Find = String(box.value ?? '').slice(0, 80);
            const list = el.querySelector?.('.npc-state-delta-story-list');
            if (list) list.replaceChildren(...dossierRowNodesFor(el.__npcStateDeltaV2Find, list.ownerDocument ?? doc));
        });
    }

    // Whether Story Director's World screen shows the present cast (its feature on); a host without the
    // Features API: whether Story Director is registered.
    function worldShown() {
        if (!hosted) return false;
        const on = hostFeature(WORLD_FEATURE);
        if (on !== undefined) return on === true;
        try { return (sdkRef?.modules?.() ?? []).some(module => module?.id === 'story-director'); } catch { return false; }
    }

    // Every dossier as a row of v1's list (dossier-ui.js dossierIndexProjection), kept until Delta's state
    // changes (dossierRevision); before that list has loaded, plain rows from the dossiers' names.
    function dossierRows() {
        const api = runtime();
        let revision = '';
        try { revision = String(api?.dossierRevision?.() ?? ''); } catch { revision = ''; }
        const key = revision ? `${listParts ? 'full' : 'plain'}|${revision}` : null;
        if (key && rowsCache.key === key) return rowsCache.rows;
        let rows = [];
        try {
            const state = listParts?.project ? api?.getDossierState?.() : null;
            if (state && Array.isArray(state.npcs)) rows = state.npcs.map(npc => listParts.project(npc, state.portraitAssets || {}));
            else {
                rows = npcList().map(npc => ({
                    id: String(npc.id ?? ''), name: String(npc.name ?? '').trim() || 'Unnamed NPC', aliases: Array.isArray(npc.aliases) ? npc.aliases : [],
                    role: '', statusLabel: npc.archived ? 'Archived' : npc.present ? 'Present' : '', bucket: npc.archived ? 'archived' : 'active', portrait: '',
                }));
            }
        } catch (error) {
            warn('Story Suite v2 dossier list failed', error);
            rows = [];
        }
        rowsCache = { key, rows };
        return rows;
    }
    // The dossier rows and the meters are DOM nodes built with textContent: a name, a role, a stage or a note is text, never
    // markup. Story Block's list-row classes are the same as story-block-tabs.js dossierRowNodes (its builder, once loaded).
    // Before story-block-tabs.js has loaded: plain rows of names that still open each dossier.
    function plainRowNodes(rows, doc, total = 0) {
        if (!rows.length) return [elementOf(doc, 'p', 'npc-state-delta-story-empty', total ? 'No dossier matches.' : 'No dossiers yet. An NPC gets one when a scan finds them in the story.')];
        return rows.map(row => {
            const item = elementOf(doc, 'li', 'ss-listcard-row');
            const button = elementOf(doc, 'button', 'ss-listcard-item npc-state-delta-story-row');
            button.dataset.npcId = String(row.id ?? '');
            button.setAttribute('aria-label', `Open ${row.name} dossier`);
            button.setAttribute('type', 'button');
            const text = elementOf(doc, 'span', 'npc-state-delta-story-text ss-listcard-main');
            text.append(elementOf(doc, 'b', 'ss-listcard-title', row.name), elementOf(doc, 'small', 'ss-listcard-sub', row.statusLabel ?? ''));
            button.append(elementOf(doc, 'span', 'npc-state-delta-story-thumb ss-listcard-icon', Array.from(String(row.name ?? '').trim())[0]?.toUpperCase() ?? '?'), text);
            item.append(button);
            return item;
        });
    }
    // The dossier rows for a search, as nodes (story-block-tabs.js when loaded; the plain rows before that).
    function dossierRowNodesFor(query, doc) {
        const rows = dossierRows();
        let visible;
        try {
            if (listParts?.filter) visible = listParts.filter(rows, { query });
            else {
                const needle = String(query).trim().toLocaleLowerCase();
                visible = rows.filter(row => !needle || [row.name, ...(row.aliases ?? [])].some(name => String(name).toLocaleLowerCase().includes(needle)));
            }
        } catch { visible = rows; }
        try {
            return listParts?.rowNodes ? listParts.rowNodes(withMeters(visible), doc, { query, total: rows.length }) : plainRowNodes(visible, doc, rows.length);
        } catch {
            return plainRowNodes(visible, doc, rows.length);
        }
    }
    // Each row's stage and meters (npc.cast: the ranks and bars the present cards' meters show; the row draws at most DOSSIER_BAR_MAX).
    // Read when the list is drawn and never cached with the rows: a reply moves them without changing any dossier.
    function withMeters(rows) {
        if (!hosted || !rows.length || typeof sdkRef?.query !== 'function') return rows;
        let cast;
        try {
            const head = headReply?.();
            cast = sdkRef.query('npc.cast', Number.isInteger(head) ? { headReply: head } : {});
        } catch {
            return rows;
        }
        if (!Array.isArray(cast) || !cast.length) return rows;
        const byKey = Object.fromEntries(cast.map(entry => [entry.key, entry]));
        return rows.map(row => {
            const who = part.identify(byKey, row.name);
            const entry = who && Object.hasOwn(byKey, who.key) ? byKey[who.key] : null;
            return entry ? { ...row, stage: entry.rank || '', bars: entry.bars ?? [] } : row;
        });
    }
    // The dossier browser: a search box and every dossier, each opening its dossier view (Delta's own).
    function dossierListNode(el, doc) {
        const query = typeof el?.__npcStateDeltaV2Find === 'string' ? el.__npcStateDeltaV2Find : '';
        const wrap = elementOf(doc, 'div', 'npc-state-delta-story-dossiers npc-state-delta-v2-dossiers');
        wrap.append(elementOf(doc, 'span', 'npc-state-delta-kicker', 'DOSSIERS'));
        const box = elementOf(doc, 'input', 'text_pole npc-state-delta-story-search');
        box.setAttribute('type', 'search');
        box.setAttribute('placeholder', 'Search dossiers');
        box.setAttribute('aria-label', 'Search dossiers');
        box.setAttribute('maxlength', '80');
        box.value = query;
        wrap.append(box);
        const list = elementOf(doc, 'div', 'npc-state-delta-story-list ss-listcard ss-glass');
        list.append(...dossierRowNodesFor(query, doc));
        wrap.append(list);
        return wrap;
    }

    // The NPCs the meters show, in order: the present dossiers' (dossier order), then (beta) the people the story's change
    // lines gave meters who have no dossier yet (no scan has made one), straight from the state: those Story Block's scene has
    // here, or all of them when the scene cannot say. → { shown, byKey, cast } or null.
    function meterEntries() {
        if (!hosted || typeof sdkRef?.query !== 'function') return null;
        let cast;
        try {
            const head = headReply?.();
            cast = sdkRef.query('npc.cast', Number.isInteger(head) ? { headReply: head } : {});
        } catch {
            return null;
        }
        if (!Array.isArray(cast) || !cast.length) return null;
        const byKey = Object.fromEntries(cast.map(entry => [entry.key, entry]));
        const shown = [];
        for (const npc of presentList()) {
            const who = part.identify(byKey, npc.name);
            const entry = who && Object.hasOwn(byKey, who.key) ? byKey[who.key] : null;
            if (entry && !shown.includes(entry)) shown.push(entry);
        }
        let scene = null;
        try {
            const list = sdkRef.query('scene.present');
            scene = Array.isArray(list) ? list.map(name => part.identify(byKey, String(name ?? ''))?.key).filter(Boolean) : null;
        } catch { scene = null; }
        for (const entry of cast) {
            if (shown.includes(entry) || dossierOf(entry.name)) continue;
            if (scene && !scene.includes(entry.key)) continue;
            shown.push(entry);
        }
        return { shown, byKey, cast };
    }
    const barNodesOf = (doc, entry, defs) => entry.bars.map(bar => meterBarNode(doc, defs.find(def => def.id === bar.id) ?? bar, bar.value, bar.stage, bar));
    // The notes and the next-stage line of one NPC (text only). A card shows its stage on its name line, so it leaves the rank out.
    function noteNodes(doc, entry, { card = false } = {}) {
        const nodes = [];
        if (!card && entry.rank) { const p = elementOf(doc, 'p', 'npc-state-delta-v2-rank'); p.append(elementOf(doc, 'b', '', entry.rank)); nodes.push(p); }
        if (entry.next) nodes.push(elementOf(doc, 'p', 'npc-state-delta-v2-next', entry.next));
        const texts = entry.opened?.length ? normalizeSecrets(dossierOf(entry.name)?.secrets) : [];
        for (const note of entry.opened ?? []) {
            const text = texts.find(secret => secret.id === note.id)?.text ?? '';
            const p = elementOf(doc, 'p', 'npc-state-delta-v2-note npc-state-delta-v2-note-open');
            p.append(doc.createTextNode('🔓 '), elementOf(doc, 'b', '', note.title ?? ''));
            if (text) p.append(doc.createTextNode(`: ${text}`));
            nodes.push(p);
        }
        for (const note of entry.locked ?? []) nodes.push(elementOf(doc, 'p', 'npc-state-delta-v2-note npc-state-delta-v2-note-locked', note.text ?? ''));
        return nodes;
    }
    // Delta's own present-cast cards (the same markup as v1's Present NPCs tab; the cards' text is set by fillPresentCast),
    // each with its NPC's stage on the name line, its meters inside the row and its notes under it. Then the NPCs with meters
    // but no card (a block of their own), then the dossier list (`list`). `track: false` (the game view's screen, the World
    // screen) leaves castEl, the Story panel's tab pane, alone.
    function renderCast(el, { track = true, cast = true, list = false } = {}) {
        if (!el) return;
        if (track) castEl = el;
        bindCastActions(el);
        const api = runtime();
        const owner = el.ownerDocument ?? doc;
        let body = '';
        if (cast) {
            if (!api) body = emptyCast({ text: 'NPC State Delta is still loading.' });
            else if (!enabled()) body = emptyCast({ text: 'NPC State Delta is off.' });
            else body = String(api.presentCastHtml?.() || '') || emptyCast(api.castEmptyReason?.());
        }
        const meters = cast && api && enabled() ? meterEntries() : null;
        let listPart = null;
        let listText = '';
        if (list && !(cast && (!api || !enabled()))) {
            if (!api) listText = emptyCast({ text: 'NPC State Delta is still loading.' });
            else if (!enabled()) listText = emptyCast({ text: 'NPC State Delta is off.' });
            else listPart = dossierListNode(el, owner);
        }
        const pane = `<div class="${PANE_CLASS}">${body}${listText}</div>`;
        const rowsKey = list ? JSON.stringify([el.__npcStateDeltaV2Find ?? '', dossierRows().map(row => [row.id, row.name, row.statusLabel, row.role]), meters?.cast ?? null]) : '';
        const key = `${pane}\u0001${meters ? JSON.stringify(meters.cast) : ''}\u0001${rowsKey}`;
        // A full redraw replaces the search box: the reader typing in it keeps the focus and the caret.
        const typing = list && owner?.activeElement?.classList?.contains?.('npc-state-delta-story-search') && el.contains?.(owner.activeElement);
        // Skip an unchanged redraw only while the element still holds what was drawn: Story Block's tab host empties the
        // shared pane (replaceChildren) before every render.
        const drawn = el.__npcStateDeltaV2CastNode;
        const stillShown = drawn ? drawn.parentNode === el : Boolean(el.innerHTML);
        if (el.__npcStateDeltaV2Cast === key && stillShown) return;
        el.innerHTML = pane;
        el.__npcStateDeltaV2Cast = key;
        el.__npcStateDeltaV2CastPane = pane;
        el.__npcStateDeltaV2CastNode = el.firstElementChild ?? null;
        const extras = [];
        if (meters && cast) {
            const defs = part.defs();
            const used = new Set();
            for (const cell of el.querySelectorAll?.('.npc-state-delta-present-cell[data-npc-id]') ?? []) {
                const npc = npcList().find(item => String(item.id ?? '') === String(cell.dataset?.npcId ?? ''));
                const who = npc ? part.identify(meters.byKey, npc.name) : null;
                const entry = who && Object.hasOwn(meters.byKey, who.key) ? meters.byKey[who.key] : null;
                if (!entry || used.has(entry)) continue;
                used.add(entry);
                const text = cell.querySelector?.('.npc-state-delta-present-card-text');
                const stage = cell.querySelector?.('.npc-state-delta-present-card-stage');
                if (stage) stage.textContent = entry.rank ?? '';
                if (text) {
                    const bars = elementOf(owner, 'div', 'npc-state-delta-present-card-bars');
                    bars.append(...barNodesOf(owner, entry, defs));
                    text.append(bars);
                }
                for (const line of noteNodes(owner, entry, { card: true })) cell.append(line);
            }
            const apart = meters.shown.filter(entry => !used.has(entry));
            if (apart.length) {
                const block = elementOf(owner, 'div', 'npc-state-delta-v2-meters');
                block.append(elementOf(owner, 'span', 'npc-state-delta-kicker', 'METERS'));
                for (const entry of apart) {
                    const section = elementOf(owner, 'section', 'npc-state-delta-v2-meter-npc');
                    section.dataset.npcKey = String(entry.key ?? '');
                    section.append(elementOf(owner, 'h4', '', entry.name ?? ''));
                    const bars = elementOf(owner, 'div', 'npc-state-delta-v2-meter-bars');
                    bars.append(...barNodesOf(owner, entry, defs));
                    section.append(bars, ...noteNodes(owner, entry));
                    block.append(section);
                }
                extras.push(block);
            }
        }
        if (listPart) extras.push(listPart);
        if (extras.length) {
            const wrap = elementOf(owner, 'div', PANE_CLASS);
            wrap.append(...extras);
            el.append(wrap);
        }
        // The now lines and chatter bubbles get their text through textContent, never markup.
        if (cast) api?.fillPresentCast?.(el);
        if (typing) {
            const box = el.querySelector?.('.npc-state-delta-story-search');
            try {
                box?.focus?.({ preventScroll: true });
                const end = String(box?.value ?? '').length;
                box?.setSelectionRange?.(end, end);
            } catch { /* focus is a convenience */ }
        }
    }

    // The Dossiers tab and screen: the present cast at the top only while Story Director's World does not
    // show it, then the dossier list.
    function renderDossiers(el, { track = true } = {}) {
        renderCast(el, { track, cast: !worldShown(), list: true });
    }

    // ---- the page API for Story Director's World (PAGE_API) ----

    function notifyChange() {
        for (const fn of [...watchers]) {
            try { fn(); } catch (error) { warn('Story Suite v2 cast listener failed', error); }
        }
    }
    // Each `slot(name, aliases)` node inside its present person's card (the card's text, under the now lines).
    function fillSlots(el, slot) {
        for (const old of [...(el.querySelectorAll?.(`.${PAGE_SLOT_CLASS}`) ?? [])]) old.remove?.();
        const cells = [...(el.querySelectorAll?.('.npc-state-delta-present-cell[data-npc-id]') ?? [])];
        if (typeof slot !== 'function' || !cells.length) return cells.length;
        const list = npcList();
        for (const cell of cells) {
            const npc = list.find(item => String(item.id ?? '') === String(cell.dataset?.npcId ?? ''));
            if (!npc) continue;
            let node = null;
            try { node = slot(String(npc.name ?? '').trim(), Array.isArray(npc.aliases) ? [...npc.aliases] : []); } catch { node = null; }
            if (!node || typeof node !== 'object' || typeof node.nodeType !== 'number') continue;
            node.classList?.add?.(PAGE_SLOT_CLASS);
            (cell.querySelector?.('.npc-state-delta-present-card-text') ?? cell).append?.(node);
        }
        return cells.length;
    }
    const pageApi = Object.freeze({
        version: 1,
        /** True while Delta is hosted, loaded and on: its cards can be drawn. */
        available: () => hosted && Boolean(runtime()) && enabled(),
        /** Draws the present cast's cards and meters into `el`; → how many present cards it drew (0: none, or not available). */
        render(el, { slot = null } = {}) {
            if (!el || !pageApi.available()) return 0;
            try {
                renderCast(el, { track: false });
                return fillSlots(el, slot);
            } catch (error) {
                warn('Story Suite v2 World cast failed', error);
                return 0;
            }
        },
        /** `fn()` after Delta's cast or state may have changed; → unsubscribe. */
        onChange(fn) {
            if (typeof fn !== 'function') return () => {};
            watchers.add(fn);
            return () => { watchers.delete(fn); };
        },
    });
    function offerPage(on) {
        if (!page || (typeof page !== 'object' && typeof page !== 'function')) return;
        try {
            if (on) page[PAGE_API] = pageApi;
            else if (page[PAGE_API] === pageApi) delete page[PAGE_API];
        } catch (error) { warn('Story Suite v2 page API failed', error); }
    }

    // Story Block's tab host has ONE pane for every module's tab (host-ui.js createTabHost marks it
    // with the shown tab's id). Delta may draw into it on its own only while it still shows the Cast
    // tab and still holds what Delta drew there; otherwise it is another module's tab now.
    function castStillShown(el) {
        if (el?.dataset?.tabId !== CAST_TAB_ID) return false;
        const drawn = el.__npcStateDeltaV2CastNode;
        if (drawn) return drawn.parentNode === el;
        return typeof el.__npcStateDeltaV2CastPane === 'string' && el.innerHTML.startsWith(el.__npcStateDeltaV2CastPane);
    }

    // ---- the Cast in the game view ----

    // Each drawn Cast screen again (Delta's page events: a cast drawn in the chat, Delta on or off);
    // one no longer on the page is let go.
    function redrawCastViews() {
        for (const box of castViews) {
            if (box.isConnected === false) {
                castViews.delete(box);
                continue;
            }
            try { renderDossiers(box, { track: false }); } catch (error) { warn('Story Suite v2 Dossiers screen failed', error); }
        }
    }

    // CAST_WIDGET: render(el, props, api) → { update, destroy }. Props are the screen's data (npc.cast,
    // npc.present), passed only so the widget redraws when they change; what it draws is renderCast's.
    const castWidget = Object.freeze({
        props: Object.freeze({}),
        validate: () => [],
        render(el) {
            const owner = el?.ownerDocument ?? doc;
            if (typeof owner?.createElement !== 'function') return { update() {}, destroy() {} };
            const box = owner.createElement('div');
            box.className = 'npc-state-delta-v2-cast-view';
            el.append(box);
            castViews.add(box);
            bindCastActions(box);
            const draw = () => {
                try { renderDossiers(box, { track: false }); } catch (error) { warn('Story Suite v2 Dossiers screen failed', error); }
            };
            draw();
            return {
                update: draw,
                destroy() {
                    castViews.delete(box);
                    box.remove?.();
                },
            };
        },
    });

    const castScreen = Object.freeze({
        id: CAST_SCREEN_ID,
        title: DOSSIERS_TITLE,
        icon: DOSSIERS_ICON,
        mounts: Object.freeze(['screen']),
        order: CAST_SCREEN_ORDER,
        data: Object.freeze({ cast: Object.freeze({ query: 'npc.cast' }), present: Object.freeze({ query: 'npc.present' }) }),
        template: `<ss-widget name="${CAST_WIDGET}" data-props='{"cast":{{ q.cast }},"present":{{ q.present }}}'></ss-widget>`,
        css: '.npc-state-delta-v2-cast-view { display: block; }',
    });

    // ---- the meter presets (settings section) ----

    // A block of buttons above Delta's panel: each preset with its description and Use / Stop using.
    // It writes only the `presets` setting (no schema row shows it, so no stale row can overwrite it).
    function presetsBlock(api) {
        if (typeof doc?.createElement !== 'function') return null;
        const root = doc.createElement('div');
        root.className = 'npc-state-delta-v2-presets';
        const read = () => {
            try { return presetIds((api?.values?.() ?? storedSettings())?.presets); } catch { return []; }
        };
        const write = ids => {
            try {
                if (typeof api?.set === 'function') api.set('presets', ids);
                else sdkRef?.settings?.set?.(MODULE_ID, 'presets', ids);
            } catch (error) { warn('Story Suite v2 preset setting failed', error); }
        };
        const draw = () => {
            root.replaceChildren();
            const head = doc.createElement('b');
            head.textContent = 'Meter presets';
            root.appendChild(head);
            if (!part.featureOn(FEATURE_PRESETS)) {
                const off = doc.createElement('small');
                off.textContent = ' Turned off in Features.';
                root.appendChild(off);
                return;
            }
            const help = doc.createElement('small');
            help.textContent = ' One click adds a set of meters, a stage ladder for the NPCs you give it in the dossier editor, and their limits.';
            root.appendChild(help);
            const used = read();
            for (const preset of catalog()) {
                const row = doc.createElement('div');
                row.className = 'npc-state-delta-v2-preset';
                row.dataset.preset = preset.id;
                const name = doc.createElement('span');
                name.className = 'npc-state-delta-v2-preset-name';
                name.textContent = preset.name;
                const about = doc.createElement('small');
                about.textContent = preset.describe;
                const on = used.includes(preset.id);
                const button = doc.createElement('button');
                button.type = 'button';
                button.className = 'menu_button npc-state-delta-v2-preset-toggle';
                button.textContent = on ? 'Stop using' : 'Use';
                button.setAttribute?.('aria-pressed', on ? 'true' : 'false');
                button.addEventListener?.('click', () => {
                    const now = read();
                    write(now.includes(preset.id) ? now.filter(id => id !== preset.id) : [...now, preset.id]);
                    draw();
                });
                for (const node of [name, about, button]) row.appendChild(node);
                root.appendChild(row);
            }
        };
        try {
            draw();
        } catch (error) {
            warn('Story Suite v2 meter presets could not be shown', error);
            return null;
        }
        return root;
    }

    // ---- the per-reply step (npc.tick) ----

    function onTurn(turn) {
        if (!hosted || !TICK_TURNS.includes(turn?.type) || !enabled()) return;
        let wanted = false;
        try { wanted = part.tickWanted(); } catch { wanted = false; }
        if (!wanted) return;
        lastTick = send('npc.tick', {}, { own: true });
    }

    // ---- Diagnostics (Story Block's Settings → Diagnostics) ----

    function diagnosticsLines() {
        const api = runtime();
        if (typeof api?.scannerReport !== 'function') return ['NPC State Delta is still loading (no scanner report yet).'];
        const lines = [...api.scannerReport()];
        try {
            const npcs = suiteApi?.npcs?.() ?? [];
            if (Array.isArray(npcs)) lines.push(`Dossiers in this chat: ${npcs.filter(npc => !npc?.archived).length} active, ${npcs.filter(npc => npc?.archived).length} archived, ${npcs.filter(npc => npc?.present).length} present.`);
        } catch { /* the counts are optional */ }
        lines.push(`Hosted in Story Block: ${hosted ? 'yes' : 'no'}. Settings panel in the overlay: ${mounted ? 'yes' : 'no'}.`);
        return lines;
    }

    // ---- what Delta sends on its own (Story Block's prompt size; its `ownPrompt` hook, SPEC §5) ----

    // Delta's live dossier and, with one-pass capture on, its instruction go out under Delta's own prompt
    // keys, so the host counts them toward its share of the context and shows them in its prompt size and
    // "Show what's sent". The same texts Delta's own What's sent shows (index.js nextReplyTexts); nothing
    // is built twice for the prompt and nothing here changes what is sent.
    function ownPrompt() {
        if (!enabled()) return [];
        let preview = null;
        try { preview = suiteApi?.manage?.preview?.(); } catch { return []; }
        const parts = Array.isArray(preview?.parts) ? preview.parts : [];
        return parts
            .filter(item => typeof item?.text === 'string' && item.text)
            .map(item => ({ label: String(item.label ?? MODULE_NAME), text: item.text }));
    }

    // ---- the story's date (Story Director's clock, read only) ----

    // Story Director's `director.time` minutes and `director.calendar` config while hosted, or null: no
    // host, no Story Director (the queries are unknown), its clock not set yet, or the reader keeps the
    // calendar in Delta (`calendarOwn`). calendar.js turns it
    // into a date on Delta's own calendar (storyClockDate) when the two calendars agree.
    function storyClock() {
        if (!hosted || typeof sdkRef?.query !== 'function') return null;
        try { if (calendarOwn?.() === true) return null; } catch { return null; }
        let time = null;
        let calendar = null;
        try {
            time = sdkRef.query('director.time', {});
            if (!Number.isSafeInteger(time?.minutes)) return null;
            calendar = sdkRef.query('director.calendar', {});
        } catch {
            return null;
        }
        if (!calendar || typeof calendar !== 'object' || !Array.isArray(calendar.months)) return null;
        const months = calendar.months.map(month => ({ name: String(month?.name ?? ''), days: Number(month?.days) }));
        return { minutes: time.minutes, calendar: { era: String(calendar.era ?? ''), months, leapYears: calendar.leapYears === true } };
    }

    // ---- the module definition ----

    const definition = Object.freeze({
        id: MODULE_ID,
        name: MODULE_NAME,
        version: String(version),
        // Story Block 2.0.0-beta.1 or later, the beta host this was built and tested with. An alpha.2 host
        // refuses the hosted module and Delta keeps working on its own; a host before 2.0.0-alpha.2
        // compares without the pre-release tag and takes it.
        requires: Object.freeze({ storyBlock: '>=2.0.0-beta.1' }),
        // The optional mechanics (MODULES §F100); a host without the Features API warns and ignores.
        features: part.features,
        domains: part.domains,
        commands: Object.freeze({
            ...part.commands,
            'npc.milestone': Object.freeze({ handler: part.commands['npc.milestone'], feature: FEATURE_STAGES }),
        }),
        queries,
        capture: {
            kinds: {
                [NPC_KIND]: { grammar: part.kinds[NPC_KIND].grammar },
                [MILESTONE_KIND]: { grammar: part.kinds[MILESTONE_KIND].grammar, feature: FEATURE_STAGES },
            },
            apply: (ctx, line) => part.kinds[NPC_KIND].apply(ctx, line),
        },
        context: {
            // Nothing about meters while Delta is off; otherwise the same line until the settings change.
            static: () => (enabled() ? part.context.static() : ''),
            tail: view => (enabled() ? part.context.tail(view) : { lines: [], optional: [] }),
            budget: part.context.budget,
        },
        settings: {
            defaults: part.settings.defaults,
            schema: part.settings.schema,
            section: (el, api) => mountSection(el, presetsBlock(api)),
        },
        // Story Block's Settings → Diagnostics (its optional hooks.diagnostics; an older host ignores it):
        // the scanner's route, profile, call counts and last outcome (index.js scannerReport),
        // and what Delta sends under its own prompt keys (`ownPrompt`, Story Block's prompt size).
        hooks: Object.freeze({ diagnostics: () => diagnosticsLines(), ownPrompt: () => ownPrompt() }),
        screens: [metersCardScreen, castScreen],
        widgets: { [CAST_WIDGET]: castWidget },
        tabs: [{
            id: CAST_TAB_ID,
            title: DOSSIERS_TITLE,
            icon: DOSSIERS_ICON,
            render: (el) => {
                try { renderDossiers(el); } catch (error) { warn('Story Suite v2 Dossiers tab failed', error); }
            },
        }],
    });

    // ---- host lifecycle ----

    // story-block-tabs.js and index.js take back (or offer again) what v1 gave Story Block, and the
    // page flag (HOSTED_FLAG) follows.
    function announceHosted(on) {
        try {
            const data = doc?.documentElement?.dataset;
            if (data && on) data[HOSTED_FLAG] = '1';
            else if (data) delete data[HOSTED_FLAG];
        } catch (error) {
            warn('Story Suite v2 host flag failed', error);
        }
        try {
            if (typeof doc?.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
                doc.dispatchEvent(new CustomEvent(V2_HOST_EVENT, { detail: { hosted: on } }));
            }
        } catch (error) {
            warn('Story Suite v2 host event failed', error);
        }
        notifyChange();
    }

    function listen() {
        if (listening || typeof doc?.addEventListener !== 'function') return;
        listening = true;
        doc.addEventListener(EVENTS.settingsMounted, () => {
            if (!hosted) return;
            if (pendingSection?.isConnected) mountSection(pendingSection);
            else syncDrawer();
        });
        // Delta's own page events (a cast drawn in the chat, Delta turned on or off) redraw the Cast
        // tab only while the pane still shows it; once the reader has moved to another tab the pane
        // is let go until the host renders the Cast tab again.
        const rerender = () => {
            if (!hosted) return;
            // Story Director's World screen (the page API's subscribers) redraws its cards too.
            notifyChange();
            redrawCastViews();
            if (!castEl) return;
            if (!castEl.isConnected || !castStillShown(castEl)) {
                castEl = null;
                return;
            }
            try { renderDossiers(castEl); } catch (error) { warn('Story Suite v2 Dossiers tab failed', error); }
        };
        doc.addEventListener(EVENTS.castRendered, rerender);
        doc.addEventListener(EVENTS.enabledChanged, rerender);
    }

    async function register(sdk, from, attempt) {
        if (hostRef !== from) return false;
        if (host() !== from) {
            // Replaced while it was getting ready: look again (still within the bound).
            hostRef = null;
            if (started) schedulePoll(attempt + 1);
            return false;
        }
        if (typeof sdk?.registerModule !== 'function' || sdkRef === sdk) return false;
        sdkRef = sdk;
        // The host's registerModule is async: Delta is hosted (drawer copy, launcher and in-chat cast
        // step aside) only once the host has accepted the module, never on a refusal.
        try {
            await sdk.registerModule(definition);
        } catch (error) {
            if (sdkRef === sdk) sdkRef = null;
            warn('Story Suite v2 registration failed; Delta keeps working on its own', error);
            return false;
        }
        if (!started || hostRef !== from || sdkRef !== sdk) return false;
        hosted = true;
        try {
            const off = typeof sdk.on === 'function' ? sdk.on('turn', onTurn) : null;
            offTurn = typeof off === 'function' ? off : null;
        } catch (error) { warn('Story Suite v2 turn events are not available', error); }
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
        // The dossier list's markup; until it loads (or if it cannot), plain rows of names.
        Promise.resolve().then(() => loadDossierList?.()).then(parts => {
            if (parts && typeof parts.rowNodes === 'function') listParts = parts;
        }, () => { /* plain rows */ });
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
        try { offTurn?.(); } catch { /* the host is gone */ }
        offTurn = null;
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

    // ---- what index.js asks while hosted (each a no-op answer without a host) ----

    // A command to the host as Delta's own action (cause ui; the host keeps other causes for itself).
    // `own`: the command is one npc.adjust takes only from Delta itself (ownSends, while it runs).
    async function send(type, payload, { own = false } = {}) {
        if (!hosted || typeof sdkRef?.command !== 'function') return null;
        const key = own ? sendKey(type, payload) : null;
        if (key) ownSends.set(key, (ownSends.get(key) ?? 0) + 1);
        try {
            const out = await sdkRef.command(type, payload);
            if (out && out.ok === false && out.code !== 'REFUSED' && out.code !== 'NOT_FOUND') warn(`Story Suite v2 ${type} was not kept: ${out.message ?? out.code}`);
            return out ?? null;
        } catch (error) {
            warn(`Story Suite v2 ${type} failed`, error);
            return null;
        } finally {
            if (key) {
                const left = (ownSends.get(key) ?? 1) - 1;
                if (left > 0) ownSends.set(key, left);
                else ownSends.delete(key);
            }
        }
    }

    /**
     * `npcs` (Delta's records) with each one's `relationship` read from the v2 slice where the slice
     * has an entry; the same array when not hosted or when nothing differs. Never changes `npcs`.
     */
    function sliceView(npcs) {
        if (!Array.isArray(npcs) || !hosted) return npcs;
        const entries = sliceEntries();
        if (!entries?.length) return npcs;
        let changed = false;
        const out = npcs.map(npc => {
            const entry = npc && typeof npc === 'object' ? entryFor(entries, npc) : null;
            if (!entry) return npc;
            const relationship = relationshipOf(entry, npc.relationship);
            if (RELATIONSHIP_KEYS.every(key => Number(npc.relationship?.[key]) === relationship[key])) return npc;
            changed = true;
            return { ...npc, relationship };
        });
        return changed ? out : npcs;
    }

    // ---- the dossier editor and the dossier view (hosted only) ----

    const EDITOR = Object.freeze({
        secrets: 'npc_state_delta_edit_secrets',
        track: 'npc_state_delta_edit_meter_track',
        limits: 'npc_state_delta_edit_meter_limits',
        milestones: 'npc_state_delta_edit_milestones',
        meter: id => `npc_state_delta_edit_meter_${id}`,
    });
    const milestoneLines = entry => Object.values(entry?.milestones ?? {}).join('\n');

    /**
     * The editor's v2 controls for one dossier, as markup ('' without a host): the hidden notes (with
     * titles), the stage ladder track, the per-meter limits, the milestones and the custom meters'
     * values (the slice's). Every value is escaped.
     */
    function editorHtml(npc) {
        if (!hosted || !npc) return '';
        const settings = part.meterSettings();
        const entry = entryFor(sliceEntries(), npc);
        const setup = setupOf(npc);
        const box = (id, label, help, value, rows = 3) => `
      <label class="npc-state-delta-editor-wide">${label} <small>${help}</small><textarea id="${id}" class="text_pole" rows="${rows}">${escapeHtml(value)}</textarea></label>`;
        let html = box(EDITOR.secrets, 'Hidden notes', 'Never sent to the story, nor shown, while locked. One per line: meter, threshold, colon, an optional [title] shown while it is locked, then the note (e.g. "trust 60: [Her past] She is the duke\'s daughter."). Opens when the meter reaches the threshold (at or below it for a negative one); then given to the story while this NPC is present.', secretsToLines(npc.secrets));
        const tracks = [...new Set(Object.keys(settings.ladder).filter(Boolean))];
        const presetName = id => catalog().find(preset => preset.id === id)?.name ?? id;
        if (part.featureOn(FEATURE_STAGES) && (tracks.length || setup.track)) {
            const options = [['', 'Everyone\'s ladder'], ...[...new Set([...tracks, ...(setup.track ? [setup.track] : [])])].map(id => [id, presetName(id)])];
            html += `
      <label class="npc-state-delta-editor-wide">Meter preset <small>Which stage ladder and limits this NPC follows.</small><select id="${EDITOR.track}" class="text_pole">${options.map(([id, label]) => `<option value="${escapeHtml(id)}"${id === setup.track ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label>`;
        }
        html += box(EDITOR.limits, 'Meter limits', 'One meter per line: "affection: ceiling 40" or "trust: floor -20, ceiling 60". Story lines and scans never raise a meter past its ceiling or lower it past its floor; a change back from one always lands. Leave empty to use the preset\'s.', limitsToLines(setup.limits), 2);
        if (part.featureOn(FEATURE_STAGES)) html += box(EDITOR.milestones, 'Milestones', 'Story turning points, one per line (the story adds them with "+ milestone Name — what happened"). A stage on the ladder may need one.', milestoneLines(entry), 2);
        const custom = part.defs().filter(def => !def.builtIn);
        if (custom.length) {
            html += `
      <div class="npc-state-delta-editor-wide npc-state-delta-v2-editor-meters">${custom.map(def => `<label>${escapeHtml(def.label)}<input id="${EDITOR.meter(def.id)}" class="text_pole" type="number" min="${def.min}" max="${def.max}" value="${entry ? meterValue({ meters: entry.meters }, def) : def.start}" data-delta-meter="${escapeHtml(def.id)}"></label>`).join('')}</div>`;
        }
        return html;
    }

    /**
     * What the editor's v2 controls hold for dossier `current` (read(id) → a control's value, or
     * undefined when the control is not there): { secrets?, meterSetup?, milestones?: { add, remove },
     * meters?: { id: n } (changed custom values), problems: [sentences] }. Only what the reader changed.
     */
    function readEditor(read, current) {
        const out = { problems: [] };
        if (!hosted || typeof read !== 'function') return out;
        const value = id => {
            try { const got = read(id); return got === null || got === undefined ? undefined : String(got); } catch { return undefined; }
        };
        const secrets = value(EDITOR.secrets);
        if (secrets !== undefined) {
            const parsed = secretsFromLines(secrets, current?.secrets);
            out.secrets = parsed.secrets;
            if (parsed.problems.length) out.problems.push(`these hidden notes were not kept (write "meter number: note"): ${parsed.problems.join(' / ')}`);
        }
        const track = value(EDITOR.track);
        const limitsText = value(EDITOR.limits);
        if (track !== undefined || limitsText !== undefined) {
            const was = setupOf(current);
            const parsed = limitsText === undefined ? { limits: was.limits, problems: [] } : limitsFromLines(limitsText);
            if (parsed.problems.length) out.problems.push(`these meter limits were not kept (write "meter: ceiling N, floor N"): ${parsed.problems.join(' / ')}`);
            const next = { track: track === undefined ? was.track : track.trim().slice(0, 80), limits: parsed.limits };
            if (JSON.stringify(next) !== JSON.stringify(was)) out.meterSetup = next.track || Object.keys(next.limits).length ? next : null;
        }
        const entry = entryFor(sliceEntries(), current);
        const milestones = value(EDITOR.milestones);
        if (milestones !== undefined) {
            const had = entry?.milestones ?? {};
            const wanted = new Map(milestones.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => [wordKey(line), line]).filter(([key]) => key));
            const add = [...wanted].filter(([key]) => !Object.hasOwn(had, key)).map(([, line]) => line);
            const remove = Object.keys(had).filter(key => !wanted.has(key));
            if (add.length || remove.length) out.milestones = { add, remove };
        }
        const meters = {};
        for (const def of part.defs().filter(item => !item.builtIn)) {
            const raw = value(EDITOR.meter(def.id));
            if (raw === undefined || raw.trim() === '') continue;
            const number = Math.round(Number(raw));
            const was = entry ? meterValue({ meters: entry.meters }, def) : def.start;
            if (Number.isFinite(number) && number !== was) meters[def.id] = number;
        }
        if (Object.keys(meters).length) out.meters = meters;
        return out;
    }

    /**
     * Each dossier's v2 meters for Delta's dossier view, by dossier id ({} without a host): { bars:
     * [{ id, label, value, min, max, text, tone, builtIn, ceiling?, delta? }], rank, next, milestones:
     * [names], locked: [teaser lines], opened: [titles] }. Locked notes are titles and rules only.
     */
    function dossierMeters(npcs) {
        if (!hosted || !Array.isArray(npcs) || typeof sdkRef?.query !== 'function') return {};
        let cast;
        try {
            const head = headReply?.();
            cast = sdkRef.query('npc.cast', Number.isInteger(head) ? { headReply: head } : {});
        } catch {
            return {};
        }
        if (!Array.isArray(cast) || !cast.length) return {};
        const byKey = Object.fromEntries(cast.map(entry => [entry.key, entry]));
        const entries = sliceEntries() ?? [];
        const builtIn = new Set(part.defs().filter(def => def.builtIn).map(def => def.id));
        const out = {};
        for (const npc of npcs) {
            if (!npc?.id) continue;
            const who = part.identify(byKey, npc.name);
            const entry = who && Object.hasOwn(byKey, who.key) ? byKey[who.key] : null;
            if (!entry) continue;
            const slice = entries.find(item => item.key === entry.key);
            out[npc.id] = {
                bars: entry.bars.map(bar => ({ ...bar, builtIn: builtIn.has(bar.id) })),
                rank: entry.rank ?? '',
                next: entry.next ?? '',
                milestones: Object.values(slice?.milestones ?? {}),
                locked: (entry.locked ?? []).map(note => note.text),
                opened: (entry.opened ?? []).map(note => note.title),
            };
        }
        return out;
    }

    return Object.freeze({
        definition,
        /** The page API Story Director's World screen uses (PAGE_API). */
        pageApi,
        /** While hosted: Delta's scanner changes for one NPC → `npc.adjust` (a promise of the result, or null). */
        adjust: ({ name, meters, start, reply } = {}) => send('npc.adjust', { name, meters, ...(start ? { start } : {}), ...(Number.isInteger(reply) && reply >= 0 ? { reply } : {}) }, { own: true }),
        /** While hosted: the reader's own values from the dossier editor → `npc.set` (the host's latest reply; headReply). */
        setMeters: ({ name, meters } = {}) => send('npc.set', { name, meters }),
        /** While hosted: stages and notes again for one NPC (after its notes were edited) → `npc.refresh`. */
        refresh: name => send('npc.refresh', { name }),
        /** While hosted: one NPC's slice entry (npc.meters), or null. */
        meters: name => {
            const entries = sliceEntries();
            const npc = dossierOf(name) ?? { name };
            return entries ? entryFor(entries, npc) : null;
        },
        sliceView,
        /** While hosted: Story Director's clock, { minutes, calendar: { era, months, leapYears } }, or null. */
        storyClock,
        /** What Delta sends with the next reply under its own keys: [{ label, text }] (the `ownPrompt` hook). */
        ownPrompt,
        /** While hosted: the names in Story Block's scene (`scene.present`), or null when it cannot answer. */
        scenePresent: () => {
            if (!hosted || typeof sdkRef?.query !== 'function') return null;
            try {
                const list = sdkRef.query('scene.present');
                return Array.isArray(list) ? list.map(name => String(name ?? '').trim()).filter(Boolean) : null;
            } catch {
                return null;
            }
        },
        /**
         * While hosted: who is in the scene now, for the scanner: Story Director's World view
         * (`director.world.here` → `present`) when it answers, else Story Block's `scene.present`; null
         * when neither can answer. Both are optional: Delta alone (or Story Block alone) still works.
         */
        presentNow: () => {
            if (!hosted || typeof sdkRef?.query !== 'function') return null;
            const ask = name => {
                try { return sdkRef.query(name, {}); } catch { return undefined; }
            };
            const here = ask('director.world.here');
            const list = Array.isArray(here?.present) ? here.present : ask('scene.present');
            return Array.isArray(list) ? list.map(name => String(name ?? '').trim()).filter(Boolean) : null;
        },
        /** A dossier's hidden notes as editor lines, and editor lines back to notes (src/npc-meters.js). */
        secretLines: list => secretsToLines(list),
        parseSecrets: (text, previous) => secretsFromLines(text, previous),
        /** While hosted: the editor's v2 controls for a dossier (markup), and what they hold (readEditor). */
        editorHtml,
        readEditor,
        /**
         * While hosted, after the dossier was saved: the editor's milestones and custom meter values
         * go to the slice (npc.milestone, npc.set), then stages and notes are settled again (npc.refresh).
         */
        applyEditor: async (name, edits = {}) => {
            if (!hosted) return null;
            if (edits.meters && Object.keys(edits.meters).length) await send('npc.set', { name, meters: edits.meters });
            if (edits.milestones) await send('npc.milestone', { name, add: edits.milestones.add ?? [], remove: edits.milestones.remove ?? [] });
            return send('npc.refresh', { name });
        },
        /** While hosted: the dossier view's v2 meters by dossier id ({} otherwise). */
        dossierMeters,
        /** While hosted: Delta's per-reply step now (the host's 'turn' event sends it on its own). */
        tick: () => send('npc.tick', {}, { own: true }),
        /** Resolves once the latest per-reply step has settled. */
        ticked: () => lastTick,
        /** Start looking for the host (idempotent). */
        start() {
            if (started) return;
            started = true;
            offerPage(true);
            poll(0);
        },
        /** Stop looking and give everything back (tests; a reload of Delta). */
        stop() {
            started = false;
            offerPage(false);
            watchers.clear();
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
