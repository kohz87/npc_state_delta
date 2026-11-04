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

import { satisfies } from './packs/version.js';
import { NEEDS_HINT, affectsStatic, featureOf, presetsOf } from './features.js';
import {
    byId, isObject, definitionProblems, neededVersion, definitionWarnings, HOST_MODULE, grammarOf,
    CAPTURE_PREFIX, INIT_PREFIX, jsonProblem, RESTORE_STATES, placeOf, headsOf,
} from './registry-checks.js';
export { CAPTURE_PREFIX, INIT_PREFIX, HOST_MODULE, RESTORE_STATES, STANDARD_PREFIX, SETTINGS_PLACES, MAX_CAPABILITIES, FIELD_TYPES, jsonProblem, normalizeField, definitionProblems, definitionWarnings } from './registry-checks.js';

export function createRegistry({ hostVersion = null, warn = message => console.warn(`[Story Suite] ${message}`), featureValue = () => undefined } = {}) {
    const defs = new Map();
    // C3-5: each module's features as they were when it registered (module id → [declaration]): a
    // definition changed afterwards (a label set to a number, a feature pushed later) changes nothing.
    const declared = new Map();
    const owners = { domain: new Map(), command: new Map(), query: new Map(), kind: new Map(), tab: new Map(), screen: new Map(), widget: new Map(), feature: new Map() };
    // A query marked `fallback: true` answers only while no other module owns that name: it takes no ownership (a module that registers the name, before
    // or after, owns it and is the one asked), and a second fallback of the same name is refused as any second owner is. name → module id.
    const fallbacks = new Map();
    const isFallback = (def, name) => def.queries?.[name]?.fallback === true;
    // Every capture kind and alias → its canonical kind.
    const canonical = new Map();

    const sorted = () => [...defs.values()].sort(byId);
    // Modules refused at registration, by id (the latest refusal), for the overlay's Versions fold:
    // { id, name, version, requires, version: true when it was the Story Block version, message }.
    const refusals = new Map();
    function noteRefusal(def, id, message, { forVersion = false } = {}) {
        refusals.set(id, {
            id,
            name: typeof def?.name === 'string' && def.name ? def.name : id,
            version: typeof def?.version === 'string' ? def.version : '',
            requires: typeof def?.requires?.storyBlock === 'string' ? def.requires.storyBlock : '',
            forVersion,
            message: message.replace(/^Story Suite: /, ''),
        });
    }

    function refuse(id, reasons, def = null) {
        const list = reasons.length === 1 ? reasons[0] : reasons.map(reason => `\n- ${reason}`).join('');
        const message = `Story Suite: the module "${id}" cannot be registered: ${list}${reasons.length === 1 ? '.' : ''}`;
        noteRefusal(def, id, message);
        throw new Error(message);
    }

    // The names this definition claims, by table: [table, name, label].
    function claims(def) {
        const out = [];
        for (const name of Object.keys(def.domains ?? {})) out.push(['domain', name, `the domain "${name}"`]);
        for (const type of Object.keys(def.commands ?? {})) out.push(['command', type, `the command "${type}"`]);
        for (const name of Object.keys(def.queries ?? {})) out.push([isFallback(def, name) ? 'fallback' : 'query', name, `the query "${name}"`]);
        for (const [kind, spec] of Object.entries(def.capture?.kinds ?? {})) {
            out.push(['kind', kind, `the capture kind "${kind}"`]);
            for (const alias of spec.aliases ?? []) out.push(['kind', alias, `the capture kind "${alias}" (an alias of "${kind}")`]);
        }
        for (const tab of def.tabs ?? []) out.push(['tab', tab.id, `the tab "${tab.id}"`]);
        for (const screen of def.screens ?? []) out.push(['screen', screen.id, `the screen "${screen.id}"`]);
        for (const name of Object.keys(def.widgets ?? {})) out.push(['widget', name, `the widget "${name}"`]);
        for (const feature of def.features ?? []) out.push(['feature', feature.id, `the feature "${feature.id}"`]);
        return out;
    }

    function register(def) {
        const id = isObject(def) && typeof def.id === 'string' ? def.id : '?';
        const problems = definitionProblems(def);
        if (problems.length) refuse(id, problems, def);
        const range = def.requires?.storyBlock;
        if (hostVersion && typeof range === 'string' && !satisfies(hostVersion, range)) {
            const message = `Story Suite: ${def.name ?? id} needs Story Block ${neededVersion(range, hostVersion)}; this is ${hostVersion}. Update Story Block to use it.`;
            noteRefusal(def, id, message, { forVersion: true });
            throw new Error(message);
        }
        if (defs.has(id)) refuse(id, ['a module with this id is already registered'], def);
        const clashes = [];
        const seen = new Set();
        for (const [table, name, label] of claims(def)) {
            const key = `${table}:${name}`;
            if (seen.has(key)) clashes.push(`${label} is named twice in it`);
            seen.add(key);
            const owner = (table === 'fallback' ? fallbacks : owners[table]).get(name);
            if (owner) clashes.push(`${label} already belongs to "${owner}"`);
        }
        if (clashes.length) refuse(id, clashes, def);
        for (const [table, name] of claims(def)) (table === 'fallback' ? fallbacks : owners[table]).set(name, id);
        for (const [kind, spec] of Object.entries(def.capture?.kinds ?? {})) {
            canonical.set(kind, kind);
            for (const alias of spec.aliases ?? []) canonical.set(alias, kind);
        }
        defs.set(id, def);
        peerNeeds.set(id, Object.freeze(Object.entries(isObject(def.requires?.peers) ? def.requires.peers : {}).map(([peer, range]) => Object.freeze({ peer, range }))));
        lifeCache = null;
        declared.set(id, Object.freeze((def.features ?? []).map(feature => Object.freeze({
            id: feature.id,
            label: feature.label.trim(),
            describe: typeof feature.describe === 'string' ? feature.describe.trim() : '',
            default: feature.default !== false,
            prompt: affectsStatic(def, feature.id),
            // Only a feature that says it carries `presets` (features.js): one that does not follows its default in every preset.
            ...(feature.presets === undefined ? {} : { presets: presetsOf(feature) }),
            needs: needsOf(feature),
        }))));
        refusals.delete(id);
        for (const message of definitionWarnings(def)) warn(`${def.name ?? id}: ${message}.`);
    }

    // ---- features (features.js) -----------------------------------------------------------------

    function featureDecl(id) {
        const owner = owners.feature.get(String(id ?? ''));
        if (!owner) return null;
        const def = defs.get(owner);
        const feature = declared.get(owner)?.find(item => item.id === id);
        if (!feature) return null;
        const { needs } = feature;
        // A feature of a module held back (dormant, restore barrier) is not available, whatever it needs.
        const heldOwner = held(owner);
        const available = !heldOwner && availableFor(needs);
        return Object.freeze({
            id: feature.id,
            moduleId: owner,
            moduleName: typeof def?.name === 'string' && def.name ? def.name : owner,
            label: feature.label,
            describe: feature.describe,
            default: feature.default,
            prompt: feature.prompt,
            ...(feature.presets === undefined ? {} : { presets: feature.presets }),
            needs,
            available,
            why: available ? '' : heldOwner ? lifecycle(owner).reason : needs.why,
        });
    }
    // `needs` in full: { kinds, commands, queries, why } (lists of names; why: the overlay's reason).
    function needsOf(feature) {
        const given = isObject(feature.needs) ? feature.needs : {};
        const list = key => (Array.isArray(given[key]) ? given[key].map(String) : []);
        const why = typeof given.why === 'string' && given.why.trim() ? given.why.trim() : NEEDS_HINT;
        return Object.freeze({ kinds: Object.freeze(list('kinds')), commands: Object.freeze(list('commands')), queries: Object.freeze(list('queries')), why });
    }
    // Available: every kind, command and query it needs is registered (by any module, whatever its
    // features say: a feature never waits on another's switch).
    // Held back, a module's kinds, commands and queries are not there for another's feature to need.
    const there = (table, name) => table.has(name) && !held(table.get(name));
    const availableFor = needs => needs.kinds.every(kind => canonical.has(kind.toLowerCase()) && !held(owners.kind.get(canonical.get(kind.toLowerCase()))))
        && needs.commands.every(type => there(owners.command, type))
        && needs.queries.every(name => there(owners.query, name) || there(fallbacks, name));
    // What a read would say with other switches (`withFeatures`): feature id → true | false, set only while that call runs.
    let asIf = null;
    // On: the reader's choice when there is one, else the feature's default; an id no module declares, or
    // a feature whose `needs` no module meets, is off.
    function featureOn(id) {
        const decl = featureDecl(id);
        if (!decl || !decl.available) return false;
        if (asIf?.has(decl.id)) return asIf.get(decl.id) === true;
        let value;
        try { value = featureValue(decl.id); } catch { value = undefined; }
        return typeof value === 'boolean' ? value : decl.default;
    }
    // Runs `read` (synchronously) as if the features in `switches` (a Map or an object, id → true | false) had those states and the
    // rest were as they are: what a preset would send, counted without switching anything. Nothing is stored or told, and the
    // reader's choices are back the moment `read` returns (or throws). An unavailable feature stays off, as it does in a real read.
    function withFeatures(switches, read) {
        const before = asIf;
        asIf = switches instanceof Map ? switches : new Map(Object.entries(isObject(switches) ? switches : {}));
        try { return read(); } finally { asIf = before; }
    }
    // True while a `withFeatures` read runs: what it asks is not the story as it is.
    const hypothetical = () => asIf !== null;
    // Is this item (a kind spec, a command, a hook, a tab…) under a feature that is off?
    const off = item => {
        const id = featureOf(item);
        return id !== null && !featureOn(id);
    };
    const offQuery = () => null;

    // ---- lifecycle (docs/v2/LIFECYCLE.md) ---------------------------------------------------------

    // Each module's peers as they were when it registered (module id → [{ peer, range }]), like
    // `declared` above: a definition changed afterwards changes nothing.
    const peerNeeds = new Map();
    // Modules switched off by the host (id → reason), and the restore barrier (setRestore).
    const switchedOff = new Map();
    let barrier = { state: 'idle', reason: '' };
    // id → { status: 'ready'|'dormant', reason }: the peers' verdict, without the barrier. Cleared
    // whenever a module registers or is switched on or off; worked out again when next asked.
    let lifeCache = null;
    const nameOf = id => (typeof defs.get(id)?.name === 'string' && defs.get(id).name ? defs.get(id).name : id);

    // The ids from `id` back to `id` along registered peers (['a', 'b', 'a']), or null when `id` is on no cycle.
    function cycleFrom(id) {
        const seen = new Set();
        const walk = (at, path) => {
            for (const { peer } of peerNeeds.get(at) ?? []) {
                if (!defs.has(peer)) continue;
                if (peer === id) return [...path, id];
                if (seen.has(peer)) continue;
                seen.add(peer);
                const found = walk(peer, [...path, peer]);
                if (found) return found;
            }
            return null;
        };
        return walk(id, [id]);
    }

    function peerVerdicts() {
        if (lifeCache) return lifeCache;
        const verdicts = new Map();
        const ids = [...defs.keys()].sort();
        for (const id of ids) {
            if (switchedOff.has(id)) { verdicts.set(id, { status: 'dormant', reason: switchedOff.get(id) }); continue; }
            const cycle = cycleFrom(id);
            if (cycle) verdicts.set(id, { status: 'dormant', reason: `Its peers need each other (${cycle.join(' → ')}), so none of them can start.` });
            else verdicts.set(id, { status: 'ready', reason: null });
        }
        // A peer's own readiness can only take more modules down, so this settles in a few rounds.
        for (let changed = true; changed;) {
            changed = false;
            for (const id of ids) {
                if (verdicts.get(id).status !== 'ready') continue;
                const unmet = [];
                for (const { peer, range } of peerNeeds.get(id) ?? []) {
                    const other = defs.get(peer);
                    if (!other) { unmet.push(`Needs ${peer} ${range}, which is not installed.`); continue; }
                    const version = typeof other.version === 'string' ? other.version : '';
                    if (!satisfies(version, range)) { unmet.push(`Needs ${peer} ${range}; the one installed is ${version || 'of unknown version'}.`); continue; }
                    const theirs = verdicts.get(peer);
                    if (theirs.status !== 'ready') unmet.push(`Needs ${nameOf(peer)}, which is not ready: ${theirs.reason}`);
                }
                if (unmet.length) { verdicts.set(id, { status: 'dormant', reason: unmet.join(' ') }); changed = true; }
            }
        }
        lifeCache = verdicts;
        return verdicts;
    }

    const BARRIER_REASON = 'A restore is in progress; every part must agree before the story goes on.';

    /** `{ status: 'ready'|'dormant'|'restore-pending', reason: string|null }` of a registered module, else null. */
    function lifecycle(id) {
        const base = peerVerdicts().get(id);
        if (!base) return null;
        if (barrier.state === 'pending') return { status: 'restore-pending', reason: barrier.reason || BARRIER_REASON };
        return { status: base.status, reason: base.reason };
    }

    // Is module `id` held back (dormant, or the restore barrier is up and it is not Story Block's own)?
    function held(id) {
        const base = peerVerdicts().get(id);
        if (!base) return false;
        return base.status === 'dormant' || (barrier.state === 'pending' && id !== HOST_MODULE);
    }

    // The refusal for a reader's action on command `type` whose module is held back, else null.
    function refusal(type) {
        const owner = commandOwner(type);
        if (!owner || !held(owner)) return null;
        const life = lifecycle(owner);
        return life.status === 'restore-pending'
            ? { code: 'RESTORE_PENDING', message: `${nameOf(owner)} is waiting: ${life.reason}` }
            : { code: 'DEPENDENCY_UNAVAILABLE', message: `${nameOf(owner)} is not running: ${life.reason}` };
    }

    // A context with its parts folded in: one static() and one tail(view) of what is on.
    function contextOf(def) {
        const context = isObject(def.context) ? def.context : {};
        const whole = !off(context);
        const parts = whole ? [{ static: context.static, tail: context.tail }, ...(Array.isArray(context.parts) ? context.parts : []).filter(part => !off(part))] : [];
        const statics = parts.map(part => part.static).filter(item => typeof item === 'function');
        const tails = parts.map(part => part.tail).filter(item => typeof item === 'function');
        const joined = statics.length <= 1 ? statics[0] ?? null
            : hint => statics.map(item => item(hint)).filter(text => typeof text === 'string' && text.trim()).map(text => text.trim()).join('\n');
        const tail = tails.length <= 1 ? tails[0] ?? null : view => {
            const lines = [];
            const optional = [];
            for (const item of tails) {
                const out = item(view) ?? {};
                if (Array.isArray(out.lines)) lines.push(...out.lines);
                if (Array.isArray(out.optional)) optional.push(...out.optional);
            }
            return { lines, optional };
        };
        return { static: joined, tail };
    }

    // A display kind's options ({ perReply?, noun?, read? }), or null for a kind that runs a command.
    const displayOf = spec => (spec.display === true ? Object.freeze({}) : isObject(spec.display) ? spec.display : null);

    function captureEntry(word) {
        const kind = canonical.get(String(word ?? '').toLowerCase());
        if (!kind) return null;
        const def = defs.get(owners.kind.get(kind));
        const spec = def.capture.kinds[kind];
        // `enabled: false` (a kind of an API not in use, MODULES / LIFECYCLE "Deferred domains"): acts as if it were not declared, so a
        // line of it is told as an unknown kind, exactly as in a host that never had the kind.
        if (spec.enabled === false) return null;
        // `after: ['place', 'mount']` (a kind that reads what other kinds' lines of the same reply set up, such as Story Director's trip): its
        // lines run after the reply's lines of those kinds, whatever order the narrator wrote them in. Words that are no kind are left out.
        const after = Array.isArray(spec.after) ? [...new Set(spec.after.map(word => canonical.get(String(word ?? '').toLowerCase())).filter(Boolean))] : [];
        return { moduleId: def.id, kind, grammar: grammarOf(spec), apply: def.capture.apply, feature: featureOf(spec), off: off(spec), display: displayOf(spec), ...(after.length ? { after } : {}) };
    }

    // The feature a command belongs to (a capture.<kind> command: its kind's), or null.
    function commandFeature(type) {
        const name = String(type ?? '');
        if (name.startsWith(CAPTURE_PREFIX)) return captureEntry(name.slice(CAPTURE_PREFIX.length))?.feature ?? null;
        if (name.startsWith(INIT_PREFIX)) return null;
        return featureOf(commandEntry(name));
    }

    // One domain's initial() slice, a plain copy; null when it throws or is not plain JSON. Each
    // failure is logged once (until that domain works again), so a broken domain costs only itself
    // and the retry at every later turn stays quiet.
    const failing = new Map();
    function initialSlice(name) {
        const owner = owners.domain.get(name);
        const def = defs.get(owner);
        let problem = '';
        let slice = null;
        try {
            slice = def.domains[name].initial();
            problem = isObject(slice) ? jsonProblem(slice, `/domains/${name}`) : `initial() does not return an object`;
        } catch (error) {
            problem = `initial() threw: ${error?.message ?? error}`;
        }
        if (!problem) {
            failing.delete(name);
            return structuredClone(slice);
        }
        if (failing.get(name) !== problem) {
            failing.set(name, problem);
            warn(`${def.name ?? owner}: the domain "${name}" could not be set up (${problem}); the rest of the story goes on without it, and it is tried again later.`);
        }
        return null;
    }

    // `module.init.<id>`: sets the module's domains the state lacks to their initial() slices (§2.6).
    // The payload names them ({ domains: [...] }, from sdk.js ensureModules); without it, every
    // domain of the module. Either way a domain the chat already holds is never reset (a module that
    // gains a domain keeps the data of the others). A domain whose initial() fails is skipped; the
    // command fails only when none could be set up.
    function initHandler(def) {
        return (ctx, payload) => {
            const own = Object.keys(def.domains ?? {});
            const lacking = name => typeof ctx.read !== 'function' || ctx.read(name) == null;
            const named = own.filter(name => !def.domains[name].deferred && (!Array.isArray(payload?.domains) || payload.domains.includes(name)) && lacking(name));
            const done = [];
            for (const name of named) {
                const slice = initialSlice(name);
                if (!slice) continue;
                const draft = ctx.draft(name);
                if (!isObject(draft)) ctx.fail('FAILED', `The ${def.name ?? def.id} state could not be set up.`);
                for (const key of Object.keys(draft)) delete draft[key];
                Object.assign(draft, slice);
                done.push(name);
            }
            if (named.length && !done.length) ctx.fail('FAILED', `The ${def.name ?? def.id} state could not be set up: ${named.map(name => failing.get(name) ?? '').filter(Boolean).join('; ')}.`);
            return { summary: `${def.name ?? def.id} is set up.`, narrate: false, data: { module: def.id, domains: done } };
        };
    }

    function command(type) {
        const name = String(type ?? '');
        if (name.startsWith(CAPTURE_PREFIX)) {
            const entry = captureEntry(name.slice(CAPTURE_PREFIX.length));
            return entry && !held(entry.moduleId) ? (ctx, line) => entry.apply(ctx, line) : null;
        }
        if (name.startsWith(INIT_PREFIX)) {
            const def = defs.get(name.slice(INIT_PREFIX.length));
            return def && !held(def.id) && Object.keys(def.domains ?? {}).length ? initHandler(def) : null;
        }
        // A command of a module held back is not found (the bus says UNKNOWN_COMMAND, which a caller of
        // ctx.call may catch); the reader's actions get the reason first (`refusal`, sdk.js).
        const owner = owners.command.get(name);
        if (owner && held(owner)) return null;
        const entry = commandEntry(name);
        return entry && entry.enabled !== false ? (isObject(entry) ? entry.handler : entry) : null;
    }

    function commandEntry(name) {
        const owner = owners.command.get(name);
        return owner ? defs.get(owner).commands[name] : null;
    }

    // Steps the host takes itself (see the top): never a reader's action.
    function isInternal(type) {
        const name = String(type ?? '');
        if (name.startsWith(CAPTURE_PREFIX) || name.startsWith(INIT_PREFIX)) return true;
        const entry = commandEntry(name);
        return Boolean(entry) && entry.internal === true;
    }

    // Preludes: system commands a module's beforeGenerate asks for, previewed for the prompt and stored on the
    // generated reply before its story lines (turn.js runCues; Assist's pre-roll is the first). A command is marked
    // `{ handler, prelude: true }`, or is a handler function that carries `prelude === true` itself.
    function isPrelude(type) {
        const entry = commandEntry(String(type ?? ''));
        return Boolean(entry) && entry.prelude === true;
    }

    function commandOwner(type) {
        const name = String(type ?? '');
        if (name.startsWith(CAPTURE_PREFIX)) return captureEntry(name.slice(CAPTURE_PREFIX.length))?.moduleId ?? null;
        if (name.startsWith(INIT_PREFIX)) return command(name) ? name.slice(INIT_PREFIX.length) : null;
        return owners.command.get(name) ?? null;
    }

    // A domain whose initial() fails is left out (logged once); sdk.js ensureModules adds it later. So is
    // that of a module held back (dormant, restore barrier): it is set up when it becomes ready.
    function initialState() {
        const domains = {};
        const names = [...owners.domain.keys()].sort().filter(name => !held(owners.domain.get(name)));
        for (const name of names) {
            if (defs.get(owners.domain.get(name)).domains[name].deferred) continue;
            const slice = initialSlice(name);
            if (slice) domains[name] = slice;
        }
        return { v: 2, meta: { rev: 0, claims: {} }, domains };
    }

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
        peers: id => (peerNeeds.get(id) ?? []).map(({ peer, range }) => ({ module: peer, range })),
        /**
         * Host-internal: switch module `id` off (dormant, with `reason`) or on again. Story Block's own
         * module cannot be switched off. → whether anything changed.
         */
        setEnabled(id, on, reason = 'Turned off.') {
            if (!defs.has(id) || id === HOST_MODULE) return false;
            const was = switchedOff.has(id);
            if (on === false) switchedOff.set(id, String(reason || 'Turned off.'));
            else switchedOff.delete(id);
            lifeCache = null;
            return was !== switchedOff.has(id);
        },
        /** The restore barrier: `{ state: 'idle'|'pending'|'failed', reason }`. */
        restore: () => ({ ...barrier }),
        /**
         * Host-internal: raise or drop the restore barrier (the save-point package drives it; tests use it).
         * While 'pending', no module but Story Block's own is ready (see held). 'failed' is only reported
         * (sdk.preflight): it holds nothing.
         */
        setRestore(state, reason = '') {
            if (!RESTORE_STATES.includes(state)) throw new Error(`Story Suite: a restore is ${RESTORE_STATES.join(', ')}, not "${state}".`);
            barrier = { state, reason: state === 'idle' ? '' : String(reason ?? '') };
        },
        /** The functions modules registered under hook `name`, in module-id order. */
        // Hooks, tabs, screens and widgets under a feature that is off are left out of these lists.
        // A module held back (lifecycle above) has no hooks and no cards, and no context.
        hooks: name => sorted().filter(def => !held(def.id)).map(def => def.hooks?.[name]).filter(hook => typeof hook === 'function' && !off(hook)),
        /** Same, with the module each comes from: [{ moduleId, fn }]. */
        hookEntries: name => sorted().filter(def => !held(def.id) && typeof def.hooks?.[name] === 'function' && !off(def.hooks[name])).map(def => ({ moduleId: def.id, fn: def.hooks[name] })),
        /** [{ moduleId, id: "<module>/<card>", fn }] for the cards under replies (reply-cards.js), in module-id order; a card off is left out. */
        cardEntries: () => sorted().filter(def => !held(def.id)).flatMap(def => Object.entries(def.cards ?? {}).filter(([, card]) => typeof card?.for === 'function' && !off(card))
            .map(([id, card]) => ({ moduleId: def.id, id: `${def.id}/${id}`, fn: card.for }))),
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
