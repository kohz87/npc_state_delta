// The public sdk (docs/v2/SPEC.md §3.1, §6): what modules get from `await StoryBlock.ready`.
// Built from the store, the command bus and the registry; it adds the parts they share: events,
// settings under extension_settings.storySuite, the view modules read, ids, and adding a late
// module's initial state. No SillyTavern import (turn.js wires SillyTavern).

import { INIT_PREFIX, normalizeField } from './registry.js';
import { headReply } from './commands.js';
import { KEY as RECORD_KEY, isCarrier, recordFault } from './persist.js';
import { cutAt } from '../text.js';
import { MODEL_CALL_ERRORS, MODEL_CALL_TEXT, profileName } from './model-call.js';

// sdk.check comes from check.js (SB-commands); the sdk still loads without it.
const checkModule = await import('./check.js').catch(() => null);

// `feature` ({ id, on, prompt }) fires when the reader turns a feature on or off (MODULES §F100).
// `modules` ({ changes: [{ id, status, reason, from }] }) fires when a module becomes ready, dormant or
// restore-pending (docs/v2/LIFECYCLE.md); `from` is the status it had been announced with, null when new.
export const EVENTS = Object.freeze(['committed', 'head', 'turn', 'feature', 'modules']);
// The most change lines one reply's block may hold; the rest are one Problem (turn.js).
export const MAX_CHANGE_LINES = 150;
export const HOST_SETTINGS_DEFAULTS = Object.freeze({ tailBudget: 1500, contextShare: 40, maxChangeLines: MAX_CHANGE_LINES, callQueue: true, panelStyle: 'glass', glassStrength: 50, font: 'nunito' });
export const HOST_SETTINGS_SCHEMA = Object.freeze({
    tailBudget: Object.freeze({
        type: 'int', min: 100, max: 20000, label: 'Notes per reply (tokens)',
        help: 'The most Story Suite adds to the end of each reply\'s prompt, about four characters a token.',
    }),
    contextShare: Object.freeze({
        type: 'int', min: 10, max: 90, label: 'Share of the context (%)',
        help: 'The most of SillyTavern\'s context size (less the reply) Story Suite\'s instructions and notes take together; the rest is left for the conversation. The notes are cut to fit, the instructions never are.',
    }),
    maxChangeLines: Object.freeze({
        type: 'int', min: 10, max: 1000, label: 'Change lines per reply',
        help: 'The most change lines one reply may hold; any after them are not used and the Problems list says so.',
    }),
    callQueue: Object.freeze({
        type: 'bool', label: 'Run extra calls one at a time per connection',
        help: 'Story Suite\'s own model calls (Delta\'s scan, the arc planner, Assist) wait for each other when they use the same connection profile, so a local server that answers one request at a time is never asked twice at once. Calls on different profiles still go side by side.',
    }),
    // Story Suite's look (src/v2/view/theme.js): the panels and the font, for every Story Suite screen.
    panelStyle: Object.freeze({
        type: 'choice', label: 'Panel style', options: Object.freeze([
            Object.freeze({ value: 'glass', label: 'Glass' }),
            Object.freeze({ value: 'solid', label: 'Solid' }),
            Object.freeze({ value: 'sillytavern', label: 'Follow SillyTavern' }),
        ]),
        help: 'How Story Suite\'s panels look. Glass: see-through panels over your background. Solid: less transparency and no blur. Follow SillyTavern: its own colours and blur only. Light or dark follows your SillyTavern theme either way. Solid suits a busy background or a slow device; your system\'s "reduce transparency" setting also turns Glass into Solid.',
    }),
    glassStrength: Object.freeze({
        type: 'int', min: 30, max: 90, form: 'slider', label: 'Glass strength (%)',
        help: 'How dense the Glass panels are: low shows more of your background through them, high is easier to read on a busy one. Solid ignores it.',
    }),
    font: Object.freeze({
        type: 'choice', label: 'Font', options: Object.freeze([
            Object.freeze({ value: 'nunito', label: 'Nunito (soft and round)' }),
            Object.freeze({ value: 'theme', label: 'Your theme\'s font' }),
        ]),
        help: 'Nunito comes with Story Block, so it looks the same offline and with "Forbid external media" on. "Your theme\'s font" uses the font SillyTavern\'s theme sets.',
    }),
});

