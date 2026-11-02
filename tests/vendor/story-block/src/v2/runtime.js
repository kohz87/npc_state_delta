// Story Block v2's runtime, wired once for SillyTavern (index.js) and for the testkit alike: the
// registry with the core module (scene, inventory, packs, events), settings under
// extension_settings.storySuite, the store over the chat, the command bus, the public sdk and the
// turn. No DOM: the settings overlay, the tab host and the mounts are index.js's (src/v2/ui-host.js).
//
// What the runtime adds on top of the parts:
// * the initial state of a chat with none is the registry's, with the enabled packs' start merged
//   in (SPEC §2.6; `start` hooks, packs' applyStart);
// * the chat's one currency (MODULES §F1) is the reader's name for it, else the first enabled
//   pack's suggestion, else the default (gold);
// * the events part commits through this runtime's command bus (its cues are system steps) and asks
//   through its sdk;
// * the reader's features (MODULES §F100, features.js) under extension_settings.storySuite.features: the
//   registry leaves out what is off, a change is the sdk's `feature` event, and the assist helpers get
//   their two switches from Story Block's preroll and extractor features.
// * sdk.callModel (MODULES §G, model-call.js) over the `callModel` option (the one the assist helpers
//   use), else SillyTavern's own (stModelCall): one call per module at a time, a time limit
//   (`modelTimeoutMs`), FEATURE_OFF while the calling module's feature is off. A call on the chat's
//   connection (the assist's too) is marked as our own, so the turn never takes its prompt for the
//   reply's; sdk.callModel's waits while a reply is being built or awaited (the assist's run inside the
//   turn and do not). A profile's call goes at once.

import { KEEPALIVE_MAX, createChatFile, utf8Bytes } from './chat-file.js';
import { createCommandBus as realBus } from './commands.js';
import { CORE_MODULE_ID, createCoreModule } from './domains/index.js';
import { WALLET_KEY } from './domains/money.js';
import { SETTING as ASSIST_SETTING, TIMEOUT_MS as ASSIST_TIMEOUT_MS, createAssistPart } from './assist/index.js';
import { CORE_FEATURE, createFeatureStore } from './features.js';
import { applyStart, createPacksPart } from './packs/index.js';
import { MODEL_CALL_ERRORS, createCallQueue, createModelCalls, createOwnCalls, profileName, stModelCall } from './model-call.js';
import { carryRecord } from './persist.js';
import { createRegistry } from './registry.js';
import { MAX_CHANGE_LINES, announceModules, createEvents, createSdk, createSettings, newId, runQuery } from './sdk.js';
import { displayLines } from './extras.js';
import { DEFAULT_HIDDEN } from './view/screens.js';
import { SCENE_SCREEN_ID } from './screens/scene.js';
import { createRewind } from './rewind.js';
import { createTimeline, withRuleOverlay } from './timeline/index.js';
import { createStore as realStore } from './store.js';
import { createTurn, substituteNames } from './turn.js';

export const VERSION = '2.16.0';

/**
 * Settings where Story Block's `currency` (and `currencyShort`, `currencyPlural`, `coins`) fall back to
 * `suggest()` → { name, short, plural?, coins? } | null when the reader has not set them: the reader's
 * coins win, then the pack's (only with the pack's currency: a currency the reader named keeps no pack
 * coins), then none. Same interface as createSettings().
 */
export function withPackCurrency(base, suggest) {
    const settings = id => {
        const values = base(id);
        if (id !== CORE_MODULE_ID) return values;
        const stored = base.stored(id);
        if (Object.hasOwn(stored, 'currency') && String(stored.currency ?? '').trim()) return values;
        let offer = null;
        try { offer = suggest(); } catch { offer = null; }
        if (offer && typeof offer.name === 'string' && offer.name.trim()) {
            values.currency = offer.name.trim();
            if (!Object.hasOwn(stored, 'currencyShort') || !String(stored.currencyShort ?? '').trim()) values.currencyShort = String(offer.short ?? '');
            if (!Object.hasOwn(stored, 'currencyPlural') || !String(stored.currencyPlural ?? '').trim()) values.currencyPlural = String(offer.plural ?? '');
            const ownCoins = Array.isArray(stored.coins) && stored.coins.length > 0;
            if (!ownCoins && Array.isArray(offer.coins) && offer.coins.length) values.coins = structuredClone(offer.coins);
        }
        return values;
    };
    settings.stored = base.stored;
    settings.set = base.set;
    return settings;
}

