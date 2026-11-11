// The module registry (docs/v2/SPEC.md §6, §12): every module's definition, checked when it
// registers, and the lookups the rest of the host asks it (who owns a domain, a command, a
// capture kind; the initial state; hooks, tabs, settings, prompt contexts). One writer per
// domain: a second owner for a domain, command, query, capture kind or tab is refused with a
// plain sentence, and nothing of the refused module is kept. Pure: no DOM, no SillyTavern.
//
// Old and new versions meet (SPEC §6): a module may say which Story Block it needs
// (`requires: { storyBlock: '>=2.0.0' }`) and is refused with "needs Story Block ≥ x" when this
// one is older; a field this host does not know (a newer module's) is logged and ignored, never a
// refusal. A domain's initial() that throws when a chat starts costs that domain only.
//
// Features (MODULES §F100, features.js): what a module marks `feature: '<id>'` is left out of the
// lookups while the reader has that feature off: its capture kinds' grammar and its context (contexts),
// its hooks, tabs, screens and widgets; its queries answer null (query); its commands are known but
// refused by the bus (commandFeature); a change line of its kinds is told quietly (capture().off).
// `featureValue(id)` gives the reader's stored choice (true, false or undefined for the default).
//
// Lifecycle (docs/v2/LIFECYCLE.md): a module may name the peers it needs
// (`requires: { peers: { 'story-director': '^2' } }`). A module whose peer is missing, of another
// version, turned off or not ready itself, or whose peers need each other, is dormant: it is
// registered and its names stay reserved, but it has no domain set up, no capture, hooks, context or
// cards, its commands are not found and its queries answer null. A module with no peers is always
// ready. A restore barrier (`setRestore('pending')`, driven by the save-point package) holds every
// module but Story Block's own the same way. The status is worked out when asked, so a peer that
// registers or comes back is seen at the next view, action or generation, and nothing registers twice.

import { byId, grammarOf, placeOf, headsOf } from './registry-checks.js';
export { CAPTURE_PREFIX, INIT_PREFIX, HOST_MODULE, RESTORE_STATES, STANDARD_PREFIX, SETTINGS_PLACES, MAX_CAPABILITIES, FIELD_TYPES, jsonProblem, normalizeField, definitionProblems, definitionWarnings } from './registry-checks.js';
import { createCommandLookups } from './registry/commands.js';
import { createFeatureLookups } from './registry/features.js';
import { createLifecycle } from './registry/lifecycle.js';
import { createRegistration } from './registry/registration.js';