// A text field with no `max` of its own is held to this many characters; a list to this many rows.
export const SETTING_TEXT_MAX = 200;
export const SETTING_LIST_ROWS = 100;

/**
 * A value as `field` (a settings schema entry) allows it: text is text, cut at `max` characters
 * (SETTING_TEXT_MAX when the field sets none), never inside a character; a whole number is kept inside
 * min/max (null when it is not one); a choice must be one of its options (null when not); a profile is a
 * Connection Manager profile's name, trimmed and cut at 100 ('' for the chat's connection); a list is at
 * most SETTING_LIST_ROWS rows of records, each holding its `of` fields as they allow them (other keys
 * dropped). Other types pass unchanged.
 */
export function settingValue(field, value) {
    if (!field) return value;
    const f = normalizeField(field);
    if (f.type === 'text') {
        if (value === undefined || value === null) return '';
        const text = typeof value === 'string' ? value : String(value);
        const max = Number.isInteger(f.max) && f.max >= 0 ? f.max : SETTING_TEXT_MAX;
        return text.length > max ? cutAt(text, max) : text;
    }
    if (f.type === 'list') {
        if (!Array.isArray(value)) return [];
        const of = isObject(f.of) ? Object.entries(f.of) : [];
        return value.slice(0, SETTING_LIST_ROWS).filter(isObject)
            .map(row => Object.fromEntries(of.map(([key, sub]) => [key, settingValue(sub, row[key])])));
    }
    if (f.type === 'int') {
        const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
        if (value === '' || value === null || value === undefined || !Number.isFinite(n)) return null;
        let out = Math.round(n);
        if (Number.isInteger(f.min)) out = Math.max(f.min, out);
        if (Number.isInteger(f.max)) out = Math.min(f.max, out);
        return out;
    }
    // A Connection Manager profile's name, trimmed and cut at 100; '' (or 'chat') is the chat's connection.
    if (f.type === 'profile') return profileName(typeof value === 'string' ? value : '');
    if (f.type === 'bool') return Boolean(value);
    if (f.type === 'choice' && Array.isArray(f.options) && f.options.length) {
        const options = (f.options ?? []).map(option => String(option && typeof option === 'object' ? option.value : option));
        return options.includes(String(value)) ? String(value) : null;
    }
    return value;
}

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const ID_PREFIX = /^[a-z][a-z0-9]*$/;
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/** `<prefix>_<8 base36 chars>` from crypto randomness (§2.1), e.g. `it_k3f9a2qz`. */
export function newId(prefix) {
    if (typeof prefix !== 'string' || !ID_PREFIX.test(prefix)) throw new Error(`Story Suite: an id prefix is lowercase letters and digits (like "it"), not "${prefix}".`);
    let out = '';
    const bytes = new Uint8Array(16);
    while (out.length < 8) {
        globalThis.crypto.getRandomValues(bytes);
        // 252 = 7 × 36: values above it would favour the first letters.
        for (const byte of bytes) if (byte < 252 && out.length < 8) out += BASE36[byte % 36];
    }
    return `${prefix}_${out}`;
}

/** { on(name, fn) → off, emit(name, payload) }; a listener that throws is logged, not passed on. */
export function createEvents() {
    const listeners = new Map(EVENTS.map(name => [name, new Set()]));
    const known = name => {
        if (!listeners.has(name)) throw new Error(`Story Suite: there is no "${name}" event (known: ${EVENTS.join(', ')}).`);
        return listeners.get(name);
    };
    return {
        on(name, fn) {
            if (typeof fn !== 'function') throw new Error('Story Suite: on() needs a function.');
            const set = known(name);
            set.add(fn);
            return () => set.delete(fn);
        },
        emit(name, payload) {
            for (const fn of [...known(name)]) {
                try { fn(payload); } catch (error) { console.warn(`[Story Suite] a "${name}" listener failed`, error); }
            }
        },
    };
}

/**
 * Settings under `root().storySuite` (`root`: () => SillyTavern's extension_settings):
 * `settings(id)` → the module's values over its defaults (a plain copy); `settings()` → the
 * host's ({ tailBudget, maxChangeLines }). `settings.set(id, key, value)` stores one value (id null:
 * the host's) as its schema field allows it (settingValue: text cut at `max`, numbers inside min/max;
 * a value the field cannot take is not stored) and calls `save` (saveSettingsDebounced). Returns the
 * value stored, or undefined. `settings.stored(id)` is the stored object itself.
 */