/** The initial State: the registry's, with each `start` hook's merged pack start applied. */
export function initialWithStart(registry, { id = newId } = {}) {
    let state = registry.initialState();
    for (const hook of registry.hooks('start')) {
        let start = null;
        try { start = hook(); } catch (error) {
            console.warn('[Story Suite] a pack start could not be read', error);
            continue;
        }
        if (!start || !Array.isArray(start.packs) || !start.packs.length) continue;
        try { state = applyStart(state, start, { id, coin: WALLET_KEY }); } catch (error) {
            console.warn('[Story Suite] a pack start could not be applied', error);
        }
    }
    return state;
}

/** A packs part over `ctx.extensionSettings.storySuite` (the testkit's; index.js uses the live one). */
export function packsFor(ctx, options = {}) {
    return createPacksPart({
        settings: {
            read() {
                const root = ctx.extensionSettings ?? (ctx.extensionSettings = {});
                if (!root.storySuite || typeof root.storySuite !== 'object') root.storySuite = {};
                return root.storySuite;
            },
            save: () => ctx.saveSettingsDebounced?.(),
        },
        ...options,
    });
}

/**
 * How the store saves (SPEC §3.3), for SillyTavern and the testkit alike:
 * * In SillyTavern the chat file is written directly (src/v2/chat-file.js), with the chat as it is in
 *   the same tick as the store's check that it is still the chat the change was made in; a refused
 *   save throws, so it stays unsaved, is told once and tried again. Where there is no such file (the
 *   testkit, a temporary chat) it is ctx.saveChat().
 * * A change left in a chat that is no longer open (rescue) is put into that chat's file as read back
 *   from the server: only its records, onto the same messages; nothing else in the file changes.
 * * The reader's actions are saved at once (sdk.command); the rest within 400 ms; when the page is
 *   closed with something unsaved, it is sent with keepalive, and the browser asks first if saves have
 *   been failing.
 * Returns the createStore() options for it.
 */
