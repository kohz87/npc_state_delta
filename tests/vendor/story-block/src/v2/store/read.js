// Story Suite v2: the store's reads (head, at, opsAt, problems, proofs, boundary, timelineMarkers, ...), the reader's repairs (startOver,
// keepEarliest, ensureInitial) and the timeline witness (prefixWitness, witnessScope, witnessMemoSize, witnessFresh), moved out of createStore
// unchanged: the methods of `api` that read the chat and the memos. `createRead(s, deps)` returns them as one object and createStore puts
// each in `api` at the place it was. It is given the store's state holder `s` and the store functions it calls (memo.js's come from
// createMemo); `deps.api` is only used as `api.sourceAt(...)`. It never imports store.js. The witness answers are also kept by the identity
// of their own prefix (prefixKey), so a write or a lifecycle flip elsewhere in the chat does not make every boundary be worked out again.

import { KEY, carrierIndexes, isCarrier, lastCarrier, readRecord, swipeOf } from '../persist.js';
import { isObject, revOf, deepFreeze } from './constants.js';
import { deriveId, hashJson, isMetaSpan } from '../replay.js';
import { hasMeta, payloadHashOf } from './digest.js';
import { markerProblem } from '../timeline/boundary.js';

// The most witness answers kept by the identity of their own prefix (outside forgetMemos; the oldest goes first).
const BY_PREFIX_MAX = 2048;