export function createSettings({ root, registry, save = () => {} }) {
    function bucket() {
        const es = root?.();
        if (!isObject(es)) return { host: {}, modules: {} };
        if (!isObject(es.storySuite)) es.storySuite = {};
        if (!isObject(es.storySuite.modules)) es.storySuite.modules = {};
        if (!isObject(es.storySuite.host)) es.storySuite.host = {};
        return es.storySuite;
    }
    function stored(id) {
        const all = bucket();
        if (id === undefined || id === null) return all.host;
        if (!isObject(all.modules[id])) all.modules[id] = {};
        return all.modules[id];
    }
    function settings(id) {
        const defaults = id === undefined || id === null ? HOST_SETTINGS_DEFAULTS : registry.module(id)?.settings?.defaults ?? {};
        return structuredClone({ ...defaults, ...stored(id) });
    }
    settings.stored = stored;
    const fieldOf = (id, key) => {
        const schema = id === undefined || id === null ? HOST_SETTINGS_SCHEMA : registry.module(id)?.settings?.schema;
        return schema && Object.hasOwn(schema, key) ? schema[key] : null;
    };
    settings.set = (id, key, value) => {
        const next = settingValue(fieldOf(id, key), value);
        if (next === null && value !== null) return undefined;
        stored(id)[key] = structuredClone(next);
        save();
        return next;
    };
    return settings;
}

/**
 * Runs a registered query on `state`; the answer is a plain copy. Throws for an unknown query.
 * A query is called (state, args, tools) with tools.query(name, args) over the same state,
 * tools.receipts() → [{ index, receipt }], the stored receipts in chat order (`receipts` option),
 * tools.pendingProofs() → [{ proof }], a Re-read's planned proof (`pendingProofs` option, story.evidence), and
 * tools.reply ({ index, sid } or null, the `reply` option): the reply the state is the head of, as a
 * command's ctx.reply (commands.js).
 */
export function runQuery(registry, state, name, args, { receipts = () => [], reply = null, pendingProofs = null } = {}) {
    const query = registry.query(name);
    if (!query) throw new Error(`Story Suite: no module answers the query "${name}".`);
    const tools = Object.freeze({
        reply,
        query: (other, otherArgs) => runQuery(registry, state, other, otherArgs, { receipts, reply, pendingProofs }),
        receipts: () => receipts() ?? [],
        // The proof a Re-read has planned but not stored (evidence.js), for story.evidence; none otherwise.
        ...(typeof pendingProofs === 'function' ? { pendingProofs } : {}),
    });
    const answer = query(state, args === undefined ? undefined : structuredClone(args), tools);
    return answer === undefined ? undefined : structuredClone(answer);
}

/**
 * The mounts' query (src/v2/view/mounts/common.js): `(name, args, state)` → runQuery over that
 * state, so a card asks against its own reply's state and the registry's queries still get
 * (state, args, tools). A query that throws is the mount's to report (resolveData gives null).
 */
export const mountQuery = (registry, receipts = () => []) => (name, args, state) => runQuery(registry, state, name, args, { receipts });

/**
 * What modules read (§6): { state (frozen head), query(name, args), settings(id), feature(id), chat:
 * { length, lastUser } }. `chat`: SillyTavern's chat array (or nothing). `feature(id)`: whether the
 * reader has that feature on (MODULES §F100); false for an id no module declares. `state` and `reply`
 * (optional): another state than the head and the reply it stands for (`tools.reply`), for a Re-read's
 * afterCapture hook, which reads the reply's state after its new story lines (turn.js).
 */
export function makeView({ store, registry, settings, chat = [], active = null, state = store.head(), reply = headReply(store), pendingProofs = null }) {
    const messages = Array.isArray(chat) ? chat : [];
    // (`active`: the timeline's reader of earlier messages, so a faded message of the reader's is not the last one a module sees)
    const lastUser = [...(active ? active.messages(messages) : messages)].reverse().find(message => message?.is_user);
    return Object.freeze({
        state,
        query: (name, args) => runQuery(registry, state, name, args, { receipts: () => store.receipts?.() ?? [], reply, pendingProofs }),
        settings,
        feature: id => featureOn(registry, id),
        chat: Object.freeze({ length: messages.length, lastUser: String(lastUser?.mes ?? '') }),
    });
}

