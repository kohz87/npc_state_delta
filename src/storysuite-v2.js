// Story Suite v2 adapter (Story Block 2, docs/v2/SPEC.md §6 and MODULES.md §D in Story Block).
//
// NPC State Delta stays a standalone engine: its storage, capture, prompts and history rules are
// its own and nothing here changes them. When a Story Block v2 host is on the page, Delta also
// registers as module `npc-state-delta` with read-only queries, a Cast tab that shows Delta's own
// present-cast cards (and the same Cast as a screen in Story Block's game view), and a settings section that carries Delta's own settings panel into the Story
// Suite overlay. It also owns one small domain, `npc` (src/npc-meters.js; F81, F90): each NPC's
// meters, stages and unlocked hidden notes in the per-reply state, so they swipe and delete back
// with the replies. While hosted that slice is the truth for meter values: index.js reads it back
// through sliceView() for the dossier view and the injection, and sends its scanner's relationship
// changes as `npc.adjust` (adjust()); the `~ npc` change line, an NPC card under each reply and the
// meters in the Cast tab come from here. While hosted, the copy in SillyTavern's extensions drawer is
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
    FEATURE_PRESETS, FEATURE_STAGES, MILESTONE_KIND, NPC_KIND, createNpcPart, limitsFromLines, limitsToLines, meterValue,
    normalizeSecrets, secretsFromLines, secretsToLines, wordKey,
} from './npc-meters.js';
import { normalizeLimits, presetCatalog, presetIds } from './npc-meters-presets.js';
import { METERS_CARD_ID, metersCardScreen } from './npc-meters-screen.js';
import { DOSSIER_FIELDS } from './fields/registry.js';
import { escapeHtml } from './util/html.js';

export const MODULE_ID = 'npc-state-delta';
export const MODULE_NAME = 'NPC State Delta';
export const CAST_TAB_ID = 'cast';
/**
 * The Cast as a game-view screen (Story Block's full-screen view lists screens, not module tabs): mount
 * `screen` only, so the Story panel keeps its one Cast tab. Its template is one widget,
 * CAST_WIDGET, that draws exactly what the Cast tab draws (Delta's present-cast cards and the meters).
 */
export const CAST_SCREEN_ID = 'npc-state-delta/cast';
export const CAST_WIDGET = 'npc-state-delta.cast';
// After Scene (30), before Inventory (40): Story Block's navigation order (view/screens.js DEFAULT_ORDER).
export const CAST_SCREEN_ORDER = 35;
export const QUERY_NAMES = Object.freeze(['npc.present', 'npc.dossier', 'npc.known', 'npc.portrait', 'npc.meters', 'npc.cast', 'npc.next']);
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

/**
 * One meter bar as ss.meter draws it (WIDGETS.md: role="meter", aria values, `ss-w-meter-*` parts,
 * `--ss-w-ratio` on the track), as markup for the Cast tab. `def`: { id, label, min, max, tone }.
 * `extra` (all optional): { text (the value as shown), ceiling (a notch on the track), ticks: [{ at,
 * label }] (thresholds as marks), delta (▲3 / ▼2 beside the value) }.
 */
