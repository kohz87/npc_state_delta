// Story Suite v2: the state store (SPEC §2, §12). State lives in carriers; this module replays it.
//
// * State at carrier N = the latest checkpoint at or before N, then every carrier's `ops` from there
//   through N. Head state = state at the last carrier. Rebuilding replays stored ops only; it never runs a
//   command handler.
// * A carrier that gets its first record also gets a checkpoint (the state before its own ops) when 20
//   carriers have passed since the last checkpoint, or the ops since then exceed 32 KB of JSON.
// * Writes go to the head carrier (actions after reply N belong to reply N, so swiping or deleting reply N
//   takes them back) and only ever touch `extra.storySuite` and the matching `swipe_info` extra.
// * Told and untold (§4.1 step 2): a receipt is told once a carrier at or after its own lists its ID in
//   `narrated`. Untold receipts are the `narrate: true` ones that no such carrier lists, oldest first. "At
//   or after" rather than "after" so a cue committed on the head carrier while it is being re-generated
//   (a swipe) counts as told by that same carrier.
// * Every state handed out is deep-frozen. The head and the checkpoints are cached; the cache is checked
//   against the chat on each read, and `rebuild()` drops it.

import { apply as applyOps } from './ops.js';
import {
    KEY, carrierIndexes, createSaver, isCarrier, lastCarrier, newRecordId, readRecord, writeRecord,
} from './persist.js';

export const CHECKPOINT_EVERY = 20;
export const CHECKPOINT_BYTES = 32 * 1024;

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const utf8 = new TextEncoder();
const jsonBytes = value => utf8.encode(JSON.stringify(value)).length;

export function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const item of Object.values(value)) deepFreeze(item);
    }
    return value;
}

const revOf = state => (Number.isInteger(state?.meta?.rev) ? state.meta.rev : 0);

/**
 * @param {object} options
 * @param {() => object[]} options.chat     the live chat array (SillyTavern's `chat`)
 * @param {() => Promise<void>} options.save  saves the chat (the host checks the head's `rev` after it)
 * @param {() => number} [options.now]       accepted for the §12 interface; the store keeps no clock
 * @param {(state, ops) => object} [options.apply]  defaults to ops.js; tests inject a fake
 * @param {(error) => void} [options.onSaveError]   told when a scheduled (not flushed) save fails
 * @param {object} [options.timers]          { setTimeout, clearTimeout } for tests
 * @param {number} [options.checkpointEvery] / [options.checkpointBytes]  thresholds (default 20 / 32 KB)
 * @param {() => string} [options.recordId]  ID of a new carrier record
 */
