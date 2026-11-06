// The registry's command, capture, context and initial-state lookups, extracted from registry.js:
// which module answers a command or kind, the feature and lifecycle it is under, the
// refusal for a held-back module's action, a domain's initial slice and the state a chat starts with.

import { featureOf } from '../features.js';
import { CAPTURE_PREFIX, INIT_PREFIX, grammarOf, isObject, jsonProblem } from '../registry-checks.js';

export function createCommandLookups({ defs, owners, canonical, held, lifecycle, nameOf, off, warn }) {
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

    return { refusal, contextOf, captureEntry, commandFeature, command, isInternal, isPrelude, commandOwner, initialState };
}