export function storeSaving({ ctx, live = () => ctx, fetch = null, onSaveError = null, storage = null }) {
    const context = () => {
        try { return live() ?? ctx; } catch { return ctx; }
    };
    const file = createChatFile({ context, ...(fetch ? { fetch } : {}) });
    // After a write timed out (persist.js createSaver): each later write of that chat carries a rising number
    // in its metadata (`stamp`), and this page keeps a copy of what it wrote (`kept`, by stamp, only until the
    // read-backs end) to put back when the file is found older and the chat is not the open one. Nothing is
    // stamped, kept or read without a timeout.
    let counter = 0;
    const kept = new Map();
    const seqOf = metadata => {
        const n = Number(isPlain(metadata) ? metadata[SAVE_SEQ_KEY] : NaN);
        return Number.isSafeInteger(n) ? n : 0;
    };
    function stampInto(metadata, messages) {
        counter = Math.max(counter, seqOf(metadata)) + 1;
        metadata[SAVE_SEQ_KEY] = counter;
        kept.set(counter, JSON.stringify({ metadata, messages }));
        while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value);
        return counter;
    }
    const memoKey = chatId => `${MEMO_PREFIX}${chatId}`;
    return {
        /**
         * Would a save of the open chat now go out with keepalive (a body of at most KEEPALIVE_MAX bytes as
         * UTF-8, B-a3-1)? Measured only when asked (the page is closing). True where this page does not write the file itself.
         */
        keepaliveFits() {
            if (!file.where()) return true;
            try {
                return utf8Bytes(JSON.stringify({ chat: [context().chatMetadata ?? {}, ...(ctx.chat ?? [])] })) + 256 <= KEEPALIVE_MAX;
            } catch { return false; }
        },
        chat: () => ctx.chat,
        // The chat's metadata (SillyTavern's, saved with the chat file): the store keeps the source-map archive there.
        metadata: () => context().chatMetadata ?? null,
        chatId: () => (typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId),
        place: () => file.where(),
        save: (change, { keepalive = false, signal = null, stamp: wanted = false } = {}) => {
            markUsed(context().chatMetadata, ctx.chat);
            const place = file.where();
            let metadata = context().chatMetadata;
            if (!isPlain(metadata)) metadata = {};
            const stamp = wanted ? stampInto(metadata, ctx.chat) : null;
            const out = stamp === null ? null : { stamp };
            if (!place) return Promise.resolve(ctx.saveChat()).then(() => out);
            return file.write(place, ctx.chat, metadata, { keepalive, signal }).then(() => out);
        },
        confirm: {
            /** Does the file of `change`'s chat hold the write stamped `stamp`, or a newer one? */
            async holds(change, stamp) {
                const place = change?.place ?? null;
                if (!place) return true;     // no file this page can read (ctx.saveChat saved it)
                const [header] = await file.read(place);
                return seqOf(header?.chat_metadata) >= stamp;
            },
            /**
             * Does the open chat hold the write stamped `stamp`, or a newer one (not a copy read back after the
             * late write landed)? By the newest record of the copy kept of that write, found in the open chat by
             * its `sid` with at least its `rev`; else by the number in the open chat's metadata.
             */
            fresh(stamp) {
                const copy = kept.get(stamp);
                const head = copy ? newestRecord(JSON.parse(copy).messages) : null;
                const mine = head ? (ctx.chat ?? []).map(message => message?.extra?.storySuite).find(record => isPlain(record) && record.sid === head.sid) : null;
                if (mine) return Number(mine.rev) >= Number(head.rev);
                return seqOf(context().chatMetadata) >= stamp;
            },
            /** Writes the copy kept of the write stamped `stamp` into `change`'s chat file; false when none is kept. */
            async restore(change, stamp) {
                const copy = kept.get(stamp);
                if (!copy || !change?.place) return false;
                const { metadata, messages } = JSON.parse(copy);
                await file.write(change.place, messages, metadata);
                return true;
            },
            forget: stamp => { kept.delete(stamp); },
        },
        // A1-2: a suspect chat's read-backs, kept over a reload of the page (browser storage; a missing or
        // full one only loses that convenience).
        memo: storage ? {
            get(chatId) {
                try {
                    const text = storage.getItem(memoKey(chatId));
                    return text ? JSON.parse(text) : null;
                } catch { return null; }
            },
            set(chatId, value) {
                try {
                    if (value) storage.setItem(memoKey(chatId), JSON.stringify(value));
                    else storage.removeItem(memoKey(chatId));
                } catch { /* only a convenience */ }
            },
        } : null,
        async rescue(change, entries, { stamp: wanted = false } = {}) {
            if (!entries.length) return null;
            if (!change?.place) throw new Error('this page cannot write to that chat\'s file');
            const [header, ...messages] = await file.read(change.place);
            if (!header || !messages.length) throw new Error('its chat file is no longer on the server (deleted, or renamed elsewhere)');
            let wrote = false;
            for (const { message, index } of entries) {
                const at = rescueIndex(message, messages, index);
                if (at < 0) throw new Error(`its chat file no longer holds message ${index} as it was`);
                if (holdsRecord(messages[at], message)) continue;
                if (!carryRecord(message, messages[at])) throw new Error(`its chat file no longer holds message ${index} as it was`);
                wrote = true;
            }
            if (!wrote) return null;    // the file holds every change already (SillyTavern saved it itself)
            // C4-5: the rescued file is marked as used too (markUsed), as a save of the open chat is.
            const metadata = isPlain(header.chat_metadata) ? header.chat_metadata : {};
            markUsed(metadata, messages);
            // A1-5: after a timeout of a write of this chat, the rescue is stamped as a save is.
            const stamp = wanted ? stampInto(metadata, messages) : null;
            await file.write(change.place, messages, metadata);
            return stamp === null ? null : { stamp };
        },
        onSaveError,
    };
}

