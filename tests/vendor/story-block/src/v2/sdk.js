// The public sdk (docs/v2/SPEC.md §3.1, §6): what modules get from `await StoryBlock.ready`.
// Built from the store, the command bus and the registry; it adds the parts they share: events,
// settings under extension_settings.storySuite, the view modules read, ids, and adding a late
// module's initial state. No SillyTavern import (turn.js wires SillyTavern).

import { INIT_PREFIX, normalizeField } from './registry.js';
import { headReply } from './commands.js';
import { cutAt } from '../text.js';
import { MODEL_CALL_ERRORS, MODEL_CALL_TEXT, profileName } from './model-call.js';

// sdk.check comes from check.js (SB-commands); the sdk still loads without it.
const checkModule = await import('./check.js').catch(() => null);

// `feature` ({ id, on, prompt }) fires when the reader turns a feature on or off (MODULES §F100).
export const EVENTS = Object.freeze(['committed', 'head', 'turn', 'feature']);
// The most change lines one reply's block may hold; the rest are one Problem (turn.js).
export const MAX_CHANGE_LINES = 150;
export const HOST_SETTINGS_DEFAULTS = Object.freeze({ tailBudget: 1500, contextShare: 40, maxChangeLines: MAX_CHANGE_LINES });
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
 * tools.receipts() → [{ index, receipt }], the stored receipts in chat order (`receipts` option), and
 * tools.reply ({ index, sid } or null, the `reply` option): the reply the state is the head of, as a
 * command's ctx.reply (commands.js).
 */
export function runQuery(registry, state, name, args, { receipts = () => [], reply = null } = {}) {
    const query = registry.query(name);
    if (!query) throw new Error(`Story Suite: no module answers the query "${name}".`);
    const tools = Object.freeze({
        reply,
        query: (other, otherArgs) => runQuery(registry, state, other, otherArgs, { receipts, reply }),
        receipts: () => receipts() ?? [],
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
export function makeView({ store, registry, settings, chat = [], state = store.head(), reply = headReply(store) }) {
    const messages = Array.isArray(chat) ? chat : [];
    const lastUser = [...messages].reverse().find(message => message?.is_user);
    return Object.freeze({
        state,
        query: (name, args) => runQuery(registry, state, name, args, { receipts: () => store.receipts?.() ?? [], reply }),
        settings,
        feature: id => featureOn(registry, id),
        chat: Object.freeze({ length: messages.length, lastUser: String(lastUser?.mes ?? '') }),
    });
}

/** Whether feature `id` is on (registry.featureOn); false for an unknown id or a registry without features. */
export const featureOn = (registry, id) => typeof registry?.featureOn === 'function' && registry.featureOn(id) === true;

/**
 * The registered modules whose domains the head state lacks (enabled after the chat began, or a
 * newer version with a domain more): [{ def, missing: [domain names] }], in module-id order.
 */
export function missingModules(registry, state) {
    const domains = state?.domains ?? {};
    return registry.modules()
        .map(def => ({ def, missing: Object.keys(def.domains ?? {}).filter(name => !Object.hasOwn(domains, name)) }))
        .filter(entry => entry.missing.length);
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

/**
 * The public sdk. `deps`: { store, bus, registry, settings (createSettings), events
 * (createEvents), chat?: () => Message[], check?, onRegister?(def) (after each registerModule),
 * rewind?({ index, beforeRev }) (src/v2/rewind.js), substitute?(text), dialog?(screenId, opts), dialogCurrent?(), reread?(index) (turn.js),
 * callModel?(request) (model-call.js createModelCalls().callModel) }.
 * Returns { sdk, events, markReady }:
 * `sdk.ready` resolves to the sdk once the host calls markReady().
 */
export function createSdk({ store, bus, registry, settings, events = createEvents(), chat = () => [], check = checkModule, onRegister = null, rewind = null, substitute = text => String(text ?? ''), dialog = null, dialogCurrent = null, reread = null, callModel = null }) {
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
    const sdk = Object.freeze({
        apiVersion: 2,
        ready,
        /** Registers a module (§6); a module enabled mid-chat gets its initial state now. */
        async registerModule(def) {
            registry.register(def);
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
            return saved(committed(await bus.command(type, payload, { cause: 'ui' })));
        },
        preview: async (type, payload) => (registry.isInternal?.(type)
            ? refused(`"${type}" is a step Story Block takes itself; it cannot be sent as an action.`)
            : bus.preview(type, payload)),
        commit: async token => saved(committed(await bus.commit(token))),
        query: (name, args) => runQuery(registry, store.head(), name, args, { receipts: () => store.receipts?.() ?? [], reply: headReply(store) }),
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
        view: () => makeView({ store, registry, settings, chat: chat() }),
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
        id: newId,
        check: check ? Object.freeze({ ...check }) : null,
        settings: id => settings(id),
        /** Whether the reader has feature `id` on (MODULES §F100); false for an id no module declares. */
        feature: id => featureOn(registry, id),
        /** Every declared feature: [{ id, moduleId, moduleName, label, describe, default, prompt, on }]. */
        features: () => (registry.features?.() ?? []).map(feature => Object.freeze({ ...feature, on: featureOn(registry, feature.id) })),
        /** [{ id, name, version, domains, commands, kinds, tabs, features }] in id order. */
        modules: () => registry.modules().map(def => Object.freeze({
            id: def.id,
            name: def.name ?? def.id,
            version: def.version ?? '',
            domains: Object.keys(def.domains ?? {}),
            commands: Object.keys(def.commands ?? {}),
            kinds: Object.keys(def.capture?.kinds ?? {}),
            tabs: (def.tabs ?? []).map(tab => tab.id),
            features: (def.features ?? []).map(feature => feature.id),
        })),
    });
    return { sdk, events, markReady };
}
