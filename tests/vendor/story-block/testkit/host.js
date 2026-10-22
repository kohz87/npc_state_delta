// createHost(): a whole Story Block v2 host on a fake SillyTavern context, the way index.js
// wires it (registry, settings, store, command bus, sdk, turn), for module tests (docs/v2/SPEC.md
// §10). The store and the command bus are imported lazily from ../src/v2/, so the testkit loads
// in a checkout that does not have them yet; `hostAvailable()` says whether they are there, for
// `test(..., { skip })`. `fakes: true` uses the small stand-ins in fakes.js instead.
//
// Vendored into a module's tests/vendor/story-block/ (npm run sync-testkit), the layout is kept:
// testkit/ next to src/v2/, so the relative imports below work there too.

import { createFakeContext } from './fake-st.js';
import { createFakeBus, createFakeStore } from './fakes.js';
import { createRuntime } from '../src/v2/runtime.js';

const RUNTIME = { store: '../src/v2/store.js', commands: '../src/v2/commands.js' };

async function load(path) {
    try { return { module: await import(path) }; } catch (error) {
        return { error };
    }
}

/**
 * { ok, reason, missing }: whether the real store and command bus are in this checkout.
 * `reason` is a sentence for `test(name, { skip: reason })`.
 */
export async function hostAvailable() {
    const missing = [];
    for (const [name, path] of Object.entries(RUNTIME)) {
        const { module, error } = await load(path);
        if (!module) missing.push(`${name}.js (${error?.code === 'ERR_MODULE_NOT_FOUND' ? 'not in this checkout yet' : error?.message})`);
    }
    return {
        ok: !missing.length,
        missing,
        reason: missing.length ? `the Story Block v2 runtime is incomplete here: ${missing.join(', ')}` : '',
    };
}

/**
 * Builds a host. `options`: { modules?: def[] (registered after the core ones), core?: true
 * (register Story Block's core module: scene, inventory, packs, events, assist), callModel?(prompt, opts)
 * (the model behind sdk.callModel and the assist helpers; createFakeModel in model.js scripts one), fakes?: false (use fakes.js), st?: options for
 * createFakeContext (plus onBlocked?), settings?: initial extension_settings.storySuite }.
 * Returns { st, ctx, registry, settings, features, store, bus, events, sdk, turn, packs, send(text, reply, { stopped }),
 * swipe(reply), regenerate(reply), cont(reply), quiet(), head(), close() }; `st` is the fake
 * SillyTavern (fake-st.js), with `st.notices` = [{ reason, moduleId }] for held-back generations; `features` is the
 * reader's feature choices (createFeatureStore: `features.set('my-module.wear', false)`). Throws when the runtime is missing and `fakes` is not set.
 */
export async function createHost(options = {}) {
    const { modules = [], core = true, fakes = false, st: stOptions = {}, settings: initialSettings = null, callModel = null } = options;
    let createStore = createFakeStore;
    let createCommandBus = createFakeBus;
    if (!fakes) {
        const available = await hostAvailable();
        if (!available.ok) throw new Error(`testkit: ${available.reason}.`);
        ({ createStore } = await import(RUNTIME.store));
        ({ createCommandBus } = await import(RUNTIME.commands));
    }
    const extensionSettings = stOptions.extensionSettings ?? {};
    if (initialSettings) extensionSettings.storySuite = structuredClone(initialSettings);
    const st = createFakeContext({ ...stOptions, extensionSettings });
    // What the reader was told when a generation was held back (a toastr warning live).
    st.notices = [];
    const ctx = st.ctx;

    // The same wiring as index.js (src/v2/runtime.js): the core module with its packs part over the
    // fake extension settings, then the given modules.
    const runtime = createRuntime({
        ctx, core, modules, createStore, createCommandBus, callModel,
        onBlocked: stOptions.onBlocked ?? null,
        notify: (reason, moduleId) => st.notices.push({ reason, moduleId }),
    });
    const { registry, settings, store, bus, events, sdk, turn, markReady } = runtime;
    turn.install({ globalName: null });
    st.interceptor = turn.interceptor;
    await turn.onChatChanged();
    markReady();

    return {
        st, ctx, registry, settings, features: runtime.features, store, bus, events, sdk, turn, packs: runtime.packs,
        send: (text, reply = '', { stopped = false } = {}) => st.send(text, { reply, stopped }),
        swipe: (reply = '') => st.generate('swipe', { reply }),
        regenerate: (reply = '') => st.generate('regenerate', { reply }),
        cont: (reply = '') => st.generate('continue', { reply }),
        quiet: (reply = '') => st.generate('quiet', { reply }),
        head: () => store.head(),
        close: () => turn.uninstall({ globalName: null }),
    };
}
