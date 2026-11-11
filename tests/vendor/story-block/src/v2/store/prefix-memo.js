// Story Suite v2: the incremental prefix memo. A reply only appends a carrier, so the state after every older
// carrier stays valid. This keeps those states by the exact prefix each was replayed over, in a bounded LRU, and
// steps one new unguarded record from the previous state instead of replaying a checkpoint window again.

import { isCarrier, lastCarrier, readRecord } from '../persist.js';
import { hashJson } from '../replay.js';
import { deepFreeze } from './constants.js';
import { hasMeta } from './digest.js';

/** The most states one chat keeps in the prefix memo. An evicted state is simply replayed again. */
export const PREFIX_MEMO_MAX = 512;

const textOf = (read, fallback = '?') => {
    try { return String(read()); } catch { return fallback; }
};

export function createPrefixMemo(s, deps) {
    const { chain, chatId, markNow, marked, replay, replayEnv, replayRecord, spineStep } = deps;
    const cache = s.prefixes instanceof Map ? s.prefixes : (s.prefixes = new Map());
    const checkpoints = new WeakMap();
    // The earliest replan point (s.replanFrom's kind) the replay of each kept state found. A hit or a step skips that replay, so it lowers
    // s.replanFrom again from here; without it a witness built on a shared base would keep no replan point at all.
    const replans = new WeakMap();
    const lower = state => {
        const at = state !== null && typeof state === 'object' ? replans.get(state) : undefined;
        if (at !== undefined && at < s.replanFrom) s.replanFrom = at;
    };
    function replayKept(arr, index) {
        const before = s.replanFrom;
        s.replanFrom = Infinity;
        let found = Infinity;
        let state;
        try { state = deepFreeze(replay(arr, index).state); } finally { found = s.replanFrom; s.replanFrom = Math.min(before, found); }
        if (state !== null && typeof state === 'object') replans.set(state, found);
        return state;
    }
    const bump = name => {
        if (!s.counts) return;
        s.counts[name] = (Number.isFinite(s.counts[name]) ? s.counts[name] : 0) + 1;
    };

    // The spine covers replay inputs, but intentionally omits later checkpoints and their trust fields (`owned`, the proof owners a guard may ask, included). Chain those
    // separately for this memo: changing one can change where replay starts even when the ordinary spine is unchanged.
    // Both links are cached per immutable record, so an unchanged pass costs one lookup per carrier/checkpoint.
    function spineRun(arr) {
        const out = new Array(arr.length);
        let hash = '';
        let checkpointHash = '';
        let first = true;
        for (let i = 0; i < arr.length; i++) {
            if (!isCarrier(arr[i])) continue;
            const record = readRecord(arr[i]);
            if (!record) continue;
            hash = spineStep(hash, record, arr[i], first);
            if (record.checkpoint) {
                const hit = checkpoints.get(record);
                if (hit && hit.prev === checkpointHash) checkpointHash = hit.out;
                else {
                    const trust = {};
                    for (const field of ['prefix', 'covers', 'coverHash', 'guardEnv', 'owned']) {
                        if (record[field] !== undefined) trust[field] = record[field];
                    }
                    const out = hashJson({ p: checkpointHash, checkpoint: record.checkpoint, trust });
                    checkpoints.set(record, { prev: checkpointHash, out });
                    checkpointHash = out;
                }
            }
            first = false;
            out[i] = JSON.stringify([hash, checkpointHash]);
        }
        return out;
    }

    // The exact key: the spine hash through the carrier, then the replay environment (Features), the guard mark
    // when guards have been seen, the reply mark, and the chat id. Each part is a string, in this fixed order.
    function keyOf(spine) {
        return JSON.stringify([
            String(spine),
            textOf(replayEnv),
            s.guardSeen ? textOf(markNow) : '',
            textOf(marked),
            textOf(chatId),
        ]);
    }

    function touch(key) {
        const state = cache.get(key);
        cache.delete(key);
        cache.set(key, state);
        return state;
    }

    function remember(key, state) {
        if (cache.has(key)) cache.delete(key);
        cache.set(key, state);
        while (cache.size > PREFIX_MEMO_MAX) cache.delete(cache.keys().next().value);
    }

    // The state of the nearest earlier carrier with a record. Carriers without records do not change the state,
    // so they are passed over; a record that is not in the memo cannot be passed over, because its ops matter.
    function previous(arr, index, spines) {
        for (let i = index - 1; i >= 0; i--) {
            if (!isCarrier(arr[i])) continue;
            const record = readRecord(arr[i]);
            if (!record || spines[i] === undefined) continue;
            const key = keyOf(spines[i]);
            return cache.has(key) ? { key, state: cache.get(key) } : null;
        }
        return null;
    }

    /**
     * The state after carrier `index`. A hit is returned as stored (deep-frozen). A miss steps the one new
     * record from the previous carrier's memo when the record has no checkpoint and no guarded block occurs
     * through it; otherwise it replays through the store's normal checkpoint chain.
     *
     * `spines` is optional: pass the result of one spineRun(arr) to reuse it across a synchronous witness scope.
     */
    function stateAfterPrefix(arr, index, spines = null) {
        if (!Array.isArray(arr)) throw new TypeError('stateAfterPrefix needs the chat array.');
        if (!Number.isInteger(index) || index < 0 || index >= arr.length) {
            throw new RangeError(`There is no message ${index} in this chat.`);
        }
        const run = spines ?? spineRun(arr);
        const record = isCarrier(arr[index]) ? readRecord(arr[index]) : null;
        if (!record) {
            const before = lastCarrier(arr, index);
            return before < 0 ? null : stateAfterPrefix(arr, before, run);
        }

        if (s.applying || s.staged) {
            bump('prefixReplays');
            return replay(arr, index).state;
        }

        const spine = run[index];
        if (spine === undefined) {
            bump('prefixReplays');
            return replay(arr, index).state;
        }
        const key = keyOf(spine);
        if (cache.has(key)) {
            bump('prefixHits');
            const kept = touch(key);
            lower(kept);
            return kept;
        }

        const fast = !record.checkpoint && !hasMeta(record) && !chain(arr, index).history;
        if (fast) {
            const prior = previous(arr, index, run);
            if (prior && prior.state !== null && prior.state !== undefined) {
                const state = deepFreeze(replayRecord(prior.state, record, index, [], null, arr[index]));
                touch(prior.key);
                if (state !== null && typeof state === 'object') {
                    const at = replans.get(prior.state);
                    if (at !== undefined) replans.set(state, at);
                }
                lower(state);
                bump('prefixSteps');
                bump('recordsRead');
                remember(key, state);
                return state;
            }
        }

        bump('prefixReplays');
        const state = replayKept(arr, index);
        remember(key, state);
        return state;
    }

    return { spineRun, stateAfterPrefix };
}
