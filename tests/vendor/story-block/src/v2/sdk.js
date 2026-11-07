// The public sdk (docs/v2/SPEC.md §3.1, §6): what modules get from `await StoryBlock.ready`.
// Built from the store, the command bus and the registry; it adds the parts they share: events,
// settings under extension_settings.storySuite, the view modules read, ids, and adding a late
// module's initial state. No SillyTavern import (turn.js wires SillyTavern).
//
// The parts live under src/v2/sdk/: constants, settings, ids, events, queries and lifecycle. This file
// keeps its path, builds the sdk, and re-exports every public name.

import { INIT_PREFIX, normalizeField } from './registry.js';
import { headReply, replyAt } from './commands.js';
import { KEY as RECORD_KEY, isCarrier, recordFault } from './persist.js';
import { cutAt } from '../text.js';
import { MODEL_CALL_ERRORS, MODEL_CALL_TEXT, profileName } from './model-call.js';
import { RESOLVE as RPG_RESOLVE } from './lean-rpg/names.js';
import { receiptCue, entriesWithCue } from './lean-rpg/cue.js';
import { createPublicPaths } from './public-paths.js';

import { createCardSettings } from './packs/card-settings.js';

import { isObject } from './sdk/shared.js';
import { createEvents } from './sdk/events.js';
import { newId } from './sdk/ids.js';
import { featureOn, makeView, missingModules, runQuery, withCue } from './sdk/queries.js';
import { announceModules, ensureModules, preflight, rememberTimeline } from './sdk/lifecycle.js';

// sdk.check comes from check.js (SB-commands); the sdk still loads without it.
const checkModule = await import('./check.js').catch(() => null);

export { EVENTS, MAX_CHANGE_LINES, HOST_SETTINGS_DEFAULTS, HOST_SETTINGS_SCHEMA, SETTING_TEXT_MAX, SETTING_LIST_ROWS, PREFLIGHT_CLASSES } from './sdk/constants.js';
export { settingValue, createSettings } from './sdk/settings.js';
export { newId } from './sdk/ids.js';
export { createEvents } from './sdk/events.js';
export { runQuery, mountQuery, makeView, featureOn, missingModules } from './sdk/queries.js';
export { announceModules, ensureModules, preflight } from './sdk/lifecycle.js';

/**
 * The public sdk. `deps`: { store, bus, registry, settings (createSettings), events
 * (createEvents), chat?: () => Message[], check?, onRegister?(def) (after each registerModule),
 * rewind?({ index, beforeRev }) (src/v2/rewind.js), substitute?(text), dialog?(screenId, opts), dialogCurrent?(), reread?(index) (turn.js),
 * callModel?(request) (model-call.js createModelCalls().callModel), timeline? (timeline/coordinator.js createTimeline: sdk.timeline,
 * savepoint.make, the participants of the modules registered) }.
 * Returns { sdk, events, markReady }:
 * `sdk.ready` resolves to the sdk once the host calls markReady().
 */
