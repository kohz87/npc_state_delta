// Pack events (SPEC §9, MODULES §E): `{ id, when, cue, once = true, after?, then? }`.
//
// Before each reply (`beforeGenerate(view)`, SPEC §4.1 step 3) every enabled event is checked against
// the head state, in id order. An event is due when its `after` event has happened (its claim is on
// this line of history) and its condition is true. A due event is committed as one `system` command,
// `events.fire`, whose receipt summary is the cue: the next reply is told it as an untold receipt, so
// nothing goes to the tail. The same transaction claims `event:<id>` (once events) and runs the
// event's `then` commands through `ctx.call`, so either all of it happens or none of it does.
//
// Whether an event has happened is read from `meta.claims` only, never from memory: swipe or delete the
// carrier that holds the claim and the event can happen again; replay and rebuild agree by construction.
// A chain (`after`) moves at most one link per reply, because every event is checked against the same
// view the reply started from.

import { compile, evaluateCondition } from './condition.js';

/** The internal command a due event is committed through. */
export const FIRE = 'events.fire';

export const EVENT_LIMITS = Object.freeze({ id: 120, cue: 500, then: 8, events: 500 });

const ID = /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const claimKey = id => `event:${id}`;

function claimed(state, id) {
    const claims = state?.meta?.claims;
    return isRecord(claims) && Object.prototype.hasOwnProperty.call(claims, claimKey(id)) && claims[claimKey(id)] === true;
}

/** Plain JSON data only (SPEC §2.1): objects, arrays, strings, finite numbers, booleans, null. */
function isPlain(value, depth = 0) {
    if (depth > 16) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(item => isPlain(item, depth + 1));
    const proto = typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
    if (proto !== Object.prototype && proto !== null) return false;   // functions, Dates, Maps, class instances
    return Object.values(value).every(item => isPlain(item, depth + 1));
}

/** A JSON copy of a payload record, or null when it is not plain data (or larger than 4 KB). */
function plainCopy(value) {
    if (value === undefined) return {};
    if (!isRecord(value) || !isPlain(value)) return null;
    const text = JSON.stringify(value);
    return text.length > 4000 ? null : JSON.parse(text);
}

function checkId(id, what) {
    if (typeof id !== 'string' || !id.trim()) return `${what} needs an id.`;
    if (id.length > EVENT_LIMITS.id) return `${what} has an id longer than ${EVENT_LIMITS.id} characters.`;
    if (!ID.test(id)) return `${what} has the id "${id}", which may only hold letters, digits and . _ / : -`;
    return '';
}

/** The fire payload's own fields (`id`, `cue`, `once`, `then`): `{ value }` or `{ why }`. */
function normalizeFire(raw) {
    const idProblem = checkId(raw?.id, 'An event');
    if (idProblem) return { why: idProblem };
    const id = raw.id;
    if (typeof raw.cue !== 'string' || !raw.cue.trim()) return { why: `The event "${id}" has no cue to tell.` };
    const cue = raw.cue.trim();
    if (cue.length > EVENT_LIMITS.cue) return { why: `The cue of "${id}" is longer than ${EVENT_LIMITS.cue} characters.` };
    const once = raw.once === undefined ? true : raw.once;
    if (typeof once !== 'boolean') return { why: `The event "${id}" has once: ${JSON.stringify(once)}; use true or false.` };
    const list = raw.then === undefined || raw.then === null ? [] : raw.then;
    if (!Array.isArray(list)) return { why: `The "then" of "${id}" must be a list of commands.` };
    if (list.length > EVENT_LIMITS.then) return { why: `The event "${id}" runs more than ${EVENT_LIMITS.then} commands.` };
    const then = [];
    for (const [index, step] of list.entries()) {
        const where = `Command ${index + 1} of "${id}"`;
        if (!isRecord(step) || typeof step.command !== 'string' || !step.command.trim()) return { why: `${where} needs a command name.` };
        if (step.command === FIRE) return { why: `${where} can't fire another event.` };
        const payload = plainCopy(step.payload);
        if (!payload) return { why: `${where} (${step.command}) has a payload that is not a plain record of data.` };
        then.push({ command: step.command, payload });
    }
    return { value: { id, cue, once, then } };
}