export function createRead(s, deps) {
    const { archive, chatId, marked, replayEnv } = deps;
    const byPrefixMax = Number.isInteger(deps.witnessPrefixMax) && deps.witnessPrefixMax > 0 ? deps.witnessPrefixMax : BY_PREFIX_MAX;     // (a smaller cap is for tests)
    const text = read => { try { return String(read()); } catch { return '?'; } };
    // The one carrier each (sid, swipeKey) names in this generation (null when none or several), worked out once per generation.
    function uniqueIndex(gen, arr, cursor) {
        if (!gen.sources) {
            gen.sources = new Map();
            for (const index of carrierIndexes(arr)) {
                const source = deps.api.sourceAt(index);
                if (!source) continue;
                const k = `${source.sid}\u0000${source.swipeKey}`;
                gen.sources.set(k, gen.sources.has(k) ? -1 : index);
            }
        }
        const at = gen.sources.get(`${cursor.sid}\u0000${cursor.swipeKey}`);
        return Number.isInteger(at) && at >= 0 ? at : null;
    }
    // Everything a witness answer reads, by the prefix it is about: the cursor, its carrier and the chained hash of every replay input
    // through it (spineRun, checkpoint chain and guarded text included), the boundary message's text, the Features, the guard mark,
    // the reply mark, the chat, the source archive (the replay environment carries the Features and the registered replay rules; a checkpoint's proof owners are in the spine run). Null: no memo (the cursor is not unique in the chat, or has no record).
    function prefixKey(gen, arr, cursor, key) {
        const index = uniqueIndex(gen, arr, cursor);
        if (index === null) return null;
        const open = s.scopeSpines && s.scopeSpines.arr === arr && s.scopeSpines.epoch === s.epoch;
        const run = open ? s.scopeSpines.run : (gen.spines ??= deps.spineRun(arr));
        if (run[index] === undefined) return null;
        return JSON.stringify([key, index, run[index], payloadHashOf(arr[index]), text(replayEnv), s.guardSeen ? deps.markSeen() : '', text(marked), text(chatId), archive().size]);
    }
    const { api, blockParts, blocksBefore, carriedTo, chainHash, current, faultsNow, forgetMemos, idsOf, keptNow, list, listProofs, markSeen, memoAt, prefixWitnessUncached, preservedAt, rawKind, readOnlyMessage, reservedSid, saver, sidFor, sourceFor, spansFor, spineRun, witnessGeneration, witnessKeyOf, write } = deps;

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
            return memoAt(arr, index);
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

        // Problems met by the last head rebuild: [{ index, block, receipts, why, message }], one per block
        // of stored ops that no longer applies (`receipts`: the IDs whose changes were skipped).
        problems() {
            const problems = current().problems.map(problem => ({ ...problem, receipts: [...(problem.receipts ?? [])] }));
            for (const fault of faultsNow().values()) {
                const index = list().indexOf(fault.message);
                if (index < 0) continue;
                const source = api.sourceAt(index);
                if (source?.sid !== fault.source.sid || source?.swipeKey !== fault.source.swipeKey) continue;
                if (problems.some(problem => problem.index === index && problem.why.includes(fault.why))) continue;
                problems.push({ index, block: null, receipts: [], why: fault.why, code: 'REPLAY_PREREQUISITE',
                    message: `A replay guard on message ${index} refused its planned changes: ${fault.why}` });
            }
            return problems;
        },

        // Why the head is only the empty read-only state: the first record is a future version's, an older one's or
        // damaged ('future' | 'legacy' | 'damaged'), or the replies before the earliest saved point are gone and
        // unseen ('unresolved'); it is kept as it is. → { index, kind, why }, else null. Nothing is written meanwhile.
        readOnly() {
            const kept = keptNow();
            return kept ? { index: kept.index, kind: kept.kind, why: kept.why } : null;
        },

        // The reader's own repair (never automatic; each needs `{ confirmed: true }`, the caller has asked the reader):
        // * startOver: the story's state starts over from its beginning, the replies after it replaying on top. A
        //   damaged or older record on any reply is set aside beside where it was (`extra.storySuiteAside`, a list that only
        //   grows: each repair adds its records), not lost.
        //   Not for a record from a newer version: update Story Block.
        // * keepEarliest (unresolved only): the earliest saved point is trusted as the start of the story.
        startOver({ confirmed = false } = {}) {
            const kept = keptNow();
            if (!kept) throw new Error('The story record is not being kept aside; there is nothing to start over.');
            if (kept.kind === 'future') throw new Error('The story record is from a newer version of Story Block, so it is not started over; update Story Block to read it.');
            if (confirmed !== true) throw new Error('Starting the story state over needs the reader\'s confirmation.');
            const arr = list();
            for (const message of arr) {
                if (!isCarrier(message)) continue;
                const raw = message.extra?.[KEY];
                const kind = rawKind(raw);
                if (kind !== 'legacy' && kind !== 'damaged') continue;
                // Every record set aside is kept, in the order it was: a later repair adds to the list, never replaces an entry.
                const earlier = message.extra.storySuiteAside;
                // (a list of { kind, record } entries is ours; anything else that is there, an array of records from before included, is one earlier record)
                const ours = Array.isArray(earlier) && earlier.every(entry => isObject(entry) && typeof entry.kind === 'string' && Object.hasOwn(entry, 'record'));
                const kept = ours ? earlier : earlier === undefined ? [] : [{ kind: 'earlier', record: earlier }];
                message.extra.storySuiteAside = [...kept, { kind, record: structuredClone(raw) }];
                delete message.extra[KEY];
                const info = Array.isArray(message.swipe_info) ? message.swipe_info[swipeOf(message)] : null;
                if (isObject(info?.extra) && info.extra !== message.extra && rawKind(info.extra[KEY]) === kind) delete info.extra[KEY];
            }
            const first = carrierIndexes(arr)[0];
            const message = arr[first];
            const checkpoint = structuredClone(s.fallback);
            // The checkpoints after it hold the story the start used to be: they go (the story builds new ones as it grows).
            for (const i of carrierIndexes(arr)) {
                if (i === first) continue;
                const record = readRecord(arr[i]);
                if (!record?.checkpoint) continue;
                const { checkpoint: gone, covers, coverHash, guardEnv, prefix, carried, owned, ...rest } = record;
                void gone; void covers; void coverHash; void guardEnv; void prefix; void carried; void owned;
                write(arr[i], rest);
            }
            const own = readRecord(message);
            const { covers, coverHash, guardEnv, prefix, carried, owned, ...rest } = own ?? {};
            void covers; void coverHash; void guardEnv; void prefix; void carried; void owned;
            write(message, own
                ? { ...rest, checkpoint, rev: revOf(checkpoint) }
                : { v: 2, sid: sidFor(message), checkpoint, ops: [], receipts: [], narrated: [], spans: [], rev: revOf(checkpoint) });
            saver.touch();
            s.cache = null;
            forgetMemos();
            return { index: first };
        },
        keepEarliest({ confirmed = false } = {}) {
            const kept = keptNow();
            if (kept?.kind !== 'unresolved') throw new Error('There is no unresolved start to keep a saved point of.');
            if (confirmed !== true) throw new Error('Keeping the earliest saved point needs the reader\'s confirmation.');
            const arr = list();
            const { covers, coverHash, prefix, carried, owned, ...rest } = readRecord(arr[kept.index]);
            void covers; void coverHash; void prefix; void carried; void owned;     // (the first record there is: trusted as the start, whatever was in front of it)
            write(arr[kept.index], rest);
            saver.touch();
            s.cache = null;
            forgetMemos();
            return { index: kept.index };
        },

        // A chat with no state yet gets one on its first carrier. A record already there is never
        // replaced: it gets the starting point it lacks (the state the deleted carriers before it ended
        // with, else `initialState`) and keeps its own changes. A first record that is a newer version's, an older
        // one's or damaged is never written over or repaired, and a story whose first replies are gone and unseen
        // (the earliest checkpoint left cannot be checked) is not adopted or reset by itself: both are kept as they
        // are, read-only, and the reader decides (startOver / keepEarliest). Returns notes for the Problems list.
        ensureInitial(initialState) {
            if (!isObject(initialState)) throw new TypeError('The initial state must be an object.');
            const head = current();
            idsOf(list());    // the baseline of the ids this chat holds, for what is deleted before anything is written
            if (head.state && !keptNow()) return [];
            const arr = list();
            const first = carrierIndexes(arr)[0];
            if (first === undefined) return [];
            const keepAside = () => {
                if (!s.fallback) {
                    s.fallback = deepFreeze(structuredClone(initialState));
                    s.cache = null;
                    forgetMemos();
                }
                const kept = preservedAt(arr, true);
                const key = `${kept.kind}:${kept.index}:${kept.raw ? JSON.stringify(kept.raw).length : 0}`;
                if (s.noted === key) return [];
                s.noted = key;
                return [readOnlyMessage(kept)];
            };
            if (preservedAt(arr)) return keepAside();
            const message = arr[first];
            const carried = carriedTo(message);
            // The replies before the first one that is left are gone and this session never saw them: the earliest
            // checkpoint that survives cannot be checked, so nothing is adopted and the story is not reset to its start.
            if (!carried && carrierIndexes(arr).some(i => readRecord(arr[i])?.checkpoint)) return keepAside();
            const checkpoint = carried ?? structuredClone(initialState);
            const own = readRecord(message);
            const { covers, coverHash, prefix, carried: droppedProblems, owned: droppedOwners, ...base } = own ?? {};
            void covers; void coverHash; void prefix; void droppedProblems; void droppedOwners;
            const record = own
                ? { ...base, sid: typeof own.sid === 'string' ? own.sid : sidFor(message), checkpoint,
                    rev: Number.isInteger(own.rev) ? own.rev : revOf(checkpoint) }
                : { v: 2, sid: sidFor(message), checkpoint, ops: [], receipts: [], narrated: [], spans: [], rev: revOf(checkpoint) };
            write(message, record);
            saver.touch();
            s.cache = null;
            forgetMemos();
            return [];
        },

        /**
         * The proof of the chat's blocks, in apply order: [{ proof, block, index }] (frozen). Only the blocks that applied
         * (replay's own account of them: a block that was skipped, is off, collided on a proof id or is damaged gives none;
         * before the first checkpoint replay starts from, the blocks that could apply), so the one that owns an id is the
         * one that applied with it. Not yet active: the state pins the active ones (evidence.js visibleProofs, the
         * `story.evidence` query). `{ all: true }`: the proof of every block that could apply, whether it did or not (what
         * a new proof must not take an id from).
         */
        proofs(options = {}) {
            return listProofs(options?.all === true);
        },

        /** The guarded block of carrier `index` whose Source ordinal is `ordinal` (a step planned again names its own): { block, op } (its id, the changes before it), or null. */
        blockAt(index, ordinal) {
            const arr = list();
            const record = isCarrier(arr[index]) ? readRecord(arr[index]) : null;
            if (!record) return null;
            let op = 0;
            for (const span of spansFor(record)) {
                if (isMetaSpan(span) && span.source?.ordinal === ordinal) return { block: span.id, op };
                op += Number.isInteger(span?.n) ? span.n : 0;
            }
            return null;
        },

        /** The first carrier seen holding a guarded step with a `replan`, or blocks numbered at or below the rev before them (the turn reconciles from it), else null. */
        replansFrom() {
            return Number.isFinite(s.replanFrom) ? s.replanFrom : null;
        },

        /**
         * The guarded blocks whose recorded boundary (prefix hash) is not what the chat as it stands gives: [{ index, block }].
         * Empty after a Re-read or a reconcile that was staged right, and for a chat nobody edited; a reply edited since
         * its blocks were stored shows here too (its text is part of the prefix).
         */
        boundaryProblems() {
            const arr = list();
            const out = [];
            for (let i = 0; i < arr.length; i++) {
                const record = isCarrier(arr[i]) ? readRecord(arr[i]) : null;
                if (!record || !hasMeta(record)) continue;
                const before = chainHash(arr, i);
                const earlier = [];
                for (const part of blockParts(record)) {
                    if (isMetaSpan(part.span) && part.span.boundaries?.[0]) {
                        const expected = hashJson({ p: before, k: record.source?.swipeKey, t: payloadHashOf(arr[i]), b: blocksBefore(earlier) });
                        if (expected !== part.span.boundaries[0].prefixHash) out.push({ index: i, block: part.span.id });
                    }
                    earlier.push(part);
                }
            }
            return out;
        },

        /** The hash of the text of carrier `index`'s shown swipe as evidence (what a block's boundary recorded). */
        payloadHashAt(index) {
            const message = list()[index];
            return isCarrier(message) ? payloadHashOf(message) : null;
        },

        /**
         * Where the committed story ends (the timeline's head, contract §8): the cursor and the prefix hash a block
         * stored now would start at, so `{ cursor, prefixHash }` is exactly the boundary that block's span will carry
         * (apart from its own block id: `cursor.block` is the last block's on the head reply, or a stand-in worked out
         * from the position when it has none). `payloadHash` is the head reply's text as evidence; `source` its Source.
         * null without a carrier or a state. Nothing is written (a first record's id is only reserved, as sourceAt does).
         */
        boundary() {
            const arr = list();
            const index = lastCarrier(arr);
            if (index < 0) return null;
            const head = current();
            if (!head.state) return null;
            const message = arr[index];
            const record = readRecord(message);
            const sid = record ? record.sid : reservedSid(message);
            if (typeof sid !== 'string') return null;
            const entry = isObject(record?.source) ? record.source : sourceFor(arr, message, sid);
            const spans = record ? spansFor(record) : [];
            const parts = record ? blockParts({ ...record, spans, ops: record.ops }) : [];
            const op = record ? record.ops.length : 0;
            const last = [...spans].reverse().find(isMetaSpan);
            return {
                index,
                cursor: { sid: entry.logical, swipeKey: entry.swipeKey, block: last ? last.id : deriveId('bl', `end:${entry.swipeKey}:${op}`), op, rev: revOf(head.state) },
                prefixHash: hashJson({ p: chainHash(arr, index), k: entry.swipeKey, t: payloadHashOf(message), b: blocksBefore(parts) }),
                payloadHash: payloadHashOf(message),
                source: { sid: entry.logical, swipeKey: entry.swipeKey, evidence: entry.evidence, ordinal: Number.isInteger(entry.next) ? entry.next : 0 },
            };
        },

        // Only committed marker pins are projected. A skipped/failed/replaced root publishes none.
        timelineMarkers() {
            const state = current().state;
            const pins = state?.meta?.proofs ?? {};
            const out = [];
            const seen = new Set();
            for (const index of carrierIndexes(list())) {
                const record = readRecord(list()[index]);
                if (!record) continue;
                for (const span of record.spans ?? []) {
                    const prior = [];
                    for (const marker of span.clockBoundaries ?? []) {
                        if (markerProblem(marker) || pins[marker.proof] !== marker.pin || seen.has(marker.cursor.block)) continue;
                        seen.add(marker.cursor.block);
                        out.push({ ...structuredClone(marker), root: structuredClone(span.boundaries[0]), prior: [...prior] });
                        prior.push(marker.cursor.block);
                    }
                }
            }
            return out;
        },

        // Internal timeline witness. A native checkpoint belongs to this exact surviving prefix,
        // including the state its guards accepted. Never match by revision or by message index.
        prefixWitness(cursor) {
            const arr = list();
            // Queries ask this for every archived boundary on every read; on an unchanged chat the answer is the same (witnessGeneration).
            const key = witnessKeyOf(cursor);
            if (key === null || s.applying || s.staged) return prefixWitnessUncached(arr, cursor);
            const gen = witnessGeneration(arr);
            if (gen.answers.has(key)) {
                const hit = gen.answers.get(key);
                return hit === null ? null : { ...hit };
            }
            const pkey = prefixKey(gen, arr, cursor, key);
            const byPrefix = (s.witnessByPrefix ??= new Map());
            if (pkey !== null && byPrefix.has(pkey)) {
                const kept = byPrefix.get(pkey);
                byPrefix.delete(pkey); byPrefix.set(pkey, kept);
                // (a replay lowers replanFrom as a side effect; a hit skips the replay, so it lowers it again)
                if (kept.replan < s.replanFrom) s.replanFrom = kept.replan;
                gen.answers.set(key, kept.answer);
                return kept.answer === null ? null : { ...kept.answer };
            }
            s.counts.witnessMisses++;
            // (the replan point this one replay finds, apart from what was found before it: it is kept with the answer)
            const replanBefore = s.replanFrom;
            s.replanFrom = Infinity;
            let answer;
            let found;
            try { answer = prefixWitnessUncached(arr, cursor); } finally { found = s.replanFrom; s.replanFrom = Math.min(replanBefore, found); }
            // (keyed again after the replay: it may have seen guarded blocks for the first time, and the mark is part of the key)
            const stored = pkey === null ? null : prefixKey(gen, arr, cursor, key);
            if (stored !== null) {
                byPrefix.set(stored, { answer, replan: found });
                while (byPrefix.size > byPrefixMax) byPrefix.delete(byPrefix.keys().next().value);
            }
            // (the replay may have seen guarded blocks for the first time: the mark then reads differently, though nothing else did)
            if (gen === s.witnessGen && gen.mark === '' && s.guardSeen && gen.epoch === s.epoch) gen.mark = markSeen();
            gen.answers.set(key, answer);
            return answer === null ? null : { ...answer };
        },

        /**
         * Runs `read` (synchronous, read-only: it must not write to the chat) with the witness memo checked in full once instead
         * of on each `prefixWitness` call inside it (the timeline's pass over every boundary). → what `read` returns.
         */
        witnessScope(read) {
            if (s.witnessScoped || s.applying || s.staged) return read();
            s.witnessScoped = { gen: null, epoch: s.epoch };
            try {
                const arr = list();
                witnessGeneration(arr);
                s.scopeSpines = { arr, epoch: s.epoch, run: spineRun(arr) };      // once per scope; the epoch check drops it after a write
                return read();
            } finally { s.witnessScoped = null; s.scopeSpines = null; }
        },

        /** The timeline witnesses kept for the chat as it is now (tests). */
        witnessMemoSize() {
            return s.witnessGen ? s.witnessGen.answers.size : 0;
        },

        /** `prefixWitness` worked out afresh, never from the memo (tests compare the two). */
        witnessFresh(cursor) {
            return prefixWitnessUncached(list(), cursor, { fresh: true });
        },
    };
}
