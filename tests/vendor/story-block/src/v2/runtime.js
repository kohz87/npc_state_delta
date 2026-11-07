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

import { createCommandBus as realBus } from './commands.js';
import { CORE_MODULE_ID, createCoreModule } from './domains/index.js';
import { SETTING as ASSIST_SETTING, TIMEOUT_MS as ASSIST_TIMEOUT_MS, createAssistPart } from './assist/index.js';
import { CORE_FEATURE, GEAR_FEATURE, createFeatureStore } from './features.js';
import { createCardSettings } from './packs/card-settings.js';
import { XP_RATE_SETTING, xpRateFrom, xpRateOf } from './lean-rpg/levels.js';
import { MODEL_CALL_ERRORS, createCallQueue, createModelCalls, createOwnCalls, profileName, stModelCall } from './model-call.js';
import { readRecord } from './persist.js';
import { createRegistry } from './registry.js';
import { MAX_CHANGE_LINES, announceModules, createEvents, createSdk, createSettings, runQuery } from './sdk.js';
import { displayLines } from './extras.js';
import { DEFAULT_HIDDEN } from './view/screens.js';
import { SCENE_SCREEN_ID } from './screens/scene.js';
import { createRewind } from './rewind.js';
import { createTimeline, withRuleOverlay } from './timeline/index.js';
import { createStore as realStore } from './store.js';
import { createTurn, substituteNames } from './turn.js';
import { createRpgLoader } from './rpg-lazy.js';
import { createPublicApi } from './public-api.js';
import { createPublicPaths } from './public-paths.js';
import { initialWithStart, packsFor, withPackCurrency } from './runtime/start.js';
import { pageStorage, saveOnUnload, storeSaving } from './runtime/saving.js';
export { initialWithStart, packsFor, withPackCurrency } from './runtime/start.js';
export { SAVE_SEQ_KEY, MEMO_PREFIX, markUsed, saveOnUnload, storeSaving } from './runtime/saving.js';

export const VERSION = '2.23.0';

/**
 * createRuntime({ ctx, packs?, core = true, modules = [], createStore?, createCommandBus?, notify?,
 * onBlocked?, onSaveError?, onRegister?(def), branch?(index) (src/v2/rewind.js stBranch), callModel?(prompt, { maxTokens,
 * profile, system, signal }) → text (the assist helpers' and sdk.callModel's model call), modelTimeoutMs? (sdk.callModel's default limit),
 * live?() (SillyTavern's live getContext(); default: globalThis.SillyTavern's, else ctx), fetch?, page? (for
 * beforeunload; default: globalThis.window), timelineFaults? ({ at(phase) }, a test seam: called at every phase of a save
 * point, a restore and a native change), rpgLoad?() → the RPG's library (default: import('./lean-rpg/index.js'); the code is fetched only when the
 * feature is on or the chat holds the RPG's records, rpg-lazy.js) }) → { registry, settings, features, store, bus, events, sdk, turn,
 * markReady, initial, packs, setDialog, ownCalls, timeline }. `timeline` is the host's side of sdk.timeline
 * (src/v2/timeline/, docs/v2/TIMELINE.md): `host` (prepare, activate, abort, recover, nativeEvent, registerParticipant, with the
 * host's authority bound) and `capability`; it is never given to a module. `ownCalls` marks Story Suite's own model calls on the chat's connection (model-call.js). `features` is createFeatureStore() (the reader's choices). `ctx` is SillyTavern's context (or the testkit's fake); `packs` a
 * createPacksPart() result (default: one over ctx.extensionSettings).
 */