/**
 * Check a list of event definitions. `{ defs, invalid }`: defs sorted by id, each
 * `{ id, pack, when, cue, once, after, then }`; invalid `[{ id, pack, why }]` in list order.
 * A condition that does not parse makes its event invalid (it could never be met).
 */
export function normalizeEvents(list) {
    const defs = [];
    const invalid = [];
    const seen = new Set();
    const source = Array.isArray(list) ? list : [];
    if (source.length > EVENT_LIMITS.events) invalid.push({ id: null, pack: null, why: `Only the first ${EVENT_LIMITS.events} events are read.` });
    for (const raw of source.slice(0, EVENT_LIMITS.events)) {
        const pack = isRecord(raw) && typeof raw.pack === 'string' ? raw.pack : null;
        const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : null;
        const reject = why => invalid.push({ id, pack, why });
        if (!isRecord(raw)) { reject('An event must be a record.'); continue; }
        const fire = normalizeFire(raw);
        if (fire.why) { reject(fire.why); continue; }
        if (seen.has(id)) { reject(`Two events share the id "${id}"; the first one is kept.`); continue; }
        if (typeof raw.when !== 'string' || !raw.when.trim()) { reject(`The event "${id}" has no condition ("when").`); continue; }
        const parsed = compile(raw.when);
        if (!parsed.ok) { reject(`The condition of "${id}" can't be read: ${parsed.error.message}`); continue; }
        let after = raw.after === undefined || raw.after === null || raw.after === '' ? null : raw.after;
        if (after !== null) {
            const problem = checkId(after, `The "after" of "${id}"`);
            if (problem) { reject(problem); continue; }
            if (after === id) { reject(`The event "${id}" waits for itself.`); continue; }
        }
        seen.add(id);
        defs.push({ id, pack, when: raw.when, ...fire.value, after });
    }
    // `after` must name a once event (only those leave a claim), and chains must not loop.
    const byId = new Map(defs.map(def => [def.id, def]));
    const kept = defs.filter(def => {
        const target = def.after && byId.get(def.after);
        if (target && !target.once) {
            invalid.push({ id: def.id, pack: def.pack, why: `The event "${def.id}" waits for "${def.after}", which repeats (once: false) and so never counts as happened.` });
            return false;
        }
        for (let step = def.after, hops = 0; step && hops <= defs.length; step = byId.get(step)?.after, hops += 1) {
            if (step === def.id) {
                invalid.push({ id: def.id, pack: def.pack, why: `The event "${def.id}" is part of a loop of "after" events, so none of them can happen.` });
                return false;
            }
        }
        return true;
    });
    kept.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { defs: kept, invalid };
}

/**
 * Where every event stands against a view (`{ state, query }`). Pure: no command runs.
 * `{ events: [{ id, pack, status, why, once, after, when, cue }], fired, due, waiting, invalid, problems }`
 * with status `fired` | `due` | `waiting` | `error` | `invalid`.
 */