// chat_metadata key of the rising save number written after a save timed out (storeSaving confirm).
export const SAVE_SEQ_KEY = 'storySuiteSave';
// Browser-storage key prefix of a suspect chat's read-backs (createSaver memo), and the copies kept at most.
export const MEMO_PREFIX = 'storySuite.saveCheck:';
const MAX_KEPT = 8;
// The record of the last carrier that has one (with a `sid`), or null.
function newestRecord(messages) {
    for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
        const record = messages[i]?.extra?.storySuite;
        if (isPlain(record) && typeof record.sid === 'string') return record;
    }
    return null;
}
// The page's localStorage, or null (none, or blocked: reading it can throw).
function pageStorage(page) {
    try { return page?.localStorage ?? null; } catch { return null; }
}
const isPlain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const sidOf = message => message?.extra?.storySuite?.sid;
// The story text before any tag (the change block, hidden or not, comes after it).
const storyText = message => String(message?.mes ?? '').split('<')[0].trimEnd();
const sameText = (a, b) => !!a && !!b && storyText(a) === storyText(b);

// C4-4: where the message a rescued change was written on is in its chat file now. The index it had
// when the record was written is a guess only (a message deleted before it shifts it, and SillyTavern
// saves the chat itself then): the message holding the same record (`sid`) comes first, then the one
// at that index with the same story text, then the only other one with it. carryRecord checks the
// swipe, the author and the date. → its index, or -1.
function rescueIndex(message, messages, index) {
    const sid = sidOf(message);
    if (typeof sid === 'string') {
        const at = messages.findIndex(other => sidOf(other) === sid);
        if (at >= 0) return at;
    }
    if (sameText(messages[index], message)) return index;
    const same = [];
    messages.forEach((other, at) => { if (sameText(other, message)) same.push(at); });
    return same.length === 1 ? same[0] : -1;
}

// The file's message already holds this record as it is (same `sid` and `rev`).
function holdsRecord(there, message) {
    const own = message?.extra?.storySuite;
    const kept = there?.extra?.storySuite;
    return isPlain(own) && isPlain(kept) && typeof own.sid === 'string' && kept.sid === own.sid && kept.rev === own.rev
        && JSON.stringify(kept.ops) === JSON.stringify(own.ops);
}

/**
 * Marks a chat holding story state as used (chat_metadata.tainted). SillyTavern treats an untainted chat
 * holding only the greeting as pristine and replaces that greeting (and the record on it) when the
 * character card is saved or the chat is renamed.
 */
export function markUsed(metadata, chat) {
    if (!metadata || typeof metadata !== 'object' || metadata.tainted) return;
    if ((chat ?? []).some(message => message?.extra?.storySuite)) metadata.tainted = true;
}

/**
 * On a page: the unsaved story goes out as early as the page lets it (see storeSaving).
 * * Hidden (`visibilitychange` to hidden: a tab switch, a phone putting the browser away) or `pagehide`:
 *   the newest state is saved at once, with keepalive, past a save still on its way. A page often goes
 *   from hidden to gone without another event, on a phone always.
 * * `beforeunload`: the same, and the browser asks first while saves fail, while one is still on its way,
 *   or when the body is too big to go out with keepalive (`fits()` false: more than 64 KiB, most real
 *   chats), since then the save is cut off with the page. SillyTavern 1.19 has no way to write part of a
 *   chat file, so a smaller keepalive request is not possible.
 */
export function saveOnUnload(store, page, { fits = () => true } = {}) {
    if (typeof page?.addEventListener !== 'function') return () => {};
    const doc = page.document ?? null;
    const urgent = (options = {}) => (store.saveUrgent ?? store.saveSoon)?.call(store, { keepalive: true, ...options });
    const onUnload = event => {
        // A1-4: a save still on its way (the server has not answered) would hold a queued one until the
        // page is gone: the newest state goes out at once past it.
        const inFlight = store.inFlight?.() === true;
        const dirty = store.dirty?.() === true;
        if (!dirty && !inFlight) return;
        if (dirty) urgent();
        let big = false;
        if (dirty) {
            try { big = fits() === false; } catch { big = true; }
        }
        if (store.failing?.() || inFlight || big) {
            event.preventDefault?.();
            event.returnValue = true;
        }
    };
    // The page may be going away (pagehide), so a save on its way is sent again with keepalive.
    const onHide = () => {
        if (store.dirty?.() === true) urgent({ force: true });
    };
    const onVisibility = () => {
        if (doc?.visibilityState === 'hidden' && store.dirty?.() === true) urgent();
    };
    page.addEventListener('beforeunload', onUnload);
    page.addEventListener('pagehide', onHide);
    doc?.addEventListener?.('visibilitychange', onVisibility);
    return () => {
        page.removeEventListener?.('beforeunload', onUnload);
        page.removeEventListener?.('pagehide', onHide);
        doc?.removeEventListener?.('visibilitychange', onVisibility);
    };
}