/** Whether feature `id` is on (registry.featureOn); false for an unknown id or a registry without features. */
export const featureOn = (registry, id) => typeof registry?.featureOn === 'function' && registry.featureOn(id) === true;

/**
 * The registered modules whose domains the head state lacks (enabled after the chat began, or a
 * newer version with a domain more): [{ def, missing: [domain names] }], in module-id order. A module
 * held back (dormant, or the restore barrier is up; registry.held) is left out: it is set up when it is ready.
 */
export function missingModules(registry, state) {
    const domains = state?.domains ?? {};
    return registry.modules()
        .filter(def => registry.held?.(def.id) !== true)
        .map(def => ({ def, missing: Object.keys(def.domains ?? {}).filter(name => !Object.hasOwn(domains, name)) }))
        .filter(entry => entry.missing.length);
}

// The timeline a registry's sdk was made with (createSdk), so ensureModules can recover it.
const timelines = new WeakMap();

// What each registry's modules were last announced as (`modules` event): id → "status\u0000reason".
const announced = new WeakMap();

/**
 * Tells the `modules` event what changed in the modules' lifecycle (registry.lifecycles()) since the
 * last time: a module that turned ready, dormant or restore-pending, or one that appeared dormant
 * (a new module that is ready is not news). Each change is announced once. Returns the changes
 * ([{ id, status, reason, from }]); the event carries them as { changes }.
 */
export function announceModules(registry, events = null) {
    if (typeof registry?.lifecycles !== 'function') return [];
    if (!announced.has(registry)) announced.set(registry, new Map());
    const known = announced.get(registry);
    const changes = [];
    for (const { id, status, reason } of registry.lifecycles()) {
        const before = known.get(id);
        const now = `${status}\u0000${reason ?? ''}`;
        if (before === now) continue;
        known.set(id, now);
        if (before === undefined && status === 'ready') continue;
        changes.push({ id, status, reason, from: before === undefined ? null : before.split('\u0000')[0] });
    }
    if (changes.length) events?.emit('modules', { changes });
    return changes;
}

// Set-up failures already logged, per registry: a domain whose initial() keeps failing is tried
// again at every turn, and told once.
const toldFailures = new WeakMap();

/**
 * Adds the missing initial slices of each module (only those: a domain the chat already has keeps
 * its data) with a `system` receipt on the head carrier (§2.6). Does nothing without a head carrier
 * or before the chat has its state (a module registering at boot, before CHAT_CHANGED). Returns the
 * command results.
 */
export async function ensureModules({ store, bus, registry, events = null }) {
    announceModules(registry, events);
    // A save point or a restore the last run left half way is finished or aborted before anything else (docs/v2/TIMELINE.md); a
    // chat that never used the timeline has nothing to recover and costs one look.
    const line = timelines.get(registry);
    line?.settle?.();
    if (line?.needsRecovery()) await line.recover();
    // A restore barrier changes nothing until every part agrees (registry.setRestore).
    if (registry.restore?.().state === 'pending') return [];
    if (store.headIndex() < 0 || !store.head()) return [];
    if (!toldFailures.has(registry)) toldFailures.set(registry, new Set());
    const told = toldFailures.get(registry);
    const results = [];
    for (const { def, missing } of missingModules(registry, store.head())) {
        const result = await bus.command(`${INIT_PREFIX}${def.id}`, { domains: missing }, { cause: 'system' });
        if (result?.ok) events?.emit('committed', { receipt: result.receipt });
        else {
            const message = `${def.name ?? def.id} could not be set up in this chat: ${result?.message ?? 'unknown error'}`;
            if (!told.has(message)) console.warn(`[Story Suite] ${message}`);
            told.add(message);
        }
        results.push(result);
    }
    return results;
}

// ---- sdk.preflight (RB_CONTRACT §2, §9; docs/v2/LIFECYCLE.md) --------------------------------------