export function inspect(view, list, problems = []) {
    const { defs, invalid } = normalizeEvents(list);
    const state = view?.state;
    const env = { state, query: view?.query };
    const known = new Set(defs.map(def => def.id));
    const events = [];
    for (const def of defs) {
        const row = { id: def.id, pack: def.pack, status: 'waiting', why: '', once: def.once, after: def.after, when: def.when, cue: def.cue };
        if (def.once && claimed(state, def.id)) {
            row.status = 'fired';
            row.why = 'It has happened on this line of the story.';
        } else if (def.after && !claimed(state, def.after)) {
            row.why = known.has(def.after)
                ? `It waits for "${def.after}" to happen first.`
                : `It waits for "${def.after}", which no enabled pack defines.`;
        } else {
            const result = evaluateCondition(def.when, env);
            if (result.error) {
                row.status = 'error';
                row.why = `Its condition can't be checked: ${result.error.message}`;
            } else if (result.met) {
                row.status = 'due';
                row.why = def.once ? 'Its condition is met: it happens before the next reply.' : 'Its condition is met: it repeats before every reply while that holds.';
            } else row.why = 'Its condition is not met yet.';
        }
        events.push(row);
    }
    for (const entry of invalid) events.push({ id: entry.id, pack: entry.pack, status: 'invalid', why: entry.why, once: null, after: null, when: null, cue: null });
    const ids = status => events.filter(row => row.status === status).map(row => row.id);
    return {
        events,
        fired: ids('fired'),
        due: ids('due'),
        waiting: events.filter(row => row.status === 'waiting' || row.status === 'error').map(row => ({ id: row.id, why: row.why })),
        invalid: events.filter(row => row.status === 'invalid').map(row => ({ id: row.id, why: row.why })),
        problems: [...problems],
        defs,
    };
}

// A repeating event's claim for one reply (`at` = the index of the reply being written; a swipe or a
// regenerate writes the same index again, so it does not pay again): once per reply.
export const repeatKey = (id, at) => `event:${id}:${at}`;

/**
 * The `events.fire` handler (SPEC §3.2), for the event definitions `events(view)` gives (the enabled
 * packs'): claim, run `then`, tell the cue. Payload `{ id, at }` as `beforeGenerate` sends it; the cue,
 * `once` and `then` always come from the pack's own definition, never from the payload (B3-1). Runs only
 * as the host's own `system` cue at the top (REFUSED otherwise, and for an id no enabled pack defines or
 * whose condition is not met), and is marked internal for the registry. Its steps run with
 * ctx.caller `event:<id>`. A once event claims `event:<id>`; a repeating one `event:<id>:<at>`
 * (`at` = the index of the reply being written), so it pays at most once per reply (B3-9).
 */
export function createFireEvent(events = () => []) {
    function fireEvent(ctx, payload) {
        if (ctx.cause !== 'system' || ctx.caller) ctx.fail('REFUSED', 'An event happens only when Story Block checks the events before a reply, never from a button, a change line or another command.');
        const idProblem = checkId(payload?.id, 'An event');
        if (idProblem) ctx.fail('INVALID', idProblem);
        // The condition is checked again here, on the transaction's state: its domains are read as asked.
        const domains = new Proxy({}, {
            get: (_, name) => (typeof name === 'string' ? ctx.read(name) ?? undefined : undefined),
            getOwnPropertyDescriptor: (_, name) => {
                const value = typeof name === 'string' ? ctx.read(name) : null;
                return value === null || value === undefined ? undefined : { value, enumerable: true, configurable: true, writable: false };
            },
            has: (_, name) => typeof name === 'string' && ctx.read(name) !== null,
        });
        const view = { state: { domains }, query: (name, args) => ctx.query(name, args) };
        let list;
        try { list = events(view); } catch { list = []; }
        const def = normalizeEvents(Array.isArray(list) ? list : []).defs.find(entry => entry.id === payload.id);
        if (!def) ctx.fail('REFUSED', `No enabled pack has an event "${payload.id}".`);
        const met = evaluateCondition(def.when, view);
        if (met.error || !met.met) ctx.fail('REFUSED', `The event "${def.id}" is not due: its condition is not met.`);
        const at = Number.isSafeInteger(payload.at) && payload.at >= 0 ? payload.at : null;
        if (def.once && !ctx.claim(claimKey(def.id))) ctx.fail('CLAIMED', `The event "${def.id}" has already happened on this line of the story.`);
        if (!def.once && at !== null && !ctx.claim(repeatKey(def.id, at))) ctx.fail('CLAIMED', `The event "${def.id}" has already happened for this reply.`);
        for (const step of def.then) ctx.call(step.command, step.payload, { as: `event:${def.id}` });
        return { summary: def.cue, narrate: true, data: { event: def.id, then: def.then.map(step => step.command) } };
    }
    // An internal command (registry.js): the bus refuses it with cause 'ui' and the public sdk never sends it.
    Object.defineProperty(fireEvent, 'internal', { value: true, enumerable: true });
    return fireEvent;
}

