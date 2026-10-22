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

import { createChatFile } from './chat-file.js';
import { createCommandBus as realBus } from './commands.js';
import { CORE_MODULE_ID, createCoreModule } from './domains/index.js';
import { WALLET_KEY } from './domains/money.js';
import { SETTING as ASSIST_SETTING, createAssistPart } from './assist/index.js';
import { CORE_FEATURE, createFeatureStore } from './features.js';
import { applyStart, createPacksPart } from './packs/index.js';
import { carryRecord } from './persist.js';
import { createRegistry } from './registry.js';
import { createEvents, createSdk, createSettings, newId } from './sdk.js';
import { createRewind } from './rewind.js';
import { createStore as realStore } from './store.js';
import { createTurn, substituteNames } from './turn.js';

export const VERSION = '2.0.0-alpha.2';

/**
 * Settings where Story Block's `currency` (and `currencyShort`, `currencyPlural`) fall back to
 * `suggest()` → { name, short, plural? } | null when the reader has not set them. Same interface as createSettings().
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
export function storeSaving({ ctx, live = () => ctx, fetch = null, onSaveError = null }) {
    const context = () => {
        try { return live() ?? ctx; } catch { return ctx; }
    };
    const file = createChatFile({ context, ...(fetch ? { fetch } : {}) });
    return {
        chat: () => ctx.chat,
        chatId: () => (typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId),
        place: () => file.where(),
        save: (change, { keepalive = false } = {}) => {
            markUsed(context().chatMetadata, ctx.chat);
            const place = file.where();
            if (!place) return ctx.saveChat();
            return file.write(place, ctx.chat, context().chatMetadata ?? {}, { keepalive });
        },
        async rescue(change, entries) {
            if (!entries.length) return;
            if (!change?.place) throw new Error('this page cannot write to that chat\'s file');
            const [header, ...messages] = await file.read(change.place);
            if (!header || !messages.length) throw new Error('its chat file is no longer on the server (deleted, or renamed elsewhere)');
            for (const { message, index } of entries) {
                if (!carryRecord(message, messages[index])) throw new Error(`its chat file no longer holds message ${index} as it was`);
            }
            await file.write(change.place, messages, header.chat_metadata ?? {});
        },
        onSaveError,
    };
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

/** On a page: the unsaved story goes out when the page is closed (keepalive); see storeSaving. */
export function saveOnUnload(store, page) {
    if (typeof page?.addEventListener !== 'function') return () => {};
    const onUnload = event => {
        if (!store.dirty?.()) return;
        store.saveSoon?.({ keepalive: true });
        if (store.failing?.()) {
            event.preventDefault?.();
            event.returnValue = true;
        }
    };
    page.addEventListener('beforeunload', onUnload);
    return () => page.removeEventListener?.('beforeunload', onUnload);
}

/**
 * createRuntime({ ctx, packs?, core = true, modules = [], createStore?, createCommandBus?, notify?,
 * onBlocked?, onSaveError?, onRegister?(def), branch?(index) (src/v2/rewind.js stBranch), callModel? (assist),
 * live?() (SillyTavern's live getContext(); default: globalThis.SillyTavern's, else ctx), fetch?, page? (for
 * beforeunload; default: globalThis.window) }) → { registry, settings, features, store, bus, events, sdk, turn,
 * markReady, initial, packs, setDialog }. `features` is createFeatureStore() (the reader's choices). `ctx` is SillyTavern's context (or the testkit's fake); `packs` a
 * createPacksPart() result (default: one over ctx.extensionSettings).
 */
export function createRuntime({
    ctx, packs = null, core = true, modules = [], createStore = realStore, createCommandBus = realBus,
    notify, onBlocked = null, onSaveError = null, onRegister = null, branch = null, callModel = null,
    live = () => globalThis.SillyTavern?.getContext?.() ?? ctx, fetch = null, page = globalThis.window ?? null,
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
    const settings = withPackCurrency(base, () => packPart.startState().currency);
    let sdk = null;
    let bus = null;
    let turn = null;
    if (core) {
        registry.register(createCoreModule({
            hooks: name => registry.hooks(name),
            hookEntries: name => registry.hookEntries(name),
            // A failing item.define hook goes to the Problems list (the turn is made below).
            problem: entry => turn?.report(entry),
            settings: () => settings(CORE_MODULE_ID),
            version: VERSION,
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
                ...(callModel ? { callModel } : {}),
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
    const store = createStore({ ...storeSaving({ ctx, live, fetch, onSaveError }), validate, scratch: name => registry.scratch(name) });
    saveOnUnload(store, page);
    bus = createCommandBus({ store, registry, settings });
    events = createEvents();
    const rewind = createRewind({ ctx, store, events, ...(branch ? { branch } : {}) });
    let dialogOpener = null;
    const made = createSdk({ store, bus, registry, settings, events, chat: () => ctx.chat, onRegister: def => onRegister?.(def), rewind,
        substitute: text => substituteNames(text, ctx), dialog: (screenId, opts) => dialogOpener?.(screenId, opts) ?? null,
        reread: index => turn?.reread(index) });
    sdk = made.sdk;
    const initial = () => initialWithStart(registry);
    turn = createTurn({ ctx, store, bus, registry, settings, events, onBlocked, initial, ...(notify ? { notify } : {}) });
    // The UI (ui-host.js) plugs its dialog mount in here, for sdk.dialog.open.
    const setDialog = fn => { dialogOpener = typeof fn === 'function' ? fn : null; };
    return { registry, settings, features, store, bus, events, sdk, turn, markReady: made.markReady, initial, packs: packPart, setDialog };
}