export function createSdk({ store, bus, registry, settings, events = createEvents(), chat = () => [], check = checkModule, onRegister = null, rewind = null, substitute = text => String(text ?? ''), dialog = null, dialogCurrent = null, reread = null, callModel = null, timeline = null, seed = null, cardSettings = createCardSettings(), publicPaths = createPublicPaths() }) {
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
    // `background` (a module's own step after the reply, e.g. a forward of what its scan found, no reader waits
    // for it): within the late phase it joins one late window (store.saveLate) instead of saving 1.5 s later.
    const saved = async (result, background = false) => {
        if (result?.ok && !(background && typeof store.saveLate === 'function' ? store.saveLate() : store.saveIdle?.())) await store.saveSoon?.();
        return result;
    };
    // A module that became ready (a peer registered, a switch, the barrier dropped) is set up before the
    // reader's action runs. What is asked is the need itself (a ready module whose domain the chat lacks),
    // not whether a change was announced: a view may have announced it already. A quiet host costs a scan.
    const settle = () => {
        timeline?.settle();
        // A chat with a message but no state yet (Story Block has not heard of the chat, turn.seed): the state starts first.
        if (typeof seed === 'function' && !store.head?.()) {
            try { seed(); } catch (error) { console.warn('[Story Suite] the chat\'s state could not be started', error); }
        }
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
        rememberTimeline(registry, timeline);
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
            return held(type) ?? saved(committed(await bus.command(type, payload, { cause: 'ui' })), isObject(options) && options.background === true);
        },
        preview: async (type, payload) => {
            if (registry.isInternal?.(type)) return refused(`"${type}" is a step Story Block takes itself; it cannot be sent as an action.`);
            const waiting = settle();
            if (waiting) await waiting;
            return held(type) ?? bus.preview(type, payload);
        },
        commit: async token => saved(committed(await bus.commit(token))),
        // `{ asOf: index }` in args is read-only history: the answer is Story Block's state after that reply (store.at), with only the receipts
        // up to it and that reply as `tools.reply`; the head, the chat and the saves are not touched. Without it the head answers as before.
        query: (name, args) => {
            timeline?.settle();
            if (isObject(args) && Object.hasOwn(args, 'asOf')) {
                const { asOf, ...rest } = args;
                if (!Number.isInteger(asOf) || asOf < 0) throw new RangeError('asOf must be a reply index (a whole number, 0 or more).');
                const state = store.at(asOf);
                const upTo = () => (store.receipts?.() ?? []).filter(item => item.index <= asOf);
                return runQuery(registry, state, name, rest, { receipts: upTo, reply: replyAt(store, asOf) });
            }
            return runQuery(registry, store.head(), name, args, { receipts: () => store.receipts?.() ?? [], reply: headReply(store) });
        },
        /** The stored receipts on the current line of history, in chat order: [{ index, receipt }]. */
        receipts: () => withCue(store.receipts?.() ?? []),
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
        /**
         * Public paths from a module (docs/v2/PUBLIC-API.md "Paths from modules"): `({ owner, prefix, paths() → [path], get(path) → value,
         * hidden(path) → bool, values()? → { path: value } })` → `unregister()` (call `unregister.changed()` when the values moved). One owner per prefix; the prefix may not
         * be scene, money, items, party or blocks. Throws on a bad registration.
         */
        registerPublicPaths: options => publicPaths.register(options),
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
         * The timeline coordinator (docs/v2/TIMELINE.md): `head`, `make` (a manual save), `list`, `status`,
         * `history`, `forget` for a reader; `prepare`, `activate`, `abort`, `recover`, `nativeEvent`, `registerParticipant`
         * refuse without the host's capability, which no module is given. Every method answers `{ ok: true, … }` or
         * `{ ok: false, code, message }`, as a promise.
         */
        timeline: timeline ? timeline.api : Object.freeze(Object.fromEntries(['head', 'make', 'list', 'status', 'history', 'forget', 'registerParticipant', 'prepare', 'activate', 'abort', 'recover', 'nativeEvent', 'nativeMutation'].map(name => [name, noTimeline]))),
        id: newId,
        /**
         * The settings a character card may recommend (packs/card-settings.js): `registerCardSettings({ owner, label, keys: { <key>: { label,
         * valueText(v), valid(v) } }, read(key), apply(values) → Promise<{ applied: [key] }> })` → `unregister()`. Internal: not in the public api.
         */
        registerCardSettings: spec => cardSettings.register(spec),
        check: check ? Object.freeze({ ...check }) : null,
        settings: id => settings(id),
        /** Whether the reader has feature `id` on (MODULES §F100); false for an id no module declares. */
        feature: id => featureOn(registry, id),
        /** Every declared feature: [{ id, moduleId, moduleName, label, describe, default, prompt, on }]. */
        features: () => (registry.features?.() ?? []).map(feature => Object.freeze({ ...feature, on: featureOn(registry, feature.id) })),
        /**
         * [{ id, name, version, domains, commands, kinds, tabs, features, capabilities, status, reason }] in id order.
         * `domains`, `commands` and `kinds` are what the module declares; `capabilities` are the names it declares for
         * packs' requires.capabilities (a frozen list, empty when it declares none); it is available only while
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
                capabilities: Object.freeze([...new Set(def.capabilities ?? [])]),
                status: life?.status ?? 'ready',
                reason: life?.reason ?? null,
            });
        }),
    });
    return { sdk, events, markReady };
}