/** The classes a module's stored data can be in, as sdk.preflight tells them. */
export const PREFLIGHT_CLASSES = Object.freeze(['empty', 'current', 'legacy', 'mixed', 'future', 'damaged']);
// The version of the store records this Story Block reads (record `v`, state `v`).
const STORE_VERSION = 2;
// The slice whose root carries a module's rules marker (rulesVersion, rulesHash): RPG Battle's `rules`.
const RULES_DOMAIN = 'rules';
// What a module not registered yet is known by: the domains it keeps and the peers it needs, for the
// suite's own modules, so `preflight({ module: 'rpg-battle' })` can look before it registers. Any
// other module (or a different list) passes `domains` and `peers` itself.
export const SUITE_MODULES = Object.freeze({
    'rpg-battle': Object.freeze({
        domains: Object.freeze(['party', 'effects', 'creation', 'gear', 'combat', 'bestiary', 'trade', 'craft', 'rules', 'progress', 'training', 'death']),
        peers: Object.freeze(['story-director']),
    }),
});
const MODULE_ID_TEXT = /^[a-z0-9][a-z0-9._-]*$/;
const DOMAIN_TEXT = /^[a-z][a-zA-Z0-9_-]*$/;

/**
 * What Story Block can tell about a chat before `module` registers, with nothing written (no set-up,
 * receipt, record repair or save): `{ hostApi, hostVersion, storeVersion, classification, domains,
 * rulesVersion, rulesHash, peers, restore }` (docs/v2/LIFECYCLE.md has each field).
 *
 * `options`: { module (id), rulesVersion? (a whole number ≥ 1: the rules generation the caller runs),
 * domains? (the module's domain names), peers? (module ids it needs) }. A module marks its rules
 * generation by `rulesVersion` (a whole number) and `rulesHash` (text) at the root of any of its domain
 * slices; Story Block only reads them. Data it cannot read is `damaged`, never `empty`.
 */
export function preflight({ store, registry, chat = () => [], apiVersion = 2 }, options) {
    if (!isObject(options) || typeof options.module !== 'string' || !MODULE_ID_TEXT.test(options.module)) {
        throw new TypeError('Story Suite: preflight needs { module } with a module id (like "rpg-battle").');
    }
    const wanted = options.rulesVersion;
    if (wanted !== undefined && wanted !== null && !(Number.isInteger(wanted) && wanted >= 1)) {
        throw new TypeError('Story Suite: preflight rulesVersion is a whole number from 1, or left out.');
    }
    const id = options.module;
    const def = registry.module?.(id) ?? null;
    const suite = SUITE_MODULES[id] ?? null;
    // `domains` and `peers`, when given, are lists of valid names; a bad one throws, it is never left out
    // (a list that lost a name would read `empty`).
    const listed = (name, pattern) => {
        const list = options[name];
        if (list === undefined || list === null) return null;
        if (!Array.isArray(list) || list.some(item => typeof item !== 'string' || !pattern.test(item))) {
            throw new TypeError(`Story Suite: preflight ${name} is a list of ${name === 'domains' ? 'domain names (like "party")' : 'module ids (like "story-director")'}.`);
        }
        return list;
    };
    const domainNames = listed('domains', DOMAIN_TEXT) ?? (def ? Object.keys(def.domains ?? {}) : suite ? [...suite.domains] : []);
    const peerIds = listed('peers', MODULE_ID_TEXT) ?? (def ? registry.peers(id).map(peer => peer.module) : suite ? [...suite.peers] : []);

    const result = {
        hostApi: apiVersion,
        hostVersion: registry.hostVersion?.() ?? '',
        storeVersion: null,
        classification: 'empty',
        domains: [],
        rulesVersion: null,
        rulesHash: null,
        peers: peerIds.map(peer => {
            const other = registry.module?.(peer) ?? null;
            return { module: peer, version: typeof other?.version === 'string' && other.version ? other.version : null, enabled: Boolean(other) && registry.lifecycle?.(peer)?.status !== 'dormant' };
        }),
        restore: registry.restore?.().state ?? 'idle',
    };
    const done = classification => Object.assign(result, { classification });

    // The chat's records, read as they are. Anything that cannot be read is damaged.
    let messages;
    let state;
    try {
        messages = chat();
        if (messages === undefined || messages === null) messages = [];
        if (!Array.isArray(messages)) return done('damaged');
        state = store.head();
    } catch {
        return done('damaged');
    }
    let version = null;
    let damaged = false;
    for (const message of messages) {
        if (!isCarrier(message)) continue;
        let record;
        try { record = message.extra?.[RECORD_KEY]; } catch { damaged = true; continue; }
        if (record === undefined) continue;
        if (!isObject(record) || !Number.isInteger(record.v) || record.v < STORE_VERSION) { damaged = true; continue; }
        version = Math.max(version ?? 0, record.v);
        if (record.v === STORE_VERSION && recordFault(message)) damaged = true;
    }
    if (state !== null && state !== undefined) {
        if (!isObject(state) || !Number.isInteger(state.v) || !isObject(state.domains)) damaged = true;
        else version = Math.max(version ?? 0, state.v);
    } else if (version === STORE_VERSION) damaged = true;   // records that did not replay into a state
    result.storeVersion = version;
    if (damaged) return done('damaged');
    if (version !== null && version > STORE_VERSION) return done('future');
    if (!state) return done('empty');

    // The module's own slices, and its rules marker: the `rules` slice's `rulesVersion` and `rulesHash` at its
    // root. Only that slice says which rules generation the data is; another slice that carries a marker is
    // read only to see whether it disagrees. A module without a `rules` domain has no marker to look for,
    // unless the caller asks for a generation.
    const has = name => Object.hasOwn(state.domains, name) && state.domains[name] !== undefined && state.domains[name] !== null;
    const present = domainNames.filter(has);
    const marked = domainNames.includes(RULES_DOMAIN) || (wanted !== undefined && wanted !== null);
    result.domains = present;
    if (!present.length) return done('empty');
    const markOf = name => {
        const slice = state.domains[name];
        if (!isObject(slice)) return undefined;
        if (!Object.hasOwn(slice, 'rulesVersion') && !Object.hasOwn(slice, 'rulesHash')) return null;
        const { rulesVersion, rulesHash = null } = slice;
        if (!(Number.isInteger(rulesVersion) && rulesVersion >= 1) || !(rulesHash === null || (typeof rulesHash === 'string' && rulesHash))) return undefined;
        return { rulesVersion, rulesHash };
    };
    const marks = new Map(present.map(name => [name, markOf(name)]));
    if ([...marks.values()].includes(undefined)) return done('damaged');
    if (!marked) return done('current');
    const rules = marks.get(RULES_DOMAIN) ?? null;   // none when the module has no such slice here
    if (!rules) return done('legacy');
    result.rulesVersion = rules.rulesVersion;
    result.rulesHash = rules.rulesHash;
    const conflict = [...marks.entries()].some(([name, mark]) => name !== RULES_DOMAIN && mark && (mark.rulesVersion !== rules.rulesVersion || (mark.rulesHash && rules.rulesHash && mark.rulesHash !== rules.rulesHash)));
    if (conflict) return done('mixed');
    if (wanted === undefined || wanted === null) return done('current');
    if (rules.rulesVersion > wanted) return done('future');
    return done(rules.rulesVersion < wanted ? 'legacy' : 'current');
}