export function meterBarHtml(def, value, stage = '', extra = {}) {
    const min = Number.isFinite(def?.min) ? def.min : -100;
    const max = Number.isFinite(def?.max) && def.max > min ? def.max : min + 100;
    const now = Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Math.round(Number(value)) : min));
    const at = point => Math.round(((Math.min(max, Math.max(min, point)) - min) / (max - min)) * 10000) / 10000;
    const ratio = at(now);
    const text = typeof extra?.text === 'string' && extra.text ? extra.text : stage ? `${now} · ${stage}` : String(now);
    const tone = METER_TONES.has(def?.tone) ? def.tone : 'neutral';
    const label = escapeHtml(def?.label ?? def?.id ?? '');
    const delta = Number.isInteger(extra?.delta) && extra.delta !== 0 ? extra.delta : 0;
    const deltaHtml = delta ? `<span class="npc-state-delta-v2-delta ${delta > 0 ? 'npc-state-delta-v2-delta-up' : 'npc-state-delta-v2-delta-down'}" aria-hidden="true">${delta > 0 ? '▲' : '▼'}${Math.abs(delta)}</span>` : '';
    const marks = [];
    for (const tick of (Array.isArray(extra?.ticks) ? extra.ticks : []).slice(0, 8)) {
        if (!Number.isFinite(tick?.at)) continue;
        marks.push(`<span class="npc-state-delta-v2-tick" style="--npc-state-delta-at: ${at(tick.at)}" title="${escapeHtml(`${tick.label ?? ''} ${tick.at}`.trim())}"></span>`);
    }
    if (Number.isFinite(extra?.ceiling) && extra.ceiling < max) marks.push(`<span class="npc-state-delta-v2-ceiling" style="--npc-state-delta-at: ${at(extra.ceiling)}" title="${escapeHtml(`Ceiling ${extra.ceiling}`)}"></span>`);
    return `<div class="ss-w ss-w-meter ss-w-tone-${tone}${ratio >= 1 ? ' ss-w-full' : ''}${ratio <= 0 ? ' ss-w-empty' : ''}" role="meter" aria-label="${label}" aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${now}" aria-valuetext="${escapeHtml(text)}" data-meter="${escapeHtml(def?.id ?? '')}">`
        + `<div class="ss-w-meter-head"><span class="ss-w-meter-label">${label}</span><span class="ss-w-meter-value" aria-hidden="true">${escapeHtml(text)}${deltaHtml}</span></div>`
        + `<div class="ss-w-meter-track" style="--ss-w-ratio: ${ratio}"><div class="ss-w-meter-fill"></div>${marks.join('')}</div></div>`;
}

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

    // The present NPCs' meters under the cards: one bar per shown meter, drawn with ss.meter's own
    // markup and classes (role="meter", the --ss-w-ratio fill) so Story Block's widget styles apply,
    // with the NPC's ceiling as a notch, stage thresholds as marks and the latest reply's change.
    // Under them: the stage reached on the ladder and what the next one still needs, the hidden
    // notes still locked (title and rule only) and the ones opened (with their text). A module tab
    // is given no widget renderer (SPEC §6 tabs get el, view, api), so the bars are written here; the
    // NPC card under each reply uses the real ss.meter widget (npc-meters-screen.js).
    function castMetersHtml() {
        if (!hosted || typeof sdkRef?.query !== 'function') return '';
        let cast;
        try {
            const head = headReply?.();
            cast = sdkRef.query('npc.cast', Number.isInteger(head) ? { headReply: head } : {});
        } catch {
            return '';
        }
        if (!Array.isArray(cast) || !cast.length) return '';
        const byKey = Object.fromEntries(cast.map(entry => [entry.key, entry]));
        const defs = part.defs();
        const blocks = [];
        // The present dossiers' entries, in dossier order; then (beta) the entries of people the story's
        // change lines gave meters who have no dossier yet (no scan has made one), straight from the
        // state: those Story Block's scene has here, or all of them when the scene cannot say.
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
        for (const entry of shown) {
            const npc = { name: entry.name };
            const bars = entry.bars.map(bar => meterBarHtml(defs.find(def => def.id === bar.id) ?? bar, bar.value, bar.stage, bar)).join('');
            const lines = [];
            if (entry.rank) lines.push(`<p class="npc-state-delta-v2-rank"><b>${escapeHtml(entry.rank)}</b></p>`);
            if (entry.next) lines.push(`<p class="npc-state-delta-v2-next">${escapeHtml(entry.next)}</p>`);
            const texts = entry.opened?.length ? normalizeSecrets(dossierOf(npc.name)?.secrets) : [];
            for (const note of entry.opened ?? []) {
                const text = texts.find(secret => secret.id === note.id)?.text ?? '';
                lines.push(`<p class="npc-state-delta-v2-note npc-state-delta-v2-note-open">🔓 <b>${escapeHtml(note.title)}</b>${text ? `: ${escapeHtml(text)}` : ''}</p>`);
            }
            for (const note of entry.locked ?? []) lines.push(`<p class="npc-state-delta-v2-note npc-state-delta-v2-note-locked">${escapeHtml(note.text)}</p>`);
            blocks.push(`<section class="npc-state-delta-v2-meter-npc" data-npc-key="${escapeHtml(entry.key)}"><h4>${escapeHtml(entry.name)}</h4><div class="npc-state-delta-v2-meter-bars">${bars}</div>${lines.join('')}</section>`);
        }
        return blocks.length ? `<div class="npc-state-delta-v2-meters"><span class="npc-state-delta-kicker">METERS</span>${blocks.join('')}</div>` : '';
    }
    // Delta's own present-cast cards (the same markup as v1's Present NPCs tab), or why it is empty.
    // `track: false` (the game view's Cast screen) leaves castEl, the Story panel's tab pane, alone.
    function renderCast(el, { track = true } = {}) {
        if (!el) return;
        if (track) castEl = el;
        bindCastActions(el);
        const api = runtime();
        let body;
        if (!api) body = emptyCast({ text: 'NPC State Delta is still loading.' });
        else if (!enabled()) body = emptyCast({ text: 'NPC State Delta is off.' });
        else body = String(api.presentCastHtml?.() || '') || emptyCast(api.castEmptyReason?.());
        const meters = api && enabled() ? castMetersHtml() : '';
        const html = `<div class="${PANE_CLASS}">${body}${meters}</div>`;
        // Skip an unchanged redraw only while the pane still holds what was drawn: Story Block's tab
        // host empties the shared pane (replaceChildren) before every render.
        const drawn = el.__npcStateDeltaV2CastNode;
        const stillShown = drawn ? drawn.parentNode === el : Boolean(el.innerHTML);
        if (el.__npcStateDeltaV2Cast === html && stillShown) return;
        el.innerHTML = html;
        el.__npcStateDeltaV2Cast = html;
        el.__npcStateDeltaV2CastNode = el.firstElementChild ?? null;
        // The now lines and chatter bubbles get their text through textContent, never markup.
        api?.fillPresentCast?.(el);
    }

    // Story Block's tab host has ONE pane for every module's tab (host-ui.js createTabHost marks it
    // with the shown tab's id). Delta may draw into it on its own only while it still shows the Cast
    // tab and still holds what Delta drew there; otherwise it is another module's tab now.
    function castStillShown(el) {
        if (el?.dataset?.tabId !== CAST_TAB_ID) return false;
        const drawn = el.__npcStateDeltaV2CastNode;
        if (drawn) return drawn.parentNode === el;
        return typeof el.__npcStateDeltaV2Cast === 'string' && el.innerHTML === el.__npcStateDeltaV2Cast;
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
            try { renderCast(box, { track: false }); } catch (error) { warn('Story Suite v2 Cast screen failed', error); }
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
                try { renderCast(box, { track: false }); } catch (error) { warn('Story Suite v2 Cast screen failed', error); }
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
        title: 'Cast',
        icon: 'fa-masks-theater',
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
        // Story Block 2.0.0-alpha.2 or later (an older host ignores the field).
        requires: Object.freeze({ storyBlock: '>=2.0.0-alpha.2' }),
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
            title: 'Cast',
            icon: 'fa-masks-theater',
            render: (el) => {
                try { renderCast(el); } catch (error) { warn('Story Suite v2 Cast tab failed', error); }
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
            redrawCastViews();
            if (!castEl) return;
            if (!castEl.isConnected || !castStillShown(castEl)) {
                castEl = null;
                return;
            }
            try { renderCast(castEl); } catch (error) { warn('Story Suite v2 Cast tab failed', error); }
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