export function createStore({
    chat, save, now = null, apply = applyOps, onSaveError = null, timers = globalThis,
    checkpointEvery = CHECKPOINT_EVERY, checkpointBytes = CHECKPOINT_BYTES, recordId = newRecordId,
} = {}) {
    if (typeof chat !== 'function') throw new TypeError('createStore needs a chat() function.');
    if (typeof apply !== 'function') throw new TypeError('createStore needs an apply(state, ops) function.');
    void now;
    const saver = createSaver({ save, onError: onSaveError, timers });
    let frozenCheckpoints = new WeakMap();
    let cache = null;          // { key, state, problems }

    const list = () => {
        const arr = chat();
        return Array.isArray(arr) ? arr : [];
    };

    function checkpointState(raw) {
        let state = frozenCheckpoints.get(raw);
        if (!state) frozenCheckpoints.set(raw, state = deepFreeze(structuredClone(raw)));
        return state;
    }

    // Ops are cloned on the way in so nothing the chat holds ends up inside (and frozen with) a state.
    function step(state, ops) {
        return ops.length ? deepFreeze(apply(state, structuredClone(ops))) : state;
    }

    // State after the last carrier at or before `upTo`, or null when no checkpoint precedes it. Ops that
    // no longer apply (a hand-edited chat) are skipped and reported, so a bad carrier cannot block the rest.
    function replay(arr, upTo) {
        let from = -1;
        for (let i = Math.min(upTo, arr.length - 1); i >= 0; i--) {
            if (readRecord(arr[i])?.checkpoint) { from = i; break; }
        }
        if (from < 0) return { state: null, problems: [] };
        let state = checkpointState(readRecord(arr[from]).checkpoint);
        const problems = [];
        for (let i = from; i <= upTo && i < arr.length; i++) {
            const record = readRecord(arr[i]);
            if (!record) continue;
            try {
                state = step(state, record.ops);
            } catch (error) {
                problems.push({ index: i, message: `The changes stored on message ${i} no longer apply and were skipped: ${error?.message ?? error}` });
            }
        }
        return { state, problems };
    }

    function headKey(arr) {
        const index = lastCarrier(arr);
        const message = arr[index];
        return { arr, length: arr.length, index, message, swipe: message?.swipe_id, extra: message?.extra,
            record: message?.extra?.[KEY] };
    }

    const sameKey = (a, b) => Object.keys(a).every(name => a[name] === b[name]);

    function current() {
        const arr = list();
        const key = headKey(arr);
        if (!cache || !sameKey(cache.key, key)) {
            const { state, problems } = key.index < 0 ? { state: null, problems: [] } : replay(arr, key.index);
            cache = { key, state, problems };
        }
        return cache;
    }

    // After a write that changed the head carrier's record: keep the cache, with the new key.
    function retain(arr, state, problems = cache?.problems ?? []) {
        cache = { key: headKey(arr), state, problems };
    }

    function carrierAt(arr, index) {
        if (!Number.isInteger(index) || index < 0 || index >= arr.length) {
            throw new RangeError(`There is no message ${index} in this chat.`);
        }
        if (!isCarrier(arr[index])) throw new RangeError(`Message ${index} is the user's; it holds no story state.`);
        return arr[index];
    }

    function stateBefore(arr, index) {
        const prev = lastCarrier(arr, index);
        return prev < 0 ? null : replay(arr, prev).state;
    }

    // Does a new record on carrier `index` need a checkpoint? Counts the carriers and the op JSON since
    // the last checkpoint before it.
    function needsCheckpoint(arr, index) {
        let carriers = 0;
        let bytes = 0;
        for (let i = index - 1; i >= 0; i--) {
            if (!isCarrier(arr[i])) continue;
            carriers++;
            const record = readRecord(arr[i]);
            if (record?.ops.length) bytes += jsonBytes(record.ops);
            if (record?.checkpoint) return carriers >= checkpointEvery || bytes > checkpointBytes;
            if (carriers >= checkpointEvery) return true;
        }
        return false;
    }

    // The carrier's record to build on: its own, or a fresh one (with a checkpoint when one is due).
    // `before` is the state before the carrier when the caller already has it.
    function take(arr, index, before) {
        const message = carrierAt(arr, index);
        const own = readRecord(message);
        if (own) return { message, record: own, fresh: false };
        const record = { v: 2, sid: recordId(), ops: [], receipts: [], narrated: [], spans: [] };
        if (needsCheckpoint(arr, index)) {
            const base = before === undefined ? stateBefore(arr, index) : before;
            if (base) record.checkpoint = structuredClone(base);
        }
        return { message, record, fresh: true };
    }

    function spansOf(record) {
        const spans = Array.isArray(record.spans) ? record.spans : null;
        const total = spans?.reduce((sum, span) => sum + (Number.isInteger(span?.n) ? span.n : NaN), 0);
        if (spans && total === record.ops.length) return spans;
        // A record without usable spans: fine as one kept block if it holds no story receipts.
        if (!record.receipts.some(receipt => receipt?.cause === 'story')) return [{ n: record.ops.length, story: false }];
        return null;
    }

    function asOps(ops) {
        if (ops === undefined || ops === null) return [];
        if (!Array.isArray(ops)) throw new TypeError('Ops must be an array.');
        return structuredClone(ops);
    }

    return {
        head() {
            return current().state;
        },

        at(index) {
            const arr = list();
            if (!Number.isInteger(index) || index < 0 || index >= arr.length) {
                throw new RangeError(`There is no message ${index} in this chat.`);
            }
            const head = current();
            if (index >= head.key.index) return head.state;
            return replay(arr, index).state;
        },

        headIndex() {
            return lastCarrier(list());
        },

        // Carrier `index`'s own ops (frozen copies), [] for a message with no record.
        opsAt(index) {
            const arr = list();
            if (!Number.isInteger(index) || index < 0 || index >= arr.length) return [];
            return deepFreeze(structuredClone(readRecord(arr[index])?.ops ?? []));
        },

        // The JSON Pointers carrier `index`'s ops touched, in first-touched order (for a card's
        // "only what changed" and changed(path)). [] for a message with no record.
        changesAt(index) {
            const arr = list();
            if (!Number.isInteger(index) || index < 0 || index >= arr.length) return [];
            const record = readRecord(arr[index]);
            return [...new Set((record?.ops ?? []).map(op => op?.path).filter(path => typeof path === 'string'))];
        },

        // Problems met by the last head rebuild: carriers whose stored ops no longer apply.
        problems() {
            return current().problems.map(problem => ({ ...problem }));
        },

        ensureInitial(initialState) {
            if (!isObject(initialState)) throw new TypeError('The initial state must be an object.');
            if (current().state) return;
            const arr = list();
            const first = carrierIndexes(arr)[0];
            if (first === undefined) return;
            const checkpoint = structuredClone(initialState);
            writeRecord(arr[first], { v: 2, sid: recordId(), checkpoint, ops: [], receipts: [], narrated: [],
                spans: [], rev: revOf(checkpoint) });
            saver.touch();
            cache = null;
        },

        append({ ops, receipt = null } = {}) {
            const arr = list();
            const index = lastCarrier(arr);
            if (index < 0) throw new Error('There is no reply in this chat to hold the change yet.');
            const base = current().state;
            if (!base) throw new Error('This chat has no story state yet.');
            const added = asOps(ops);
            if (receipt !== null && !isObject(receipt)) throw new TypeError('A receipt must be an object.');
            if (!added.length && !receipt) return;
            const next = step(base, added);       // throws on a bad op: nothing is written
            const { message, record } = take(arr, index, base);
            if (typeof receipt?.id === 'string' && record.receipts.some(known => known?.id === receipt.id)) {
                throw new Error(`Receipt ${receipt.id} is already stored on this reply.`);
            }
            writeRecord(message, {
                ...record,
                ops: [...record.ops, ...added],
                receipts: receipt ? [...record.receipts, structuredClone(receipt)] : record.receipts,
                spans: [...(spansOf(record) ?? []), { n: added.length, story: receipt?.cause === 'story' }],
                rev: revOf(next),
            });
            saver.touch();
            retain(arr, next);
        },

        // Re-read: the carrier's `story` receipts and their ops are replaced; ui and system receipts stay,
        // after the new story ops. Later carriers are replayed on top so their checkpoints stay true; if any
        // later change no longer applies, nothing is written and this throws.
        replaceStory(index, { ops, receipts = [] } = {}) {
            const arr = list();
            const message = carrierAt(arr, index);
            if (!Array.isArray(receipts) || receipts.some(receipt => !isObject(receipt) || receipt.cause !== 'story')) {
                throw new TypeError('Re-read takes story receipts only.');
            }
            const before = stateBefore(arr, index);
            const startsHere = readRecord(message)?.checkpoint;
            const base = startsHere ? checkpointState(startsHere) : before;
            if (!base) throw new Error('This chat has no story state yet.');
            const { record } = take(arr, index, before);
            const spans = spansOf(record);
            if (!spans) throw new Error('The story changes on this reply cannot be told apart from the others.');
            const kept = [];
            const keptSpans = [];
            let at = 0;
            for (const span of spans) {
                if (!span.story) {
                    kept.push(...record.ops.slice(at, at + span.n));
                    keptSpans.push({ n: span.n, story: false });
                }
                at += span.n;
            }
            const fresh = asOps(ops);
            const nextOps = [...fresh, ...kept];
            let state;
            try {
                state = step(base, nextOps);
            } catch (error) {
                throw new Error(`The new story changes and this reply's other changes do not fit together: ${error?.message ?? error}`);
            }
            const writes = [[message, {
                ...record,
                ops: nextOps,
                receipts: [...structuredClone(receipts), ...record.receipts.filter(receipt => receipt?.cause !== 'story')],
                spans: [{ n: fresh.length, story: true }, ...keptSpans],
                rev: revOf(state),
            }]];
            for (let i = index + 1; i < arr.length; i++) {
                const later = readRecord(arr[i]);
                if (!later) continue;
                const checkpoint = later.checkpoint ? structuredClone(state) : undefined;
                try {
                    state = step(state, later.ops);
                } catch (error) {
                    throw new Error(`A later change (message ${i}) depends on this reply's old story changes: ${error?.message ?? error}`);
                }
                if (checkpoint) writes.push([arr[i], { ...later, checkpoint, rev: revOf(state) }]);
            }
            for (const [target, next] of writes) writeRecord(target, next);
            saver.touch();
            retain(arr, state, []);
        },

        setNarrated(index, ids) {
            if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
                throw new TypeError('Narrated receipts must be a list of receipt IDs.');
            }
            const arr = list();
            const head = current();
            const atHead = index === head.key.index;
            const { message, record, fresh } = take(arr, index, atHead ? head.state : undefined);
            const rev = fresh ? revOf(atHead ? head.state : stateBefore(arr, index)) : record.rev;
            writeRecord(message, { ...record, narrated: [...new Set(ids)], ...(rev === undefined ? {} : { rev }) });
            saver.touch();
            if (atHead) retain(arr, head.state, head.problems);
        },

        // Every stored receipt on the current line of history, in chat order: [{ index, receipt }]
        // (the carriers the head is built from; frozen copies).
        receipts() {
            const arr = list();
            const out = [];
            let started = false;
            for (const i of carrierIndexes(arr)) {
                const record = readRecord(arr[i]);
                if (record?.checkpoint) started = true;
                if (!started || !record) continue;
                for (const receipt of record.receipts) if (isObject(receipt)) out.push({ index: i, receipt });
            }
            return deepFreeze(structuredClone(out));
        },

        // Return in time (MODULES §F17): drops the head carrier's receipts with rev >= beforeRev and
        // their ops, so the head is the state just before the first of them. Each receipt's ops end with
        // its `/meta/rev` op, which is where they are cut. Only the head carrier (nothing after it holds
        // state that depends on it). Returns { dropped: receipt ids, rev }.
        truncate(index, beforeRev) {
            const arr = list();
            if (index !== lastCarrier(arr)) throw new RangeError(`Message ${index} is not the last reply that keeps the story, so its changes cannot be taken back alone.`);
            if (!Number.isInteger(beforeRev) || beforeRev < 1) throw new TypeError('beforeRev must be a whole number of 1 or more.');
            const message = carrierAt(arr, index);
            const record = readRecord(message);
            if (!record) return { dropped: [], rev: revOf(current().state) };
            const chunks = [];
            let start = 0;
            record.ops.forEach((op, at) => {
                if (op?.path === '/meta/rev') {
                    chunks.push({ ops: record.ops.slice(start, at + 1), rev: op.value });
                    start = at + 1;
                }
            });
            if (start < record.ops.length) chunks.push({ ops: record.ops.slice(start), rev: null });
            const cut = chunks.findIndex(chunk => chunk.rev === null || chunk.rev >= beforeRev);
            const kept = cut < 0 ? chunks : chunks.slice(0, cut);
            const keptRevs = new Set(kept.map(chunk => chunk.rev));
            const receipts = record.receipts.filter(receipt => keptRevs.has(receipt?.rev));
            const dropped = record.receipts.filter(receipt => !keptRevs.has(receipt?.rev)).map(receipt => receipt?.id);
            const base = record.checkpoint ? checkpointState(record.checkpoint) : stateBefore(arr, index);
            if (!base) throw new Error('This chat has no story state yet.');
            const ops = kept.flatMap(chunk => chunk.ops);
            const state = step(base, ops);
            const byRev = new Map(receipts.map(receipt => [receipt.rev, receipt]));
            writeRecord(message, {
                ...record,
                ops,
                receipts,
                spans: kept.map(chunk => ({ n: chunk.ops.length, story: byRev.get(chunk.rev)?.cause === 'story' })),
                narrated: record.narrated.filter(id => !dropped.includes(id)),
                rev: revOf(state),
            });
            saver.touch();
            retain(arr, state, []);
            return { dropped, rev: revOf(state) };
        },

        untold() {
            const arr = list();
            const records = [];
            for (const i of carrierIndexes(arr)) {
                const record = readRecord(arr[i]);
                if (record?.checkpoint || (records.length && record)) records.push(record);
            }
            const told = new Set();
            const out = [];
            for (let r = records.length - 1; r >= 0; r--) {
                for (const id of records[r].narrated) told.add(id);
                const receipts = records[r].receipts;
                for (let k = receipts.length - 1; k >= 0; k--) {
                    if (receipts[k]?.narrate === true && !told.has(receipts[k].id)) out.push(receipts[k]);
                }
            }
            return deepFreeze(structuredClone(out.reverse()));
        },

        rebuild() {
            frozenCheckpoints = new WeakMap();
            cache = null;
            current();
        },

        scheduleSave(ms = 400) { saver.schedule(ms); },
        flush() { return saver.flush(); },
        dirty() { return saver.dirty(); },
    };
}