export function createRuntime({
    ctx, packs = null, core = true, modules = [], createStore = realStore, createCommandBus = realBus,
    notify, onBlocked = null, onSaveError = null, onRegister = null, branch = null, callModel = null, modelTimeoutMs = undefined,
    live = () => globalThis.SillyTavern?.getContext?.() ?? ctx, fetch = null, page = globalThis.window ?? null, timelineFaults = null, rpgLoad = undefined,
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
    // The settings a card may recommend (packs/card-settings.js); Story Block's own are registered below, the others' through sdk.registerCardSettings.
    const cardSettings = createCardSettings();
    let sdk = null;
    let bus = null;
    let timeline = null;
    // The reader's messages on the line of history (the timeline's `view.lastUser` reader leaves out the faded ones): the starting kit is open at 0.
    const readersOf = () => {
        const list = Array.isArray(ctx.chat) ? ctx.chat : null;
        if (!list) return null;
        const seen = typeof timeline?.active === 'function' ? timeline.active('view.lastUser').messages(list) : list;
        return seen.filter(message => message?.is_user).length;
    };
    // Whether the line of history is still just the opening greetings: at least one message, none from the reader and none that carries a Story Block reply record (null: not known).
    // A narrator or member that spoke on its own, or a reply, ends it, so deleting only the reader's messages does not reopen the starting kit; a group chat's several greetings do not.
    const greetingOnlyOf = () => {
        const list = Array.isArray(ctx.chat) ? ctx.chat : null;
        if (!list) return null;
        const seen = typeof timeline?.active === 'function' ? timeline.active('view.lastUser').messages(list) : list;
        return seen.length > 0 && seen.every(message => {
            if (!message || message.is_user) return false;
            // A captured reply carries `reply: true` (turn.js); a record from before the mark (no `mv`) other than the head greeting's is taken for a reply, so old chats stay closed.
            // A record with `mv` and no mark is the reader's own edits on a greeting (the kit's adds), and stays a greeting.
            const record = readRecord(message);
            if (!record) return true;
            if (record.reply === true) return false;
            // (whatever the mark: a story block or a receipt of the story is a reply's)
            if ((record.spans ?? []).some(span => span?.story !== false) || (record.receipts ?? []).some(receipt => receipt?.cause !== 'ui')) return false;
            return record.mv === 1 || (record.checkpoint !== undefined && message === seen[0]);
        });
    };
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
            extras: { promptChat: () => chatterReaders.prompt.messages(ctx.chat), headChat: () => chatterReaders.head.messages(ctx.chat), sceneChat: () => chatterReaders.scene.messages(ctx.chat), display, headIndex: () => store.headIndex(), proofs: () => store.proofs(), readers: () => readersOf(), greetingOnly: () => greetingOnlyOf(), chatEmpty: () => Array.isArray(ctx.chat) && ctx.chat.length === 0, rpgOn: () => registry.featureOn(CORE_FEATURE.leanRpg), gearOn: () => registry.featureOn('story-block.gear') && registry.featureOn(CORE_FEATURE.leanRpg), persona: () => { try { return (live() ?? ctx)?.name1 ?? ''; } catch { return ctx?.name1 ?? ''; } }, worldShown: () => registry.screens().some(screen => screen.id === DEFAULT_HIDDEN[SCENE_SCREEN_ID]) },
            version: VERSION,
            timeline: () => timeline,
            dataModules: { state: () => store.head(), lifecycle: id => registry.lifecycle(id), restore: () => registry.restore(), boardOn: () => registry.featureOn(CORE_FEATURE.leanRpg) && registry.featureOn(CORE_FEATURE.fightBoard), persona: () => { try { return (live() ?? ctx)?.name1 ?? ''; } catch { return ctx?.name1 ?? ''; } } },
            // The RPG's pre-call asks through the same queued call as Assist's helpers (assistCall, set below).
            leanRpg: { callModel: (prompt, options = {}) => assistCall(prompt, options), chat: () => ctx.chat, chatId: () => ctx.getCurrentChatId?.() ?? ctx.chatId ?? '', metadata: () => { try { return (live() ?? ctx)?.chatMetadata ?? null; } catch { return ctx?.chatMetadata ?? null; } }, onPlanning: working => events?.emit('head', { index: store.headIndex(), reason: working ? 'fight-start' : 'fight-start-done' }) },
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
                grammar: () => registry.contexts().flatMap(context => context.kinds.map(kind => kind.grammar)).filter(Boolean),
                // The scene's place, the map's places (the atlas's when Story Director is on, else the packs') and the story's date and
                // time, for the safety net (assist/where.js). A query that is not there or throws is none of it.
                where: () => {
                    const ask = (name, args) => { try { return sdk?.query(name, args); } catch { return null; } };
                    const clock = ask('director.time', {});
                    return { here: ask('scene.place', {}), places: [...(ask('atlas.places', {}) ?? []), ...(ask('packs.content', { kind: 'places' }) ?? [])],
                        time: typeof clock?.text === 'string' ? clock.text : '' };
                },
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
    const store = createStore({ ...saving, validate, scratch: name => registry.scratch(name), replayEnv: () => registry.features().map(feature => `${feature.id}${registry.featureOn(feature.id) ? '+' : '-'}`).join(','), marked: () => { try { return registry.featureOn('story-block.gear') && registry.featureOn(CORE_FEATURE.leanRpg); } catch { return false; } } });
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
    assistCall = async (prompt, { maxTokens, profile = '', helper = 'pre-roll', timeoutMs } = {}) => {
        const result = await modelCalls.callModel({ prompt, maxTokens, profile, module: `${CORE_MODULE_ID} (${helper === 'extractor' ? 'safety net' : helper === 'rolls' ? 'rolls' : 'pre-roll'})`, timeoutMs: helper === 'rolls' && Number.isFinite(timeoutMs) ? timeoutMs : ASSIST_TIMEOUT_MS }, { idle: false });
        if (result.ok) return result.text;
        if (result.error === MODEL_CALL_ERRORS.EMPTY) return '';
        throw Object.assign(new Error(result.message), { code: result.error });
    };
    const publicPaths = createPublicPaths();   // the paths modules offer to the public API (sdk.registerPublicPaths)
    const made = createSdk({ publicPaths, store, bus, registry, settings, events, chat: () => ctx.chat, onRegister: def => onRegister?.(def), rewind,
        substitute: text => substituteNames(text, ctx), dialog: (screenId, opts) => dialogOpener?.(screenId, opts) ?? null,
        dialogCurrent: () => dialogCurrent?.() ?? null, reread: index => turn?.reread(index), callModel: modelCalls.callModel, timeline, seed: () => turn?.seed(), cardSettings });
    sdk = made.sdk;
    registerOwnCardSettings();
    // Story Block's own owner of card settings: the RPG, Gear in fights and the XP rate. Applying persists exactly as Settings → RPG does
    // (the feature store's set, the settings' set).
    function registerOwnCardSettings() {
        const onOff = value => (value ? 'on' : 'off');
        cardSettings.registerOwn({
            owner: CORE_MODULE_ID,
            label: 'Story Block',
            keys: {
                rpg: { label: 'RPG', valueText: onOff, valid: value => typeof value === 'boolean' },
                gear: { label: 'Gear', valueText: onOff, valid: value => typeof value === 'boolean' },
                rpgXpRate: { label: 'XP rate', valueText: value => `${value}%`, valid: value => xpRateOf(value) !== null },
            },
            read: key => (key === 'rpg' ? registry.featureOn(CORE_FEATURE.leanRpg) === true
                : key === 'gear' ? registry.featureOn(GEAR_FEATURE) === true
                    : xpRateFrom(settings(CORE_MODULE_ID) ?? {})),
            apply: async values => {
                const applied = [];
                for (const [key, value] of Object.entries(values)) {
                    if (key === 'rpg' || key === 'gear') {
                        if (features.set(key === 'rpg' ? CORE_FEATURE.leanRpg : GEAR_FEATURE, value) !== undefined) applied.push(key);
                    } else if (key === 'rpgXpRate' && xpRateOf(value) !== null) {
                        if (settings.set(CORE_MODULE_ID, XP_RATE_SETTING, value) !== undefined) applied.push(key);
                    }
                }
                return { applied };
            },
        });
    }
    const initial = () => initialWithStart(registry);
    // The RPG's code comes in before a chat that needs it is read (the turn awaits `prepare`), and the moment the reader switches the feature on.
    const rpgLoader = createRpgLoader({
        ...(rpgLoad ? { load: rpgLoad } : {}),
        featureOn: () => registry.featureOn(CORE_FEATURE.leanRpg), chat: () => ctx.chat, metadata: chatMetadata, problem: entry => turn?.report(entry),
    });
    events.on('feature', () => { rpgLoader.ensure({ scan: false }); });
    turn = createTurn({ ctx, live, store, bus, timeline, registry, settings, events, onBlocked, initial, prepare: options => rpgLoader.ensure(options), ownPrompt: eventData => ownCalls.owns(eventData), ...(notify ? { notify } : {}) });
    // The public API (public-api.js, docs/v2/PUBLIC-API.md): the head state read through the queries and readers that exist, events after the store has written.
    const apiPersona = () => { try { return String((live() ?? ctx)?.name1 ?? ''); } catch { return String(ctx?.name1 ?? ''); } };
    const api = createPublicApi({
        version: VERSION,
        hostReady: made.sdk.ready,
        state: () => store.head(),
        before: index => { try { return store.before?.(index) ?? null; } catch { return null; } },
        ask: (state, name, args) => runQuery(registry, state, name, args, { receipts: () => store.receipts?.() ?? [] }),
        rpgOn: () => registry.featureOn(CORE_FEATURE.leanRpg),
        persona: apiPersona,
        events,
        publicPaths,
        latestIndex: () => { try { return Math.max(0, (ctx.chat?.length ?? 1) - 1); } catch { return 0; } },
        chatId: () => (typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId) ?? '',
        // A reply's state is written before its events go out (a reply's idle save is brought forward only while a listener waits for it).
        saved: async () => { try { if (store.dirty?.() === true) await store.saveSoon?.(); } catch { /* a failed save is told and tried again by the store */ } },
    });
    // The UI (ui-host.js) plugs its dialog mount in here, for sdk.dialog.open (and .current).
    const setDialog = (fn, current = null) => {
        dialogOpener = typeof fn === 'function' ? fn : null;
        dialogCurrent = typeof current === 'function' ? current : null;
    };
    return { registry, settings, features, store, bus, events, sdk, api, turn, rpgLoader, markReady: made.markReady, initial, packs: packPart, cardSettings, setDialog, display, ownCalls, callQueue, timeline };
}