/**
 * The public sdk. `deps`: { store, bus, registry, settings (createSettings), events
 * (createEvents), chat?: () => Message[], check?, onRegister?(def) (after each registerModule),
 * rewind?({ index, beforeRev }) (src/v2/rewind.js), substitute?(text), dialog?(screenId, opts), dialogCurrent?(), reread?(index) (turn.js),
 * callModel?(request) (model-call.js createModelCalls().callModel), timeline? (timeline/coordinator.js createTimeline: sdk.timeline,
 * savepoint.make, the participants of the modules registered) }.
 * Returns { sdk, events, markReady }:
 * `sdk.ready` resolves to the sdk once the host calls markReady().
 */
export function createSdk({ store, bus, registry, settings, events = createEvents(), chat = () => [], check = checkModule, onRegister = null, rewind = null, substitute = text => String(text ?? ''), dialog = null, dialogCurrent = null, reread = null, callModel = null, timeline = null }) {
    let markReady;
    const ready = new Promise(resolve => { markReady = () => resolve(sdk); });
    const refused = message => ({ ok: false, code: 'REFUSED', message });
    const committed = result => {
        if (result?.ok) events.emit('committed', { receipt: result.receipt });
        return result;
    };
    // The reader's action goes out with the turn's save (store.saveIdle: a moment after the last action,
    // with the reply's capture; docs/v2/PERFORMANCE.md "Long chats"): a chat opened before that save puts
    // the action into its own chat's file (the store's rescue, B-b2-timeline-1). Where that cannot be done
    // (no chat file this page can write) it is saved at once, before the result comes back. A failed save
    // is told and tried again by the store; the action itself stands.
    const saved = async result => {
        if (result?.ok && !store.saveIdle?.()) await store.saveSoon?.();
        return result;
    };
    // A module that became ready (a peer registered, a switch, the barrier dropped) is set up before the
    // reader's action runs. What is asked is the need itself (a ready module whose domain the chat lacks),
    // not whether a change was announced: a view may have announced it already. A quiet host costs a scan.
    const settle = () => {
        timeline?.settle();
        announceModules(registry, events);
        if (registry.restore?.().state === 'pending' || store.headIndex?.() < 0) return null;
        const head = store.head?.();
        return head && missingModules(registry, head).length ? ensureModules({ store, bus, registry, events }) : null;
    };
    // The reason a reader's action cannot run: its module is dormant or a restore is pending.
    const held = type => {
        const why = registry.refusal?.(type);
        return why ? { ok: false, code: why.code, message: why.message } : null;
    };
    // The participants of the modules already registered (the runtime's `modules`, the core), and of each one registered later.
    const attachParticipant = def => {
        const done = timeline?.attach(def);
        if (done && done.ok === false) console.warn(`[Story Suite] ${def?.id}'s participant was not registered: ${done.message}`);
    };
    if (timeline) {
        timelines.set(registry, timeline);
        for (const def of registry.modules()) attachParticipant(def);
    }
    const viewReader = typeof timeline?.active === 'function' ? timeline.active('view.lastUser') : null;
    const noTimeline = async () => ({ ok: false, code: 'UNSUPPORTED', message: 'This host has no timeline.' });
    const sdk = Object.freeze({
        apiVersion: 2,
        ready,
        /** Registers a module (§6); a module enabled mid-chat gets its initial state now. */
        async registerModule(def) {
            registry.register(def);
            attachParticipant(def);
            if (typeof onRegister === 'function') {
                try { onRegister(def); } catch (error) { console.warn('[Story Suite] a module was registered, but the screens could not follow', error); }
            }
            await ensureModules({ store, bus, registry, events });
            return sdk;
        },
        /**
         * Runs a command as the reader's own action (cause 'ui', SPEC §3.1). Screens, widgets, layouts
         * and modules all come through here, so nothing here can raise the cause (the host's own story
         * and system steps go to the command bus directly) or name an internal command (registry.js).
         */
        command: async (type, payload, options = {}) => {
            const cause = isObject(options) && options.cause !== undefined ? options.cause : 'ui';
            if (cause !== 'ui') return refused(`A command sent from a screen, widget or module runs as the reader's action ("ui"); "${cause}" is kept for Story Block itself.`);
            if (registry.isInternal?.(type)) return refused(`"${type}" is a step Story Block takes itself; it cannot be sent as an action.`);
            const waiting = settle();
            if (waiting) await waiting;
            // A save point waits for the participants' checkpoints, which a command handler cannot: the timeline makes it
            // (docs/v2/TIMELINE.md) and answers with the same receipt envelope.
            if (type === 'savepoint.make' && timeline) return saved(await timeline.makeCommand(payload));   // (the timeline tells the `committed` event itself)
            return held(type) ?? saved(committed(await bus.command(type, payload, { cause: 'ui' })));
        },
        preview: async (type, payload) => {
            if (registry.isInternal?.(type)) return refused(`"${type}" is a step Story Block takes itself; it cannot be sent as an action.`);
            const waiting = settle();
            if (waiting) await waiting;
            return held(type) ?? bus.preview(type, payload);
        },
        commit: async token => saved(committed(await bus.commit(token))),
        query: (name, args) => { timeline?.settle(); return runQuery(registry, store.head(), name, args, { receipts: () => store.receipts?.() ?? [], reply: headReply(store) }); },
        /** The stored receipts on the current line of history, in chat order: [{ index, receipt }]. */
        receipts: () => store.receipts?.() ?? [],
        /**
         * Return in time (MODULES §F17): a SillyTavern branch of the chat at carrier `index`, without
         * that carrier's receipts from `beforeRev` on, opened as the current chat. → Promise<{ ok, … }>.
         */
        rewind: async options => (typeof rewind === 'function' ? rewind(options) : { ok: false, code: 'FAILED', message: 'Going back in time is not available here.' }),
        /**
         * Re-read (F40): reply `index`'s <Changes> block read again from its shown swipe, replacing the
         * story changes stored on it (the reader's actions on it stay). → Promise<{ ok, receipts, problems }
         * | { ok: false, code, message }> (turn.js reread).
         */
        reread: async index => (typeof reread === 'function' ? reread(index) : { ok: false, code: 'FAILED', message: 'Re-read is not available here.' }),
        /**
         * A module's own model call (MODULES §G): `({ profile, system, prompt, maxTokens, signal, feature?,
         * module?, timeoutMs? })` → Promise<{ ok, text, error }> (error null, or a code with `message`). Never
         * posts to the chat or changes the reader's connection; never rejects.
         */
        callModel: async request => {
            if (typeof callModel !== 'function') return { ok: false, text: '', error: MODEL_CALL_ERRORS.UNAVAILABLE, message: MODEL_CALL_TEXT.unavailable };
            try {
                return await callModel(request);
            } catch {
                return { ok: false, text: '', error: MODEL_CALL_ERRORS.FAILED, message: MODEL_CALL_TEXT.unavailable };
            }
        },
        /** The view tabs and contexts get: { state, query, settings, chat }. */
        view: () => {
            announceModules(registry, events);
            return makeView({ store, registry, settings, chat: chat(), active: viewReader });
        },
        /**
         * What the chat holds for `module`, read-only and usable before it registers (docs/v2/LIFECYCLE.md):
         * `{ hostApi, hostVersion, storeVersion, classification, domains, rulesVersion, rulesHash, peers, restore }`.
         * `options`: { module, rulesVersion?, domains?, peers? }. Nothing is set up, repaired or saved.
         */
        preflight: options => preflight({ store, registry, chat, apiVersion: 2 }, options),
        on: (name, fn) => events.on(name, fn),
        /** `{{user}}` / `{{char}}` in a text → the persona's and the character's names (for tabs, screens). */
        substitute: text => substitute(text),
        /**
         * Dialogs and wizards (SPEC §13.6): `open(screenId, opts)` → the dialog handle, or null where no
         * page is shown (opts as the dialog mount's: draft, submit, random, onDone, onClose…);
         * `current()` → the topmost open dialog's handle, or null (so a module does not open a second).
         */
        dialog: Object.freeze({
            open: (screenId, opts = {}) => (typeof dialog === 'function' ? dialog(screenId, opts) : null),
            current: () => (typeof dialogCurrent === 'function' ? dialogCurrent() ?? null : null),
        }),
        /**
         * The timeline coordinator (RB_CONTRACT §8; docs/v2/TIMELINE.md): `head`, `make` (a manual save), `list`, `status`,
         * `history`, `forget` for a reader; `prepare`, `activate`, `abort`, `recover`, `nativeEvent`, `registerParticipant`
         * refuse without the host's capability, which no module is given. Every method answers `{ ok: true, … }` or
         * `{ ok: false, code, message }`, as a promise.
         */
        timeline: timeline ? timeline.api : Object.freeze(Object.fromEntries(['head', 'make', 'list', 'status', 'history', 'forget', 'registerParticipant', 'prepare', 'activate', 'abort', 'recover', 'nativeEvent', 'nativeMutation'].map(name => [name, noTimeline]))),
        id: newId,
        check: check ? Object.freeze({ ...check }) : null,
        settings: id => settings(id),
        /** Whether the reader has feature `id` on (MODULES §F100); false for an id no module declares. */
        feature: id => featureOn(registry, id),
        /** Every declared feature: [{ id, moduleId, moduleName, label, describe, default, prompt, on }]. */
        features: () => (registry.features?.() ?? []).map(feature => Object.freeze({ ...feature, on: featureOn(registry, feature.id) })),
        /**
         * [{ id, name, version, domains, commands, kinds, tabs, features, status, reason }] in id order.
         * `domains`, `commands` and `kinds` are what the module declares; it is available only while
         * `status` is 'ready' ('dormant': waiting for a peer; 'restore-pending': a restore holds it), and
         * `reason` says why when it is not (null when ready).
         */
        modules: () => registry.modules().map(def => {
            const life = registry.lifecycle?.(def.id);
            return Object.freeze({
                id: def.id,
                name: def.name ?? def.id,
                version: def.version ?? '',
                domains: Object.keys(def.domains ?? {}),
                commands: Object.keys(def.commands ?? {}),
                kinds: Object.keys(def.capture?.kinds ?? {}),
                tabs: (def.tabs ?? []).map(tab => tab.id),
                features: (def.features ?? []).map(feature => feature.id),
                status: life?.status ?? 'ready',
                reason: life?.reason ?? null,
            });
        }),
    });
    return { sdk, events, markReady };
}