/**
 * createRuntime({ ctx, packs?, core = true, modules = [], createStore?, createCommandBus?, notify?,
 * onBlocked?, onSaveError?, onRegister?(def), branch?(index) (src/v2/rewind.js stBranch), callModel?(prompt, { maxTokens,
 * profile, system, signal }) → text (the assist helpers' and sdk.callModel's model call), modelTimeoutMs? (sdk.callModel's default limit),
 * live?() (SillyTavern's live getContext(); default: globalThis.SillyTavern's, else ctx), fetch?, page? (for
 * beforeunload; default: globalThis.window), timelineFaults? ({ at(phase) }, a test seam: called at every phase of a save
 * point, a restore and a native change) }) → { registry, settings, features, store, bus, events, sdk, turn,
 * markReady, initial, packs, setDialog, ownCalls, timeline }. `timeline` is the host's side of sdk.timeline
 * (src/v2/timeline/, docs/v2/TIMELINE.md): `host` (prepare, activate, abort, recover, nativeEvent, registerParticipant, with the
 * host's authority bound) and `capability`; it is never given to a module. `ownCalls` marks Story Suite's own model calls on the chat's connection (model-call.js). `features` is createFeatureStore() (the reader's choices). `ctx` is SillyTavern's context (or the testkit's fake); `packs` a
 * createPacksPart() result (default: one over ctx.extensionSettings).
 */