export function createRegistry({ hostVersion = null, warn = message => console.warn(`[Story Suite] ${message}`), featureValue = () => undefined } = {}) {
    const defs = new Map();
    // C3-5: each module's features as they were when it registered (module id → [declaration]): a
    // definition changed afterwards (a label set to a number, a feature pushed later) changes nothing.
    const declared = new Map();
    const owners = { domain: new Map(), command: new Map(), query: new Map(), kind: new Map(), tab: new Map(), screen: new Map(), widget: new Map(), feature: new Map() };
    // A query marked `fallback: true` answers only while no other module owns that name: it takes no ownership (a module that registers the name, before
    // or after, owns it and is the one asked), and a second fallback of the same name is refused as any second owner is. name → module id.
    const fallbacks = new Map();
    // Every capture kind and alias → its canonical kind.
    const canonical = new Map();

    const sorted = () => [...defs.values()].sort(byId);
    // Modules refused at registration, by id (the latest refusal), for the overlay's Versions fold:
    // { id, name, version, requires, version: true when it was the Story Block version, message }.
    const refusals = new Map();
    const life = createLifecycle({ defs });
    const { lifecycle, held, setEnabled, restore, restoreEpoch, setRestore, peers } = life;
    const featureLookups = createFeatureLookups({ defs, declared, owners, fallbacks, canonical, featureValue, held, lifecycle });
    const { featureDecl, needsOf, featureOn, withFeatures, hypothetical, off, offQuery } = featureLookups;
    const commandLookups = createCommandLookups({ defs, owners, canonical, held, lifecycle, nameOf: life.nameOf, off, warn });
    const { refusal, contextOf, captureEntry, commandFeature, command, isInternal, isPrelude, commandOwner, initialState } = commandLookups;
    const { register } = createRegistration({ defs, declared, owners, fallbacks, canonical, refusals, hostVersion, warn, needsOf, setPeers: life.setPeers });

    return {
        register,
        /** This Story Block's version as the registry checks `requires` against (null: not checked). */
        hostVersion: () => hostVersion,
        /** The modules refused since the page opened and not registered since: [{ id, name, version, requires, forVersion, message }]. */
        refusals: () => [...refusals.values()].sort(byId).map(item => ({ ...item })),
        has: id => defs.has(id),
        module: id => defs.get(id) ?? null,
        /** Every definition, sorted by id. */
        modules: sorted,
        domainOwner: name => owners.domain.get(name) ?? null,
        /** The replay rules now registered, as text: each domain with its owner, the owner's version, whether it validates, its scratch fields and counters. It changes when a module registers or goes (the store keys what it kept on it). */
        rulesSignature: () => [...owners.domain].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, id]) => {
            const def = defs.get(id)?.domains?.[name] ?? {};
            const list = value => (Array.isArray(value) ? value.join('+') : '');
            return `${name}@${id}@${defs.get(id)?.version ?? ''}:${typeof def.validate === 'function' ? 'v' : ''}:${list(def.scratch)}:${list(def.counters)}`;
        }).join(';'),
        commandOwner,
        captureOwner: kind => captureEntry(kind)?.moduleId ?? null,
        queryOwner: name => owners.query.get(name) ?? null,
        /** The handler for a command type (module commands and the registry's own), or null. */
        command,
        /** True for a command only the host runs (capture.*, module.init.*, commands marked internal). */
        isInternal,
        /** True for a prelude command (marked `prelude`): previewed before the reply and stored on it before its story lines. */
        isPrelude,
        /** { moduleId, kind, grammar, apply, feature, off, display } (display: a display kind's options, else null) for a capture kind or alias, or null. */
        capture: word => {
            const entry = captureEntry(word);
            return entry && held(entry.moduleId) ? null : entry;
        },
        /** The canonical kind a written kind word stands for, or null. */
        kindOf: word => canonical.get(String(word ?? '').toLowerCase()) ?? null,
        validator(name) {
            const owner = owners.domain.get(name);
            return owner ? defs.get(owner).domains[name].validate ?? null : null;
        },
        /** The fields a domain keeps per-reply bookkeeping in (`scratch`, ops.js), [] when none. */
        scratch(name) {
            const owner = owners.domain.get(name);
            const list = owner ? defs.get(owner).domains[name].scratch : null;
            return Array.isArray(list) ? [...list] : [];
        },
        /** The number paths a domain keeps as counts (`counters`, ops.js), [] when none. */
        counters(name) {
            const owner = owners.domain.get(name);
            const list = owner ? defs.get(owner).domains[name].counters : null;
            return Array.isArray(list) ? [...list] : [];
        },
        /** The query function; one answering null while its feature is off. */
        query(name) {
            const owner = owners.query.get(name) ?? fallbacks.get(name);
            if (!owner) return null;
            const fn = defs.get(owner).queries[name];
            if (fn.enabled === false) return null;
            const asked = off(fn) || held(owner) ? offQuery : fn;
            // A fallback stands behind the owner: asked when the owner is held back (switched off, dormant) or its feature is off, and when the owner answers nothing
            // (null or an empty list: an older party module in a chat that is not its own), so it cannot hide the fallback's answer.
            const behind = fallbacks.get(name);
            if (!behind || behind === owner) return asked;
            const back = defs.get(behind).queries[name];
            if (back.enabled === false || off(back) || held(behind)) return asked;
            if (asked === offQuery) return back;
            return Object.assign((state, args, tools) => {
                const answer = asked(state, args, tools);
                return answer === null || answer === undefined || (Array.isArray(answer) && answer.length === 0) ? back(state, args, tools) : answer;
            }, {});
        },
        initialState,
        /**
         * Where module `id` stands (docs/v2/LIFECYCLE.md): `{ status: 'ready'|'dormant'|'restore-pending',
         * reason: string|null }`, or null for a module that is not registered. Worked out when asked.
         */
        lifecycle,
        /** Every module's lifecycle: [{ id, status, reason }] in id order. */
        lifecycles: () => sorted().map(def => ({ id: def.id, ...lifecycle(def.id) })),
        /** The ids of the modules held back now, in id order. */
        heldModules: () => sorted().map(def => def.id).filter(held),
        /** True when module `id` is held back: dormant, or the restore barrier is up (Story Block's own is never held by it). */
        held,
        /** `{ code, message }` that refuses the reader's action `type` because its module is held back, else null. */
        refusal,
        /** [{ module, range }] the peers module `id` named when it registered. */
        peers,
        /**
         * Host-internal: switch module `id` off (dormant, with `reason`) or on again. Story Block's own
         * module cannot be switched off. → whether anything changed.
         */
        setEnabled,
        /** The restore barrier: `{ state: 'idle'|'pending'|'failed', reason }`. */
        restore,
        /** Changes when a new restore barrier is raised, not when its reason changes. */
        restoreEpoch,
        /**
         * Host-internal: raise or drop the restore barrier (the save-point package drives it; tests use it).
         * While 'pending', no module but Story Block's own is ready (see held). 'failed' is only reported
         * (sdk.preflight): it holds nothing.
         */
        setRestore,
        /** The functions modules registered under hook `name`, in module-id order. */
        // Hooks, tabs, screens and widgets under a feature that is off are left out of these lists.
        // A module held back (lifecycle above) has no hooks and no cards, and no context.
        hooks: name => sorted().filter(def => !held(def.id)).map(def => def.hooks?.[name]).filter(hook => typeof hook === 'function' && !off(hook)),
        /** Same, with the module each comes from: [{ moduleId, fn }]. */
        hookEntries: name => sorted().filter(def => !held(def.id) && typeof def.hooks?.[name] === 'function' && !off(def.hooks[name])).map(def => ({ moduleId: def.id, fn: def.hooks[name] })),
        /** [{ moduleId, id: "<module>/<card>", fn }] for the cards under replies (reply-cards.js), in module-id order; a card off is left out. */
        cardEntries: () => sorted().filter(def => !held(def.id)).flatMap(def => Object.entries(def.cards ?? {}).filter(([, card]) => typeof card?.for === 'function' && !off(card))
            .map(([id, card]) => ({ moduleId: def.id, id: `${def.id}/${id}`, fn: card.for }))),
        /** [{ moduleId, key: "<module>/<id>", id, label, icon, query, command, args, payload }]: each module's one game view header toggle, module-id order; off, held back or its feature off: left out. */
        headerControls: () => sorted().filter(def => !held(def.id)).flatMap(def => (Array.isArray(def.headerControls) ? def.headerControls : []).filter(control => !off(control))
            .map(control => ({ moduleId: def.id, key: `${def.id}/${control.id}`, id: control.id, label: control.label, icon: control.icon, query: control.query, command: control.command, args: control.args ?? {}, payload: control.payload ?? {} }))),
        /** [{ moduleId, id, title, icon, render }] in module-id order, each module's in its own order. */
        tabs: () => sorted().flatMap(def => (def.tabs ?? []).filter(tab => !off(tab)).map(tab => ({ ...tab, moduleId: def.id }))),
        /** [{ moduleId, ...screen }] in module-id order, each module's in its own order (§13.1). */
        screens: () => sorted().flatMap(def => (def.screens ?? []).filter(screen => !off(screen)).map(screen => ({ ...screen, moduleId: def.id }))),
        /** [{ moduleId, name, props, render }] in module-id order, then by name (§13.5). */
        widgets: () => sorted().flatMap(def => Object.keys(def.widgets ?? {}).sort().filter(name => !off(def.widgets[name])).map(name => ({ ...def.widgets[name], name, moduleId: def.id }))),
        /** One widget by its namespaced name, or null (also while its feature is off). */
        widget(name) {
            const owner = owners.widget.get(name);
            return owner && !off(defs.get(owner).widgets[name]) ? { ...defs.get(owner).widgets[name], name, moduleId: owner } : null;
        },
        /** True when a module's screen `id` is under a feature that is off (whoever restyled it). */
        screenOff(id) {
            const owner = owners.screen.get(id);
            return Boolean(owner) && off(defs.get(owner).screens.find(screen => screen.id === id));
        },
        /** The names of the widgets whose feature is off. */
        widgetsOff: () => sorted().flatMap(def => Object.keys(def.widgets ?? {}).sort().filter(name => off(def.widgets[name]))),
        /**
         * Every declared feature: [{ id, moduleId, moduleName, label, describe, default, prompt, presets, needs,
         * available, why }], module-id order (`presets`: false, or { lean?, full? }: features.js). `available` is false while what it `needs` is not registered
         * (it is then off, whatever the reader chose); `why` says so for the overlay.
         */
        features: () => sorted().flatMap(def => (declared.get(def.id) ?? []).map(feature => featureDecl(feature.id))),
        /** One declared feature, or null. */
        feature: featureDecl,
        /** Whether feature `id` is on (the reader's choice, else its default); false for an id no module declares. */
        featureOn,
        withFeatures,
        hypothetical,
        /** The feature command `type` belongs to, or null; the bus refuses it with FEATURE_OFF while that is off. */
        commandFeature,
        /**
         * [{ moduleId, name, title, defaults, schema, section, folds, place }] for modules with settings, in
         * module-id order. `section` is the custom panel function (from either form) or null; `title` the
         * section's title when one was given as text, else the module's name; `folds` the module's own
         * top-level panels, [{ id, title, hint, render, place }] (empty when it has none); `place`
         * 'diagnostics' (the fold goes in Settings → Diagnostics) or null (an unknown place is null).
         */
        settingsDefs: () => sorted().filter(def => def.settings).map(def => ({
            moduleId: def.id,
            name: def.name ?? def.id,
            defaults: def.settings.defaults ?? {},
            schema: def.settings.schema ?? {},
            title: typeof def.settings.section === 'string' && def.settings.section.trim() ? def.settings.section.trim() : def.name ?? def.id,
            section: typeof def.settings.section === 'function' ? def.settings.section : def.settings.render ?? null,
            folds: (Array.isArray(def.settings.folds) ? def.settings.folds : [])
                .map(item => ({ id: item.id, title: item.title.trim(), hint: typeof item.hint === 'string' ? item.hint : '', render: item.render, place: placeOf(item.place) })),
            place: placeOf(def.settings.place),
        })),
        /**
         * [{ moduleId, name, domains, kinds: [{ kind, grammar }], static, tail, budget }] in module-id order. `hint` (optional): what the prompt being built
         * tells the grammar functions and `static(hint)` (prompt.js assemble); without it they answer in full.
         */
        // Kinds and context (parts) under a feature that is off are left out (MODULES §F100).
        contexts: hint => sorted().filter(def => !held(def.id)).map(def => {
            const context = contextOf(def);
            return {
                moduleId: def.id,
                name: def.name ?? def.id,
                domains: Object.keys(def.domains ?? {}),
                kinds: Object.keys(def.capture?.kinds ?? {}).sort().filter(kind => def.capture.kinds[kind].enabled !== false && !off(def.capture.kinds[kind])).map(kind => {
                    const heads = headsOf(def.capture.kinds[kind]);
                    return { kind, grammar: grammarOf(def.capture.kinds[kind], hint), ...(heads.length ? { heads } : {}) };
                }).filter(entry => entry.grammar || entry.heads),
                static: context.static,
                tail: context.tail,
                budget: def.context?.budget ?? null,
            };
        }),
    };
}
