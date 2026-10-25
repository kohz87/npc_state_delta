// The participant registry (contract §8; docs/v2/TIMELINE.md): modules that keep native state beside the story (NPC
// dossiers and their history) and take part in snapshots and restores. A module declares `participant` in its
// definition; the host registers it when the module is registered (`registerParticipant` is the host's callback, never
// the module's). Each callback is the module's own, called with the contract's input, and answers `{ ok: true, ...fields }`
// or the common failure; whatever else it does (throws, answers nothing, answers the wrong shape) is a FAILED, never a
// success. A callback may be synchronous or return a promise.

import { isHash } from '../replay.js';
import { CODES, crashing, fail, isObject } from './util.js';

export const PARTICIPANT_TIMEOUT_MS = 10000;

// One bound for every asynchronous participant callback, including native prepare. A timed-out
// call remains quarantined until it really settles: a late activation must not race a new selection.
export async function boundedParticipant(callback, timeoutMs = PARTICIPANT_TIMEOUT_MS) {
    let timer;
    try {
        return await Promise.race([Promise.resolve().then(callback), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`participant callback timed out after ${timeoutMs} ms`)), timeoutMs);
        })]);
    } finally { clearTimeout(timer); }
}

export const CALLBACKS = Object.freeze(['checkpoint', 'prepare', 'activate', 'abort', 'status']);
const MODULE_ID = /^[a-z0-9][a-z0-9._-]*$/;
const STATUSES = Object.freeze(['prepared', 'active', 'aborted']);
const text = value => typeof value === 'string' && value.length > 0;

// The fields each callback's success must carry.
const SHAPES = Object.freeze({
    checkpoint: answer => text(answer.checkpoint) && isHash(answer.hash) && Number.isInteger(answer.schema) && answer.schema >= 0,
    prepare: answer => text(answer.prepared) && isHash(answer.hash),
    activate: answer => text(answer.checkpoint) && isHash(answer.hash),
    abort: answer => answer.aborted === true,
    status: answer => text(answer.checkpoint) && isHash(answer.hash) && STATUSES.includes(answer.status),
    applyEvent: answer => text(answer.event) && text(answer.checkpoint) && isHash(answer.hash) && answer.ack === true,
});

export function createParticipants({ timeoutMs = PARTICIPANT_TIMEOUT_MS, chat = () => null } = {}) {
    // Callback state belongs to the chat that began it. Late completion clears only that chat's slot.
    const inflight = new Map();
    async function run(module, callback) {
        const holder = chat();
        let calls = inflight.get(holder);
        if (!calls) { calls = new Map(); inflight.set(holder, calls); }
        if (calls.has(module)) throw new Error(`The participant ${module} still has a timed-out callback in flight.`);
        const pending = Promise.resolve().then(callback);
        calls.set(module, pending);
        const clear = () => {
            if (calls.get(module) === pending) calls.delete(module);
            if (!calls.size && inflight.get(holder) === calls) inflight.delete(holder);
        };
        pending.then(clear, clear);
        return boundedParticipant(() => pending, timeoutMs);
    }
    const table = new Map();
    return {
        /** Registers a participant: → { ok: true, module } | INVALID | CONFLICT. */
        register(spec) {
            if (!isObject(spec) || typeof spec.module !== 'string' || !MODULE_ID.test(spec.module)) return fail('INVALID', 'A participant names its module (like "npc-state-delta").');
            if (!Number.isInteger(spec.schema) || spec.schema < 0) return fail('INVALID', `The participant ${spec.module} names its checkpoint schema (a whole number, 0 or more).`);
            for (const name of CALLBACKS) {
                if (typeof spec[name] !== 'function') return fail('INVALID', `The participant ${spec.module} has no ${name}() callback.`);
            }
            if (spec.applyEvent !== undefined && typeof spec.applyEvent !== 'function') return fail('INVALID', `The participant ${spec.module} has an applyEvent that is not a function.`);
            if (spec.current !== undefined && typeof spec.current !== 'function') return fail('INVALID', `The participant ${spec.module} has a current that is not a function.`);
            if (table.has(spec.module)) return fail('CONFLICT', `The participant ${spec.module} is registered already.`);
            const entry = { module: spec.module, schema: spec.schema };
            for (const name of [...CALLBACKS, 'applyEvent', 'current']) if (typeof spec[name] === 'function') entry[name] = spec[name];
            table.set(spec.module, Object.freeze(entry));
            return { ok: true, module: spec.module };
        },
        has: module => table.has(module),
        ready: () => !inflight.get(chat())?.size,
        run,
        get: module => table.get(module) ?? null,
        /** The registered participants' modules, sorted. */
        modules: () => [...table.keys()].sort(),
        /**
         * The optional synchronous probe `current({ checkpoint, hash, schema })` → `{ ok: true, current: boolean }`: is its native state still the one it handed over? Asked
         * in the section that commits a save point, where nothing may be awaited. → { current: true } (it says so, or has no probe: today's
         * behaviour) | { current: false, why } (it says no, or throws, or answers anything but `{ ok: true, current }`, or a promise: it fails closed).
         */
        probe(module, input) {
            const entry = table.get(module);
            if (typeof entry?.current !== 'function') return { current: true };
            let answer;
            try {
                answer = entry.current(structuredClone(input));
            } catch (error) {
                if (crashing(error)) throw error;
                return { current: false, why: `its probe failed: ${error?.message ?? error}` };
            }
            if (answer && typeof answer.then === 'function') {
                answer.then(null, () => {});
                return { current: false, why: 'its probe did not answer at once' };
            }
            if (isObject(answer) && answer.ok === true && typeof answer.current === 'boolean') {
                return answer.current ? { current: true } : { current: false, why: 'its native state changed after its checkpoint' };
            }
            return { current: false, why: 'its probe answered something other than { ok: true, current: boolean }' };
        },
        /**
         * Calls the participant's `method` with `input` and checks the answer. → the success (as the participant gave it) or
         * a failure envelope: the participant's own failure (unknown codes become FAILED), or FAILED when it threw,
         * answered nothing, or answered the wrong shape. A simulated crash passes through.
         */
        async call(module, method, input) {
            const entry = table.get(module);
            if (!entry) return fail('SNAPSHOT_UNAVAILABLE', `The participant ${module} is not registered, so its saved state cannot be used.`);
            const callback = entry[method];
            if (typeof callback !== 'function') return fail('UNSUPPORTED', `The participant ${module} cannot ${method}.`);
            let answer;
            try {
                answer = await run(module, () => callback(structuredClone(input)));
            } catch (error) {
                if (crashing(error)) throw error;
                return fail('FAILED', `The participant ${module} failed at ${method}: ${error?.message ?? error}`);
            }
            if (!isObject(answer) || typeof answer.ok !== 'boolean') return fail('FAILED', `The participant ${module} answered ${method} with neither a success nor a failure.`);
            if (answer.ok === false) return fail(CODES.includes(answer.code) ? answer.code : 'FAILED', typeof answer.message === 'string' && answer.message ? answer.message : `The participant ${module} could not ${method}.`);
            const shape = SHAPES[method];
            if (shape && !shape(answer)) return fail('FAILED', `The participant ${module} answered ${method} without the fields it must give.`);
            return answer;
        },
    };
}