export function createRuntime({
    ctx, packs = null, core = true, modules = [], createStore = realStore, createCommandBus = realBus,
    notify, onBlocked = null, onSaveError = null, onRegister = null, branch = null, callModel = null, modelTimeoutMs = undefined,
    live = () => globalThis.SillyTavern?.getContext?.() ?? ctx, fetch = null, page = globalThis.window ?? null, timelineFaults = null,
} = {}) {
    let features = null;
    let events = null;
    const registry = createRegistry({ hostVersion: VERSION, featureValue: id => features?.stored(id) });
    features = createFeatureStore({
        root: () => ctx.extensionSettings,
        registry,
        save: () => ctx.saveSettingsDebounced?.(),
        onChange: change => events?.emit('feature', change),
    });
    const packPart = packs ?? packsFor(ctx);
    const base = createSettings({ root: () => ctx.extensionSettings, registry, save: () => ctx.saveSettingsDebounced?.() });
    // The chat's rule settings (a restore sets them, docs/v2/TIMELINE.md) are read in preference to the global ones.
    const settings = withRuleOverlay(withPackCurrency(base, () => packPart.startState().currency), {
        registry, state: () => { try { return store.head(); } catch { return null; } },
    });
    let sdk = null;
    let bus = null;
    let timeline = null;
    let chatterReaders = null;   // the timeline's readers of earlier messages for the Inner chatter tail line and its two queries
    let assistCall = async () => { throw new Error('Story Block is not ready.'); };
    let turn = null;
    // What a reply's display lines (Choices, Inner chatter; extras.js) show, read from its text with the
    // same cap the capture read it with (the host's maxChangeLines).
    const display = mes => {
        const cap = settings()?.maxChangeLines;
        return displayLines(mes, { entryOf: word => registry.capture(word), max: Number.isInteger(cap) && cap > 0 ? cap : MAX_CHANGE_LINES });
    };
    // Our own calls on the chat's connection (model-call.js): marked for the turn's prompt handlers.
    const ownCalls = createOwnCalls();
    const marked = base => (prompt, options = {}) => (profileName(options?.profile)
        ? base(prompt, options)
        : ownCalls.around(prompt, () => base(prompt, options)));
    if (core) {
        registry.register(createCoreModule({
            hooks: name => registry.hooks(name),
            hookEntries: name => registry.hookEntries(name),
            // A failing item.define hook goes to the Problems list (the turn is made below).
            problem: entry => turn?.report(entry),
            settings: () => settings(CORE_MODULE_ID),
            // The chatter the reader may send back to the story (its setting): the replies and how to read one.
            // The head reply's index too, for `scene.moved` (the store is made below; asked only later).
            // Whether Story Director's World screen is there (it shows the chatter; else Scene does: `scene.chatter`).
            extras: { promptChat: () => chatterReaders.prompt.messages(ctx.chat), headChat: () => chatterReaders.head.messages(ctx.chat), sceneChat: () => chatterReaders.scene.messages(ctx.chat), display, headIndex: () => store.headIndex(), proofs: () => store.proofs(), rpgOn: () => registry.featureOn(CORE_FEATURE.leanRpg), worldShown: () => registry.screens().some(screen => screen.id === DEFAULT_HIDDEN[SCENE_SCREEN_ID]) },
            version: VERSION,
            timeline: () => timeline,
            dataModules: { state: () => store.head(), lifecycle: id => registry.lifecycle(id), restore: () => registry.restore(), persona: () => { try { return (live() ?? ctx)?.name1 ?? ''; } catch { return ctx?.name1 ?? ''; } } },
            // The RPG's pre-call asks through the same queued call as Assist's helpers (assistCall, set below).
            leanRpg: { callModel: (prompt, options = {}) => assistCall(prompt, options), chat: () => ctx.chat, chatId: () => ctx.getCurrentChatId?.() ?? ctx.chatId ?? '', metadata: () => { try { return (live() ?? ctx)?.chatMetadata ?? null; } catch { return ctx?.chatMetadata ?? null; } } },
            packs: packPart,
            // Due events are the host's own system cues: straight to the bus (the public sdk only runs
            // the reader's 'ui' actions), with the same 'committed' event the sdk sends.
            command: (type, payload, options) => {
                if (!bus) return { ok: false, code: 'FAILED', message: 'Story Block is not ready.' };
                const result = bus.command(type, payload, options);
                const tell = value => {
                    if (value?.ok) events.emit('committed', { receipt: value.receipt });
                    return value;
                };
                return typeof result?.then === 'function' ? result.then(tell) : tell(result);
            },
            query: (name, args) => {
                if (!sdk) throw new Error('Story Block is not ready.');
                return sdk.query(name, args);
            },
            // The two optional helpers, off until the reader turns them on (Story Block's features).
            assist: createAssistPart({
                settings: () => ({
                    ...settings(CORE_MODULE_ID),
                    [ASSIST_SETTING.classifier]: registry.featureOn(CORE_FEATURE.preroll),
                    [ASSIST_SETTING.extractor]: registry.featureOn(CORE_FEATURE.extractor),
                }),
                grammar: () => registry.contexts().flatMap(context => context.kinds.map(kind => kind.grammar)),
                chat: () => ctx.chat,
                chatId: () => ctx.getCurrentChatId?.() ?? ctx.chatId ?? '',
                hasKind: kind => {
                    const entry = registry.capture(kind);
                    return Boolean(entry) && !entry.off;
                },
                // Through sdk.callModel's rules and its queue per connection (model-call.js), as the host's
                // own call: no wait for an idle chat (the pre-roll asks while the reply is prepared).
                callModel: (prompt, options = {}) => assistCall(prompt, options),
            }),
        }));
    }
    for (const def of modules) registry.register(def);

    // A replay that moves counts (a reply before them deleted) checks the domains it moved (B3-8).
    const validate = (state, names) => names.flatMap(name => {
        const fn = registry.validator(name);
        if (typeof fn !== 'function') return [];
        try {
            const errors = fn(state?.domains?.[name], state);
            return Array.isArray(errors) ? errors.map(String) : [];
        } catch (error) {
            return [`The ${name} check failed: ${error?.message ?? error}`];
        }
    });
    const saving = storeSaving({ ctx, live, fetch, onSaveError, storage: pageStorage(page) });
    const store = createStore({ ...saving, validate, scratch: name => registry.scratch(name) });
    saveOnUnload(store, page, { fits: saving.keepaliveFits });
    bus = createCommandBus({ store, registry, settings });
    events = createEvents();
    // The timeline (docs/v2/TIMELINE.md): save points, restores, participants. Its archive is in the open chat's metadata.
    const chatMetadata = () => {
        try { return (live() ?? ctx)?.chatMetadata ?? null; } catch { return ctx?.chatMetadata ?? null; }
    };
    timeline = createTimeline({
        store, registry, metadata: chatMetadata, chat: () => ctx.chat, settings: id => settings(id), faults: timelineFaults,
        // a message a restore hid or showed again is drawn again; a message that could not be hidden is a Problem
        redraw: (index, message) => { try { ctx.updateMessageBlock?.(index, message); } catch { /* drawn from the saved chat later */ } },
        problem: entry => turn?.report(entry),
        query: (name, args, state) => runQuery(registry, state, name, args),
        barrier: (state, reason) => {
            registry.setRestore(state, reason);
            announceModules(registry, events);
        },
        announce: receipt => events.emit('committed', { receipt }),
    });
    chatterReaders = { prompt: timeline.active('prompt.chatter'), head: timeline.active('query.chatter.head'), scene: timeline.active('query.scene.chatter') };
    const rewind = createRewind({ ctx, store, events, ...(branch ? { branch } : {}) });
    let dialogOpener = null;
    let dialogCurrent = null;
    // One model call at a time per connection (the host setting `callQueue`, default on; MODULES §G).
    const callQueue = createCallQueue({ enabled: () => settings()?.callQueue !== false });
    const modelCalls = createModelCalls({
        queue: callQueue,
        call: marked(callModel ?? stModelCall),
        gate: { whenIdle: () => turn?.whenIdle?.() ?? Promise.resolve() },
        featureOn: id => registry.featureOn(id),
        featureModule: id => (registry.features?.() ?? []).find(feature => feature?.id === id)?.moduleId ?? null,
        ...(modelTimeoutMs !== undefined ? { timeoutMs: modelTimeoutMs } : {}),
    });
    // The assist helpers' call (assist/index.js: (prompt, { maxTokens, profile, helper }) → text, throwing
    // with a code on failure; an empty answer is '' as before).
    assistCall = async (prompt, { maxTokens, profile = '', helper = 'pre-roll' } = {}) => {
        const result = await modelCalls.callModel({ prompt, maxTokens, profile, module: `${CORE_MODULE_ID} (${helper === 'extractor' ? 'safety net' : helper === 'rolls' ? 'rolls' : 'pre-roll'})`, timeoutMs: ASSIST_TIMEOUT_MS }, { idle: false });
        if (result.ok) return result.text;
        if (result.error === MODEL_CALL_ERRORS.EMPTY) return '';
        throw Object.assign(new Error(result.message), { code: result.error });
    };
    const made = createSdk({ store, bus, registry, settings, events, chat: () => ctx.chat, onRegister: def => onRegister?.(def), rewind,
        substitute: text => substituteNames(text, ctx), dialog: (screenId, opts) => dialogOpener?.(screenId, opts) ?? null,
        dialogCurrent: () => dialogCurrent?.() ?? null, reread: index => turn?.reread(index), callModel: modelCalls.callModel, timeline });
    sdk = made.sdk;
    const initial = () => initialWithStart(registry);
    turn = createTurn({ ctx, live, store, bus, timeline, registry, settings, events, onBlocked, initial, ownPrompt: eventData => ownCalls.owns(eventData), ...(notify ? { notify } : {}) });
    // The UI (ui-host.js) plugs its dialog mount in here, for sdk.dialog.open (and .current).
    const setDialog = (fn, current = null) => {
        dialogOpener = typeof fn === 'function' ? fn : null;
        dialogCurrent = typeof current === 'function' ? current : null;
    };
    return { registry, settings, features, store, bus, events, sdk, turn, markReady: made.markReady, initial, packs: packPart, setDialog, display, ownCalls, callQueue, timeline };
}