/** events.fire with no events to fire (every id is refused); createEventsPart builds the real one. */
export const fireEvent = createFireEvent();

const isThenable = value => value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';

/** Run `steps` in order; synchronous while every result is, a promise from the first that is not. */
function sequence(steps, onResult) {
    for (let index = 0; index < steps.length; index += 1) {
        let result;
        try {
            result = steps[index]();
        } catch (error) {
            result = { ok: false, code: 'FAILED', message: error?.message ?? String(error) };
        }
        if (isThenable(result)) {
            return Promise.resolve(result)
                .catch(error => ({ ok: false, code: 'FAILED', message: error?.message ?? String(error) }))
                .then(value => {
                    onResult(index, value);
                    return sequence(steps.slice(index + 1), (rest, next) => onResult(index + 1 + rest, next));
                });
        }
        onResult(index, result);
    }
    return undefined;
}

/**
 * The engine around injected dependencies:
 *   events(view) → event definitions from the enabled packs
 *   command(type, payload, { cause }) → { ok, receipt } | { ok: false, code, message } (or a promise of it)
 *   query(name, args) → for `status(state)` outside a beforeGenerate view
 */
export function createEngine({ events, command, query } = {}) {
    let lastRun = { fired: [], failed: [] };

    function read(view) {
        try {
            const list = typeof events === 'function' ? events(view) : [];
            if (isThenable(list)) return { list: [], problems: ['The event list answered later; events are read synchronously.'] };
            return { list: Array.isArray(list) ? list : [], problems: [] };
        } catch (error) {
            return { list: [], problems: [`The event list could not be read: ${error?.message ?? String(error)}`] };
        }
    }

    function report(view) {
        const { list, problems } = read(view);
        return inspect(view, list, problems);
    }

    /**
     * SPEC §4.1 step 3. Commits the due events; returns nothing for the tail (or a promise of nothing).
     * `info.type` is the generation's ('normal', 'swipe', …): a swipe writes the last message again.
     */
    function beforeGenerate(view, info = {}) {
        const result = report(view);
        const dueIds = new Set(result.due);
        const due = result.defs.filter(def => dueIds.has(def.id));
        // A Continue or a dry run commits nothing (turn.js says so with commit: false).
        if (info?.commit === false || info?.dryRun === true || info?.type === 'continue') return undefined;
        const run = { fired: [], failed: [] };
        lastRun = run;
        if (!due.length) return undefined;
        if (typeof command !== 'function') {
            run.failed = due.map(def => ({ id: def.id, code: 'FAILED', message: 'There is no command bus to commit events through.' }));
            return undefined;
        }
        const length = Number.isInteger(view?.chat?.length) ? view.chat.length : null;
        const at = length === null ? null : info?.type === 'swipe' || info?.type === 'continue' ? length - 1 : length;
        const steps = due.map(def => () => command(FIRE, { id: def.id, ...(at === null ? {} : { at }) }, { cause: 'system' }));
        const done = sequence(steps, (index, result) => {
            const { id } = due[index];
            if (result?.ok) run.fired.push(id);
            else run.failed.push({ id, code: result?.code ?? 'FAILED', message: result?.message ?? 'The command gave no answer.' });
        });
        return isThenable(done) ? done.then(() => undefined) : undefined;
    }

    /** The `events.status` query: where each event stands, plus what the last beforeGenerate did. */
    function status(state, view = null) {
        const { defs, ...rest } = report(view ?? { state, query });
        return { ...rest, lastRun: { fired: [...lastRun.fired], failed: lastRun.failed.map(entry => ({ ...entry })) } };
    }

    return { beforeGenerate, status, report };
}
